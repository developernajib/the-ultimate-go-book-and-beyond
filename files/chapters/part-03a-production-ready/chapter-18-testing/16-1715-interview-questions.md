## 18.15 Interview Questions

Testing questions are universal in Go interviews. Interviewers check whether you write deterministic tests that catch real bugs, reach for the right tool (table-driven subtests, `httptest`, `testing/synctest`, fuzzing) per situation, and can read a flaky-test report and propose a fix rather than a retry loop.

> **What FAANG actually tests here**: test deterministic design, knowledge of the standard library's `testing`, `net/http/httptest`, `testing/quick`, and `testing/synctest` (stable in Go 1.25), willingness to fuzz, and awareness that mocking is the last resort, not the default.

### Question 1: What's the difference between t.Error and t.Fatal?

**What FAANG expects**: correct semantics (Error continues, Fatal stops the goroutine via `runtime.Goexit`), plus the subtle rule that `t.Fatal` from a goroutine other than the test's own goroutine does NOT stop the test. For assertions inside spawned goroutines, send failures back to the main test goroutine.

**Answer:**

`t.Error` records a failure but continues executing the test. `t.Fatal` records a failure and immediately stops the test function.

```go
func TestExample(t *testing.T) {
    t.Error("This fails but continues")
    fmt.Println("This line runs")

    t.Fatal("This fails and stops")
    fmt.Println("This line never runs")
}
```

**When to use each:**
- Use `t.Error` when subsequent assertions might provide useful information
- Use `t.Fatal` when continuing would cause panics or provide meaningless results
- In setup code that later tests depend on, use `t.Fatal`

**Follow-ups**:
- What does `t.Fatal` actually do under the hood, and why does calling it from a non-test goroutine fail to stop the test?
- When would you use `t.Errorf` plus `t.FailNow` instead of `t.Fatalf`? Is there ever a reason to split them?

### Question 2: How do you test code that uses time.Now()?

**Answer:**

**What FAANG expects**: clock injection as a dependency, plus awareness that `testing/synctest` (stable in Go 1.25) gives you a virtual clock for free when the test can be wrapped in a bubble, eliminating the dependency-injection ceremony for most cases.

Direct calls to `time.Now()` make tests non-deterministic because the result changes on every run. The traditional fix is to inject the clock as a dependency, a function field of type `func() time.Time`, so tests can supply a fixed timestamp while production code uses the real clock. This pattern applies to any external source of non-determinism (random numbers, UUIDs, file system timestamps).

```go
// Production code
type TimeFunc func() time.Time

type Service struct {
    now TimeFunc
}

func NewService() *Service {
    return &Service{now: time.Now}
}

func (s *Service) IsExpired(expiry time.Time) bool {
    return s.now().After(expiry)
}

// Test code
func TestIsExpired(t *testing.T) {
    fixedTime := time.Date(2024, 1, 15, 12, 0, 0, 0, time.UTC)

    service := &Service{
        now: func() time.Time { return fixedTime },
    }

    tests := []struct {
        name   string
        expiry time.Time
        want   bool
    }{
        {"not expired", fixedTime.Add(time.Hour), false},
        {"expired", fixedTime.Add(-time.Hour), true},
        {"exactly now", fixedTime, false}, // After, not After or Equal
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            if got := service.IsExpired(tt.expiry); got != tt.want {
                t.Errorf("IsExpired() = %v; want %v", got, tt.want)
            }
        })
    }
}

// Modern alternative with testing/synctest (stable in Go 1.25):
// run the code in a bubble where time package functions use a fake
// clock. No dependency injection required.
func TestIsExpiredSynctest(t *testing.T) {
    synctest.Test(t, func(t *testing.T) {
        start := time.Now()
        // Advance virtual time. All time-package functions see the jump.
        time.Sleep(2 * time.Hour)
        if time.Since(start) < 2*time.Hour {
            t.Fatal("virtual clock did not advance")
        }
    })
}
```

**Follow-ups**:
- Why does `testing/synctest` fail to help when the code under test reads the system clock via `syscall` or a third-party library that bypasses the `time` package?
- When is dependency injection still better than a synctest bubble? (hint: state shared across multiple bubbles, or code that cannot be isolated)

### Question 3: How do you ensure tests don't leak goroutines?

**Answer:**

**What FAANG expects**: `go.uber.org/goleak` as the third-party gold standard, that `testing/synctest` gives deterministic leak detection inside a bubble, and awareness of the `goroutineleak` pprof profile (GA in Go 1.27) for finding leaks in a live process.

A goroutine leak occurs when a goroutine is started but never exits, accumulating memory over time. The `go.uber.org/goleak` package detects leaks by capturing goroutine **stack traces** before and after a test and failing if an unexpected one remains, which is why its output names the leaking function and its creation site. You can install it per-test with a defer, or globally in `TestMain`.

```go
import "go.uber.org/goleak"

func TestMain(m *testing.M) {
    goleak.VerifyTestMain(m)
}

// Or per-test verification
func TestNoLeak(t *testing.T) {
    defer goleak.VerifyNone(t)

    // Test code that might leak goroutines
    service := NewService()
    defer service.Stop() // Must stop to avoid leak
}
```

Inside a `synctest` bubble you get leak detection for free, and this is the detail candidates get wrong. It comes from `synctest.Test`, **not** from `synctest.Wait`. `Test` waits for every bubble goroutine to exit, so a goroutine that is permanently blocked when the bubble body finishes is reported precisely:

```
panic: deadlock: main bubble goroutine has exited but blocked goroutines remain
```

`synctest.Wait` does something different: it blocks until every *other* goroutine in the bubble is durably blocked. It is a synchronization primitive that replaces `time.Sleep`-and-hope, and it does not fail a test for having a runnable goroutine, it waits for it.

**Follow-ups**:
- Why does `goleak` need a filter list, and which goroutines does it usually ignore?
- How would you detect a leak that `goleak` misses because it only fires under specific race timing?
- The `goroutineleak` profile is reachability-based rather than time-based. What class of leak does that catch that `goleak` cannot, and what does it miss that `goleak` catches?

### Question 4: What is table-driven testing and why is it preferred?

**What FAANG expects**: the data-versus-logic separation, `t.Run` for named subtests (supports `-run` regex filtering and `-parallel`), and the modern `t.Parallel` discipline for subtest parallelism.

**Answer:**

Table-driven testing declares each test case as a struct in a slice, separating the *data* (inputs and expected outputs) from the *logic* (execution and assertion). The test function iterates over the slice and runs each entry as a named subtest via `t.Run`. This pattern is preferred because it eliminates duplicated assertion code, makes adding new cases trivial, and produces individually addressable subtests in `go test -v` output.

```go
func TestAdd(t *testing.T) {
    tests := []struct {
        name     string
        a, b     int
        expected int
    }{
        {"positives", 2, 3, 5},
        {"negatives", -1, -2, -3},
        {"mixed", -1, 3, 2},
        {"zeros", 0, 0, 0},
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            if got := Add(tt.a, tt.b); got != tt.expected {
                t.Errorf("Add(%d, %d) = %d; want %d",
                    tt.a, tt.b, got, tt.expected)
            }
        })
    }
}
```

**Benefits:**
1. Easy to add new cases
2. Consistent assertion logic
3. Cases serve as documentation
4. Subtests enable parallel execution and selective running

Note: before Go 1.22, `t.Parallel()` inside a table-driven subtest required capturing the loop variable (`tt := tt`) to avoid the classic shared-variable bug. Go 1.22 changed for-range scoping so each iteration creates a fresh variable, removing the need for the manual capture.

**Follow-ups**:
- Show the pre-Go-1.22 table-driven parallel subtest bug with shared loop variables.
- How do you pick between a table-driven test and multiple independent tests? What belongs in the table and what does not?

### Question 5: How do you test HTTP handlers and clients?

**What FAANG expects**: `httptest.NewRecorder` for handlers, `httptest.NewServer` for clients, plus knowledge that `httptest.NewUnstartedServer` + TLS setup is required for HTTPS client testing.

**Answer:**

The `net/http/httptest` package provides two complementary tools. `httptest.NewRecorder` creates an in-memory `ResponseWriter` that captures status codes, headers, and body bytes, you pass it directly to a handler's `ServeHTTP` method without opening a network port. `httptest.NewServer` starts a real but ephemeral HTTP server on localhost for testing client code against controlled responses.

```go
// Testing handlers
func TestHandler(t *testing.T) {
    handler := NewUserHandler()

    req := httptest.NewRequest("GET", "/users/1", nil)
    w := httptest.NewRecorder()

    handler.ServeHTTP(w, req)

    if w.Code != http.StatusOK {
        t.Errorf("Status = %d; want %d", w.Code, http.StatusOK)
    }
}

// Testing clients
func TestClient(t *testing.T) {
    server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
    }))
    defer server.Close()

    client := NewAPIClient(server.URL)
    result, err := client.GetStatus()
    // ...
}
```

**Follow-ups**:
- What does `httptest.NewRecorder` *not* simulate that `httptest.NewServer` does? (hint: connection state, HTTP/2 negotiation, TLS)
- How would you test a client against an HTTPS endpoint with `httptest`? Walk through `NewUnstartedServer` plus `StartTLS`.

### Q (Staff track): Your CI test suite takes 45 minutes. How do you fix it?

**Answer**: Diagnose first.

1. Identify the slow tests with `go test -v` timing output.
2. Categorise: is the slowness in tests that should be fast (unit), or tests that are justifiably slow (e2e)?
3. For slow unit tests: find sleeps and real-time dependencies. Replace with `testing/synctest`. Find external calls. Mock them.
4. For slow integration tests: parallelize at the CI level, share containers across tests, and reduce setup overhead.
5. For e2e tests: move them off the PR path if they are too slow. Run nightly instead.

Target: unit tests under 10 minutes, integration under 30, e2e on a separate schedule. The cost is real engineering time. The benefit is faster feedback and more frequent local test runs.

### Q (Staff track): Coverage is 80% but production still breaks. What is wrong?

**Answer**: Coverage measures what lines executed, not whether the tests are meaningful. Likely problems:

1. Tests without assertions (execute lines but verify nothing).
2. Tests that only cover happy paths (error paths missed).
3. Tests that mock everything, so they test mocks instead of code.
4. Coverage gap in critical paths even if overall percentage looks good.

The fix is qualitative, not quantitative. Read representative tests. Are they verifying real behavior? Review incident postmortems and ask: would our tests have caught this? If no, that category of bug is under-tested regardless of percentage.

---
