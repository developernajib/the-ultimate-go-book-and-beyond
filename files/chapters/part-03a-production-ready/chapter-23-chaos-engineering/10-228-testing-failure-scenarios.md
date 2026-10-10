## 23.8 Testing Failure Scenarios

Chaos experiments are not limited to production environments. You can integrate fault injection directly into your Go test suite using the standard `testing` package. This lets you verify that your service handles failures correctly as part of your regular test runs, catching resilience regressions before they reach production.

There is a trap here that catches most first attempts, and it is worth naming before the code. A resilience test must have something under test. Consider a test that wraps a handler returning `200 OK` in a fault injector set to a 30% error rate, fires 100 requests with a plain client, and asserts that at least 50 succeeded. It passes, it looks like a chaos test, and it verifies nothing about resilience. There is no retry logic in it, no breaker, no timeout policy, nothing that could regress. The only component whose behaviour it constrains is the injector's random number generator. Delete the service, replace it with a handler that flips a coin, and the test still passes.

Ask of any test in this section: what code would have to break for this to go red? If the answer is "the chaos library", the test belongs to the chaos library.

### Determinism, or Why Random Faults Belong in Production and Not in CI

The second trap is randomness itself. A 30% error rate driven by `math/rand/v2`'s global source produces a different failure pattern on every run, which means the test is a lottery ticket. It will pass a thousand times and fail on the run that matters, and the engineer who sees it fail will re-run CI, watch it go green, and learn to ignore it. That is how a resilience suite becomes decoration.

Production chaos should be random, because the real world is. CI chaos should be deterministic, because a test's job is to fail for exactly one reason. Drive the fault from a counter rather than a die, and you get a test that pins down the precise contract you care about:

```go
package resilience_test

import (
    "errors"
    "fmt"
    "io"
    "net/http"
    "net/http/httptest"
    "sync/atomic"
    "testing"
    "time"

    "myapp/resilience"
)

// RetryClient is the code under test. Without something like this in the
// picture, a chaos test is only testing the chaos.
type RetryClient struct {
    c        *http.Client
    attempts int
}

func (rc *RetryClient) Get(url string) (int, error) {
    var lastErr error
    for i := 0; i < rc.attempts; i++ {
        resp, err := rc.c.Get(url)
        if err != nil {
            lastErr = err
            continue
        }
        io.Copy(io.Discard, resp.Body)
        resp.Body.Close()
        if resp.StatusCode >= 500 {
            lastErr = fmt.Errorf("status %d", resp.StatusCode)
            continue
        }
        return resp.StatusCode, nil
    }
    return 0, lastErr
}

// The backend fails exactly the first two calls. No RNG, so no flake, and the
// assertion is about the retry policy rather than about the dice.
func TestRetryClientSurvivesDeterministicFaults(t *testing.T) {
    var calls atomic.Int32
    srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        if calls.Add(1) <= 2 {
            http.Error(w, "chaos: injected error", http.StatusInternalServerError)
            return
        }
        w.WriteHeader(http.StatusOK)
    }))
    defer srv.Close()

    rc := &RetryClient{c: srv.Client(), attempts: 3}
    if _, err := rc.Get(srv.URL); err != nil {
        t.Fatalf("a client with 3 attempts must survive 2 injected failures: %v", err)
    }
}
```

Pair every test like that with its negative. A test proving the client survives two failures is satisfied by a client that retries forever, which is a far worse bug than the one you were testing for. The second test pins the other side of the contract:

```go
func TestRetryClientGivesUpAfterAttempts(t *testing.T) {
    var calls atomic.Int32
    srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        calls.Add(1)
        http.Error(w, "chaos: injected error", http.StatusInternalServerError)
    }))
    defer srv.Close()

    rc := &RetryClient{c: srv.Client(), attempts: 3}
    if _, err := rc.Get(srv.URL); err == nil {
        t.Fatal("client must fail when every attempt fails")
    }
    if got := calls.Load(); got != 3 {
        t.Fatalf("want exactly 3 attempts, got %d", got)
    }
}
```

### Circuit Breaker Under Chaos

The circuit breaker test drives a consistently failing backend past the breaker's threshold and asserts that subsequent calls are rejected with `ErrCircuitOpen` rather than forwarded to an already-failing backend.

Assert the *consequence*, not just the error value. A test that only checks `errors.Is(err, ErrCircuitOpen)` on one call confirms the breaker reports being open. The reason breakers exist is that they stop traffic reaching a service that is already on the floor, so count the backend's calls and prove they stopped. That is the property that prevents a struggling dependency from being finished off by a retry storm, and it is the one worth regression-testing.

```go
func TestCircuitBreakerOpensAndShedsLoad(t *testing.T) {
    var backendCalls atomic.Int32
    backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        backendCalls.Add(1)
        http.Error(w, "backend failure", http.StatusInternalServerError)
    }))
    defer backend.Close()

    cb := resilience.NewCircuitBreaker(5, 10*time.Second)

    call := func() error {
        resp, err := backend.Client().Get(backend.URL)
        if err != nil {
            return err
        }
        defer resp.Body.Close()
        io.Copy(io.Discard, resp.Body)
        if resp.StatusCode >= 500 {
            return fmt.Errorf("server error: %d", resp.StatusCode)
        }
        return nil
    }

    opened := -1
    for i := 0; i < 20; i++ {
        if err := cb.Execute(call); errors.Is(err, resilience.ErrCircuitOpen) {
            opened = i
            break
        }
    }
    if opened < 0 {
        t.Fatal("breaker never opened after 20 failing calls")
    }

    // The point of a breaker: the failing backend stops being hit at all.
    hitsAtOpen := backendCalls.Load()
    for i := 0; i < 50; i++ {
        if err := cb.Execute(call); !errors.Is(err, resilience.ErrCircuitOpen) {
            t.Fatalf("call %d leaked through an open breaker: %v", i, err)
        }
    }
    if got := backendCalls.Load(); got != hitsAtOpen {
        t.Fatalf("open breaker still forwarded %d calls to the failing backend",
            got-hitsAtOpen)
    }
}
```

That breaker opens on the fifth call, and the fifty calls that follow are shed without the backend seeing one of them.

Two mechanical notes, since both are easy to get wrong. Compare errors with `errors.Is` rather than `!=`, because a breaker that wraps the open error with context will silently defeat `!=`. And qualify the identifiers: a test in package `chaos_test` that calls a bare `NewCircuitBreaker` will not compile, however plausible it looks on the page.

### Where Randomness Does Belong

None of this argues against random fault injection. It argues about placement. Randomised, rate-based chaos is exactly right in a soak test or a staging game day, where the run is long enough for the statistics to mean something and a surprising result is a finding rather than a red build. If you do assert on a rate-based run, compute the bound instead of guessing at one. "Allow some variance" as a comment next to a threshold picked by feel is how a test ends up either flaky or unable to fail. Work out the distribution, choose a bound that flakes less often than your team's tolerance, and write the number in the test with the arithmetic that produced it.

### Staff Lens: Failure Scenario Library

Build a library of standard failure scenarios the org tests against: slow dependency, crashing dependency, network partition, disk full, memory pressure, corrupted data. Each service runs the relevant scenarios regularly. Standardization means every service meets the same resilience bar.

Standardising the scenarios is the easy half. The half that decides whether the library is worth anything is standardising the assertions, because a scenario library where each team writes its own "and then check it still works" produces a hundred tests that pass under conditions nobody agreed on. Ship the scenarios with the contracts: this is the p99 the dependency may add, this is the number of retries permitted, this is the point at which you must shed rather than queue.

---
