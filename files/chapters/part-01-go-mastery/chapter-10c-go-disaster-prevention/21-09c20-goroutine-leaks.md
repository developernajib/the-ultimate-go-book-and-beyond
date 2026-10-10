## 10C.20 Goroutine Leaks

A goroutine leak occurs when a goroutine is started but never terminates, usually because it is permanently blocked waiting on a channel operation, a mutex, or an I/O call that will never complete. Unlike memory leaks in other languages, goroutine leaks are invisible to the garbage collector because the goroutine is still technically "alive" and reachable. Over time, leaked goroutines accumulate, consuming memory and stack space until the program runs out of memory. Every goroutine you launch must have a guaranteed exit path, typically via `context.Done()` or a channel close signal.

```go
package main

import (
    "context"
    "fmt"
    "runtime"
    "time"
)

// DISASTER: goroutine blocked forever waiting for a channel nobody writes to
func leakPattern1() {
    ch := make(chan int)
    go func() {
        v := <-ch // blocks forever, nobody sends to ch
        fmt.Println(v)
    }()
    // The function returns. ch is now unreachable from any running code, but
    // the parked goroutine still references it, so neither is collected. The
    // goroutine and its whole stack are pinned for the process lifetime.
}

// DISASTER: goroutine blocked forever waiting for a channel nobody reads from
func leakPattern2() {
    ch := make(chan int) // unbuffered
    go func() {
        ch <- 42 // blocks forever, nobody receives
    }()
    // The mirror image of pattern 1, and the more common one in practice:
    // a producer outliving its consumer. It shows up whenever a caller
    // returns early on an error path and abandons a channel it was reading.
}

// DISASTER: HTTP handler goroutines that never respect request context
func leakPattern3(ctx context.Context) {
    go func() {
        // This goroutine will run even after the HTTP request context is canceled
        time.Sleep(10 * time.Minute)
        doWork() // runs long after caller has moved on
    }()
}

// CORRECT: All goroutines should have an exit condition
func noLeak1(ctx context.Context) {
    ch := make(chan int, 1) // buffered so goroutine can always send once
    go func() {
        select {
        case <-ctx.Done():
            return // exit on cancellation
        case ch <- 42:
        }
    }()
}

// Returning a channel raises the bar: EVERY blocking operation needs a
// cancellation path, including the send. Guarding only the work and then
// doing a bare `ch <- 42` relocates the leak instead of fixing it, because
// an unbuffered send to a caller who stopped reading blocks forever and
// ctx.Done() is not being watched at that moment.
//
// Two ways out. Either buffer the channel with room for every value the
// goroutine can produce, so the send never blocks, or select on ctx.Done()
// at the send as well. Below does both, since the buffer alone stops
// helping the moment the goroutine sends more than once.
func noLeak2(ctx context.Context) <-chan int {
    ch := make(chan int, 1)
    go func() {
        defer close(ch)
        select {
        case <-ctx.Done():
            return
        case <-time.After(1 * time.Second):
        }
        select {
        case ch <- 42:
        case <-ctx.Done():
        }
    }()
    return ch
}

// Detection, weakest to strongest.
//
// 1. Goroutine count. Cheap, and blunt: a rising NumGoroutine tells you
//    that you leak, never where. Useful as a production alarm, useless as
//    a diagnosis.
func goroutineCount() int {
    return runtime.NumGoroutine()
}

// 2. goleak in tests, which snapshots goroutines and fails the test on any
//    that outlive it:
// func TestMyFunc(t *testing.T) {
//     defer goleak.VerifyNone(t)
//     MyFunc() // if this leaks a goroutine, the test fails
// }
//
// 3. The goroutineleak pprof profile (GA in Go 1.27, experimental in Go 1.26), at
//    /debug/pprof/goroutineleak. This is the one that answers "where".
//    It applies GC-style reachability to blocked goroutines: if nothing
//    runnable can still reach the channel or mutex a goroutine is parked
//    on, nothing can ever wake it, and the profile reports it with its
//    stack. No time thresholds, so a legitimately slow goroutine is never
//    misreported, and every pattern above shows up in it by construction.

func doWork() {}
```

---
