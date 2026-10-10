## Concurrency Pitfall Details (Katherine Cox-Buday)

From *"Concurrency in Go"*, critical concurrency patterns. Katherine Cox-Buday's book is the definitive guide to Go's concurrency model, covering everything from the theory behind deadlocks to practical patterns for managing goroutine lifecycles. The concepts below are especially important because concurrency bugs are among the hardest to reproduce and debug, and understanding the underlying theory helps you prevent them at design time rather than hunting them down in production.

### The Deadlock Conditions
All four must be present:
1. **Mutual Exclusion** - Resource held exclusively
2. **Hold and Wait** - Holding one resource while waiting for another
3. **No Preemption** - Resources can't be forcibly taken
4. **Circular Wait** - Circular chain of waiting

### Goroutine Lifecycle Management
Every goroutine you launch must have a clear exit path, otherwise your program accumulates goroutines that never terminate, slowly consuming memory until the process crashes. The done channel pattern gives the caller an explicit mechanism to signal a worker to stop: the goroutine checks the channel on each iteration and returns cleanly when it receives a signal. This avoids the need for global flags or unsafe goroutine cancellation, keeping ownership and control flow easy to reason about.
```go
// Pattern: Done channel for signaling
func worker(done <-chan struct{}) {
    for {
        select {
        case <-done:
            return
        default:
            // do work
        }
    }
}
```

### Error Propagation in Concurrent Code
When multiple goroutines produce results asynchronously, returning errors through a separate channel quickly becomes unwieldy and easy to mishandle. Bundling the result value and any error into a single generic `Result[T]` struct lets you send both over a single channel, keeping the success and failure paths symmetric. Consumers can then range over one channel and inspect the `Err` field, which mirrors the familiar synchronous `value, err` idiom and makes error handling uniform regardless of how many concurrent workers are running.
```go
// Pattern: Result type combining value and error
type Result[T any] struct {
    Value T
    Err   error
}

func worker(results chan<- Result[int]) {
    val, err := doWork()
    results <- Result[int]{Value: val, Err: err}
}
```

### Confinement Strategies
- **Lexical confinement**: Variable only accessible in limited scope
- **Ad-hoc confinement**: Convention-based restriction
- Use channels to transfer ownership

---
