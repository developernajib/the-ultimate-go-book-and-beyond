## 10C.26 Break Statement Behavior in Switch/Select

### The Disaster

In Go, `break` inside a `switch` or `select` terminates only that statement, not any enclosing `for` loop. Engineers coming from C, Java, or JavaScript naturally expect `break` to exit the loop, so this code processes all values including those after the sentinel, a logic bug that looks syntactically correct.

```go
package main

import "fmt"

func main() {
    // WRONG: break exits the switch, not the for loop, so the sentinel never
    // stops iteration and every value gets processed
    values := []int{1, 2, 3, -1, 4, 5}

    for _, v := range values {
        switch {
        case v == -1:
            fmt.Println("found sentinel value, stopping...")
            break // BUG: this breaks the SWITCH, not the for loop!
        default:
            fmt.Printf("processing %d\n", v)
        }
        // Execution continues here even after break!
        fmt.Printf("after switch, v=%d\n", v)
    }
    // Output: processes ALL values including 4 and 5!
    // The break on -1 only skipped the rest of that switch case.
}
```

### Why It's Dangerous

- Go's `break` here behaves exactly like C's: it exits the `switch`. The trap is not the semantics, it is the habit. In C, cases fall through, so `break` is mandatory at the end of nearly every case and your fingers type it without thought. Go does not fall through, so that same `break` is a no-op, and a no-op that looks like control flow is worse than no statement at all.
- `break` inside `switch` exits only the `switch`, and code **after** the `switch` still runs for that iteration
- `break` inside `select` exits only the `select`, and the enclosing `for` goes right back around
- The `select` case is the one that hangs: `for { select { case <-done: break } }` spins forever, because `break` returns to the top of the loop instead of leaving it
- The bug is silent. No panic, no vet warning, no error. Just a loop that does not stop.

### The Fix: Labeled Break

Go's labeled `break` statement specifies which enclosing statement to exit. Attach a label to the `for` loop, then use `break Label` inside the `switch` or `select` to exit the loop rather than just the inner statement.

```go
package main

import "fmt"

func main() {
    values := []int{1, 2, 3, -1, 4, 5}

    // CORRECT: Use a labeled break to exit the outer for loop
OuterLoop:
    for _, v := range values {
        switch {
        case v == -1:
            fmt.Println("found sentinel value, stopping...")
            break OuterLoop // exits the for loop, not just the switch
        default:
            fmt.Printf("processing %d\n", v)
        }
        fmt.Printf("after switch, v=%d\n", v)
    }
    fmt.Println("done, only 1, 2, 3 were processed")

    // Same issue with select inside a for loop:
    ch := make(chan int, 5)
    for i := range 5 {
        ch <- i
    }
    close(ch)

    // CORRECT: labeled break with select
ReadLoop:
    for {
        select {
        case v, ok := <-ch:
            if !ok {
                break ReadLoop // exits the for loop when channel is closed
            }
            fmt.Printf("received: %d\n", v)
        }
    }
    fmt.Println("channel drained")
}
```

**The Rule:** a bare `break` inside a `switch` or `select` that sits inside a `for` loop is nearly always a bug. Either it does nothing (end of a Go switch case, where there is no fallthrough to stop) or it does the wrong thing (returns to the top of the loop you meant to leave). Read every one you find as a question about intent.

One caveat on the labeled form: a label is the right tool for escaping a `select`, since there is no alternative. For a `switch` in a loop, prefer restructuring. `break OuterLoop` works, but a guard clause with a plain `return`, or hoisting the sentinel check out of the switch, usually reads better than asking the reader to find a label twenty lines up.

---
