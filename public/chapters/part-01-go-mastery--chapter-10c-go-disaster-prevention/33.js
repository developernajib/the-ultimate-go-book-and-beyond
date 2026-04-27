export default `## 10C.32 Recover Only Works in Deferred Functions

\`recover()\` is Go's mechanism for catching panics, but it has a strict requirement: it **only works when called directly inside a deferred function**. If you call \`recover()\` from a helper function invoked by a deferred function, or from a non-deferred context, it silently returns \`nil\` - no panic is caught, the program crashes anyway.

### The Disaster

\`recover()\` only intercepts a panic when called directly within a deferred function on the same goroutine stack frame where the panic occurred. Calling \`recover()\` from a helper function invoked by \`defer\` adds an extra stack frame, causing \`recover()\` to return \`nil\` silently, the panic propagates and crashes the program as if no recovery was attempted.

\`\`\`go
package main

import "fmt"

// WRONG: recover in a helper function called from defer - does NOT work
func handlePanic() {
    r := recover() // returns nil! Not called directly by a deferred function.
    if r != nil {
        fmt.Println("recovered:", r)
    }
}

func doWorkBroken() {
    defer handlePanic() // handlePanic calls recover, but recover is not
                        // in the deferred function itself - it's one level deeper
    panic("something went wrong")
}

// WRONG: recover in a nested function inside defer - does NOT work
func doWorkAlsoBroken() {
    defer func() {
        // Calling a helper that calls recover - recover returns nil
        nestedRecover := func() interface{} {
            return recover() // nil! Not called directly by the deferred function
        }
        r := nestedRecover()
        if r != nil {
            fmt.Println("recovered:", r) // never prints
        }
    }()
    panic("crash")
}

// WRONG: recover outside of any defer - does nothing
func doWorkNotDeferred() {
    r := recover() // always returns nil when not in a deferred function
    _ = r
    panic("crash") // this panic is NOT caught
}

func main() {
    // All of these crash with an unrecovered panic:

    // doWorkBroken()       // PANIC - recover didn't catch it
    // doWorkAlsoBroken()   // PANIC - recover didn't catch it
    // doWorkNotDeferred()  // PANIC - recover didn't catch it

    fmt.Println("this line never executes if any of the above are uncommented")
}
\`\`\`

### Why This Is Dangerous

- \`recover()\` silently returns \`nil\` when called incorrectly, no warning, no error
- Engineers write "safe" wrappers that appear to handle panics but do not
- The bug only manifests when a panic actually occurs, often only in production
- Code reviews miss it because the pattern "looks right" at a glance

### The Fix: Call recover() Directly in the Deferred Function

Place the \`recover()\` call directly inside the deferred function body. If you need a reusable recovery pattern, make the entire function the deferred call target rather than wrapping \`recover()\` in a helper.

\`\`\`go
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

// CORRECT: recover in a named deferred function that itself calls recover
// Note: the function passed to defer must directly call recover
func doWorkWithNamedDefer() {
    defer recoverFromPanic() // this works because recoverFromPanic IS the deferred function
    panic("crash")
}

func recoverFromPanic() {
    if r := recover(); r != nil { // works: recover is in the deferred function itself
        log.Printf("recovered from panic: %v", r)
    }
}

func main() {
    doWorkFixed()         // prints: recovered: something went wrong
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
\`\`\`

**The Rule:** \`recover()\` must be called directly in the body of the function passed to \`defer\`. Not in a function called by it, not in a nested closure, and not outside of \`defer\` entirely. If you need a reusable recovery pattern, make it the deferred function itself.

---
`;
