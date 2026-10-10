## 10C.13 Defer Traps

### Defer in Loops: Resource Exhaustion

Deferred calls in loops do not execute until the surrounding function returns, not at the end of each iteration. Accumulating deferred file or connection closes in a loop exhausts file descriptors before any are released.

```go
package main

import (
    "fmt"
    "os"
)

// DISASTER: defer in a loop does NOT run until the function returns
// If this processes 10,000 files, all 10,000 file handles stay open simultaneously
func processFilesBAD(paths []string) error {
    for _, path := range paths {
        f, err := os.Open(path)
        if err != nil {
            return err
        }
        defer f.Close() // BUG: runs when processFilesBAD returns, NOT each iteration
        // process f...
    }
    return nil
}

// FIX 1: Use a helper function so defer runs per iteration
func processFilesGood(paths []string) error {
    for _, path := range paths {
        if err := processOneFile(path); err != nil {
            return err
        }
    }
    return nil
}

func processOneFile(path string) error {
    f, err := os.Open(path)
    if err != nil {
        return err
    }
    defer f.Close() // runs when processOneFile returns, once per file
    fmt.Println("processing", path)
    return nil
}

// FIX 2: explicit close inside the loop.
// This works, but it is strictly weaker than FIX 1: any early return, any
// panic, any error path added later that forgets to close will leak the
// descriptor. FIX 1 is the one to reach for, because it makes the cleanup
// impossible to skip.
func processFilesExplicit(paths []string) error {
    for _, path := range paths {
        f, err := os.Open(path)
        if err != nil {
            return err
        }
        // process f...
        fmt.Println("processing", path)
        f.Close() // no defer, so it closes now
    }
    return nil
}
```

### Defer Argument Evaluation Timing

Function arguments passed to `defer` are evaluated immediately when the `defer` statement executes, not when the deferred function runs. This surprises developers who expect values to be captured at function exit.

```go
package main

import "fmt"

func main() {
    x := 10

    // TRAP: defer evaluates arguments IMMEDIATELY at the defer statement
    // but runs the function body LATER
    defer fmt.Println("deferred x =", x) // x is captured as 10 RIGHT NOW

    x = 20
    fmt.Println("x =", x)
    // Output:
    // x = 20
    // deferred x = 10  ← surprise! not 20
}

func trapVsCapture() {
    x := 10

    // TRAP: the argument is evaluated at defer time
    defer fmt.Println(x) // prints 10, not 20

    // CAPTURE via closure: x is read when the defer actually runs
    defer func() {
        fmt.Println(x) // prints 20, the closure captures the variable
    }()

    x = 20

    // Output is 20 then 10. Defers run last-in-first-out, so the closure
    // registered second runs first. Order matters as much as timing here.
}

// Defer with named return values, which the deferred func can modify
func deferModifyReturn() (result int) {
    defer func() {
        result++ // this DOES modify the returned value
    }()
    return 10 // sets result=10, then the defer runs and makes it 11
}
```

### Panic Recovery in Defers

`recover()` stops a panic only when it is called directly by a function that the panic is unwinding through, and only in the same goroutine. It cannot reach across goroutines: a panic in a goroutine you spawned is not catchable from the one that spawned it, and an unhandled panic anywhere takes down the whole process, not just its goroutine.

```go
package main

import (
    "fmt"
    "log"
)

// recover() only works when called DIRECTLY inside a deferred function
func safeExecute(fn func()) (err error) {
    defer func() {
        if r := recover(); r != nil {
            err = fmt.Errorf("recovered panic: %v", r)
        }
    }()
    fn()
    return nil
}

// TRAP: recover in a nested function does NOT catch the panic
func brokenRecover() {
    defer func() {
        helper := func() {
            if r := recover(); r != nil { // this does NOT work
                fmt.Println("recovered:", r)
            }
        }
        // recover() returns nil here, because helper is not the function
        // the panic is unwinding. Only the deferred func itself qualifies.
        helper()
    }()
    panic("boom") // NOT caught, the process dies
}

// CORRECT: recover must be called directly by the deferred function
func correctRecover() {
    defer func() {
        if r := recover(); r != nil { // directly in the deferred func, so it works
            log.Printf("recovered: %v", r)
        }
    }()
    panic("boom") // caught!
}
```

---
