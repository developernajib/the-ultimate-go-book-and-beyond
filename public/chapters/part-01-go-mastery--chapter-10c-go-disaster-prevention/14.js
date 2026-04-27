export default `## 10C.13 Defer Traps

### Defer in Loops: Resource Exhaustion

Deferred calls in loops do not execute until the surrounding function returns, not at the end of each iteration. Accumulating deferred file or connection closes in a loop exhausts file descriptors before any are released.

\`\`\`go
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
    defer f.Close() // runs when processOneFile returns - correct!
    fmt.Println("processing", path)
    return nil
}

// FIX 2: Explicit close within the loop
func processFilesExplicit(paths []string) error {
    for _, path := range paths {
        f, err := os.Open(path)
        if err != nil {
            return err
        }
        // process f...
        fmt.Println("processing", path)
        f.Close() // explicit close - runs immediately
    }
    return nil
}
\`\`\`

### Defer Argument Evaluation Timing

Function arguments passed to \`defer\` are evaluated immediately when the \`defer\` statement executes, not when the deferred function runs. This surprises developers who expect values to be captured at function exit.

\`\`\`go
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

    // TRAP: argument evaluated at defer time
    defer fmt.Println(x) // prints 10, not 20

    // CAPTURE via closure: evaluates x when the defer runs
    defer func() {
        fmt.Println(x) // prints 20 - closure captures x by reference
    }()

    x = 20
}

// Defer with named return values - can modify the return value
func deferModifyReturn() (result int) {
    defer func() {
        result++ // this DOES modify the return value!
    }()
    return 10 // sets result=10, then defer runs and makes it 11
}
\`\`\`

### Panic Recovery in Defers

A deferred function that calls \`recover()\` catches panics from the enclosing goroutine. Without this pattern, an unhandled panic terminates the entire process, not just the goroutine where it occurred.

\`\`\`go
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
        helper() // recover inside a nested call - does NOT catch the panic
    }()
    panic("boom") // this will NOT be caught!
}

// CORRECT: recover must be directly in the deferred function
func correctRecover() {
    defer func() {
        if r := recover(); r != nil { // directly in the deferred func - works!
            log.Printf("recovered: %v", r)
        }
    }()
    panic("boom") // caught!
}
\`\`\`

---
`;
