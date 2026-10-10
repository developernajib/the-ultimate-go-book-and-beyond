## 102D.8 Shadow/Dark Launches & Feature Flags

Shadow and dark launches decouple feature deployment from feature activation. A dark launch deploys new code to production but keeps it inactive for real users, allowing performance testing and infrastructure validation without customer-visible risk. A shadow launch sends production traffic to both the old and new code paths simultaneously but discards the new response, enabling correctness validation at real-world load. The Go middleware below shows a feature flag implementation that chooses between code paths at runtime, making activation a configuration change rather than a deployment.

```go
package main

import (
    "context"
    "log/slog"

    ld "github.com/launchdarkly/go-server-sdk/v7"
    "github.com/launchdarkly/go-server-sdk/v7/ldcontext"
)

// FeatureFlags wraps LaunchDarkly for feature flag evaluation
type FeatureFlags struct {
    client *ld.LDClient
    logger *slog.Logger
}

func NewFeatureFlags(sdkKey string, logger *slog.Logger) (*FeatureFlags, error) {
    client, err := ld.MakeClient(sdkKey, 5)
    if err != nil {
        return nil, err
    }
    return &FeatureFlags{client: client, logger: logger}, nil
}

// IsEnabled checks if a feature is enabled for a specific user
func (f *FeatureFlags) IsEnabled(ctx context.Context, flagKey, userID string) bool {
    ldCtx := ldcontext.New(userID)
    value, err := f.client.BoolVariation(flagKey, ldCtx, false)
    if err != nil {
        f.logger.Error("feature flag evaluation error", "flag", flagKey, "err", err)
        return false
    }
    return value
}

type Item struct {
    ID   string `json:"id"`
    Name string `json:"name"`
}

type SearchResult struct {
    Items []Item `json:"items"`
    Total int    `json:"total"`
}

type LegacySearchEngine struct{}

func (l *LegacySearchEngine) Search(ctx context.Context, query string) (*SearchResult, error) {
    return &SearchResult{Total: 0}, nil
}

type MLSearchEngine struct{}

func (m *MLSearchEngine) Search(ctx context.Context, query string) (*SearchResult, error) {
    return &SearchResult{Total: 0}, nil
}

// Shadow launch: run new implementation alongside old, compare results
type SearchService struct {
    legacySearch *LegacySearchEngine
    newSearch    *MLSearchEngine
    flags        *FeatureFlags
    logger       *slog.Logger
}

func (s *SearchService) Search(ctx context.Context, userID, query string) (*SearchResult, error) {
    // Always use legacy for actual response
    legacyResult, err := s.legacySearch.Search(ctx, query)
    if err != nil {
        return nil, err
    }

    // If shadow flag enabled: run new search in background, compare results
    if s.flags.IsEnabled(ctx, "ml-search-shadow", userID) {
        go func() {
            newResult, newErr := s.newSearch.Search(context.Background(), query)
            if newErr != nil {
                s.logger.Error("shadow search error", "err", newErr)
                return
            }
            // Compare results for analysis (don't affect user response)
            s.compareResults(query, legacyResult, newResult)
        }()
    }

    // If canary flag enabled: use new search for some users
    if s.flags.IsEnabled(ctx, "ml-search-canary", userID) {
        return s.newSearch.Search(ctx, query)
    }

    return legacyResult, nil
}

func (s *SearchService) compareResults(query string, legacy, newResult *SearchResult) {
    // Log discrepancies for analysis
    overlap := calculateOverlap(legacy.Items, newResult.Items)
    s.logger.Info("shadow search comparison",
        "query", query,
        "legacy_count", legacy.Total,
        "new_count", newResult.Total,
        "overlap_percent", overlap,
    )
}

func calculateOverlap(legacy, newItems []Item) float64 {
    if len(legacy) == 0 || len(newItems) == 0 {
        return 0.0
    }
    matches := 0
    itemMap := make(map[string]struct{}, len(legacy))
    for _, it := range legacy {
        itemMap[it.ID] = struct{}{}
    }
    for _, it := range newItems {
        if _, exists := itemMap[it.ID]; exists {
            matches++
        }
    }
    return float64(matches) / float64(len(legacy)) * 100.0
}
```

### Junior → FAANG: Shadow Launches as a Risk Reduction Tool

Shadow mode is the safest way to validate a new implementation before exposing users to it. The key property: the new code path runs on real production traffic with real inputs, but its output is discarded. Users never see the new result. This eliminates the risk of correctness bugs reaching users while still generating the volume of test cases that staging environments cannot replicate.

The goroutine in the `Search` method is intentional: the shadow request must not add latency to the user-facing response. The `context.Background()` instead of the request context is also intentional: the request context may be canceled when the handler returns, which would interrupt the shadow comparison before it completes. Use a separate context with a timeout for shadow calls to avoid goroutine leaks.

First-job mistake to avoid: logging too much comparison data. If shadow traffic is 10% of production and production handles 10,000 requests per second, you are generating 1,000 comparison log entries per second. Design the comparison log to be queryable and aggregatable, not a full diff of every result set.

### Senior @ FAANG: Shadow Mode as a Progressive Confidence Framework

At senior level, shadow mode is not just a testing technique. It is a progressive confidence framework that decouples deployment risk from experimentation risk. The deployment risk (the new code runs in production) is accepted when shadow mode is enabled. The user-facing risk (users experience the new behavior) is deferred until the shadow comparison data justifies promotion.

The comparison function in the example is trivially simple. At FAANG scale, the comparison is a statistical analysis pipeline: bucket results by query type, compute overlap percentages by category, run chi-square tests for result order differences, and alert when overlap drops below the expected baseline for a given query class. This requires storing comparison results in a data warehouse, running nightly analysis jobs, and having a defined promotion criterion such as "95% overlap across all query categories for 7 consecutive days before enabling the canary flag."

The feature flag client wrapping pattern in this file is a platform concern, not an application concern. At scale, you do not want every service to directly instantiate a LaunchDarkly client with its own connection management, caching, and error handling. The platform team should provide a shared feature flag interface, backed by the organization's flag management system, that application code depends on through dependency injection. This enables swapping the flag backend without touching application code, implementing organization-wide kill switches that override all flag evaluations during incidents, and centrally auditing flag usage to find flags that should be cleaned up after experiments conclude.

---
