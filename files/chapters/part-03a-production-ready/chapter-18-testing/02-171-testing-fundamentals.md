## 18.1 Testing Fundamentals

### The Philosophy of Go Testing

Go takes a pragmatic approach to testing. Unlike languages that require external testing frameworks, Go provides everything you need in the standard library. The `testing` package is deliberately minimal yet capable, and the `go test` command is built directly into the toolchain.

**Key principles of Go testing:**

1. **Convention over configuration**: Test files end with `_test.go`, test functions start with `Test`
2. **No assertions framework required**: Use simple `if` statements and `t.Error()`/`t.Fatal()`
3. **Tests are code**: No special DSL, just regular Go code
4. **Sequential by default, parallel by opt-in**: within a package, tests run one at a time unless they call `t.Parallel()`
5. **Built-in benchmarking**: Performance testing is a first-class citizen
6. **Built-in fuzzing**: Property-based testing since Go 1.18

Point 4 is worth pinning down, because "Go tests are parallel by default" is a persistent myth and it is false. Instrumenting the maximum number of simultaneously-executing tests inside one package makes it unambiguous:

```
max concurrent WITHOUT t.Parallel(): 1     (0.30s for three 100ms tests)
max concurrent WITH t.Parallel():    3     (0.10s for the same three)
```

What *is* parallel by default is different packages: `go test ./...` builds and runs separate package binaries concurrently, governed by `-p` (defaulting to `GOMAXPROCS`). Inside a single package, nothing overlaps until you opt in, and `-parallel N` then caps how many opted-in tests run at once. Conflating the two is what produces the myth, and it matters: a test that mutates a package-level variable is safe today only because nobody has added `t.Parallel()` yet.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                        GO TEST EXECUTION FLOW                                   │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  go test ./...                                                                  │
│       │                                                                         │
│       ▼                                                                         │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐              │
│  │ Compile Test    │───►│ Run TestMain    │───►│ Run Tests in    │              │
│  │ Binary          │    │ (if exists)     │    │ ORDER (seq.)    │              │
│  └─────────────────┘    └─────────────────┘    └────────┬────────┘              │
│                                                          │                      │
│                              ┌───────────────────────────┼───────────────────┐  │
│                              │                           │                   │  │
│                              ▼                           ▼                   ▼  │
│                    ┌─────────────────┐        ┌─────────────────┐  ┌────────┐   │
│                    │ Test Function   │        │ Test Function   │  │ ...    │   │
│                    │ TestFoo         │        │ TestBar         │  │        │   │
│                    └────────┬────────┘        └────────┬────────┘  └────────┘   │
│                             │                          │                        │
│                    ┌────────┴────────┐        ┌────────┴────────┐               │
│                    │ Subtests        │        │ Subtests        │               │
│                    │ t.Run("a", ...) │        │ t.Run("x", ...) │               │
│                    │ t.Run("b", ...) │        │ t.Run("y", ...) │               │
│                    └─────────────────┘        └─────────────────┘               │
│                                                                                 │
│  PARALLEL EXECUTION:                                                            │
│  ├── Within a package: sequential UNLESS a test calls t.Parallel()              │
│  ├── Parallel tests are paused, then resumed together after the                 │
│  │   sequential ones finish (so they interleave with each other only)           │
│  ├── -parallel N caps concurrent parallel tests (default: GOMAXPROCS)           │
│  └── Across packages: run concurrently by default, capped by -p                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### Test File Naming

Test files must end with `_test.go`:

```
user.go          # Implementation
user_test.go     # Tests
```

### Basic Test Function

A Go test function takes a single `*testing.T` parameter and uses its methods to report failures. The naming convention is strict: the function must start with `Test` followed by a capitalized letter, which allows `go test` to automatically discover and execute it. Rather than relying on assertion libraries, Go encourages direct comparisons with `t.Errorf` for non-fatal failures and `t.Fatalf` to halt execution immediately.

```go
// user_test.go
package user

import "testing"

func TestAdd(t *testing.T) {
    result := Add(2, 3)
    expected := 5

    if result != expected {
        t.Errorf("Add(2, 3) = %d; want %d", result, expected)
    }
}
```

### Running Tests

The `go test` command is the primary interface for executing tests, and it accepts a rich set of flags that control scope, verbosity, and analysis. You can target a single package, an entire module with `./...`, or filter to specific tests by name using the `-run` flag with a regex pattern. Adding `-race` enables Go's built-in data race detector, which is especially important when testing concurrent code.

```bash
# Run all tests
go test ./...

# Run tests in current package
go test

# Verbose output
go test -v

# Run specific test
go test -run TestAdd

# Run tests matching pattern
go test -run "TestUser.*"

# With coverage
go test -cover

# Race detection
go test -race
```

### Staff Lens: Every CI Pipeline Needs These Flags

The production-grade `go test` invocation for CI:

```bash
go test -race -shuffle=on -count=1 -timeout=10m ./...
```

- `-race`: catch data races.
- `-shuffle=on`: randomize test order, to expose tests that depend on hidden shared state.
- `-count=1`: disable test caching (run fresh every time). Without it, a passing package reports `ok ci (cached)` and does not execute at all.
- `-timeout=10m`: prevent runaway tests from hanging CI forever. The default is 10 minutes anyway, but stating it means a future change to the default cannot surprise you.

Every production Go team should use something like this. Missing any of these is a gap worth fixing.

One caveat on `-shuffle=on`: it is a sampler, not a prover. Given two tests where the second silently depends on the first having run, six shuffled runs produced this:

```
2 --- FAIL: TestBUse
4 ok      ci
```

It found the bug, but only a third of the time, because it has to happen to pick an order that exposes it. So a green `-shuffle=on` run is not evidence of independence, and a flake that appears only under shuffle is a real bug rather than shuffle being unreliable. When it fails, the seed is printed. Re-run with `-shuffle=<seed>` to reproduce exactly.

---
