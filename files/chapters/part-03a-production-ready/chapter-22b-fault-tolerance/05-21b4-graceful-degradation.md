## 22B.4 Graceful Degradation

### Degradation Tiers

Graceful degradation is the art of providing the best possible service with the resources available. It requires pre-defining what "best possible" means at each level of impairment. A service that is either fully operational or completely broken is not gracefully degrading, it is binary failing.

The four-tier model from section 22B.1 needs operational teeth: explicit code that detects which tier applies and executes the corresponding behavior. This is not emergency improvisation. It is pre-planned, tested, and well-understood.

```
DEGRADATION TIER STATE MACHINE

         All services healthy
                │
                │ Non-critical service fails
                ▼
    ┌───────────────────────┐
    │     FULL SERVICE      │◄─────────────────────┐
    └──────────┬────────────┘                      │
               │ recommendations/analytics down     │ services recover
               ▼                                    │
    ┌───────────────────────┐                       │
    │    DEGRADED MODE      │───────────────────────┤
    └──────────┬────────────┘                       │
               │ primary data source fails          │ primary recovers
               ▼                                    │
    ┌───────────────────────┐                       │
    │    MINIMAL MODE       │───────────────────────┤
    └──────────┬────────────┘                       │
               │ cache fails or DB severely degraded│ full recovery
               ▼                                    │
    ┌───────────────────────┐                       │
    │   STATIC FALLBACK     │───────────────────────┘
    └───────────────────────┘
```

### Feature Flag-Driven Degradation

The cleanest mechanism for entering degraded mode is feature flags with runtime switching. When a dependency fails, the circuit breaker opens and simultaneously flips a feature flag that disables the affected feature. No deployment is required, and the flag change propagates in milliseconds.

```go
package degradation

import (
    "log/slog"
    "sync"
    "sync/atomic"
)

// Tier represents the current service degradation tier.
type Tier int32

const (
    TierFull    Tier = iota // All features operational.
    TierDegraded            // Non-critical features disabled.
    TierMinimal             // Core function only.
    TierStatic              // No live data, static fallback only.
)

func (t Tier) String() string {
    switch t {
    case TierFull:
        return "full"
    case TierDegraded:
        return "degraded"
    case TierMinimal:
        return "minimal"
    case TierStatic:
        return "static"
    default:
        return "unknown"
    }
}

// Feature represents a named capability that can be disabled during degradation.
type Feature string

const (
    FeatureRecommendations Feature = "recommendations"
    FeatureAnalytics       Feature = "analytics"
    FeaturePersonalization Feature = "personalization"
    FeatureABTesting       Feature = "ab_testing"
    FeatureSearch          Feature = "search"
    FeatureRealTimePricing Feature = "realtime_pricing"
)

// featuresDisabledAt is the COMPLETE set of features switched off at each
// tier, not a delta from the tier above. SetTier rebuilds from this table on
// every transition.
//
// The delta approach is the tempting one and it is a trap: if each tier only
// adds to the existing set, a service that drops to TierMinimal and then
// recovers to TierDegraded keeps search and personalization switched off
// forever, because nothing ever removes them. Degradation becomes a ratchet
// that only SetTier(TierFull) can release.
var featuresDisabledAt = map[Tier][]Feature{
    TierFull: {},
    TierDegraded: {
        FeatureRecommendations, FeatureAnalytics, FeatureABTesting,
    },
    TierMinimal: {
        FeatureRecommendations, FeatureAnalytics, FeatureABTesting,
        FeaturePersonalization,
        FeatureSearch, // Falls back to exact match.
    },
    TierStatic: {
        FeatureRecommendations, FeatureAnalytics, FeatureABTesting,
        FeaturePersonalization, FeatureSearch, FeatureRealTimePricing,
    },
}

// DegradationManager manages the current service tier and feature availability.
// It is safe for concurrent use.
//
// Tier-driven and manual disablement are tracked separately on purpose. A tier
// transition must not silently re-enable a feature whose circuit breaker is
// still open, and clearing a circuit breaker must not re-enable a feature the
// current tier says is off. A feature is available only if neither says no.
type DegradationManager struct {
    tier      atomic.Int32
    mu        sync.RWMutex
    tierOff   map[Feature]bool // Disabled by the current tier.
    manualOff map[Feature]bool // Disabled surgically, e.g. by an open breaker.
    listeners []chan Tier
    logger    *slog.Logger
    metrics   MetricsRecorder
}

// NewDegradationManager creates a manager starting in full service mode.
func NewDegradationManager(logger *slog.Logger, metrics MetricsRecorder) *DegradationManager {
    dm := &DegradationManager{
        tierOff:   make(map[Feature]bool),
        manualOff: make(map[Feature]bool),
        logger:    logger,
        metrics:   metrics,
    }
    dm.tier.Store(int32(TierFull))
    return dm
}

// SetTier atomically transitions to a new degradation tier,
// automatically enabling/disabling features appropriate for that tier.
func (dm *DegradationManager) SetTier(tier Tier) {
    // The tier and the flag set are swapped under one lock so that a reader
    // can never observe the new tier alongside the old tier's flags.
    dm.mu.Lock()

    prev := Tier(dm.tier.Swap(int32(tier)))
    if prev == tier {
        dm.mu.Unlock()
        return // No change.
    }

    // Rebuild rather than accumulate, so recovery upward works.
    tierOff := make(map[Feature]bool, len(featuresDisabledAt[tier]))
    for _, f := range featuresDisabledAt[tier] {
        tierOff[f] = true
    }
    dm.tierOff = tierOff

    // Non-blocking sends: a slow listener must never stall a tier transition.
    for _, ch := range dm.listeners {
        select {
        case ch <- tier:
        default:
        }
    }
    dm.mu.Unlock()

    dm.logger.Warn("degradation tier changed",
        "from", prev.String(),
        "to", tier.String(),
    )
    dm.metrics.SetGauge("degradation.tier", float64(tier))
}

// IsEnabled returns true if the feature is currently available. Both the tier
// and any surgical override must agree before a feature is considered up.
func (dm *DegradationManager) IsEnabled(f Feature) bool {
    dm.mu.RLock()
    defer dm.mu.RUnlock()
    return !dm.tierOff[f] && !dm.manualOff[f]
}

// DisableFeature manually disables a specific feature without changing tier.
// Use this for surgical feature disablement, such as an opened circuit breaker.
func (dm *DegradationManager) DisableFeature(f Feature) {
    dm.mu.Lock()
    dm.manualOff[f] = true
    dm.mu.Unlock()
    dm.logger.Warn("feature manually disabled", "feature", string(f))
    dm.metrics.IncrCounter("degradation.feature_disabled", 1, "feature", string(f))
}

// EnableFeature clears a manual disablement. Without this, a feature switched
// off by an opened circuit breaker stays off for the life of the process and
// degradation only ever moves one way.
//
// It clears the manual override only. If the current tier also disables the
// feature, it stays off until the tier recovers, which is the intended
// behaviour: recovering one dependency does not undo a service-wide tier drop.
func (dm *DegradationManager) EnableFeature(f Feature) {
    dm.mu.Lock()
    delete(dm.manualOff, f)
    dm.mu.Unlock()
    dm.logger.Info("feature re-enabled", "feature", string(f))
    dm.metrics.IncrCounter("degradation.feature_enabled", 1, "feature", string(f))
}

// CurrentTier returns the current degradation tier.
func (dm *DegradationManager) CurrentTier() Tier {
    return Tier(dm.tier.Load())
}

// Subscribe returns a channel that receives tier changes.
// The caller must read from the channel promptly to avoid blocking tier transitions.
func (dm *DegradationManager) Subscribe() <-chan Tier {
    ch := make(chan Tier, 4)
    dm.mu.Lock()
    dm.listeners = append(dm.listeners, ch)
    dm.mu.Unlock()
    return ch
}
```

### Circuit Breaker as Degradation Trigger

The circuit breaker (Chapter 22) and the degradation manager work together. When a circuit breaker transitions from closed to open, it signals the degradation manager to disable the associated feature. When the circuit breaker heals (transitions back to closed), it signals recovery.

```go
// CircuitBreakerDegradationBridge connects a circuit breaker to the
// degradation manager. When the CB opens, the feature is disabled.
// When the CB closes, the feature is re-evaluated.
type CircuitBreakerDegradationBridge struct {
    cb      CircuitBreaker
    dm      *DegradationManager
    health  HealthChecker
    feature Feature
    logger  *slog.Logger
}

// HealthChecker confirms a dependency is genuinely serving before its feature
// is switched back on. Returns nil when healthy.
type HealthChecker interface {
    Check(ctx context.Context, dependency string) error
}

func (b *CircuitBreakerDegradationBridge) OnStateChange(from, to CircuitBreakerState) {
    switch to {
    case StateOpen:
        b.logger.Warn("circuit breaker opened, disabling feature",
            "feature", b.feature,
        )
        b.dm.DisableFeature(b.feature)

    case StateClosed:
        b.logger.Info("circuit breaker closed, confirming recovery before re-enabling",
            "feature", b.feature,
        )
        // A closed breaker means probe traffic succeeded, which is weaker
        // evidence than the feature actually being healthy. Confirm with a
        // real health check, then clear the override.
        //
        // Something must call EnableFeature eventually. If nothing does, the
        // feature stays disabled for the life of the process and the service
        // degrades permanently after a single transient blip.
        if b.health.Check(context.Background(), string(b.feature)) == nil {
            b.dm.EnableFeature(b.feature)
        } else {
            b.logger.Warn("breaker closed but health check failed, staying degraded",
                "feature", b.feature,
            )
        }
    }
}
```

### Real Examples of Graceful Degradation

**Recommendation Service Degradation:**

```go
type ProductPageBuilder struct {
    dm             *DegradationManager
    recommendSvc   RecommendationService
    popularItemsSvc PopularItemsService
}

func (b *ProductPageBuilder) GetRecommendations(ctx context.Context, userID, productID string) ([]Product, DegradationInfo) {
    if !b.dm.IsEnabled(FeatureRecommendations) {
        // Feature disabled, so fall back to "most popular" from cache.
        popular, err := b.popularItemsSvc.GetTopItems(ctx, 10)
        if err != nil {
            return nil, DegradationInfo{
                Feature: "recommendations",
                Reason:  "service unavailable, popular items also unavailable",
                Tier:    "none",
            }
        }
        return popular, DegradationInfo{
            Feature: "recommendations",
            Reason:  "personalization unavailable, showing popular items",
            Tier:    "popular",
        }
    }

    recs, err := b.recommendSvc.GetForUser(ctx, userID, productID)
    if err != nil {
        // Runtime fallback even when the feature is nominally enabled.
        // The fallback's own error must be checked. Discarding it with `_`
        // and returning a nil slice would report Tier "popular" while
        // showing nothing, which is a lie told to your own dashboards.
        popular, popErr := b.popularItemsSvc.GetTopItems(ctx, 10)
        if popErr != nil {
            return nil, DegradationInfo{
                Feature: "recommendations",
                Reason:  "recommendation engine error, popular items also unavailable",
                Tier:    "none",
            }
        }
        return popular, DegradationInfo{
            Feature: "recommendations",
            Reason:  "recommendation engine error, showing popular items",
            Tier:    "popular",
        }
    }

    return recs, DegradationInfo{}
}
```

**Search Degradation to Exact Match:**

```go
type SearchService struct {
    dm          *DegradationManager
    rankingSvc  RankingService
    exactSearch ExactMatchSearch
}

type SearchResult struct {
    Items    []Item `json:"items"`
    Degraded bool   `json:"degraded,omitempty"`
    Mode     string `json:"search_mode"` // "ranked", "exact", "prefix"
}

func (s *SearchService) Search(ctx context.Context, query string) (*SearchResult, error) {
    if !s.dm.IsEnabled(FeatureSearch) {
        // Full search engine down, so exact match only.
        items, err := s.exactSearch.Find(ctx, query)
        if err != nil {
            return nil, err
        }
        return &SearchResult{
            Items:    items,
            Degraded: true,
            Mode:     "exact",
        }, nil
    }

    // Attempt full ranked search.
    items, err := s.rankingSvc.Search(ctx, query)
    if err != nil {
        // Ranking service failed at runtime, so fall back to exact match.
        items, err = s.exactSearch.Find(ctx, query)
        if err != nil {
            return nil, err
        }
        return &SearchResult{Items: items, Degraded: true, Mode: "exact"}, nil
    }

    return &SearchResult{Items: items, Mode: "ranked"}, nil
}
```

### Returning Degradation Metadata

Clients, both browsers and other services, need to know when they are receiving degraded responses so they can adapt their behavior. A browser might hide the recommendations section instead of showing a spinner. A calling service might try a different approach.

```go
// DegradationMetadata is embedded in API responses to communicate
// partial availability to clients.
type DegradationMetadata struct {
    Degraded         bool     `json:"degraded,omitempty"`
    DegradedFeatures []string `json:"degraded_features,omitempty"`
    DegradationTier  string   `json:"degradation_tier,omitempty"`
    Message          string   `json:"message,omitempty"`
}

// HTTP headers for degradation signaling.
const (
    HeaderDegradedMode     = "X-Degraded-Mode"
    HeaderDegradedFeatures = "X-Degraded-Features"
    HeaderDegradationTier  = "X-Degradation-Tier"
)

func writeDegradedResponse(w http.ResponseWriter, meta DegradationMetadata) {
    if !meta.Degraded {
        return
    }
    w.Header().Set(HeaderDegradedMode, "true")
    w.Header().Set(HeaderDegradedFeatures, strings.Join(meta.DegradedFeatures, ","))
    w.Header().Set(HeaderDegradationTier, meta.DegradationTier)
}
```

### Staff Lens: Degradation Strategy Is Product Decision

For each feature, the product team should decide: what is the acceptable degraded behavior? Show stale data? Omit the feature? Return an error? Engineering implements the chosen strategy. Without explicit product direction, engineers guess and the guesses diverge.

---
