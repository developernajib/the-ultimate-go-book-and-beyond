## 22B.3 Timeout Hierarchies

### Why Simple Timeouts Are Not Enough

The naive approach to timeouts is setting a single duration on every HTTP client and database connection: `client.Timeout = 5 * time.Second`. This is better than no timeout, but it creates a dangerous illusion of safety.

Consider a single user request that makes five sequential service calls, each with a 5-second timeout. In the worst case, where each call times out in turn, the user waits 25 seconds before receiving an error. That is not a timeout. That is a punishment.

More subtly: if your user-facing SLA is 2 seconds and every internal call has a 5-second timeout, you have made it mathematically impossible to meet your SLA when any single dependency misbehaves. The per-call timeout is completely decoupled from the overall request deadline.

The solution is a **timeout hierarchy**: a budget for the entire request, subdivided and allocated to each downstream call, with the remaining budget propagated through every layer via `context.Context`.

```
TIMEOUT HIERARCHY FOR A PRODUCT PAGE REQUEST:

User SLA: 2000ms total budget
│
├── Cache lookup: max 50ms (2.5% of budget)
│
├── Inventory service call: max 300ms (15% of budget)
│   └── DB query inside inventory: max 100ms
│
├── Pricing service call: max 400ms (20% of budget)
│   └── DB query inside pricing: max 150ms
│
├── Reviews service call: max 500ms (25% of budget)
│   └── (optional, can be skipped if budget exhausted)
│
└── Remaining budget: used for serialization, network overhead, safety margin

IF REVIEWS SERVICE HITS 490ms:
  - Remaining budget for serialization = 2000 - 50 - 300 - 400 - 490 = 760ms
  - Plenty of time to respond.

IF INVENTORY TIMES OUT AT ITS CAP AND IS RETRIED TWICE:
  - Cache miss 50ms, inventory 3 x 300ms = 900ms, pricing 400ms
  - Elapsed = 1350ms, remaining = 650ms
  - Reviews asks for 500ms and gets all of it: min(500, 650)
  - 150ms left for serialization. Tight, but the SLA holds.

IF PRICING IS ALSO RETRIED ONCE:
  - Elapsed = 1750ms, remaining = 250ms
  - Reviews asks for 500ms and is CLAMPED to 250ms: min(500, 250)
  - Reviews either answers inside 250ms or is dropped from the page.
  - Either way the 2000ms SLA holds.

Note what the budget tracker does and does not do. It clamps every call to
the budget that is actually left. It only skips a call outright when what
remains is below MinViableBudget, because firing a request you know cannot
finish just burns capacity downstream for an answer nobody will read.
```

### The TimeoutBudget Pattern

The `TimeoutBudget` pattern wraps `context.Context` with explicit budget tracking. Every downstream call declares how much budget it needs. The budget tracker enforces that no call exceeds its allocation and that the total never exceeds the user SLA.

```go
package budget

import (
    "context"
    "fmt"
    "sync"
    "time"
)

// TimeoutBudget tracks a time budget for a single request, subdividing it
// among downstream operations. It wraps context propagation so that
// all operations respect the overall deadline.
// The remaining budget is deliberately not stored as a field. It is derived
// from the wall clock in Remaining(), so it cannot drift out of sync with
// reality the way a decremented counter would.
type TimeoutBudget struct {
    mu    sync.Mutex
    total time.Duration
    start time.Time
    ops   []budgetEntry
}

type budgetEntry struct {
    name     string
    actual   time.Duration
    timedOut bool
}

// NewTimeoutBudget creates a budget for a request with the given total duration.
// The caller should also set a matching context deadline.
func NewTimeoutBudget(total time.Duration) *TimeoutBudget {
    return &TimeoutBudget{
        total: total,
        start: time.Now(),
    }
}

// Remaining returns the time remaining in the budget, accounting for
// elapsed wall clock time since the budget was created.
func (b *TimeoutBudget) Remaining() time.Duration {
    b.mu.Lock()
    defer b.mu.Unlock()

    elapsed := time.Since(b.start)
    remaining := b.total - elapsed
    if remaining < 0 {
        return 0
    }
    return remaining
}

// WithTimeout creates a child context with a deadline of at most maxDuration,
// but capped at the remaining budget. The returned cancel function must be called.
// The name parameter is used for observability.
//
// Returns an error if the remaining budget is insufficient to run the operation
// with a meaningful duration (below minViable).
func (b *TimeoutBudget) WithTimeout(
    ctx context.Context,
    name string,
    maxDuration time.Duration,
    minViable time.Duration,
) (context.Context, context.CancelFunc, error) {
    remaining := b.Remaining()

    if remaining < minViable {
        return nil, func() {}, fmt.Errorf(
            "budget: insufficient time for %q: %s remaining, need at least %s",
            name, remaining, minViable,
        )
    }

    // Use the smaller of the requested max and what remains.
    timeout := maxDuration
    if remaining < timeout {
        timeout = remaining
    }

    ctx, cancel := context.WithTimeout(ctx, timeout)
    return ctx, cancel, nil
}

// Record records the actual time taken by an operation. This is used for
// budget auditing and telemetry. Call after the operation completes.
func (b *TimeoutBudget) Record(name string, duration time.Duration, timedOut bool) {
    b.mu.Lock()
    defer b.mu.Unlock()

    b.ops = append(b.ops, budgetEntry{
        name:     name,
        actual:   duration,
        timedOut: timedOut,
    })
}

// Summary returns a human-readable budget summary for logging.
func (b *TimeoutBudget) Summary() string {
    b.mu.Lock()
    defer b.mu.Unlock()

    total := time.Since(b.start)
    summary := fmt.Sprintf("budget: total=%s elapsed=%s ops=[", b.total, total)
    for i, op := range b.ops {
        if i > 0 {
            summary += ", "
        }
        if op.timedOut {
            summary += fmt.Sprintf("%s:TIMEOUT(%s)", op.name, op.actual)
        } else {
            summary += fmt.Sprintf("%s:%s", op.name, op.actual)
        }
    }
    summary += "]"
    return summary
}

// BudgetExhausted returns true if the budget has been consumed.
func (b *TimeoutBudget) BudgetExhausted() bool {
    return b.Remaining() == 0
}
```

### Context Deadline Propagation

Go's `context.WithTimeout` nests deadlines correctly: if the parent context has a deadline of T+2s and you call `context.WithTimeout(parent, 5s)`, the child inherits the parent's deadline of T+2s, not T+5s. The `context` package enforces this. This is the mechanism that makes timeout hierarchies work in Go.

```go
// Correct context nesting. The parent deadline is respected.
parentCtx, parentCancel := context.WithTimeout(context.Background(), 2*time.Second)
defer parentCancel()

// This child will timeout in min(500ms, remaining parent budget).
childCtx, childCancel := context.WithTimeout(parentCtx, 500*time.Millisecond)
defer childCancel()

// If parentCtx deadline is 1800ms away and we request 500ms, child gets 500ms.
// If parentCtx deadline is 300ms away and we request 500ms, child gets 300ms.
// context.WithTimeout enforces the minimum for you. No manual min() needed.
```

### Timeout Configuration

Centralizing timeout configuration prevents the most common timeout-related production issue: hard-coded durations scattered across dozens of files, each tuned independently, with no guarantee they sum to less than the user SLA. When you need to adjust latency budgets, after a dependency migration or a traffic pattern change, you should change one file, not twenty.

```go
package config

import (
    "fmt"
    "os"
    "strconv"
    "time"
)

// TimeoutConfig holds all timeout budgets for the service.
// Values are loaded from environment variables, with safe defaults.
type TimeoutConfig struct {
    // UserSLA is the total time budget per request (matches external SLO).
    UserSLA time.Duration

    // Per-operation maximums. Each must be < UserSLA.
    CacheLookup        time.Duration
    InventoryService   time.Duration
    PricingService     time.Duration
    ReviewsService     time.Duration
    DBQuery            time.Duration
    SearchService      time.Duration

    // MinViableBudget: operations with less remaining budget than this are skipped.
    MinViableBudget time.Duration
}

// DefaultTimeoutConfig returns safe production defaults.
func DefaultTimeoutConfig() TimeoutConfig {
    return TimeoutConfig{
        UserSLA:          parseDuration("TIMEOUT_USER_SLA", 2*time.Second),
        CacheLookup:      parseDuration("TIMEOUT_CACHE", 50*time.Millisecond),
        InventoryService: parseDuration("TIMEOUT_INVENTORY", 300*time.Millisecond),
        PricingService:   parseDuration("TIMEOUT_PRICING", 400*time.Millisecond),
        ReviewsService:   parseDuration("TIMEOUT_REVIEWS", 500*time.Millisecond),
        DBQuery:          parseDuration("TIMEOUT_DB_QUERY", 200*time.Millisecond),
        SearchService:    parseDuration("TIMEOUT_SEARCH", 600*time.Millisecond),
        MinViableBudget:  parseDuration("TIMEOUT_MIN_VIABLE", 20*time.Millisecond),
    }
}

func parseDuration(envKey string, defaultVal time.Duration) time.Duration {
    raw := os.Getenv(envKey)
    if raw == "" {
        return defaultVal
    }
    // Support millisecond integer values for simplicity.
    if ms, err := strconv.Atoi(raw); err == nil {
        return time.Duration(ms) * time.Millisecond
    }
    if d, err := time.ParseDuration(raw); err == nil {
        return d
    }
    return defaultVal
}

// Validate ensures all per-operation timeouts are sane relative to the user SLA.
func (c TimeoutConfig) Validate() error {
    if c.UserSLA <= 0 {
        return fmt.Errorf("UserSLA must be positive")
    }
    checks := map[string]time.Duration{
        "CacheLookup":      c.CacheLookup,
        "InventoryService": c.InventoryService,
        "PricingService":   c.PricingService,
        "ReviewsService":   c.ReviewsService,
        "DBQuery":          c.DBQuery,
    }
    for name, d := range checks {
        if d <= 0 {
            return fmt.Errorf("%s timeout must be positive, got %s", name, d)
        }
        if d >= c.UserSLA {
            return fmt.Errorf("%s timeout (%s) must be < UserSLA (%s)", name, d, c.UserSLA)
        }
    }

    // Checking each timeout individually is not enough, and this is the check
    // teams forget. Five 400ms calls are each under a 2s SLA while summing to
    // 2s on their own. Validate the sequential critical path, which is every
    // required call the handler makes back to back.
    criticalPath := c.CacheLookup + c.InventoryService + c.PricingService + c.ReviewsService
    if criticalPath >= c.UserSLA {
        return fmt.Errorf(
            "sequential critical path (%s) must be < UserSLA (%s): "+
                "the budget is unsatisfiable if every call uses its full allocation",
            criticalPath, c.UserSLA,
        )
    }

    return nil
}
```

### Detecting Timeout Cascades

A timeout cascade occurs when multiple downstream services all start timing out simultaneously. This diagnostic pattern tells you whether the problem is upstream (your service is slow) or downstream (all dependencies are slow).

```go
package diagnostics

import (
    "context"
    "errors"
)

// TimeoutPattern classifies a pattern of timeouts across operations.
type TimeoutPattern int

const (
    PatternNone     TimeoutPattern = iota // No timeouts.
    PatternIsolated                       // One or two specific operations timed out.
    PatternCascade                        // Most operations timed out, so suspect upstream.
)

// ClassifyTimeouts analyzes a set of operation results and identifies
// whether timeouts indicate a cascade (upstream problem) vs isolated failure.
func ClassifyTimeouts(results map[string]error) TimeoutPattern {
    var total, timedOut int
    for _, err := range results {
        total++
        if isTimeout(err) {
            timedOut++
        }
    }

    if timedOut == 0 {
        return PatternNone
    }

    // If >50% of operations timed out, it's a cascade pattern.
    if float64(timedOut)/float64(total) > 0.5 {
        return PatternCascade
    }

    return PatternIsolated
}

func isTimeout(err error) bool {
    if err == nil {
        return false
    }

    // errors.As, not a bare type assertion. Real clients wrap:
    // fmt.Errorf("dial inventory: %w", netErr). A direct
    // err.(interface{ Timeout() bool }) fails on every wrapped error, so
    // timeouts would be counted as zero and PatternCascade would never fire,
    // which silently defeats the whole point of this detector.
    var timeouter interface{ Timeout() bool }
    if errors.As(err, &timeouter) && timeouter.Timeout() {
        return true
    }

    return errors.Is(err, context.DeadlineExceeded)
}
```

### Full Example: Request Handler with Budget Tracker

This handler ties together every concept from the section: a hard outer deadline set by `context.WithTimeout` enforces the user SLA, while `TimeoutBudget` allocates portions of that deadline to each downstream call. Required services (inventory, pricing) abort the request immediately if the budget is too low to run them, while optional services (reviews) are skipped gracefully and reported in the `X-Degraded-Features` header. The `tb.Summary()` call at the end logs a per-operation breakdown, essential for diagnosing which dependency is eating the budget in production.

```go
package handler

import (
    "context"
    "encoding/json"
    "errors"
    "log/slog"
    "math"
    "net/http"
    "strings"
    "time"

    "your/module/budget"
    "your/module/config"
)

type ProductHandler struct {
    cfg    config.TimeoutConfig
    logger *slog.Logger

    inventorySvc InventoryService
    pricingSvc   PricingService
    reviewsSvc   ReviewsService
}

type PageResponse struct {
    ProductID  string   `json:"product_id"`
    InStock    bool     `json:"in_stock"`
    PriceCents int64    `json:"price_cents"` // integer minor units, never float64
    Reviews    []Review `json:"reviews,omitempty"`
    Degraded   []string `json:"degraded,omitempty"`
}

func (h *ProductHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    // Create a request-level context with the user SLA as the hard outer deadline.
    ctx, cancel := context.WithTimeout(r.Context(), h.cfg.UserSLA)
    defer cancel()

    // Create a budget tracker for telemetry and per-operation enforcement.
    tb := budget.NewTimeoutBudget(h.cfg.UserSLA)
    productID := r.PathValue("id")
    resp := &PageResponse{ProductID: productID}
    var degraded []string

    // ── Step 1: Cache lookup (optional acceleration, non-critical)
    cacheCtx, cacheCancel, err := tb.WithTimeout(ctx, "cache", h.cfg.CacheLookup, 10*time.Millisecond)
    if err == nil {
        start := time.Now()
        // cacheErr must NOT shadow err. Writing this as
        // `if cached, err := h.fetchFromCache(...); err == nil` scopes the
        // inner err to the if statement, so the tb.Record below would read
        // the outer err, which is nil on this branch by construction. Every
        // cache timeout would then be recorded as "not a timeout".
        cached, cacheErr := h.fetchFromCache(cacheCtx, productID)
        tb.Record("cache", time.Since(start), errors.Is(cacheErr, context.DeadlineExceeded))
        if cacheErr == nil {
            cacheCancel()
            h.writeJSON(w, cached)
            return
        }
    }
    cacheCancel()

    // ── Step 2: Inventory (required)
    invCtx, invCancel, err := tb.WithTimeout(ctx, "inventory", h.cfg.InventoryService, h.cfg.MinViableBudget)
    if err != nil {
        h.logger.ErrorContext(ctx, "insufficient budget for inventory", "budget_summary", tb.Summary())
        http.Error(w, "Request deadline exceeded", http.StatusGatewayTimeout)
        return
    }
    start := time.Now()
    inStock, err := h.inventorySvc.IsInStock(invCtx, productID)
    invCancel()
    tb.Record("inventory", time.Since(start), errors.Is(err, context.DeadlineExceeded))
    if err != nil {
        h.logger.ErrorContext(ctx, "inventory service failed", "error", err)
        http.Error(w, "Internal error", http.StatusInternalServerError)
        return
    }
    resp.InStock = inStock

    // ── Step 3: Pricing (required)
    priceCtx, priceCancel, err := tb.WithTimeout(ctx, "pricing", h.cfg.PricingService, h.cfg.MinViableBudget)
    if err != nil {
        h.logger.ErrorContext(ctx, "insufficient budget for pricing", "budget_summary", tb.Summary())
        http.Error(w, "Request deadline exceeded", http.StatusGatewayTimeout)
        return
    }
    start = time.Now()
    price, err := h.pricingSvc.GetPrice(priceCtx, productID)
    priceCancel()
    tb.Record("pricing", time.Since(start), errors.Is(err, context.DeadlineExceeded))
    if err != nil {
        h.logger.ErrorContext(ctx, "pricing service failed", "error", err)
        http.Error(w, "Internal error", http.StatusInternalServerError)
        return
    }
    // Convert at the boundary: the wire format carries integer cents, so a
    // float price from the pricing service never leaks into the response.
    resp.PriceCents = int64(math.Round(price * 100))

    // ── Step 4: Reviews (optional, so degrade gracefully)
    reviewCtx, reviewCancel, err := tb.WithTimeout(ctx, "reviews", h.cfg.ReviewsService, h.cfg.MinViableBudget)
    if err != nil {
        // Budget exhausted. Skip reviews rather than wait.
        h.logger.WarnContext(ctx, "skipping reviews: insufficient budget", "budget_summary", tb.Summary())
        degraded = append(degraded, "reviews")
    } else {
        start = time.Now()
        reviews, err := h.reviewsSvc.GetReviews(reviewCtx, productID)
        reviewCancel()
        timedOut := errors.Is(err, context.DeadlineExceeded)
        tb.Record("reviews", time.Since(start), timedOut)
        if err != nil {
            h.logger.WarnContext(ctx, "reviews failed, degrading", "error", err)
            degraded = append(degraded, "reviews")
        } else {
            resp.Reviews = reviews
        }
    }

    if len(degraded) > 0 {
        resp.Degraded = degraded
        w.Header().Set("X-Degraded-Features", strings.Join(degraded, ","))
    }

    h.logger.InfoContext(ctx, "request completed", "budget_summary", tb.Summary())
    h.writeJSON(w, resp)
}

func (h *ProductHandler) writeJSON(w http.ResponseWriter, v any) {
    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(v)
}
```

### Staff Lens: End-to-End Deadline Enforcement

Every service in a chain must respect the incoming deadline and propagate reduced deadlines to downstreams. Without this, slow services burn capacity on work no one is waiting for. This is an org-wide discipline, not a per-service decision.

---
