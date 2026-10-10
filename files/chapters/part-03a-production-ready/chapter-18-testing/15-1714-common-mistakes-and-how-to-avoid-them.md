## 18.14 Common Mistakes and How to Avoid Them

### Mistake 1: Flaky Tests Due to Timing

`time.Sleep` introduces a fixed delay that is too short on a loaded CI machine and unnecessarily slow on a fast developer workstation. Using a channel or callback to receive a synchronization signal from the component under test makes the test both faster and reliable: it waits exactly as long as needed and never times out spuriously.

```go
// BAD: Relies on specific timing
func TestWorker_Bad(t *testing.T) {
    worker := NewWorker()
    worker.Start()
    time.Sleep(100 * time.Millisecond) // Flaky!
    if !worker.IsRunning() {
        t.Error("Worker should be running")
    }
}

// GOOD: Use synchronization
func TestWorker_Good(t *testing.T) {
    worker := NewWorker()

    started := make(chan struct{})
    worker.OnStart = func() { close(started) }

    worker.Start()

    select {
    case <-started:
        // Worker started
    case <-time.After(5 * time.Second):
        t.Fatal("Timeout waiting for worker to start")
    }
}
```

### Mistake 2: Shared Test State

Global variables shared across tests create hidden ordering dependencies: the outcome of one test silently determines the starting conditions of another. Each test function should establish its own isolated state, typically via a helper that provisions and tears down a fresh resource, so the suite remains deterministic regardless of execution order or parallelism.

```go
// BAD: Tests share state
var globalDB *sql.DB

func TestCreate_Bad(t *testing.T) {
    globalDB.Exec("INSERT INTO users ...")
}

func TestDelete_Bad(t *testing.T) {
    // Depends on TestCreate_Bad running first, and on go test
    // happening to run it first. `go test -shuffle=on` breaks this.
    globalDB.Exec("DELETE FROM users ...")
}

// GOOD: Each test creates its own state
func TestCreate_Good(t *testing.T) {
    db := setupCleanDB(t) // Fresh database, cleanup registered inside
    service := NewService(db)
    // Test...
    _ = service
}

func TestDelete_Good(t *testing.T) {
    db := setupCleanDB(t)

    // Set up the required state explicitly, rather than inheriting
    // it from whatever test happened to run before.
    if _, err := db.Exec("INSERT INTO users VALUES (1, 'Alice')"); err != nil {
        t.Fatalf("seed: %v", err)
    }

    service := NewService(db)
    // Test delete...
    _ = service
}
```

### Mistake 3: Testing Implementation Details

Tests that access internal fields or unexported state are tightly coupled to the implementation. Any refactoring that preserves behavior will break these tests even though nothing is wrong with the code. Tests should verify behavior through the public API so they serve as a safety net for refactoring rather than an obstacle to it.

```go
// BAD: Tests internal implementation
func TestCache_Bad(t *testing.T) {
    cache := NewCache()
    cache.Set("key", "value")

    // Testing internal map structure
    if cache.data["key"] != "value" {
        t.Error("Failed")
    }
}

// GOOD: Test public behavior
func TestCache_Good(t *testing.T) {
    cache := NewCache()
    cache.Set("key", "value")

    // Test public interface
    got, found := cache.Get("key")
    if !found || got != "value" {
        t.Errorf("Get('key') = %v, %v; want 'value', true", got, found)
    }
}
```

### Mistake 4: Not Testing Error Paths

Exercising only the happy path leaves entire branches of business logic unverified. Errors, nil inputs, and boundary values are precisely the conditions that trigger production incidents. A table-driven test that enumerates both successful and failure cases ensures that every code path is exercised and that error returns are both present when expected and absent when not.

```go
// BAD: Only tests happy path
func TestProcess_Bad(t *testing.T) {
    result, _ := Process(validInput)
    if result != expected {
        t.Error("Failed")
    }
}

// GOOD: Test all paths including errors
func TestProcess_Good(t *testing.T) {
    tests := []struct {
        name    string
        input   Input
        want    Result
        wantErr bool
    }{
        {"valid input", validInput, expectedResult, false},
        {"empty input", Input{}, Result{}, true},
        {"invalid format", invalidInput, Result{}, true},
        {"boundary value", boundaryInput, boundaryResult, false},
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            got, err := Process(tt.input)

            if (err != nil) != tt.wantErr {
                t.Errorf("Process() error = %v, wantErr %v", err, tt.wantErr)
                return
            }

            if !tt.wantErr && !reflect.DeepEqual(got, tt.want) {
                t.Errorf("Process() = %v, want %v", got, tt.want)
            }
        })
    }
}
```

### Mistake 5: Ignoring Test Coverage Blind Spots

Coverage measures which statements executed, not which inputs were exercised. 100% coverage can coexist with a critical unhandled edge case, because covering a statement takes exactly one input and the bug lives in a different one. Adding boundary values, zero values, and error-inducing inputs to the test table catches what the coverage metric structurally cannot.

```go
// Coverage shows 100% but misses important cases:

func Divide(a, b int) int {
    return a / b // Division by zero not handled!
}

func TestDivide(t *testing.T) {
    // This gives 100% coverage but misses a critical bug
    if Divide(10, 2) != 5 {
        t.Error("Failed")
    }
}

// BETTER: Think about edge cases
func TestDivide_Comprehensive(t *testing.T) {
    tests := []struct {
        name    string
        a, b    int
        want    int
        wantPanic bool
    }{
        {"positive", 10, 2, 5, false},
        {"negative dividend", -10, 2, -5, false},
        {"negative divisor", 10, -2, -5, false},
        {"both negative", -10, -2, 5, false},
        {"zero dividend", 0, 5, 0, false},
        {"division by zero", 10, 0, 0, true}, // Critical case!
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            if tt.wantPanic {
                defer func() {
                    if r := recover(); r == nil {
                        t.Error("Expected panic")
                    }
                }()
            }

            got := Divide(tt.a, tt.b)
            if got != tt.want {
                t.Errorf("Divide(%d, %d) = %d; want %d",
                    tt.a, tt.b, got, tt.want)
            }
        })
    }
}
```

This is not a rhetorical example, and it is worth running yourself. The one-case `TestDivide` genuinely reports perfect coverage:

```
$ go test -cover .
ok      dc      coverage: 100.0% of statements

$ go tool cover -func=c.out
dc/d.go:3:  Divide       100.0%
total:      (statements) 100.0%
```

while the function it "fully covers" panics on a trivially reachable input:

```
Divide(10,0) panics: runtime error: integer divide by zero
```

100% of statements, 0% of the bug. `Divide` has a single statement, so a single test executes all of it, and the coverage tool has nothing left to report. There is no metric threshold that would have caught this, which is the whole argument of 18.9: coverage finds code you forgot to test, never inputs you forgot to think about.

### Additional Testing Mistakes

1. **Testing implementation, not behavior.** Tests that pass only against a specific implementation break on every refactor. Test what the function does, not how it does it.
2. **Flaky tests left in the suite.** A flaky test teaches engineers to retry CI instead of trust it. Quarantine or fix immediately. Never leave flakes in green builds.
3. **Tests dependent on other tests.** If `TestB` fails when run alone, the test has hidden setup dependencies. Fix by making each test self-contained.
4. **No timeout in tests that use time.Sleep or network calls.** A hung test blocks CI. Add `-timeout` or use `synctest`.
5. **Panics instead of failures.** A panic in a test aborts the whole suite. Use `t.Fatal` or `t.Errorf` instead of panic.

### Staff Lens: Test Anti-Pattern Catalog

Maintain a team catalog of test anti-patterns (this chapter + team-specific ones). Reference in review. Over months, the catalog prevents the same mistakes from recurring across engineers.

---
