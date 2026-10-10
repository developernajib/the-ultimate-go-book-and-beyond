## Common Mistakes

### 1. Breaking Early from Iterator Without Returning in yield

`yield` returns `false` when the consumer executes `break`, but ignoring that return value means the iterator calls `yield` again after the loop has already exited. The runtime detects this and panics with a "range function continued iteration after loop body exit" error. Always check `if !yield(i) { return }` to honor early termination.

```go
// Wrong: calling break inside an iter.Seq consumer is fine,
// but creating a non-compliant iterator that ignores yield return value
func BadIterator() iter.Seq[int] {
    return func(yield func(int) bool) {
        for i := 0; i < 100; i++ {
            yield(i) // WRONG: ignoring return value!
            // If consumer breaks, yield returns false. Calling yield
            // again after that panics at runtime
        }
    }
}

// Correct: always check yield return value
func GoodIterator() iter.Seq[int] {
    return func(yield func(int) bool) {
        for i := 0; i < 100; i++ {
            if !yield(i) {
                return // Stop when consumer is done
            }
        }
    }
}
```

### 2. Misunderstanding iter.Pull Cleanup

`iter.Pull` converts a push-style iterator into a pull-style one backed by a coroutine. If you forget to call the stop function and abandon a sequence before it is exhausted, the goroutine backing it leaks. Deferring both `stopA()` and `stopB()` ensures cleanup regardless of which sequence terminates first.

```go
// Wrong: forgetting to call stopA when done
func Zip[A, B any](a iter.Seq[A], b iter.Seq[B]) iter.Seq2[A, B] {
    return func(yield func(A, B) bool) {
        nextA, stopA := iter.Pull(a)
        nextB, stopB := iter.Pull(b) // stopB called but stopA not if A exhausted first!
        defer stopB()
        // ...
    }
}

// Correct: defer both stops
func Zip[A, B any](a iter.Seq[A], b iter.Seq[B]) iter.Seq2[A, B] {
    return func(yield func(A, B) bool) {
        nextA, stopA := iter.Pull(a)
        defer stopA() // Always call both stops
        nextB, stopB := iter.Pull(b)
        defer stopB()
        // ...
    }
}
```

### 3. Using PGO Profile from Wrong Environment

PGO inlines and specializes the hottest code paths based on the profile data. A profile captured in a development or test environment reflects cold-cache startup patterns and synthetic traffic, causing the compiler to optimize the wrong paths. Only profiles collected from sustained production traffic under normal load produce meaningful improvements.

```go
// Wrong: using development/test profile for production PGO
// Development profiles have different hot paths than production
// (different data, different code paths exercised)

// Correct: always collect profiles from production traffic
// Never use: profiles from benchmark runs, integration test servers, or staging
// (unless staging is truly identical to production load pattern)
```

### 4. Not Setting GOMEMLIMIT with Green Tea GC

In any container, the heap grows until GC triggers, and without `GOMEMLIMIT` a burst of allocations can push memory past the container's hard limit and trigger an OOM kill with no warning. This risk is not new with Green Tea, but because Green Tea makes larger heaps cheaper to collect, teams are more tempted to raise `GOGC`, which makes an explicit `GOMEMLIMIT` more important, not less. Set `GOMEMLIMIT` to roughly 90% of the container's memory limit to give the GC a safety margin.

```go
// With Green Tea GC allowing larger heaps before GC:
// Wrong: running without GOMEMLIMIT in a container
// Result: heap grows past container limit → OOM kill

// Correct: always set GOMEMLIMIT when running in containers
// GOMEMLIMIT=1800MiB go run ./server
// or in Kubernetes:
// env:
//   - name: GOMEMLIMIT
//     value: "1800MiB"
// resources:
//   limits:
//     memory: "2Gi"
```

### 5. json/v2 Case-Sensitive Breakage

`encoding/json` v1 performs case-insensitive field matching by default, masking mismatches between JSON keys and struct tags. The v2 package is case-sensitive, so any field where the tag and incoming key differ only by case will silently fail to populate. Add the `nocase` option to struct tags that receive externally-generated JSON to maintain compatibility.

```go
// Common breakage when migrating from v1 to v2:
// External API sends {"UserName": "alice"}, your struct has json:"username"
// v1: matches (case-insensitive)
// v2: doesn't match (case-sensitive by default)

// Fix: add case:ignore tag for fields from external APIs
type ExternalPayload struct {
    UserName string `json:"username,case:ignore"` // explicit case-insensitive
    Email    string `json:"email,case:ignore"`    // for externally-generated JSON
}
```

### 6. Using SIMD Before Fallback is Implemented

`GOEXPERIMENT=simd` generates vectorized code only for supported platforms and instruction sets. Shipping SIMD-only code without a scalar fallback means the binary will fail to run on arm64, older x86 CPUs without AVX, or any future architecture that does not implement the same intrinsics. Use build tags to select between the SIMD and scalar implementations at compile time.

```go
// Wrong: deploying SIMD-dependent code without fallback
// If customer runs on arm64 or older x86 without AVX,
// GOEXPERIMENT=simd won't be available

// Correct: always provide scalar fallback using build tags
// simd_amd64.go: SIMD implementation
// simd_fallback.go: scalar implementation for all other platforms
```

### 7. Collecting PGO Profile During Atypical Load

Profiles captured during startup, incidents, maintenance windows, or load tests all represent non-representative traffic patterns. The resulting PGO binary optimizes paths that are rarely hot in normal operation while leaving the actual hot paths un-optimized. Collect profiles during normal peak hours after the service has fully warmed up, and average multiple samples to reduce noise.

```go
// Wrong: collecting profile during:
// - Initial startup (JIT-style warmup, not representative)
// - Incident/DDoS (atypical traffic pattern)
// - Maintenance mode (low traffic, cold caches)
// - Load tests (synthetic traffic misses real user paths)

// Correct: collect profile during:
// - Normal business hours
// - Peak traffic (most representative)
// - After service warmup (at least 30 minutes of steady traffic)
// - Multiple samples averaged (reduces noise)
```

### 8. Ignoring errors.AsType[T] Type Constraints

`errors.AsType[T]` constrains `T` to types that satisfy the `error` interface, and the type argument must match how the error is actually represented in the chain. If your error type defines `Error()` on a pointer receiver, only `*MyError` implements `error`, so you write `errors.AsType[*MyError]` (the value form does not even compile). If it defines `Error()` on a value receiver, use `errors.AsType[MyError]`. Picking the wrong form, `*MyError` when the chain holds `MyError` values, means the match never succeeds.

```go
// Match the type argument to how the error is stored in the chain.

// If Error() is defined on *MyError (pointer receiver),
// the chain holds *MyError, so use the pointer form:
if val, ok := errors.AsType[*MyError](err); ok {
    fmt.Println(val.Code)
}

// If Error() is defined on MyError (value receiver),
// the chain holds MyError values, so use the value form:
if val, ok := errors.AsType[MyError](err); ok {
    fmt.Println(val.Code)
}
```

---
