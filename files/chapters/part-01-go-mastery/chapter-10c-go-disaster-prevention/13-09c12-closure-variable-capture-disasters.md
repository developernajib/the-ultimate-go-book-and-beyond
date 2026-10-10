## 10C.12 Closure Variable Capture Disasters

When you create a closure (an anonymous function that references variables from its enclosing scope), the closure captures the variable **by reference**, not by value. This means the closure sees whatever value the variable holds at the time it executes, not when it was created. This is especially dangerous with goroutines launched inside loops: on Go 1.21 and earlier, by the time the goroutines actually ran, the loop variable had already advanced to its final value, so all goroutines saw the same value. Go 1.22 fixed this for every `for` loop that declares its variable with `:=` (both the three-clause and the range forms), so the classic bug no longer reproduces on the book's Go 1.27 baseline. Understanding the mechanism still matters for two reasons: you will read pre-1.22 code, and the fix was narrower than most people remember. Only the loop variable became per-iteration. Every other variable a closure captures behaves exactly as it always did, as the second example shows.

### The Classic Goroutine Loop Bug

The classic loop variable capture bug captures the loop variable's address rather than its value at goroutine launch time. By the time goroutines run, the loop has completed and the variable holds its final value.

```go
package main

import (
    "fmt"
    "sync"
)

func main() {
    var wg sync.WaitGroup

    // PRE-1.22 DISASTER: on Go 1.21 and earlier every goroutine captured the
    // SAME variable i, so once the loop finished they all saw i=5
    for i := 0; i < 5; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            fmt.Println(i) // Go <=1.21: 5 5 5 5 5 - Go 1.22+: 0-4 (per-iteration, fixed)
        }()
    }
    wg.Wait()

    fmt.Println("---")

    // FIX 1: Pass i as an argument to the goroutine (copies the value)
    for i := 0; i < 5; i++ {
        wg.Add(1)
        go func(n int) { // n is a copy of i at the time of the call
            defer wg.Done()
            fmt.Println(n) // prints 0 1 2 3 4 (in some order)
        }(i)
    }
    wg.Wait()

    fmt.Println("---")

    // FIX 2: Create a new variable in the loop body (Go 1.22+ fixes this by default)
    for i := 0; i < 5; i++ {
        i := i // shadow: creates a new variable scoped to this iteration
        wg.Add(1)
        go func() {
            defer wg.Done()
            fmt.Println(i) // correct: 0 1 2 3 4
        }()
    }
    wg.Wait()

    // NOTE: in Go 1.22+, ALL loop variables declared with := (both the
    // three-clause for and range) are per-iteration by default. So
    // `for i := range 5 { go func() { fmt.Println(i) }() }` is correct now.
    // The semantics key off the module's go directive in go.mod, not the
    // toolchain version, so a module still declaring `go 1.21` compiles with
    // the OLD sharing behavior even under a Go 1.27 toolchain. Check go.mod
    // before assuming a loop is safe.
}
```

### The Variant Go 1.22 Did Not Fix

Go 1.22 made the *loop variable* per-iteration. It did nothing for any other variable a closure captures. A variable declared outside the loop is still one variable, shared by every goroutine, and this version of the bug reproduces perfectly on Go 1.27. The 1.22 change is easy to over-generalize into "closures in loops are safe now," which is what makes the following code so easy to miss in review.

```go
package main

import (
    "fmt"
    "sync"
)

type Task struct {
    ID   int
    Name string
}

func main() {
    tasks := []Task{{1, "A"}, {2, "B"}, {3, "C"}}
    var wg sync.WaitGroup

    // STILL BROKEN ON Go 1.27: t is declared before the loop, so the
    // per-iteration rule never applies to it. All three goroutines close
    // over the same t, and they race with the loop that keeps assigning it.
    var t Task
    for _, t = range tasks { // note: `=`, not `:=`
        wg.Add(1)
        go func() {
            defer wg.Done()
            fmt.Println(t.ID, t.Name) // data race, output unpredictable
        }()
    }
    wg.Wait()

    fmt.Println("---")

    // Same shape, no range in sight. An accumulator mutated by the loop and
    // read by the goroutines is the exact same bug wearing a different hat.
    counter := 0
    for range tasks {
        wg.Add(1)
        go func() {
            defer wg.Done()
            counter++ // data race on a single shared variable
        }()
    }
    wg.Wait()

    fmt.Println("---")

    // FIX: pass the value as an argument, which copies it at call time.
    // This works regardless of where the variable was declared or which Go
    // version you are on, which is why it remains the safest habit.
    for _, task := range tasks {
        wg.Add(1)
        go func(task Task) {
            defer wg.Done()
            fmt.Println(task.ID, task.Name) // correct
        }(task)
    }
    wg.Wait()
}
```

The rule that survives every Go version: `go vet` and the 1.22 change catch the loop-variable shape only. Any other captured variable is still yours to reason about, and `-race` is what proves you got it right.

---
