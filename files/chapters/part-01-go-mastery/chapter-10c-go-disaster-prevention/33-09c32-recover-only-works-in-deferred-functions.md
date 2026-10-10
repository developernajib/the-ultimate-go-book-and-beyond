## 10C.32 Recover Only Works in Deferred Functions

`recover()` is Go's mechanism for catching panics, and it has one strict requirement: it works only when called **directly by a deferred function**. Call it from a helper that a deferred function invokes, or from a non-deferred context, and it silently returns `nil`. No panic is caught, no warning is issued, and the program crashes exactly as if you had never tried.

### The Disaster

The rule turns on one word: *directly*. A deferred function may call `recover()` and catch the panic. A function that a deferred function calls may not, because that is one frame too far. The difference is invisible at the call site, and the failure is silent: `recover()` returns `nil`, the `if r != nil` guard reads as "no panic happened", and the panic keeps unwinding past code that looks like it handled it.

The same word rules out the other two cases. `recover()` outside any `defer` has no panic in flight to intercept. And `recover()` cannot cross goroutines, since each goroutine unwinds its own stack.

```go
package main

import "fmt"

// First, the rule stated exactly, because the usual folklore version
// ("recover only works inside a deferred func literal") is wrong and leads
// people to reject working code.
//
// The spec's condition is: recover() returns the panic value when it is
// called DIRECTLY BY a deferred function. "Directly by" is the whole rule.
// It says nothing about the deferred function being a literal, and nothing
// about being defined inline.

// WORKS: handlePanic IS the deferred function, and it calls recover itself.
// One named function, no extra frame. This is fine.
func handlePanic() {
    if r := recover(); r != nil {
        fmt.Println("recovered:", r)
    }
}

func doWorkNamed() {
    defer handlePanic() // recovers correctly
    panic("something went wrong")
}

// BROKEN: one frame too many. The deferred function is the literal, and it
// calls nestedRecover, which calls recover. recover is now called directly
// by nestedRecover, not by the deferred function, so it returns nil and the
// panic keeps unwinding.
func doWorkAlsoBroken() {
    defer func() {
        nestedRecover := func() any {
            return recover() // nil: called by nestedRecover, not by the deferred func
        }
        r := nestedRecover()
        if r != nil {
            fmt.Println("recovered:", r) // never prints
        }
    }()
    panic("crash")
}

// BROKEN: recover outside any defer. There is no panic in flight when this
// line runs, so it returns nil and does nothing at all.
func doWorkNotDeferred() {
    r := recover() // always nil here
    _ = r
    panic("crash") // nothing catches this
}

// BROKEN, and the one that reaches production: a panic in another goroutine.
// recover is per-goroutine. The deferred func below is on main's stack, and
// the panic is on a different stack entirely. Nothing connects them, and an
// unrecovered panic on any goroutine takes down the whole process.
func doWorkWrongGoroutine() {
    defer func() {
        if r := recover(); r != nil {
            fmt.Println("never prints:", r)
        }
    }()
    go func() {
        panic("crash on another goroutine") // process dies
    }()
    select {} // wait
}

func main() {
    doWorkNamed() // prints: recovered: something went wrong

    // These crash with an unrecovered panic:
    // doWorkAlsoBroken()     // one frame too deep
    // doWorkNotDeferred()    // not deferred
    // doWorkWrongGoroutine() // wrong goroutine
}
```

### Why This Is Dangerous

- `recover()` silently returns `nil` when called from the wrong place. No warning, no error, no vet check.
- The nil is indistinguishable from "no panic occurred", so the wrapper reports success while the process dies
- Engineers write "safe" wrappers that never catch anything, and the wrapper's existence discourages anyone from looking again
- It only manifests when a panic actually fires, which by definition is the path nobody tested
- Reviews miss it because the extra frame is the natural result of a refactor. Somebody factored the recover block out into a helper "for reuse" and broke it without touching a line of its logic.

### The Fix: Call recover() Directly in the Deferred Function

Place the `recover()` call directly inside the deferred function body. If you need a reusable recovery pattern, make the entire function the deferred call target rather than wrapping `recover()` in a helper.

```go
package main

import (
    "fmt"
    "log"
)

// CORRECT: recover called directly inside the deferred function
func doWorkFixed() {
    defer func() {
        if r := recover(); r != nil {
            fmt.Println("recovered:", r)
        }
    }()
    panic("something went wrong")
}

// CORRECT: if you need a reusable pattern, the deferred function must call recover
func safeExecute(fn func()) (err error) {
    defer func() {
        if r := recover(); r != nil { // recover is directly in the deferred func
            err = fmt.Errorf("panic recovered: %v", r)
        }
    }()
    fn()
    return nil
}

// CORRECT: a named function passed to defer. This is the reusable shape,
// and the one most often wrongly believed not to work. recoverFromPanic IS
// the deferred function, so its recover() call qualifies.
func doWorkWithNamedDefer() {
    defer recoverFromPanic()
    panic("crash")
}

func recoverFromPanic() {
    if r := recover(); r != nil {
        log.Printf("recovered from panic: %v", r)
    }
}

// The one-character difference that breaks it. Wrapping the same helper in
// a literal inserts a frame, and recover() goes nil:
//
//   defer func() { recoverFromPanic() }() // does NOT recover
//
// Reach for the literal only when you need to close over something, such as
// a named return, and then put recover() in the literal itself.

func main() {
    doWorkFixed()          // prints: recovered: something went wrong
    doWorkWithNamedDefer() // logs: recovered from panic: crash

    err := safeExecute(func() {
        panic("boom")
    })
    fmt.Println("error:", err) // error: panic recovered: boom

    err = safeExecute(func() {
        fmt.Println("no panic here")
    })
    fmt.Println("error:", err) // error: <nil>
}
```

**The Rule:** `recover()` must be called in the body of the function passed to `defer`. That function may be a literal or a named function, and both work. What never works is `recover()` one frame deeper, outside a `defer`, or on another goroutine. If you want a reusable recovery helper, pass it to `defer` directly rather than calling it from inside a wrapper.

---
