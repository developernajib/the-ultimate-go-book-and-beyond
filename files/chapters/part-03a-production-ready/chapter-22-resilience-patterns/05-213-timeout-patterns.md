## 22.3 Timeout Patterns

### Context Timeout

Wrapping a call in a child context with a shorter timeout is the standard Go approach to bounding operation duration. The goroutine executing `doWork` checks `ctx.Done()` internally, allowing it to abort early rather than completing work that will be discarded when the parent times out.

The buffer of 1 on `done` is not incidental. On the timeout path `callWithTimeout` returns immediately and nobody ever receives from `done`, so an unbuffered channel would block that goroutine on its send **forever**, leaking it and everything it references on every single timeout. Drive 50 timeouts through both versions and count: the unbuffered one leaks **50 goroutines permanently**, the buffered one leaks **zero**. It is a one-character bug that scales linearly with your error rate, which means it stays invisible until the day a dependency gets slow.

Note what this bounds and what it does not. It bounds how long the *caller* waits. It does not stop `doWork` from running: if `doWork` ignores its context, the goroutine keeps working (holding a connection, a transaction, memory) long after the result has been discarded. Under a timeout storm that background work is exactly what tips the process over. A timeout on the caller is a promise about latency, not about resource usage, and only a context-respecting callee gives you both.

```go
func callWithTimeout(ctx context.Context, timeout time.Duration) error {
    ctx, cancel := context.WithTimeout(ctx, timeout)
    defer cancel()

    done := make(chan error, 1)
    go func() {
        done <- doWork(ctx)
    }()

    select {
    case err := <-done:
        return err
    case <-ctx.Done():
        return ctx.Err()
    }
}
```

### Layered Timeouts

Each layer of the call stack should impose its own timeout that is smaller than the parent's remaining budget. This ensures that a slow database query cannot consume time that was allocated to the subsequent external API call, while the overall request context ensures the total operation never exceeds the user-facing SLA.

```go
func handler(w http.ResponseWriter, r *http.Request) {
    // Overall request timeout: 30s
    ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
    defer cancel()

    // Database query: 5s
    dbCtx, dbCancel := context.WithTimeout(ctx, 5*time.Second)
    defer dbCancel()
    user, err := db.GetUser(dbCtx, userID)
    if err != nil {
        // Must return. Falling through leaves `user` nil, and the very next
        // line dereferences it.
        http.Error(w, "user lookup failed", http.StatusBadGateway)
        return
    }

    // External API: 10s
    apiCtx, apiCancel := context.WithTimeout(ctx, 10*time.Second)
    defer apiCancel()
    data, err := api.FetchData(apiCtx, user.ID)
    if err != nil {
        http.Error(w, "upstream failed", http.StatusBadGateway)
        return
    }

    // Processing uses remaining time from parent context
    result := process(ctx, user, data)
    writeJSON(w, result)
}
```

The sub-timeouts here are **fixed** (5s and 10s), not derived from what is actually left. `5 + 10 = 15` fits inside 30, so the arithmetic works on paper. But it only works because someone did that sum by hand, and it stops working the moment a third call is added or the caller arrives with a context that already has 3 seconds left on it rather than 30. `context.WithTimeout(ctx, 5*time.Second)` is a *ceiling*, not a reservation: it never extends a parent that expires sooner, and it never notices that the previous step already burned the budget. The next pattern fixes that properly.

### Timeout with Cleanup

When a context times out it is already in the canceled state, so any cleanup that uses it fails instantly. This is the same trap as deriving a shutdown deadline from an already-canceled signal context: the cleanup you carefully wrote never runs, and it fails in the exact circumstance it existed for. Cleanup must therefore root its context at `context.Background()`, with its own bounded timeout so a hung release cannot wedge the caller forever.

```go
func operationWithCleanup(ctx context.Context) error {
    ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
    defer cancel()

    resource, err := acquireResource(ctx)
    if err != nil {
        return err
    }

    // Cleanup should use fresh context, not canceled one
    defer func() {
        cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 5*time.Second)
        defer cleanupCancel()
        releaseResource(cleanupCtx, resource)
    }()

    return useResource(ctx, resource)
}
```

### Timeout Budget Pattern

The timeout budget pattern ensures that time spent in one operation reduces the available budget for subsequent operations, which is what stops the total request time from ballooning.

```go
// TimeoutBudget tracks remaining time across multiple operations
type TimeoutBudget struct {
    deadline time.Time
}

func NewTimeoutBudget(total time.Duration) *TimeoutBudget {
    return &TimeoutBudget{deadline: time.Now().Add(total)}
}

func (b *TimeoutBudget) Remaining() time.Duration {
    return time.Until(b.deadline)
}

func (b *TimeoutBudget) WithTimeout(ctx context.Context, max time.Duration) (context.Context, context.CancelFunc) {
    remaining := b.Remaining()
    if remaining <= 0 {
        ctx, cancel := context.WithCancel(ctx)
        cancel() // already expired
        return ctx, cancel
    }
    // Use whichever is smaller: budget remaining or max for this operation
    timeout := remaining
    if max < timeout {
        timeout = max
    }
    return context.WithTimeout(ctx, timeout)
}

// Usage: request handler with total 2s budget
func handleRequest(r *http.Request) error {
    budget := NewTimeoutBudget(2 * time.Second)

    // Cache lookup: max 50ms, but uses budget
    cacheCtx, cancel := budget.WithTimeout(r.Context(), 50*time.Millisecond)
    defer cancel()
    cached, err := cache.Get(cacheCtx, "key")
    if err == nil {
        return respond(cached)
    }

    // DB query: max 500ms, but remaining budget may be less
    dbCtx, cancel2 := budget.WithTimeout(r.Context(), 500*time.Millisecond)
    defer cancel2()
    data, err := db.Query(dbCtx, "SELECT ...")
    if err != nil {
        return err
    }

    // External API: max 800ms from whatever is left
    apiCtx, cancel3 := budget.WithTimeout(r.Context(), 800*time.Millisecond)
    defer cancel3()
    enriched, err := externalAPI.Enrich(apiCtx, data)
    if err != nil {
        // Degrade gracefully: return unenriched data
        return respond(data)
    }

    return respond(enriched)
}
```

### Timeout Hierarchy Reference

Visualising the timeout budget as a tree makes it immediately apparent when sub-operation limits sum to more than the user-facing SLA, a common misconfiguration that lets latency blow out under partial failures. The buffer (27.5% here) is deliberately reserved for serialization overhead, connection acquisition jitter, and retry attempts. Squeeze it to zero and you guarantee P99 breaches even when every individual operation hits its median.

```
User-Facing SLA: 2000ms
│
├── Auth middleware:         50ms  (2.5% of budget)
├── Cache lookup:            50ms  (2.5% of budget)
├── Primary DB query:       500ms  (25% of budget)
│   └── Index scan:         100ms
│   └── Data fetch:         300ms
│   └── Conn acquire:       100ms
├── External API call:      800ms  (40% of budget)
│   └── DNS resolution:      10ms
│   └── TCP connect:         20ms
│   └── TLS handshake:       30ms
│   └── Request/response:   740ms
└── Response serialization:  50ms  (2.5% of budget)

Buffer / overhead:          550ms  (27.5% of budget)
```

```go
// Centralized timeout config: change in one place
type TimeoutConfig struct {
    Total       time.Duration
    Auth        time.Duration
    Cache       time.Duration
    Database    time.Duration
    ExternalAPI time.Duration
}

var DefaultTimeouts = TimeoutConfig{
    Total:       2 * time.Second,
    Auth:        50 * time.Millisecond,
    Cache:       50 * time.Millisecond,
    Database:    500 * time.Millisecond,
    ExternalAPI: 800 * time.Millisecond,
}
```

### Staff Lens: No External Call Without a Timeout

Every external call (HTTP, RPC, database) must have a timeout. Without one, a hung dependency blocks the caller forever. This is one of the most common production incidents.

Default Go HTTP client has no timeout. Explicitly set one for every service.

### Deadline Propagation

When Service A calls B with budget 500ms, B calls C with budget less than 500ms (accounting for network time). Use `context.WithDeadline` propagated via context (gRPC does this automatically, HTTP requires convention).

---
