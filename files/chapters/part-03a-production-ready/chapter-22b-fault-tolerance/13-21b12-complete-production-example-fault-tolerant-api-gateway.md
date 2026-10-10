## 22B.12 Complete Production Example: Fault-Tolerant API Gateway

This example assembles every pattern from the chapter into a single cohesive gateway: priority-based load shedding at the entry point, a shared timeout budget propagated through all downstream calls, per-resource bulkheads for database and auth, fan-out with partial result support for non-critical enrichment, and a local JWT fallback when the auth service is unavailable. Each layer degrades independently, so a single dependency failure cannot cascade into a total outage.

```go
// FaultTolerantGateway wires all patterns from this chapter together.
type FaultTolerantGateway struct {
    dbBulkhead      *BulkheadWithMetrics
    authBulkhead    *BulkheadWithMetrics
    cacheBulkhead   *BulkheadWithMetrics
    paymentBulkhead *BulkheadWithMetrics
    shedder         *PriorityLoadShedder
    idempotentRetry RetryPolicy
    logger          *slog.Logger
    metrics         MetricsRecorder
}

func NewFaultTolerantGateway(reg prometheus.Registerer) (*FaultTolerantGateway, error) {
    mk := func(name string, n int) (*BulkheadWithMetrics, error) {
        return NewBulkhead(BulkheadConfig{Name: name, MaxConcurrent: n}, reg)
    }

    var g FaultTolerantGateway
    var err error

    if g.dbBulkhead, err = mk("database", 150); err != nil {
        return nil, err
    }
    if g.authBulkhead, err = mk("auth", 50); err != nil {
        return nil, err
    }
    if g.cacheBulkhead, err = mk("cache", 200); err != nil {
        return nil, err
    }
    if g.paymentBulkhead, err = mk("payment", 30); err != nil {
        return nil, err
    }

    g.shedder = NewPriorityLoadShedder(1000, reg)
    g.idempotentRetry = RetryPolicy{
        MaxAttempts:    3,
        Strategy:       StrategyFullJitter,
        Base:           100 * time.Millisecond,
        Cap:            2 * time.Second,
        MaxRetryBudget: 1500 * time.Millisecond,
        ShouldRetry:    RetryOnTransient,
    }

    return &g, nil
}

func (g *FaultTolerantGateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    // 1. Load shedding. Reject before spending any resources.
    p := priorityFromRequest(r)
    if !g.shedder.Admit(p) {
        w.Header().Set("Retry-After", "5")
        w.Header().Set("Content-Type", "application/json")
        w.WriteHeader(http.StatusServiceUnavailable)
        w.Write([]byte(`{"error":"overloaded"}`))
        return
    }
    // Release only what Admit actually acquired. Health checks bypass the
    // limiter without incrementing, so an unconditional defer would drive
    // inFlight negative and silently disable shedding. See section 22B.8.
    if p != PriorityHealth {
        defer g.shedder.Done()
    }

    // 2. Request-scoped timeout budget (2s total).
    budget := NewTimeoutBudget(2 * time.Second)

    // 3. Auth with bulkhead and a local JWT fallback.
    authCtx, cancel, err := budget.WithTimeout(r.Context(), "auth", 100*time.Millisecond, 10*time.Millisecond)
    if err != nil {
        writeJSONError(w, http.StatusGatewayTimeout, "deadline exceeded")
        return
    }
    user, err := g.authenticateWithFallback(authCtx, r)
    cancel()
    if err != nil {
        writeJSONError(w, http.StatusUnauthorized, "unauthorized")
        return
    }

    // 4. Fan-out data fetching with partial result support.
    dataCtx, cancel2, err := budget.WithTimeout(r.Context(), "data", 600*time.Millisecond, 20*time.Millisecond)
    if err != nil {
        writeJSONError(w, http.StatusGatewayTimeout, "deadline exceeded")
        return
    }
    result, missing := g.fetchPartial(dataCtx, user)
    cancel2()

    // A required source failing is NOT a partial response. Returning 200 with
    // an X-Partial-Response header here would hand the client a profile-less
    // profile page and call it success. Section 22B.5's rule applies: if a
    // required call failed, fail the request.
    if missing.RequiredFailed {
        writeJSONError(w, http.StatusServiceUnavailable, "core data unavailable")
        return
    }

    // 5. Optional enrichment (best-effort, non-critical).
    enrichCtx, cancel3, err := budget.WithTimeout(r.Context(), "enrich", 200*time.Millisecond, 10*time.Millisecond)
    if err == nil {
        // Best-effort does not mean unobserved. An error that is never logged
        // or counted is an outage nobody notices, and this chapter's own rule
        // is that there are no silent errors.
        if err := g.tryEnrich(enrichCtx, result); err != nil {
            g.logger.WarnContext(r.Context(), "enrichment failed, continuing degraded",
                "error", err)
            g.metrics.IncrCounter("gateway.enrichment_failed", 1)
            missing.Degraded = append(missing.Degraded, "enrichment")
        }
        cancel3()
    } else {
        cancel3()
        missing.Degraded = append(missing.Degraded, "enrichment")
    }

    if len(missing.Degraded) > 0 {
        w.Header().Set("X-Partial-Response", "true")
        w.Header().Set("X-Degraded-Features", strings.Join(missing.Degraded, ","))
    }
    writeJSON(w, http.StatusOK, result)
}

func (g *FaultTolerantGateway) authenticateWithFallback(ctx context.Context, r *http.Request) (*User, error) {
    var user *User
    err := g.authBulkhead.Execute(ctx, func(ctx context.Context) error {
        var e error
        user, e = callAuthService(ctx, r)
        return e
    })
    if err == nil {
        return user, nil
    }

    // Fall back ONLY when the auth service could not answer. This distinction
    // is the whole security of the pattern.
    //
    // Falling back on any error means that when the auth service answers
    // "this token is invalid", the gateway hears an error, shrugs, and asks
    // the local validator for a second opinion. Every deliberate rejection
    // (revoked token, disabled account, token issued for another audience)
    // gets a retry against a check that cannot know any of those things. That
    // is not a fallback, it is an authentication bypass with a retry loop.
    if !errors.Is(err, ErrBulkheadFull) &&
        !errors.Is(err, context.DeadlineExceeded) &&
        !errors.Is(err, ErrAuthServiceUnavailable) {
        return nil, err // The service spoke and said no. Honour that.
    }

    g.metrics.IncrCounter("gateway.auth_fallback_local", 1)
    g.logger.WarnContext(ctx, "auth service unavailable, validating JWT locally",
        "error", err)

    // Local validation checks the signature and expiry only. It cannot see
    // revocations, so keep the fallback window short and never let it
    // authorize privileged operations.
    return validateJWTLocally(r)
}

// Outcome separates "a required source failed", which must fail the request,
// from "an optional source failed", which merely degrades it. A single bool
// cannot express that difference, and collapsing the two is how a 200 ends up
// carrying a profile page with no profile in it.
type Outcome struct {
    RequiredFailed bool
    Degraded       []string
}

func (g *FaultTolerantGateway) fetchPartial(ctx context.Context, user *User) (*Response, Outcome) {
    type item struct {
        key      string
        required bool
        data     any
        err      error
    }
    ch := make(chan item, 3)

    // Profile from the DB: REQUIRED.
    go func() {
        var d any
        err := g.dbBulkhead.Execute(ctx, func(ctx context.Context) error {
            var e error
            d, e = fetchFromDB(ctx, user.ID)
            return e
        })
        ch <- item{key: "profile", required: true, data: d, err: err}
    }()

    // Preferences from cache: optional.
    go func() {
        var d any
        err := g.cacheBulkhead.Execute(ctx, func(ctx context.Context) error {
            var e error
            d, e = fetchFromCache(ctx, user.ID)
            return e
        })
        ch <- item{key: "preferences", required: false, data: d, err: err}
    }()

    // Static data: always available, no network call.
    go func() { ch <- item{key: "static", data: fetchStatic(user.ID)} }()

    resp := &Response{}
    var out Outcome

    for i := 0; i < 3; i++ {
        it := <-ch
        if it.err != nil {
            if it.required {
                out.RequiredFailed = true
            } else {
                out.Degraded = append(out.Degraded, it.key)
            }
            g.logger.WarnContext(ctx, "fan-out source failed",
                "source", it.key, "required", it.required, "error", it.err)
            continue
        }
        resp.Set(it.key, it.data)
    }
    return resp, out
}
```

### Staff Lens: API Gateway as Fault Boundary

The gateway is where external requests meet internal services. It is also where fault tolerance patterns have the most leverage: rate limit, circuit break, fallback, shed load. Investing heavily in gateway resilience protects every downstream service.

---
