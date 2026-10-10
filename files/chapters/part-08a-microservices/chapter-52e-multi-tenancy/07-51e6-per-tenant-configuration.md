## 52E.6 Per-Tenant Configuration

### Feature Flags Per Tenant

Per-tenant feature flags control which functionality is available to each customer based on their plan tier, with per-tenant overrides for custom enterprise agreements. The implementation below uses a plan-to-features mapping as the base, overlaid with database-stored overrides. An in-memory cache keyed by tenant ID avoids a database roundtrip on every flag check:

```go
package features

import (
    "context"
    "fmt"
    "sync"
    "time"

    "github.com/yourorg/app/internal/tenant"
)

type Feature string

const (
    FeatureAdvancedReporting   Feature = "advanced_reporting"
    FeatureAPIAccess           Feature = "api_access"
    FeatureSSOIntegration      Feature = "sso_integration"
    FeatureCustomDomain        Feature = "custom_domain"
    FeatureAuditLog            Feature = "audit_log"
    FeatureWebhooks            Feature = "webhooks"
    FeaturePrioritySupport     Feature = "priority_support"
)

// PlanFeatures defines which features each plan includes
var PlanFeatures = map[string][]Feature{
    "free": {
        FeatureAPIAccess,
    },
    "pro": {
        FeatureAPIAccess,
        FeatureWebhooks,
        FeatureAdvancedReporting,
    },
    "business": {
        FeatureAPIAccess,
        FeatureWebhooks,
        FeatureAdvancedReporting,
        FeatureAuditLog,
        FeatureCustomDomain,
    },
    "enterprise": {
        FeatureAPIAccess,
        FeatureWebhooks,
        FeatureAdvancedReporting,
        FeatureAuditLog,
        FeatureCustomDomain,
        FeatureSSOIntegration,
        FeaturePrioritySupport,
    },
}

type FeatureService struct {
    db      *pgxpool.Pool
    cache   *sync.Map  // tenantID → map[Feature]bool
    cacheTTL time.Duration
}

func (s *FeatureService) IsEnabled(ctx context.Context, feature Feature) (bool, error) {
    t := tenant.MustFromContext(ctx)

    features, err := s.getTenantFeatures(ctx, t)
    if err != nil {
        return false, err
    }

    return features[feature], nil
}

func (s *FeatureService) getTenantFeatures(ctx context.Context, t *tenant.TenantContext) (map[Feature]bool, error) {
    cacheKey := t.ID.String()

    if cached, ok := s.cache.Load(cacheKey); ok {
        entry := cached.(*cacheEntry)
        if time.Since(entry.loadedAt) < s.cacheTTL {
            return entry.features, nil
        }
    }

    // Build feature set from plan + overrides
    features := make(map[Feature]bool)

    // Plan-based features
    for _, f := range PlanFeatures[t.Plan] {
        features[f] = true
    }

    // Individual overrides from database (for custom enterprise agreements)
    rows, err := s.db.Query(ctx, `
        SELECT feature_name, enabled
        FROM tenant_feature_overrides
        WHERE tenant_id = $1
    `, t.ID)
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    for rows.Next() {
        var name string
        var enabled bool
        if err := rows.Scan(&name, &enabled); err != nil {
            return nil, err
        }
        if enabled {
            features[Feature(name)] = true
        } else {
            delete(features, Feature(name))
        }
    }

    entry := &cacheEntry{features: features, loadedAt: time.Now()}
    s.cache.Store(cacheKey, entry)

    return features, nil
}

// RequireFeature middleware enforces feature access at the route level
func RequireFeature(svc *FeatureService, feature Feature) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            enabled, err := svc.IsEnabled(r.Context(), feature)
            if err != nil {
                apierror.Write(w, r, apierror.InternalError())
                return
            }

            if !enabled {
                t := tenant.MustFromContext(r.Context())
                apierror.Write(w, r, &apierror.ProblemDetail{
                    Status: http.StatusForbidden,
                    Title:  "Feature Not Available",
                    Detail: fmt.Sprintf("The %q feature is not available on the %s plan. Upgrade to access this feature.", feature, t.Plan),
                })
                return
            }

            next.ServeHTTP(w, r)
        })
    }
}
```

### Tenant-Specific Settings

Beyond feature flags, tenants often need configurable settings like project limits, timezones, and webhook retry counts. The `TenantSettingsService` below implements a three-layer cache (local memory, Redis, PostgreSQL) with pub/sub invalidation so that settings changes propagate across all application instances within seconds:

```go
type TenantSettings struct {
    TenantID         uuid.UUID         `db:"tenant_id"`
    MaxProjectsLimit int               `db:"max_projects"`
    DefaultTimezone  string            `db:"default_timezone"`
    AllowedDomains   []string          `db:"allowed_domains"`
    WebhookRetries   int               `db:"webhook_retries"`
    CustomSettings   map[string]string `db:"custom_settings"`
    UpdatedAt        time.Time         `db:"updated_at"`
}

// Tenant settings are cached with invalidation via Redis pub/sub
type TenantSettingsService struct {
    db     *pgxpool.Pool
    redis  *redis.Client
    local  *sync.Map  // local in-memory cache
}

func (s *TenantSettingsService) Get(ctx context.Context, tenantID uuid.UUID) (*TenantSettings, error) {
    cacheKey := fmt.Sprintf("tenant:settings:%s", tenantID)

    // L1: local memory cache (sub-millisecond)
    if cached, ok := s.local.Load(cacheKey); ok {
        entry := cached.(*settingsCacheEntry)
        if time.Since(entry.loadedAt) < 30*time.Second {
            return entry.settings, nil
        }
    }

    // L2: Redis cache (single-digit milliseconds)
    var settings TenantSettings
    val, err := s.redis.Get(ctx, cacheKey).Bytes()
    if err == nil {
        if err := json.Unmarshal(val, &settings); err == nil {
            s.local.Store(cacheKey, &settingsCacheEntry{settings: &settings, loadedAt: time.Now()})
            return &settings, nil
        }
    }

    // L3: Database
    settings, err = s.loadFromDB(ctx, tenantID)
    if err != nil {
        return nil, err
    }

    // Write through to cache
    if data, err := json.Marshal(settings); err == nil {
        s.redis.Set(ctx, cacheKey, data, 5*time.Minute)
    }
    s.local.Store(cacheKey, &settingsCacheEntry{settings: &settings, loadedAt: time.Now()})

    return &settings, nil
}

// InvalidateSettings invalidates cache across all instances via Redis pub/sub
func (s *TenantSettingsService) InvalidateSettings(ctx context.Context, tenantID uuid.UUID) error {
    cacheKey := fmt.Sprintf("tenant:settings:%s", tenantID)
    s.local.Delete(cacheKey)
    s.redis.Del(ctx, cacheKey)

    // Notify other instances
    return s.redis.Publish(ctx, "tenant:settings:invalidate", tenantID.String()).Err()
}
```

### Junior → FAANG: Feature Flags as a Safety Mechanism

Feature flags are a common interview topic, but per-tenant feature flags in a multi-tenant context add the plan-tier dimension. FAANG interviewers use this topic to probe caching strategy, invalidation, and failure behavior.

Common junior gaps:

- Treating feature flags as a simple boolean in the database queried on every request. Without caching, feature flag checks add a database roundtrip to every HTTP request. The three-layer cache in this section (local memory, Redis, database) is the minimum viable production pattern.
- Not understanding cache stampede. When the Redis cache expires for a popular tenant, hundreds of concurrent requests may all attempt to load from the database simultaneously. The `singleflight` package prevents this: only one goroutine fetches from the database, the rest wait and share the result.
- Confusing "feature enabled" with "feature within quota." Flags gate access to a capability. Quotas enforce limits on usage within that capability. Both are necessary, but they live in different systems.

Worked example for interviews: "How do you ensure a feature flag change takes effect within 30 seconds across all application instances?"

Answer: three-layer cache with pub/sub invalidation. The database is the source of truth. Redis is the shared cache with a five-minute TTL. Local in-memory cache has a 30-second TTL. On flag change, delete the Redis key and publish an invalidation event on a Redis channel. All instances receive the event, evict their local cache, and reload on the next request. The 30-second local TTL is the fallback recovery window if the pub/sub message is missed.

First-job habits:

- Add a `RequireFeature` middleware call to every route that is gated by a plan feature. Make the gating explicit in the route definition, not buried in the handler.
- Test the "feature not available" path for every gated feature. Confirm the response body includes the plan name and a clear upgrade path message.

### Senior @ FAANG: Feature Configuration as a Platform Primitive

At staff level, per-tenant feature flags are not a product feature built by one team. They are a platform primitive used by every product team. The governance and operational concerns at this level are distinct from the implementation.

**Flag taxonomy and lifecycle:**

A mature feature flag system distinguishes between four types of flags, each with different lifecycle rules:

- Release flags: gate a feature during development, intended to be removed once the feature ships to 100% of tenants. These accumulate technical debt if not cleaned up.
- Plan gates: permanently gate a feature to specific plan tiers. These are stable and should be documented in the pricing page.
- Experiment flags: enable A/B testing across a subset of tenants using deterministic hashing. These have a defined end date and a designated owner who is responsible for cleaning them up.
- Override flags: per-tenant exceptions for enterprise agreements. These require an audit trail: who approved the exception, when, and for how long.

At staff level, you design the schema and lifecycle tooling for all four types, not just the implementation of one.

**Operational runbook for flag emergencies:**

When a new feature is causing production issues for a subset of tenants, the standard response is a flag rollback. The runbook:

1. Set the feature flag to disabled at the plan level (one database update).
2. Publish an invalidation event to Redis pub/sub (sub-second propagation to all instances).
3. Verify via per-tenant metrics that error rates drop.
4. If the flag is a plan gate, communicate to affected customers that the feature is temporarily unavailable.
5. Root-cause the issue, fix it, re-enable with a gradual rollout.

The ability to turn off a feature for all tenants in under ten seconds is a production requirement, not a nice-to-have. Design the flag cache TTL and invalidation latency accordingly.

**Quota enforcement at the platform level:**

Feature flags gate access. Quotas enforce usage limits within the gated feature. The distinction matters because they require different implementations. A flag is a binary that the `FeatureService` checks synchronously. A quota is a counter that must be atomically incremented and checked, typically in Redis, with a write-path that rejects the operation if the quota is exceeded.

The platform should expose a `QuotaService` interface alongside the `FeatureService`:

```go
type QuotaService interface {
    // Check returns the current usage and whether the tenant is within their quota.
    Check(ctx context.Context, resource QuotaResource) (current, limit int64, ok bool, err error)
    // Increment atomically increments the usage counter and returns whether the quota is still satisfied.
    Increment(ctx context.Context, resource QuotaResource, by int64) (ok bool, err error)
    // Reset resets the counter (e.g., on billing cycle renewal).
    Reset(ctx context.Context, resource QuotaResource) error
}
```

The quota limits come from the tenant's plan settings, stored in the same `TenantSettings` struct as other per-tenant configuration, and read through the same three-layer cache.

**Settings schema evolution:**

The `CustomSettings map[string]string` field in `TenantSettings` is an escape hatch for ad-hoc enterprise requirements. At scale, this becomes a maintenance burden: the schema is unvalidated, the keys are undocumented, and the values require type coercion. A mature platform migrates ad-hoc custom settings into typed, versioned configuration objects with explicit deprecation paths. This is a staff-level concern: knowing when a flexible escape hatch has become technical debt and proposing a migration path.

---
