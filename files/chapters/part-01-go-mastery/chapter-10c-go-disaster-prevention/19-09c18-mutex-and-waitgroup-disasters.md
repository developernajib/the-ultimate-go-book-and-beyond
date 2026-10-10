## 10C.18 Mutex and WaitGroup Disasters

### Mutex Copy After First Use

Copying a `sync.Mutex` after it has been used copies its internal state and can cause deadlocks. The `go vet` `copylocks` checker detects this. Mutexes must always be passed and stored by pointer.

```go
package main

import (
    "fmt"
    "sync"
)

type Counter struct {
    mu    sync.Mutex
    count int
}

func (c *Counter) Inc() {
    c.mu.Lock()
    defer c.mu.Unlock()
    c.count++
}

func main() {
    c1 := Counter{}
    c1.Inc()

    // DISASTER: copying a sync.Mutex, or anything containing one, after
    // first use. The copy takes a snapshot of the mutex's internal state,
    // including whether it is currently locked and who is waiting on it.
    // go vet reports "assignment copies lock value".
    c2 := c1 // WRONG: copies the mutex along with the count
    c2.Inc()

    // Two distinct failures hide here, and neither is guaranteed to show up
    // in a test:
    //  1. Copy a mutex while it is LOCKED and the copy is born locked, with
    //     no goroutine that will ever unlock it. The next Lock on the copy
    //     blocks forever.
    //  2. Even unlocked, the copy silently forks the state the mutex was
    //     protecting. c1 and c2 now have independent counts, and every
    //     goroutine holding c1 is guarding data that c2 does not share.
    //     No deadlock, no panic, just two truths.
    // Above, c1.Inc() had returned before the copy, so the mutex was
    // unlocked and only failure 2 applies. That is luck, not design.

    // CORRECT: always use pointers for types containing sync types
    c3 := &Counter{}
    c3.Inc()
    c4 := c3 // copies the pointer, so both share one mutex and one count
    c4.Inc()
    fmt.Println(c4.count) // 2

    // Run `go vet ./...` in CI. copylocks is one of the checks that pays
    // for the whole tool: it is exact, and the bug it finds is invisible.
}
```

### WaitGroup Misuse

`sync.WaitGroup` requires that `Add` calls happen before the goroutines they track are launched, and that `Done` is called exactly once per `Add`. The following examples show common misuse patterns and their consequences, along with `WaitGroup.Go`, added in Go 1.25, which removes most of the opportunity to get this wrong.

```go
package main

import (
    "fmt"
    "sync"
)

func main() {
    var wg sync.WaitGroup

    // TRAP 1: Add inside the goroutine, racing Wait.
    // The counter starts at 0. If Wait observes it at 0 before any goroutine
    // has scheduled far enough to call Add, Wait returns immediately and
    // main walks off while five goroutines are still starting up.
    for i := range 5 {
        go func(n int) {
            wg.Add(1) // BUG: too late, Wait may already have returned
            defer wg.Done()
            fmt.Println(n)
        }(i)
    }
    wg.Wait() // may return before a single goroutine has run

    // CORRECT: Add before launching goroutines
    var wg2 sync.WaitGroup
    for i := range 5 {
        wg2.Add(1) // Add before go
        go func(n int) {
            defer wg2.Done()
            fmt.Println(n)
        }(i)
    }
    wg2.Wait()

    // TRAP 2: more Done calls than Add, which panics on a negative counter
    var wg3 sync.WaitGroup
    wg3.Add(1)
    wg3.Done()
    // wg3.Done() // panic: sync: negative WaitGroup counter

    // TRAP 3: copying a WaitGroup, the mutex copy problem again.
    // The copy has its own counter, so Done on one is invisible to Wait on
    // the other, and Wait blocks forever. go vet's copylocks catches it.
    // This is easy to do by accident: taking a WaitGroup parameter by value
    // instead of by pointer copies it at every call.
    var wg4 sync.WaitGroup
    wg4.Add(1)
    wg5 := wg4 // WRONG: wg5 gets its own counter
    _ = wg5

    // Go 1.25+: WaitGroup.Go pairs Add and Done for you, which makes TRAP 1
    // and TRAP 2 unrepresentable. Add cannot land late because Go does it
    // before starting the goroutine, and Done cannot be forgotten, doubled,
    // or skipped by a panic because Go defers it internally.
    var wg6 sync.WaitGroup
    for i := range 5 {
        wg6.Go(func() {
            fmt.Println(i) // per-iteration since 1.22, so no capture bug
        })
    }
    wg6.Wait()
    // Prefer this shape for new code. The manual Add/go/defer Done dance is
    // now only for cases where you genuinely need to decouple the count from
    // the launch.
}
```

---
