export default `## 10C.22 select with Default, Non-Blocking vs Blocking

The \`select\` statement in Go waits for one of several channel operations to become ready. Adding a \`default\` case fundamentally changes its behavior: without \`default\`, \`select\` blocks until a channel is ready. With \`default\`, it executes the \`default\` case immediately if no channel is ready, making the entire \`select\` non-blocking. This seemingly small difference can cause your program to miss incoming messages entirely, burn CPU in a tight spin loop, or behave completely differently from what you intended.

\`\`\`go
package main

import (
    "fmt"
    "time"
)

func main() {
    ch := make(chan int, 1)

    // select WITHOUT default: BLOCKS until a case is ready
    // select WITH default: NEVER blocks - takes default immediately if no case ready

    // TRAP: using default makes the select non-blocking but may miss messages
    for range 3 {
        select {
        case v := <-ch:
            fmt.Println("received:", v)
        default:
            fmt.Println("no message available") // fires immediately if ch is empty
        }
    }
    // prints "no message available" three times even if data is incoming!

    // CORRECT pattern: timeout instead of default for timed waiting
    ch <- 42
    select {
    case v := <-ch:
        fmt.Println("received:", v) // 42
    case <-time.After(1 * time.Second):
        fmt.Println("timeout")
    }

    // CORRECT non-blocking check pattern (intentional default)
    select {
    case v := <-ch:
        fmt.Println("got value:", v)
    default:
        // channel was empty, do other work
        fmt.Println("channel empty, doing other work")
    }
}
\`\`\`

---
`;
