## 31B.4 Advanced WaitGroup Patterns

The `sync.WaitGroup` coordinates a group of goroutines by tracking a counter: `Add(n)` increments it, each goroutine calls `Done()` (decrement) when it finishes, and `Wait()` blocks until the counter reaches zero. `Add` must be called before the goroutine is launched, not inside it, because there is a race between the goroutine starting and the caller reaching `Wait`, if `Wait` is called before `Add`, it returns immediately. Reusing a WaitGroup across multiple rounds is safe as long as the previous `Wait` has returned before the next batch of `Add` calls, ensuring the counter is at zero when reuse begins.

### Go 1.25: `WaitGroup.Go` (prefer this over manual Add/Done)

Go 1.25 added `WaitGroup.Go(func())`, which encapsulates the `Add(1) + go + defer Done()` pattern in a single call. This eliminates the single most common WaitGroup bug, forgetting `Done`, calling `Add` inside the goroutine (which races with `Wait`), or mismatching `Add` counts with the number of spawned goroutines. Unless you have a specific reason to use the lower-level API (for example, decrementing by more than one), reach for `wg.Go` first.

```go
package main

import "sync"

// Go 1.25+: the preferred pattern
func fanOut(items []string) {
    var wg sync.WaitGroup
    for _, item := range items {
        item := item // avoids loop-variable capture on Go < 1.22
        wg.Go(func() {
            processItem(item)
        })
    }
    wg.Wait()
}

// Equivalent pre-1.25 code (error-prone, avoid in new code):
func fanOutLegacy(items []string) {
    var wg sync.WaitGroup
    for _, item := range items {
        item := item
        wg.Add(1)                     // forget this and Wait returns too early
        go func() {
            defer wg.Done()           // forget this and Wait blocks forever
            processItem(item)
        }()
    }
    wg.Wait()
}
```

`wg.Go` also guarantees the `Add` happens-before the new goroutine starts, removing a subtle race that existed when programmers called `Add` inside the spawned function.

```go
package main

import (
    "context"
    "fmt"
    "sync"
    "time"
)

// Pattern 1: WaitGroup with error collection (errgroup)
func withErrGroup() error {
    // Use golang.org/x/sync/errgroup for WaitGroup + error collection
    // import "golang.org/x/sync/errgroup"
    // g, ctx := errgroup.WithContext(context.Background())
    // g.Go(func() error { return doWork(ctx) })
    // return g.Wait() // returns first non-nil error
    return nil
}

// Pattern 2: Bounded concurrency with WaitGroup.Go + semaphore
func boundedConcurrency(items []string, maxConcurrent int) []error {
    var wg sync.WaitGroup
    sem := make(chan struct{}, maxConcurrent) // semaphore limits goroutines
    errs := make([]error, len(items))
    var mu sync.Mutex

    for i, item := range items {
        i, item := i, item
        wg.Go(func() {
            sem <- struct{}{}        // acquire semaphore (blocks if maxConcurrent reached)
            defer func() { <-sem }() // release on return

            if err := processItem(item); err != nil {
                mu.Lock()
                errs[i] = err
                mu.Unlock()
            }
        })
    }
    wg.Wait()
    return errs
}

// For error-returning work, prefer errgroup with SetLimit, which combines
// bounded concurrency, first-error short-circuit, and context cancellation:
//   g, ctx := errgroup.WithContext(parent)
//   g.SetLimit(maxConcurrent)
//   for _, it := range items {
//       it := it
//       g.Go(func() error { return process(ctx, it) })
//   }
//   return g.Wait()

// Pattern 3: WaitGroup with early exit via context
func withContext(ctx context.Context, items []string) error {
    var wg sync.WaitGroup
    errCh := make(chan error, 1) // buffer 1: first error only

    for _, item := range items {
        select {
        case <-ctx.Done():
            break // stop launching new goroutines on cancellation
        default:
        }

        wg.Add(1)
        go func(it string) {
            defer wg.Done()
            if err := processItem(it); err != nil {
                select {
                case errCh <- err: // send first error
                default: // error channel full, discard subsequent
                }
            }
        }(item)
    }

    // Wait in a goroutine so we can select on errCh
    done := make(chan struct{})
    go func() {
        wg.Wait()
        close(done)
    }()

    select {
    case <-done:
        select {
        case err := <-errCh:
            return err
        default:
            return nil
        }
    case <-ctx.Done():
        return ctx.Err()
    }
}

// Pattern 4: WaitGroup with timeout
func withTimeout(timeout time.Duration, work func()) bool {
    done := make(chan struct{})
    go func() {
        defer close(done)
        work()
    }()
    select {
    case <-done:
        return true // completed in time
    case <-time.After(timeout):
        return false // timed out
    }
}

// Pattern 5: Nested WaitGroups for hierarchical work
func hierarchicalWork(categories []string, itemsPerCategory func(string) []string) {
    var outerWg sync.WaitGroup

    for _, cat := range categories {
        outerWg.Add(1)
        go func(category string) {
            defer outerWg.Done()

            items := itemsPerCategory(category)
            var innerWg sync.WaitGroup
            for _, item := range items {
                innerWg.Add(1)
                go func(it string) {
                    defer innerWg.Done()
                    processItem(it)
                }(item)
            }
            innerWg.Wait() // wait for all items in this category
            fmt.Printf("category %s done\n", category)
        }(cat)
    }
    outerWg.Wait() // wait for all categories
}

func processItem(s string) error { return nil }
```

### Junior to FAANG: WaitGroup Without the Footguns

`sync.WaitGroup` is a counter. `Add(n)` increments it. `Done` decrements it. `Wait` blocks until it reaches zero. That is the entire surface. What trips up juniors is the ordering rules.

**Rule 1: call `Add` before `go`, never inside the goroutine.** The race is subtle. If you call `wg.Add(1)` inside the goroutine, `Wait` can run to completion before `Add` fires, because the goroutine has not been scheduled yet.

```go
// BROKEN
for i := 0; i < 10; i++ {
    go func() {
        wg.Add(1)    // race: Wait may return first
        defer wg.Done()
        doWork()
    }()
}
wg.Wait()

// CORRECT
for i := 0; i < 10; i++ {
    wg.Add(1)
    go func() {
        defer wg.Done()
        doWork()
    }()
}
wg.Wait()
```

**Rule 2: do not reuse a WaitGroup until `Wait` has returned.** The internal state has a "waiter count" that is only safe to reset after all waiters have been released. Go 1.20+ detects reuse violations and panics.

**Rule 3: WaitGroup does not propagate errors.** If you need error collection, use `golang.org/x/sync/errgroup` instead. `errgroup.Group` wraps WaitGroup, captures the first error, and cancels a shared context when any goroutine fails. This is the default choice at most shops for anything non-trivial.

Worked first-job example. You are asked to fan out N HTTP requests and aggregate responses. The junior answer uses `WaitGroup` and a slice. The senior answer uses `errgroup` with a semaphore:

```go
g, ctx := errgroup.WithContext(ctx)
g.SetLimit(16) // cap concurrency at 16
results := make([]Response, len(urls))
for i, url := range urls {
    i, url := i, url
    g.Go(func() error {
        r, err := fetch(ctx, url)
        if err != nil {
            return err
        }
        results[i] = r
        return nil
    })
}
if err := g.Wait(); err != nil {
    return nil, err
}
```

This is the shape of the answer interviewers want at L4. Each element in the shared `results` slice is written by exactly one goroutine at a distinct index, so no mutex is needed. The context cancellation ensures that if one fetch fails, the others stop immediately.

### Senior at FAANG: errgroup, Semaphores, Context-Aware Waiting, and Structured Concurrency

At staff level you rarely reach for bare `sync.WaitGroup`. The production-grade primitives are `errgroup`, `semaphore.Weighted`, and bounded worker pools. Understanding why each exists, and their failure modes, is a staff-level skill.

**`errgroup.Group` internals.** `errgroup` wraps `WaitGroup`, a `sync.Once` for the first error, and a cancel func for the shared context. The `Go` method increments the WaitGroup and launches the goroutine. On error, it calls the context cancel func, which propagates to every goroutine that is respecting the context. The first error wins. Subsequent errors are dropped. This is usually what you want, but for reporting it is lossy. If you need all errors, aggregate yourself with a `sync.Mutex`-protected slice or use `multierr.Combine`.

`SetLimit(n)` added in Go 1.20 bounds concurrency. The implementation is a buffered channel used as a semaphore. If `SetLimit` is not set, `errgroup` can spawn unbounded goroutines, which kills services under burst load. Always set a limit for IO-bound fanout. The rule of thumb: for CPU-bound work set to `GOMAXPROCS`, for IO-bound work set to the peer service's known concurrency budget divided by your instance count.

**`semaphore.Weighted` for heterogeneous work.** `golang.org/x/sync/semaphore.Weighted` is a counting semaphore that supports weighted acquisition. Useful when different tasks have different cost. For example, a request may need 1 unit for a small query and 10 units for a large query. `Acquire(ctx, n)` blocks until N units are available or the context cancels. Release must match acquisition. Failing to release leaks capacity.

**Context-aware WaitGroup.** The stdlib `WaitGroup.Wait` does not take a context. A timeout on `Wait` requires wrapping:

```go
func WaitCtx(ctx context.Context, wg *sync.WaitGroup) error {
    done := make(chan struct{})
    go func() { wg.Wait(); close(done) }()
    select {
    case <-done:
        return nil
    case <-ctx.Done():
        return ctx.Err()
    }
}
```

This leaks the helper goroutine if the goroutines tracked by `wg` never finish. Acceptable at shutdown if the process is exiting, otherwise you need to propagate cancellation into the worker goroutines themselves. `errgroup` handles this correctly by construction.

**Structured concurrency in Go.** Go does not enforce structured concurrency (the invariant that child goroutines complete before their parent returns). This is a persistent source of leaks. Community proposals to add it have circulated for years, and Sameer Ajmani's talks on structured concurrency are a good entry point. Various teams maintain internal helper packages that bind a spawned goroutine's lifetime to its launcher's scope. Until a stdlib solution lands, use `errgroup` as the idiomatic approximation and establish a team rule: every `go` statement must be inside an `errgroup.Go`, a worker pool, or a clearly documented long-running service goroutine.

**WaitGroup internals.** The Go 1.22+ implementation uses a single 64-bit atomic word: high 32 bits are the counter, low 32 bits are the waiter count. `Add` does a compare-and-swap, `Wait` increments the waiter count and parks on a runtime semaphore (`runtime_Semacquire`), `Done` decrements and, if the counter hits zero, wakes all waiters via `runtime_Semrelease`. There is no general-purpose lock, which is why `WaitGroup` is fast. The 1.19 rework fixed a subtle bug where the counter could go negative under specific race patterns.

**Panics and WaitGroup.** If a goroutine tracked by a WaitGroup panics and does not `recover`, the entire process crashes, and `Wait` never returns. For services that must survive, install a `recover` in every goroutine launched via a worker pool. `errgroup` does not recover by default. A common pattern is a small helper:

```go
func safeGo(g *errgroup.Group, f func() error) {
    g.Go(func() (err error) {
        defer func() {
            if r := recover(); r != nil {
                err = fmt.Errorf("panic: %v\n%s", r, debug.Stack())
            }
        }()
        return f()
    })
}
```

**Staff-level patterns.**

1. **Bounded pipeline.** Stage 1 reads from a channel, stage 2 processes, stage 3 writes. Each stage has its own `errgroup` with a SetLimit. The stage channels are sized to the bottleneck stage's limit. Use `context.Context` for cancellation.

2. **Fan-out with result ordering.** If you need results in input order, index into a pre-sized slice. If you need results in completion order, use a channel. If you need both, index into the slice and signal completion on a channel.

3. **Soft and hard deadlines.** Soft deadline: cancel the context, give workers a grace period to finish cleanly. Hard deadline: after the grace, log the stragglers and return. Never leak goroutines permanently.

4. **Leak detection in tests.** Use `go.uber.org/goleak`. Fail any test that leaves goroutines running after completion. This catches missing `Done` calls, forgotten `Cancel`, and goroutines blocked on closed channels.

**Staff-level review checklist:**

1. Is every `go` statement tracked by a WaitGroup, errgroup, or explicit lifecycle?
2. Is `Add` always before `go`?
3. Is concurrency bounded (`SetLimit` or `semaphore.Weighted`)?
4. Are panics recovered in every worker goroutine?
5. Is context cancellation propagated into worker loops?
6. Does the test suite include `goleak.VerifyNone(t)`?
7. Is there a metric for goroutine count, with alerts on unbounded growth?

---
