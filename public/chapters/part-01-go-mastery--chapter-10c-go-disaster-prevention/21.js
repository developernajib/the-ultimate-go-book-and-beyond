export default `## 10C.20 Goroutine Leaks

A goroutine leak occurs when a goroutine is started but never terminates, usually because it is permanently blocked waiting on a channel operation, a mutex, or an I/O call that will never complete. Unlike memory leaks in other languages, goroutine leaks are invisible to the garbage collector because the goroutine is still technically "alive" and reachable. Over time, leaked goroutines accumulate, consuming memory and stack space until the program runs out of memory. Every goroutine you launch must have a guaranteed exit path, typically via \`context.Done()\` or a channel close signal.

\`\`\`go
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
        v := <-ch // blocks forever - nobody sends to ch
        fmt.Println(v)
    }()
    // function returns, ch goes out of scope, goroutine leaks
}

// DISASTER: goroutine blocked forever waiting for a channel nobody reads from
func leakPattern2() {
    ch := make(chan int) // unbuffered
    go func() {
        ch <- 42 // blocks forever - nobody receives
    }()
    // goroutine leaks
}

// DISASTER: HTTP handler goroutines that never respect request context
func leakPattern3(ctx context.Context) {
    go func() {
        // This goroutine will run even after the HTTP request context is cancelled
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

func noLeak2(ctx context.Context) <-chan int {
    ch := make(chan int)
    go func() {
        defer close(ch)
        select {
        case <-ctx.Done():
            return
        case <-time.After(1 * time.Second):
            ch <- 42
        }
    }()
    return ch
}

// Detection: check goroutine count
func goroutineCount() int {
    return runtime.NumGoroutine()
}

// Use goleak in tests to detect leaks:
// func TestMyFunc(t *testing.T) {
//     defer goleak.VerifyNone(t)
//     MyFunc() // if this leaks a goroutine, the test fails
// }

func doWork() {}
\`\`\`

---
`;
