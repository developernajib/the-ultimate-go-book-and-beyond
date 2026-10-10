## 22.1 Circuit Breaker

The circuit breaker prevents cascading failures by failing fast when a service is unhealthy.

### States

```
     ┌─────────────────────────────────────────┐
     │                                         │
     ▼                                         │
┌─────────┐  failures >= threshold  ┌──────────┴─┐
│ CLOSED  │ ──────────────────────► │   OPEN     │
└────┬────┘                         └──────┬─────┘
     │                                     │
     │ success                             │ timeout
     │                                     │
     │         ┌─────────────┐             │
     └─────────│ HALF-OPEN   │◄────────────┘
               └──────┬──────┘
                      │
            success   │   failure
         ┌────────────┴────────────┐
         ▼                         ▼
     CLOSED                      OPEN
```

### Implementation

The circuit breaker wraps calls to an unreliable dependency and tracks failure counts in the closed state. When failures exceed a threshold it transitions to open, returning an error immediately without calling the downstream service. After a configurable timeout it enters half-open to probe recovery.

> **Library choice (2026)**: for production use, prefer a battle-tested library over rolling your own. `sony/gobreaker` remains the idiomatic minimal choice, state machine with `Execute(func)`, well-tested, ~zero dependencies. `failsafe-go/failsafe-go` bundles circuit breaker + retry + fallback + rate limit + hedge into a composable policy chain, attractive when you want a unified resilience framework rather than one pattern at a time. `mercari/go-circuitbreaker` is a context-aware variant that ignores errors caused by context cancellation, useful if your callers frequently cancel. The implementation below is for understanding, not copy-paste into production.

```go
package circuitbreaker

import (
    "errors"
    "sync"
    "time"
)

var ErrCircuitOpen = errors.New("circuit breaker is open")

type State int

const (
    StateClosed State = iota
    StateOpen
    StateHalfOpen
)

type CircuitBreaker struct {
    mu sync.RWMutex

    state           State
    failures        int
    successes       int
    halfOpenInFlight int // probes started but not yet finished
    lastFailureTime time.Time

    maxFailures int
    timeout     time.Duration
    halfOpenMax int
}

func New(maxFailures int, timeout time.Duration) *CircuitBreaker {
    return &CircuitBreaker{
        state:       StateClosed,
        maxFailures: maxFailures,
        timeout:     timeout,
        halfOpenMax: 3,
    }
}

func (cb *CircuitBreaker) Execute(fn func() error) error {
    if !cb.allowRequest() {
        return ErrCircuitOpen
    }

    err := fn()
    cb.recordResult(err == nil)
    return err
}

func (cb *CircuitBreaker) allowRequest() bool {
    cb.mu.Lock()
    defer cb.mu.Unlock()

    switch cb.state {
    case StateClosed:
        return true

    case StateOpen:
        if time.Since(cb.lastFailureTime) > cb.timeout {
            cb.state = StateHalfOpen
            cb.successes = 0
            cb.failures = 0
            cb.halfOpenInFlight = 1 // this request is the first probe
            return true
        }
        return false

    case StateHalfOpen:
        // Gate on probes IN FLIGHT, not probes completed. See below: gating
        // on completed probes admits an unbounded stampede.
        if cb.halfOpenInFlight >= cb.halfOpenMax {
            return false
        }
        cb.halfOpenInFlight++
        return true
    }

    return false
}

func (cb *CircuitBreaker) recordResult(success bool) {
    cb.mu.Lock()
    defer cb.mu.Unlock()

    switch cb.state {
    case StateClosed:
        if success {
            cb.failures = 0
        } else {
            cb.failures++
            cb.lastFailureTime = time.Now()
            if cb.failures >= cb.maxFailures {
                cb.state = StateOpen
            }
        }

    case StateHalfOpen:
        cb.halfOpenInFlight--
        if success {
            cb.successes++
            if cb.successes >= cb.halfOpenMax {
                cb.state = StateClosed
                cb.failures, cb.successes, cb.halfOpenInFlight = 0, 0, 0
            }
        } else {
            // One failed probe is enough: the dependency is still sick.
            cb.state = StateOpen
            cb.lastFailureTime = time.Now()
        }

    case StateOpen:
        // A probe still in flight when a sibling probe tripped us back open.
        // Without this, halfOpenInFlight never returns to zero and the next
        // half-open window admits nothing at all.
        if cb.halfOpenInFlight > 0 {
            cb.halfOpenInFlight--
        }
    }
}

func (cb *CircuitBreaker) State() State {
    cb.mu.RLock()
    defer cb.mu.RUnlock()
    return cb.state
}
```

### The Half-Open Stampede

The `halfOpenInFlight` counter above is not bookkeeping tidiness. It is the difference between a circuit breaker and a loaded gun pointed at a service that is trying to recover.

The natural way to write the half-open gate is to compare the recorded outcomes against the limit:

```go
// WRONG: admits an unbounded number of probes.
case StateHalfOpen:
    return cb.successes+cb.failures < cb.halfOpenMax
```

It reads correctly. `halfOpenMax` is 3, so at most 3 probes, right? No. `successes` and `failures` are only incremented in `recordResult`, which runs **after `fn()` returns**. A request that is in flight has incremented nothing. So while the first probe is still waiting on a slow, recovering dependency, `successes+failures` is still `0`, and every subsequent request sails through the same gate.

Under concurrency the result is not "a few extra". Take a breaker with `halfOpenMax = 3`, trip it, wait out the timeout, then release 500 concurrent requests against a dependency that takes 100ms to respond:

```
halfOpenMax = 3
requests that REACHED the recovering dependency: 500 / 500
requests rejected by the breaker:                0 / 500
```

Every single one. The breaker admitted 500 requests to a service it was supposed to probe with 3. This is the worst possible moment for it: the dependency just came back from an outage, its caches are cold, its connection pools are empty, its JIT is unwarmed. The breaker waits patiently for the recovery timeout and then delivers the entire backlog in one blow, which knocks the dependency straight back down. The breaker then trips again, waits, and repeats. This creates an oscillator that DDoSes the dependency on a fixed period, while the metric claiming "breaker is working" remains lit the whole time.

The fix is to count what you are actually trying to limit: probes **in flight**. Increment under the lock in `allowRequest`, decrement in `recordResult`. With that one change, the same test admits exactly what it promised:

```
reached dependency:  3 / 500   (peak concurrent probes: 3)
rejected by breaker: 497 / 500
```

The general lesson generalises past circuit breakers: **any limiter that gates on completed work admits unbounded concurrent work.** If the quantity you are bounding is concurrency, the counter must move when work *starts*, not when it finishes.

This is precisely what `sony/gobreaker` gets right, and it is worth reading its gate next to the broken one above:

```go
// gobreaker's beforeRequest, condensed
if state == StateOpen {
    return generation, ErrOpenState
} else if state == StateHalfOpen && cb.counts.Requests >= cb.maxRequests {
    return generation, ErrTooManyRequests
}
cb.counts.onRequest() // Requests++, at START, under the same lock
```

The increment happens *in the gate*, under the same mutex that made the decision, before the call is dispatched. There is no window for a second request to observe a stale count. `MaxRequests` is documented as "the maximum number of requests allowed to pass through when the CircuitBreaker is half-open", and its zero value is not "unlimited" but "allow only 1". That default is conservative on purpose: it is the only thing standing between a recovering database and the thundering herd.

### Usage

Callers check the returned error against `ErrCircuitOpen` to distinguish a fast-fail from an actual downstream error, allowing the handler to serve a cached or degraded response instead of propagating the failure to the caller.

```go
cb := circuitbreaker.New(5, 30*time.Second)

err := cb.Execute(func() error {
    return callExternalService()
})

if errors.Is(err, circuitbreaker.ErrCircuitOpen) {
    // Use fallback
    return cachedResponse()
}
```

### Using gobreaker Library

The `gobreaker` library from Sony provides a production-hardened circuit breaker with customizable trip conditions, state change callbacks, and per-request tracking. `ReadyToTrip` receives a `gobreaker.Counts` with exactly five fields:

```go
type Counts struct {
    Requests             uint32
    TotalSuccesses       uint32
    TotalFailures        uint32
    ConsecutiveSuccesses uint32
    ConsecutiveFailures  uint32
}
```

Note there is no error-rate field. You compute the ratio yourself, and you must guard the denominator: a rate-based policy that trips on `TotalFailures/Requests > 0.5` will trip on the very first failed request, when the rate is 1.0 out of a sample of one. Always require a minimum request count before a ratio means anything:

```go
ReadyToTrip: func(counts gobreaker.Counts) bool {
    if counts.Requests < 20 { // not enough evidence to judge
        return false
    }
    failureRate := float64(counts.TotalFailures) / float64(counts.Requests)
    return failureRate >= 0.5
},
```

```go
import "github.com/sony/gobreaker"

cb := gobreaker.NewCircuitBreaker(gobreaker.Settings{
    Name:        "external-api",
    MaxRequests: 3,
    Interval:    10 * time.Second,
    Timeout:     30 * time.Second,
    ReadyToTrip: func(counts gobreaker.Counts) bool {
        return counts.ConsecutiveFailures > 5
    },
    OnStateChange: func(name string, from, to gobreaker.State) {
        log.Printf("Circuit breaker %s: %s -> %s", name, from, to)
    },
})

result, err := cb.Execute(func() (any, error) {
    return callExternalService()
})
```

### Staff Lens: One Breaker Per Downstream

Per-service circuit breakers prevent one failing downstream from affecting unrelated calls. A single breaker for the entire service trips on any downstream failure, which is too coarse. Per-URL breakers are too fine. Per-downstream is the right granularity.

### Circuit Breaker Metrics

Every breaker should expose: state (open/half-open/closed), requests_total labeled by result, and state_change_events. Without metrics, you cannot tell if the breaker is helping or hurting.

---
