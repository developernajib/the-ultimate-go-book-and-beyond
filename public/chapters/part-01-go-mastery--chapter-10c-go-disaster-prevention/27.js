export default `## 10C.26 Break Statement Behavior in Switch/Select

### The Disaster

In Go, \`break\` inside a \`switch\` or \`select\` terminates only that statement, not any enclosing \`for\` loop. Engineers coming from C, Java, or JavaScript naturally expect \`break\` to exit the loop, so this code processes all values including those after the sentinel, a logic bug that looks syntactically correct.

\`\`\`go
package main

import "fmt"

func main() {
    // WRONG: This loop runs FOREVER because break exits the switch, not the for loop
    values := []int{1, 2, 3, -1, 4, 5}

    for _, v := range values {
        switch {
        case v == -1:
            fmt.Println("found sentinel value, stopping...")
            break // BUG: this breaks the SWITCH, not the for loop!
        default:
            fmt.Printf("processing %d\\n", v)
        }
        // Execution continues here even after break!
        fmt.Printf("after switch, v=%d\\n", v)
    }
    // Output: processes ALL values including 4 and 5!
    // The break on -1 only skipped the rest of that switch case.
}
\`\`\`

### Why It's Dangerous

- In C/Java, \`break\` in a switch also exits the switch, but the mental model is the same
- In Go, \`break\` inside \`switch\` only exits the \`switch\` - code **after** the \`switch\` still runs
- In Go, \`break\` inside \`select\` only exits the \`select\` - the for loop continues
- This leads to infinite loops or loops that process items they should have skipped
- The bug is silent: no panic, no error, just wrong behavior

### The Fix: Labeled Break

Go's labeled \`break\` statement specifies which enclosing statement to exit. Attach a label to the \`for\` loop, then use \`break Label\` inside the \`switch\` or \`select\` to exit the loop rather than just the inner statement.

\`\`\`go
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
            fmt.Printf("processing %d\\n", v)
        }
        fmt.Printf("after switch, v=%d\\n", v)
    }
    fmt.Println("done - only processed 1, 2, 3")

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
            fmt.Printf("received: %d\\n", v)
        }
    }
    fmt.Println("channel drained")
}
\`\`\`

**The Rule:** Whenever you have \`break\` inside a \`switch\` or \`select\` that is inside a \`for\` loop, you almost always need a labeled break. If you see a bare \`break\` inside \`switch\`/\`select\`, question whether it does what the author intended.

---
`;
