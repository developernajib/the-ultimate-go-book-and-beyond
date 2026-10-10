## 22B.6 Fallback Chains

### The Pattern

A fallback chain is an ordered sequence of implementations for the same logical operation, each less authoritative but more reliable than the one before it. When the primary implementation fails, execution falls to the secondary. If the secondary fails, it falls to the tertiary. At the end of the chain sits a static default, the last line of defense that always returns something.

```
FALLBACK CHAIN FOR PRICING

  Request for price
         │
         ▼
  ┌─────────────────┐
  │ PRIMARY: Live   │──► Stripe pricing API (real-time, authoritative)
  │ pricing API     │
  └────────┬────────┘
           │ FAILS (timeout, error, circuit open)
           ▼
  ┌─────────────────┐
  │ SECONDARY:      │──► Redis cache (last known price, < 15min old)
  │ Cached price    │
  └────────┬────────┘
           │ FAILS (cache miss or Redis down)
           ▼
  ┌─────────────────┐
  │ TERTIARY:       │──► Database (last persisted price, may be hours old)
  │ DB price        │
  └────────┬────────┘
           │ FAILS (DB unavailable)
           ▼
  ┌─────────────────┐
  │ DEFAULT:        │──► Static "Price unavailable, please refresh"
  │ Static message  │
  └─────────────────┘
```

### Functional Fallback Chain in Go

The implementation below uses Go generics so a single `FallbackChain[T]` type can serve any return value, a price, a user record, or an auth result, without sacrificing type safety. Handlers are sorted by `Priority` at construction time, and each is given an optional `IsAvailable` predicate that allows skipping a handler before attempting its call, saving latency when a dependency is already known to be down. The `Result` wrapper carries metadata about which handler ultimately succeeded and how many attempts preceded it, letting callers distinguish a clean primary response from a degraded fallback response and propagate that distinction to API clients or upstream metrics.

```go
package fallback

import (
    "context"
    "errors"
    "fmt"
    "log/slog"
    "sort"
    "time"
)

// ErrAllFallbacksFailed is returned when all handlers in a chain fail.
var ErrAllFallbacksFailed = errors.New("fallback: all handlers exhausted")

// Handler is a single link in a fallback chain.
type Handler[T any] struct {
    // Name identifies this handler for logging and metrics.
    Name string

    // Priority is 1 (primary) through N (least preferred).
    Priority int

    // Execute is the function this handler calls.
    Execute func(ctx context.Context) (T, error)

    // IsAvailable optionally checks availability before attempting execution.
    // If nil, always attempted.
    IsAvailable func(ctx context.Context) bool

    // ShouldFallback decides whether a failure from this handler permits
    // trying the next one. If nil, any error falls through.
    //
    // Set this for any operation with side effects. "The call failed" and
    // "the work did not happen" are different statements, and only the second
    // one makes a fallback safe. A timeout from a payment provider does not
    // mean the charge failed: it may have been authorized and the response
    // lost. Falling through on that error charges the customer twice.
    ShouldFallback func(err error) bool
}

// Result wraps a fallback chain result with metadata.
type Result[T any] struct {
    Value       T
    HandlerName string
    HandlerPriority int
    Degraded    bool
    Attempts    []Attempt
}

// Attempt records one execution attempt.
type Attempt struct {
    Handler  string
    Duration time.Duration
    Error    error
}

// FallbackChain executes handlers in priority order, falling back
// to the next handler on failure.
type FallbackChain[T any] struct {
    handlers []Handler[T]
    logger   *slog.Logger
    metrics  MetricsRecorder
}

// NewFallbackChain creates a chain from handlers. Handlers are sorted
// by Priority automatically.
func NewFallbackChain[T any](
    handlers []Handler[T],
    logger *slog.Logger,
    metrics MetricsRecorder,
) *FallbackChain[T] {
    sorted := make([]Handler[T], len(handlers))
    copy(sorted, handlers)
    // Sort by priority ascending (1 = primary, N = last resort).
    sort.Slice(sorted, func(i, j int) bool {
        return sorted[i].Priority < sorted[j].Priority
    })
    return &FallbackChain[T]{
        handlers: sorted,
        logger:   logger,
        metrics:  metrics,
    }
}

// Execute runs the fallback chain, returning the result from the first
// handler that succeeds.
func (fc *FallbackChain[T]) Execute(ctx context.Context) (*Result[T], error) {
    result := &Result[T]{
        Attempts: make([]Attempt, 0, len(fc.handlers)),
    }

    for i, handler := range fc.handlers {
        // Check availability if the handler provides a check.
        if handler.IsAvailable != nil && !handler.IsAvailable(ctx) {
            fc.logger.DebugContext(ctx, "fallback handler unavailable, skipping",
                "handler", handler.Name,
                "priority", handler.Priority,
            )
            continue
        }

        start := time.Now()
        value, err := handler.Execute(ctx)
        elapsed := time.Since(start)

        result.Attempts = append(result.Attempts, Attempt{
            Handler:  handler.Name,
            Duration: elapsed,
            Error:    err,
        })

        if err == nil {
            result.Value = value
            result.HandlerName = handler.Name
            result.HandlerPriority = handler.Priority
            result.Degraded = i > 0 // Degraded if not primary.

            if result.Degraded {
                fc.logger.WarnContext(ctx, "fallback activated",
                    "handler", handler.Name,
                    "priority", handler.Priority,
                    "attempts_before", i,
                )
                fc.metrics.IncrCounter("fallback.activation",
                    "handler", handler.Name,
                    "priority", fmt.Sprintf("%d", handler.Priority),
                )
            }

            return result, nil
        }

        fc.logger.WarnContext(ctx, "fallback handler failed",
            "handler", handler.Name,
            "priority", handler.Priority,
            "error", err,
            "elapsed", elapsed,
        )
        fc.metrics.IncrCounter("fallback.handler_failure", "handler", handler.Name)

        // Some failures forbid trying anything else. Stop the chain rather
        // than risk repeating a side effect that may already have landed.
        if handler.ShouldFallback != nil && !handler.ShouldFallback(err) {
            fc.logger.ErrorContext(ctx, "fallback chain halted: error does not permit failover",
                "handler", handler.Name,
                "error", err,
            )
            fc.metrics.IncrCounter("fallback.halted", "handler", handler.Name)
            return result, fmt.Errorf("fallback halted at %q: %w", handler.Name, err)
        }
    }

    // The result is returned alongside the error so callers keep the Attempts
    // trail. Returning a bare nil here would throw away exactly the telemetry
    // needed to explain why every handler failed.
    return result, fmt.Errorf("%w: tried %d handlers", ErrAllFallbacksFailed, len(result.Attempts))
}
```

### Cache-as-Fallback

Serving stale data is a legitimate and common fallback strategy. A product price from 15 minutes ago is almost certainly still correct. A user's profile from 5 minutes ago is still useful. The key requirement is communicating staleness to the client.

```go
// StaleCache wraps a cache that can return stale data with age metadata.
type StaleCache[T any] struct {
    client CacheClient
    maxAge time.Duration // Maximum acceptable staleness.
}

type CacheEntry[T any] struct {
    Value     T
    CachedAt  time.Time
    Age       time.Duration
    IsStale   bool
}

func (sc *StaleCache[T]) Get(ctx context.Context, key string) (*CacheEntry[T], error) {
    raw, cachedAt, err := sc.client.GetWithTimestamp(ctx, key)
    if err != nil {
        return nil, err
    }

    var value T
    if err := json.Unmarshal(raw, &value); err != nil {
        return nil, fmt.Errorf("cache: unmarshal: %w", err)
    }

    age := time.Since(cachedAt)
    return &CacheEntry[T]{
        Value:    value,
        CachedAt: cachedAt,
        Age:      age,
        IsStale:  age > sc.maxAge,
    }, nil
}
```

### Full Example: Payment Processor with 3 Provider Tiers

Everything so far has fallen back on reads. Prices, profiles, and reviews are safe to re-fetch from somewhere else, because reading twice costs nothing. Payments are where that intuition turns dangerous, and it is worth being blunt about why.

**A fallback chain over an operation with side effects is a double-charge generator unless you constrain it.** Suppose the Stripe call times out. What do you actually know? Only that no response arrived. The charge may have been declined, or it may have been authorized and the acknowledgement lost on the way back. If you treat that timeout like any other error and fall through to PayPal, you charge the customer twice, and you do it precisely during the provider incident when your support queue is already on fire. The naive chain does not "lose money on failure", it silently bills people twice, and it does so most aggressively exactly when things are worst.

So the rule for side-effecting fallbacks is: **fall back only on errors that prove the work did not happen.** A refused connection, a failed health check, and an explicit pre-authorization decline are all proof that no money moved. A timeout, a 500, or a severed connection mid-flight are ambiguous, and ambiguity must halt the chain rather than advance it. That is what the `ShouldFallback` predicate above is for.

Two things make the example below safe. Every charge carries an idempotency key derived from the order, so retrying the *same* provider cannot double-charge. And `ShouldFallback` refuses to advance to a *different* provider on an ambiguous error, because no idempotency key is shared across providers. The chain is three processors deep, with Stripe as the authoritative primary, PayPal as the secondary, and an internal stored-card processor as the last resort, each wrapped in its own sub-context timeout so a slow provider cannot consume the caller's entire deadline. Health checks let the chain skip a provider that is already known to be down, which saves latency during degraded periods and, more importantly, is a safe reason to fail over.

```go
package payment

import (
    "context"
    "errors"
    "fmt"
    "log/slog"
    "time"

    "your/module/fallback"
)

type ChargeRequest struct {
    Amount   int64 // In cents. Never float64 for money.
    Currency string
    CardID   string
    OrderID  string
}

// IdempotencyKey is stable for a given order and provider. Replaying the same
// key against the same provider returns the original charge instead of making
// a second one, which is what makes retrying a timeout safe. Note the key is
// per provider: it buys nothing when failing over to a different one, which is
// the whole reason ShouldFallback has to be conservative.
func (r *ChargeRequest) IdempotencyKey(provider string) string {
    return fmt.Sprintf("%s:%s", provider, r.OrderID)
}

type ChargeResult struct {
    TransactionID string
    Provider      string
    Degraded      bool
}

// ErrProviderUnavailable means the request never reached authorization, so no
// money moved and another provider may safely be tried.
var ErrProviderUnavailable = errors.New("payment: provider unreachable before authorization")

// ErrAmbiguousCharge means the outcome is unknown. The charge may have
// succeeded. Never retry this against a different provider.
var ErrAmbiguousCharge = errors.New("payment: charge outcome unknown")

// safeToFailover reports whether err proves no charge was authorized.
//
// The default is false. When in doubt about someone else's money, stop and
// let a human or a reconciliation job resolve it.
func safeToFailover(err error) bool {
    return errors.Is(err, ErrProviderUnavailable)
}

type PaymentService struct {
    stripe  StripeClient
    paypal  PayPalClient
    stored  StoredCardProcessor
    logger  *slog.Logger
    metrics MetricsRecorder
}

func NewPaymentService(
    stripe StripeClient,
    paypal PayPalClient,
    stored StoredCardProcessor,
    logger *slog.Logger,
    metrics MetricsRecorder,
) *PaymentService {
    return &PaymentService{
        stripe:  stripe,
        paypal:  paypal,
        stored:  stored,
        logger:  logger,
        metrics: metrics,
    }
}

// chainFor builds a chain bound to one specific request.
//
// The chain must be constructed per request, not once in the constructor,
// because every handler needs to close over req. Building it once and hoping
// to smuggle the request in later does not compile, and working around that
// with a shared mutable field would race across concurrent charges.
func (ps *PaymentService) chainFor(req *ChargeRequest) *fallback.FallbackChain[*ChargeResult] {
    handlers := []fallback.Handler[*ChargeResult]{
        {
            Name:     "stripe",
            Priority: 1,
            IsAvailable: func(ctx context.Context) bool {
                return ps.stripe.IsHealthy(ctx)
            },
            ShouldFallback: safeToFailover,
            Execute: func(ctx context.Context) (*ChargeResult, error) {
                // Sub-budget: the primary gets the most time.
                subCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
                defer cancel()

                txID, err := ps.stripe.Charge(subCtx, req, req.IdempotencyKey("stripe"))
                if err != nil {
                    return nil, fmt.Errorf("stripe: %w", classify(err))
                }
                return &ChargeResult{
                    TransactionID: txID,
                    Provider:      "stripe",
                }, nil
            },
        },
        {
            Name:     "paypal",
            Priority: 2,
            IsAvailable: func(ctx context.Context) bool {
                return ps.paypal.IsHealthy(ctx)
            },
            ShouldFallback: safeToFailover,
            Execute: func(ctx context.Context) (*ChargeResult, error) {
                subCtx, cancel := context.WithTimeout(ctx, 4*time.Second)
                defer cancel()

                txID, err := ps.paypal.Charge(subCtx, req, req.IdempotencyKey("paypal"))
                if err != nil {
                    return nil, fmt.Errorf("paypal: %w", classify(err))
                }
                return &ChargeResult{
                    TransactionID: txID,
                    Provider:      "paypal",
                    Degraded:      true,
                }, nil
            },
        },
        {
            Name:     "stored_card",
            Priority: 3,
            Execute: func(ctx context.Context) (*ChargeResult, error) {
                // Internal, most reliable, limited features.
                subCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
                defer cancel()

                txID, err := ps.stored.Charge(subCtx, req, req.IdempotencyKey("stored"))
                if err != nil {
                    return nil, fmt.Errorf("stored_card: %w", classify(err))
                }
                return &ChargeResult{
                    TransactionID: txID,
                    Provider:      "stored_card",
                    Degraded:      true,
                }, nil
            },
        },
    }

    return fallback.NewFallbackChain(handlers, ps.logger, ps.metrics)
}

// classify maps a provider error onto the only distinction that matters here:
// do we know the charge did not happen, or do we not know?
func classify(err error) error {
    var unreachable *ConnectionRefusedError
    if errors.As(err, &unreachable) {
        return fmt.Errorf("%w: %v", ErrProviderUnavailable, err)
    }

    var declined *PreAuthDeclinedError
    if errors.As(err, &declined) {
        // The provider answered and said no before authorizing. Nothing moved.
        return fmt.Errorf("%w: %v", ErrProviderUnavailable, err)
    }

    // Everything else, including every timeout, is ambiguous by default.
    return fmt.Errorf("%w: %v", ErrAmbiguousCharge, err)
}

func (ps *PaymentService) Charge(ctx context.Context, req *ChargeRequest) (*ChargeResult, error) {
    result, err := ps.chainFor(req).Execute(ctx)
    if err != nil {
        // An ambiguous failure is NOT a failed payment. Surface it as
        // needing reconciliation rather than telling the caller the charge
        // did not happen, because it may well have.
        if errors.Is(err, ErrAmbiguousCharge) {
            ps.metrics.IncrCounter("payment.needs_reconciliation", "order", req.OrderID)
            ps.logger.ErrorContext(ctx, "charge outcome unknown, reconciliation required",
                "order_id", req.OrderID,
                "error", err,
            )
            return nil, fmt.Errorf("payment: outcome unknown for order %s, do not retry blindly: %w",
                req.OrderID, err)
        }
        if errors.Is(err, fallback.ErrAllFallbacksFailed) {
            return nil, fmt.Errorf("payment: all processors unavailable: %w", err)
        }
        return nil, err
    }
    return result.Value, nil
}
```

### Full Example: Auth Service Fallback Chain

Authentication is a dependency where the fallback strategy must be chosen carefully from a security standpoint. This chain falls back through four tiers, live auth, a short-lived cache, a static emergency allow-list, and finally a deny-all handler, where each tier is progressively more conservative rather than more permissive.

The deny-all terminal handler is where the subtlety lives, and it is worth slowing down for. "Deny" has to be signalled as an **error**, not as a successful result carrying `Authenticated: false`. A fallback chain treats a nil error as success, so a denial returned with a nil error is indistinguishable from a pass to any caller that checks the error first and the payload second, which is what nearly every caller does. The safe-looking version of this handler is a fail-open authentication bypass. Make the denial an error, so that ignoring it takes deliberate effort.

```go
// Auth fallback: live → cache → allow-list → deny-all

func NewAuthFallbackChain(
    liveAuth  LiveAuthService,
    authCache AuthCache,
    allowList AllowListStore,
    logger    *slog.Logger,
    metrics   MetricsRecorder,
) *fallback.FallbackChain[AuthResult] {

    handlers := []fallback.Handler[AuthResult]{
        {
            Name:     "live_auth",
            Priority: 1,
            Execute: func(ctx context.Context) (AuthResult, error) {
                return liveAuth.Verify(ctx)
            },
        },
        {
            Name:     "cached_auth",
            Priority: 2,
            Execute: func(ctx context.Context) (AuthResult, error) {
                result, err := authCache.Get(ctx)
                if err != nil {
                    return AuthResult{}, err
                }
                if result.Age > 5*time.Minute {
                    // Stale cache. Warn, but still use it.
                    logger.WarnContext(ctx, "auth served from stale cache",
                        "age", result.Age)
                }
                return result.Value, nil
            },
        },
        {
            Name:     "allow_list",
            Priority: 3,
            Execute: func(ctx context.Context) (AuthResult, error) {
                // Check if token is on the static emergency allow-list.
                allowed, err := allowList.IsAllowed(ctx)
                if err != nil || !allowed {
                    return AuthResult{}, errors.New("not on allow-list")
                }
                return AuthResult{Authenticated: true, Source: "allow_list"}, nil
            },
        },
        {
            Name:     "deny_all",
            Priority: 4,
            Execute: func(ctx context.Context) (AuthResult, error) {
                // Final fallback: deny when auth is completely unavailable.
                //
                // The error is NOT optional. Returning
                //   AuthResult{Authenticated: false}, nil
                // makes the chain report SUCCESS, and every caller that
                // checks `if err != nil` before looking at the payload then
                // treats the denial as a pass. That is a fail-open
                // authentication bypass written to look like fail-closed.
                //
                // Returning an error means the chain exhausts, Execute
                // returns ErrAllFallbacksFailed, and a caller has to work to
                // ignore it. Make the safe outcome the lazy one.
                return AuthResult{
                    Authenticated: false,
                    Source:        "deny_all",
                    Reason:        "auth service unavailable",
                }, ErrAuthUnavailable
            },
        },
    }

    return fallback.NewFallbackChain(handlers, logger, metrics)
}

// ErrAuthUnavailable denies the request when every auth tier is down.
var ErrAuthUnavailable = errors.New("auth: all tiers unavailable, denying request")

// Authenticate is the only entry point callers should use. It converts the
// chain's outcome into a single unambiguous boolean, so no caller has to
// remember that a non-nil result can still mean "not authenticated".
func Authenticate(ctx context.Context, chain *fallback.FallbackChain[AuthResult]) (AuthResult, error) {
    result, err := chain.Execute(ctx)
    if err != nil {
        return AuthResult{Authenticated: false, Source: "denied"}, err
    }
    // Belt and braces: a handler could still hand back a non-authenticated
    // result with a nil error. Treat that as a denial rather than trusting it.
    if !result.Value.Authenticated {
        return result.Value, ErrAuthUnavailable
    }
    return result.Value, nil
}
```

### Fallback Telemetry

Every fallback activation is an operational signal. Log it at WARN level. Emit a metric for every activation. Alert when activation rates exceed normal thresholds.

```go
// FallbackTelemetry wraps a FallbackChain with enhanced telemetry.
type FallbackTelemetry[T any] struct {
    chain   *fallback.FallbackChain[T]
    name    string
    logger  *slog.Logger
    metrics MetricsRecorder
}

func (ft *FallbackTelemetry[T]) Execute(ctx context.Context) (T, error) {
    result, err := ft.chain.Execute(ctx)
    if err != nil {
        ft.metrics.IncrCounter("fallback_chain.exhausted", "chain", ft.name)
        ft.logger.ErrorContext(ctx, "all fallbacks exhausted",
            "chain", ft.name,
            "error", err,
        )
        var zero T
        return zero, err
    }

    if result.Degraded {
        ft.metrics.IncrCounter("fallback_chain.degraded_response",
            "chain", ft.name,
            "handler", result.HandlerName,
        )
    }

    ft.metrics.Histogram("fallback_chain.attempts",
        float64(len(result.Attempts)),
        "chain", ft.name,
    )

    return result.Value, nil
}
```

### Staff Lens: Fallback Chain Latency Accumulates

Each tier adds latency. A chain of four fallbacks each with a 500ms timeout can cumulatively eat 2 seconds before returning. Budget the chain, not individual tiers. When the overall budget is about to expire, skip remaining tiers and return the best available result.

---
