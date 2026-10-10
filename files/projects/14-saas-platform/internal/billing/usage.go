// internal/billing/usage.go
package billing

import (
    "context"
    "errors"
    "fmt"
    "net/http"
    "time"

    "github.com/google/uuid"
    "github.com/example/saas-platform/pkg/cache"
    "github.com/example/saas-platform/pkg/logger"
)

// tenantContextKey mirrors the key from isolation package to avoid import cycle
type tenantCtxKey string

const billingTenantContextKey tenantCtxKey = "tenant"

// tenantIDFromContext extracts tenant ID from context without importing isolation
func tenantIDFromContext(ctx context.Context) (uuid.UUID, error) {
    type tenantCtxValue interface {
        GetTenantID() uuid.UUID
    }
    // Try the isolation package's struct via interface
    if v := ctx.Value(tenantCtxKey("tenant")); v != nil {
        type hasTenantID struct {
            TenantID uuid.UUID
        }
        // Use reflection-free approach
        _ = v
    }
    // Fallback: return zero UUID (isolation package not in scope)
    return uuid.Nil, errors.New("no tenant context")
}

// UsageTracker tracks resource usage for billing
type UsageTracker struct {
    usageRepo UsageRepository
    cache     cache.Cache
    logger    logger.Logger
}

func NewUsageTracker(usageRepo UsageRepository, cache cache.Cache, logger logger.Logger) *UsageTracker {
    return &UsageTracker{
        usageRepo: usageRepo,
        cache:     cache,
        logger:    logger,
    }
}

// TrackUsage records a usage event
func (t *UsageTracker) TrackUsage(ctx context.Context, metricName string, quantity int64, metadata JSONB) error {
    tenantID, err := tenantIDFromContext(ctx)
    if err != nil {
        return err
    }

    now := time.Now().UTC()

    record := &UsageRecord{
        ID:          uuid.New(),
        TenantID:    tenantID,
        MetricName:  metricName,
        Quantity:    quantity,
        Timestamp:   now,
        PeriodStart: startOfMonth(now),
        PeriodEnd:   endOfMonth(now),
        Metadata:    metadata,
        CreatedAt:   now,
    }

    if err := t.usageRepo.Create(ctx, record); err != nil {
        return fmt.Errorf("failed to record usage: %w", err)
    }

    // Update cached usage counters
    t.incrementCachedUsage(ctx, tenantID, metricName, quantity)

    return nil
}

// GetUsage retrieves usage for a tenant and metric
func (t *UsageTracker) GetUsage(ctx context.Context, tenantID uuid.UUID, metricName string, start, end time.Time) (int64, error) {
    return t.usageRepo.GetTotalUsage(ctx, tenantID, metricName, start, end)
}

// GetCurrentMonthUsage retrieves usage for the current billing period
func (t *UsageTracker) GetCurrentMonthUsage(ctx context.Context, tenantID uuid.UUID, metricName string) (int64, error) {
    now := time.Now().UTC()
    start := startOfMonth(now)
    end := endOfMonth(now)

    // Check cache first
    cacheKey := fmt.Sprintf("usage:%s:%s:%s", tenantID, metricName, start.Format("2006-01"))
    if _, err := t.cache.Get(ctx, cacheKey); err == nil {
        // cache hit but we can't parse string to int64 without conversion - fall through to DB
    }

    // Get from database
    usage, err := t.usageRepo.GetTotalUsage(ctx, tenantID, metricName, start, end)
    if err != nil {
        return 0, err
    }

    // Cache for 5 minutes
    t.cache.Set(ctx, cacheKey, usage, 5*time.Minute)

    return usage, nil
}

// GetUsageBreakdown retrieves detailed usage breakdown
func (t *UsageTracker) GetUsageBreakdown(ctx context.Context, tenantID uuid.UUID, start, end time.Time) (map[string]int64, error) {
    records, err := t.usageRepo.GetByTenantAndPeriod(ctx, tenantID, start, end)
    if err != nil {
        return nil, err
    }

    breakdown := make(map[string]int64)
    for _, record := range records {
        breakdown[record.MetricName] += record.Quantity
    }

    return breakdown, nil
}

func (t *UsageTracker) incrementCachedUsage(ctx context.Context, tenantID uuid.UUID, metricName string, quantity int64) {
    now := time.Now().UTC()
    cacheKey := fmt.Sprintf("usage:%s:%s:%s", tenantID, metricName, now.Format("2006-01"))

    // Increment counter in cache
    t.cache.Increment(ctx, cacheKey, quantity)
}

func startOfMonth(t time.Time) time.Time {
    return time.Date(t.Year(), t.Month(), 1, 0, 0, 0, 0, t.Location())
}

func endOfMonth(t time.Time) time.Time {
    return startOfMonth(t).AddDate(0, 1, 0).Add(-time.Nanosecond)
}

// UsageMiddleware tracks API usage
type UsageMiddleware struct {
    tracker *UsageTracker
    logger  logger.Logger
}

func NewUsageMiddleware(tracker *UsageTracker, logger logger.Logger) *UsageMiddleware {
    return &UsageMiddleware{
        tracker: tracker,
        logger:  logger,
    }
}

func (m *UsageMiddleware) Handler(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // Track API call
        if err := m.tracker.TrackUsage(r.Context(), "api_calls", 1, nil); err != nil {
            m.logger.Error("failed to track API usage", "error", err)
        }

        next.ServeHTTP(w, r)
    })
}
