export default `## 10C.12 Closure Variable Capture Disasters

When you create a closure (an anonymous function that references variables from its enclosing scope), the closure captures the variable **by reference**, not by value. This means the closure sees whatever value the variable holds at the time it executes, not when it was created. This is especially dangerous with goroutines launched inside loops: by the time the goroutines actually run, the loop variable has already advanced to its final value, so all goroutines see the same value. Go 1.22 fixed this for \`for range\` loops, but understanding the mechanism is still essential.

### The Classic Goroutine Loop Bug

The classic loop variable capture bug captures the loop variable's address rather than its value at goroutine launch time. By the time goroutines run, the loop has completed and the variable holds its final value.

\`\`\`go
package main

import (
    "fmt"
    "sync"
)

func main() {
    var wg sync.WaitGroup

    // DISASTER: all goroutines capture the SAME variable i
    // By the time goroutines run, the loop has finished and i=5
    for i := 0; i < 5; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            fmt.Println(i) // prints 5 5 5 5 5 (or some permutation) NOT 0 1 2 3 4
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

    // NOTE: In Go 1.22+, range loop variables are per-iteration by default
    // for i := range 5 { go func() { fmt.Println(i) }() } - correct in Go 1.22+
}
\`\`\`

### Closure Over Mutable Struct Fields

Closures that capture a struct by pointer see concurrent mutations to its fields. When goroutines share a pointer to a mutated struct, a data race results even if individual field accesses appear safe in isolation.

\`\`\`go
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

    // DISASTER: t is the loop variable; all closures capture the same &t
    for _, t := range tasks {
        wg.Add(1)
        go func() {
            defer wg.Done()
            fmt.Println(t.ID, t.Name) // may print 3 C three times!
        }()
    }
    wg.Wait()

    fmt.Println("---")

    // FIX: Pass as argument
    for _, t := range tasks {
        wg.Add(1)
        go func(task Task) {
            defer wg.Done()
            fmt.Println(task.ID, task.Name) // correct
        }(t)
    }
    wg.Wait()
}
\`\`\`

---
`;
