## 22.4 Bulkhead Pattern

Named after the watertight compartments in ship hulls, the bulkhead pattern isolates resource pools so that a failure in one dependency cannot drain resources needed by others. Without bulkheads, a slow database can exhaust all available goroutines and block unrelated requests that never touch the database.

### Semaphore-Based Bulkhead

A semaphore implemented as a buffered channel limits the number of concurrent operations against a given resource. When the semaphore is full, new callers either wait for capacity (`Acquire`) or are rejected immediately (`TryAcquire`), giving callers control over their own waiting behavior.

Note that `fn` takes a `context.Context`. That is not decoration. It is the difference between a working bulkhead and a wedged one, for the reason spelled out below.

```go
var ErrBulkheadFull = errors.New("bulkhead at capacity: request rejected")

type Bulkhead struct {
    sem chan struct{}
}

func NewBulkhead(maxConcurrent int) *Bulkhead {
    return &Bulkhead{
        sem: make(chan struct{}, maxConcurrent),
    }
}

// Acquire waits for a slot, bounded by ctx, then runs fn.
// The ctx bounds BOTH the wait and (if fn respects it) the call.
func (b *Bulkhead) Acquire(ctx context.Context, fn func(context.Context) error) error {
    select {
    case b.sem <- struct{}{}:
        defer func() { <-b.sem }()
        return fn(ctx)
    case <-ctx.Done():
        return ctx.Err()
    }
}

// TryAcquire runs fn only if a slot is free right now, and reports
// ErrBulkheadFull otherwise. It never returns a nil error for work it
// did not do.
func (b *Bulkhead) TryAcquire(ctx context.Context, fn func(context.Context) error) error {
    select {
    case b.sem <- struct{}{}:
        defer func() { <-b.sem }()
        return fn(ctx)
    default:
        return ErrBulkheadFull
    }
}
```

**Never report rejection as `(false, nil)`.** The tempting signature is `TryExecute(fn) (bool, error)`, returning `false, nil` when the bulkhead is full. It hands every caller a loaded gun: the overwhelmingly common Go reflex is `if err != nil { return err }`, and under that reflex a rejected request looks exactly like a successful one. The caller sails on with a zero-valued result and no indication that the work never happened. Silent success on the shed path is worse than the overload the bulkhead was protecting against, because now the overload is invisible *and* corrupting data. Return an error, and let callers who genuinely want the boolean use `errors.Is(err, ErrBulkheadFull)`.

### A Bulkhead Without a Timeout Is a Deadlock Waiting to Happen

Here is the failure that makes the `fn(ctx)` signature non-negotiable. The bulkhead's context bounds how long a caller waits **for a slot**. It does nothing about how long the call **holds** one. If `fn` ignores its context and the dependency hangs, the slot is occupied forever.

Fill a bulkhead of size 3 with three hung calls that ignore their context, then send 20 healthy requests, each patient enough to wait 300ms for a slot:

```
bulkhead size 3, all 3 slots held by hung calls that ignore ctx
healthy requests completed:                     0 / 20
healthy requests timed out waiting for a slot: 20 / 20
```

Zero got through. Not degraded, wedged. The bulkhead did exactly what it promised (it capped concurrency at 3) and in doing so it converted "one slow dependency" into "this dependency is now permanently unreachable, including for the requests that would have succeeded". Worse, it is self-concealing: the rejection metric fires, which looks like the bulkhead is *working*.

A bulkhead only isolates failures if slots are guaranteed to come back. Guaranteed means a timeout on the call itself, not on the queue:

```go
func (s *ServiceBulkheads) QueryDatabase(ctx context.Context, query string) (Result, error) {
    var result Result
    err := s.database.Acquire(ctx, func(ctx context.Context) error {
        // Per-call deadline: this slot WILL be released within 2s, no matter
        // what the database does.
        ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
        defer cancel()

        var err error
        result, err = db.QueryContext(ctx, query) // context-aware, always
        return err
    })
    return result, err
}
```

With that per-call deadline in place, the same test flips completely: all **20 of 20** healthy requests succeed, because the three hung calls now surrender their slots after 2 seconds instead of holding them until the heat death of the process.

The rule: **every bulkhead needs a timeout inside it, and the timeout must be enforced by the callee.** `db.Query(query)` (no context) inside a bulkhead is a bug even though it compiles and passes every test you will write for it. The bulkhead bounds concurrency, the timeout bounds duration, and Little's Law says you need both to bound anything at all: a limit on `L` means nothing if `W` is unbounded.

### Service-Level Bulkheads

Assigning an independent bulkhead to each downstream dependency (database, external API, cache) ensures that saturation of one resource does not consume the concurrency budget for the others. Without this isolation, a slow database exhausts every goroutine and starves cache lookups that would have responded in a millisecond.

```go
type ServiceBulkheads struct {
    database    *Bulkhead
    externalAPI *Bulkhead
    cache       *Bulkhead
}

func NewServiceBulkheads() *ServiceBulkheads {
    return &ServiceBulkheads{
        database:    NewBulkhead(50),  // Max 50 concurrent DB calls
        externalAPI: NewBulkhead(20),  // Max 20 concurrent API calls
        cache:       NewBulkhead(100), // Max 100 concurrent cache calls
    }
}
```

The separate limits are the whole point: they are separate *budgets*. Twenty hung external-API calls consume the API bulkhead and nothing else, so cache lookups and database queries continue at full speed. A single shared pool would let the slowest dependency in the service set the availability of every other one.

### Bulkhead Sizing Formula

Sizing a bulkhead incorrectly renders it useless. Too large and it never engages, so it provides no protection. Too small and it rejects legitimate traffic. The starting point is Little's Law, which relates concurrency to throughput and time in the system:

```
Little's Law:  L = λ × W
  L = average concurrency (what the bulkhead limits)
  λ = arrival rate (requests per second)
  W = average time in system (seconds)

Sizing with headroom:
  Concurrent limit = (Target RPS × latency in seconds) × safety factor

Example:
  Target RPS for DB calls: 500 req/s
  DB latency:              200ms (0.2s)
  Safety factor:           1.5 (50% headroom)

  Limit = 500 × 0.2 × 1.5 = 150 concurrent DB calls
```

**Be honest about which latency you put in.** Little's Law is stated in terms of the **mean**, not a tail percentile. Feeding it P99 does not compute average concurrency, it computes the concurrency you would need if every request were as slow as your worst 1%. That is a deliberately pessimistic number, which is a defensible thing to want from a *safety* limit, but you should know that is what you are doing and not stack a second fudge factor on top of it without thinking.

The two choices give very different bulkheads. With a mean of 50ms, `500 × 0.05 = 25` concurrent. With a P99 of 200ms, `500 × 0.2 = 100`. Multiply the P99 figure by another 1.5 and you get 150, a limit six times the true average concurrency. A bulkhead that only engages at 6x normal load is not protecting you from a dependency that slows down by 3x, which is the most common way dependencies actually fail.

A workable discipline:

- Use the **mean** latency in the formula and put your headroom in the explicit safety factor, where it is visible and reviewable.
- Size the limit to the concurrency the **dependency** can actually serve, not the concurrency your service would like to send. A bulkhead is there to protect the downstream and to bound your own resource use, and neither goal cares what your target RPS is.
- Then verify empirically. Load-test until the dependency degrades, observe the concurrency at which it does, and set the limit below that. The formula gives you a starting guess to test, not an answer.

Instrumented bulkheads track total requests, rejections, in-flight count, and latency through Prometheus metrics. This makes it possible to detect when a bulkhead is consistently at capacity and needs resizing, or when an upstream dependency has degraded enough to trigger sustained rejections:

```go
// BulkheadWithMetrics adds Prometheus metrics to rejection tracking
type BulkheadWithMetrics struct {
    sem         chan struct{}
    name        string
    total       prometheus.Counter
    rejected    prometheus.Counter
    inFlight    prometheus.Gauge
    latency     prometheus.Histogram
}

func NewBulkheadWithMetrics(name string, maxConcurrent int, reg prometheus.Registerer) *BulkheadWithMetrics {
    b := &BulkheadWithMetrics{
        sem:  make(chan struct{}, maxConcurrent),
        name: name,
        total: prometheus.NewCounter(prometheus.CounterOpts{
            Name:        "bulkhead_requests_total",
            Help:        "Total requests through bulkhead",
            ConstLabels: prometheus.Labels{"bulkhead": name},
        }),
        rejected: prometheus.NewCounter(prometheus.CounterOpts{
            Name:        "bulkhead_rejected_total",
            Help:        "Requests rejected by bulkhead (at capacity)",
            ConstLabels: prometheus.Labels{"bulkhead": name},
        }),
        inFlight: prometheus.NewGauge(prometheus.GaugeOpts{
            Name:        "bulkhead_in_flight",
            Help:        "Current in-flight requests",
            ConstLabels: prometheus.Labels{"bulkhead": name},
        }),
        latency: prometheus.NewHistogram(prometheus.HistogramOpts{
            Name:        "bulkhead_latency_seconds",
            Help:        "Latency of requests through bulkhead",
            ConstLabels: prometheus.Labels{"bulkhead": name},
            Buckets:     prometheus.DefBuckets,
        }),
    }
    if reg != nil {
        reg.MustRegister(b.total, b.rejected, b.inFlight, b.latency)
    }
    return b
}

// TryAcquire mirrors Bulkhead.TryAcquire: shed immediately when full.
// Named to match, because a method called Execute that blocks in one type
// and sheds in another is a trap for whoever swaps them.
func (b *BulkheadWithMetrics) TryAcquire(ctx context.Context, fn func(context.Context) error) error {
    b.total.Inc()

    select {
    case b.sem <- struct{}{}:
        // acquired
    default:
        // At capacity: reject immediately
        b.rejected.Inc()
        return ErrBulkheadFull
    }

    b.inFlight.Inc()
    start := time.Now()
    defer func() {
        <-b.sem
        b.inFlight.Dec()
        b.latency.Observe(time.Since(start).Seconds())
    }()

    return fn(ctx)
}
```

Two notes on the instrumentation. The `defer` releases the semaphore **before** decrementing the gauge and observing the latency, which is the right order: freeing capacity is the urgent part, and the metrics bookkeeping should never sit between a finished call and the next caller's slot. And `latency` here measures only the time holding the slot, not the time spent queueing for it. If you use the blocking `Acquire`, add a separate `wait_seconds` histogram, because queue time is invisible to callers' own timers and is usually the first thing to degrade.

### Alert: Bulkhead Rejection Rate

If your bulkhead rejection rate exceeds 1-2%, the upstream dependency is overloaded or your limit is too small. Set this alert:

```yaml
# Prometheus alert rule
- alert: BulkheadHighRejectionRate
  expr: |
    rate(bulkhead_rejected_total[5m]) /
    rate(bulkhead_requests_total[5m]) > 0.02
  for: 2m
  labels:
    severity: warning
  annotations:
    summary: "Bulkhead {{ $labels.bulkhead }} rejecting >2% of requests"
    description: "Check if upstream is overloaded or bulkhead limit needs adjustment"
```

### Staff Lens: Bulkheads Protect Critical Paths

Bulkheads separate resource pools so one dependency's exhaustion does not starve others. Critical paths (payment processing) should have their own bulkhead, separate from non-critical paths (analytics). Sizing is per-path based on latency budget and load.

Use `golang.org/x/sync/semaphore` for the canonical implementation.

---
