## 10C.22 select with Default, Non-Blocking vs Blocking

The `select` statement in Go waits for one of several channel operations to become ready. Adding a `default` case fundamentally changes its behavior: without `default`, `select` blocks until a channel is ready. With `default`, it executes the `default` case immediately if no channel is ready, making the entire `select` non-blocking. This seemingly small difference can cause your program to miss incoming messages entirely, burn CPU in a tight spin loop, or behave completely differently from what you intended.

```go
package main

import (
    "fmt"
    "time"
)

func main() {
    ch := make(chan int, 1)

    // select WITHOUT default: blocks until some case is ready.
    // select WITH default: never blocks, and takes default the instant no
    // case is ready. Note "ready right now", not "ready soon". A sender
    // one microsecond away is indistinguishable from a sender that will
    // never come.

    // TRAP: default turns a wait into a poll, and the poll always loses
    for range 3 {
        select {
        case v := <-ch:
            fmt.Println("received:", v)
        default:
            fmt.Println("no message available") // ch is empty, so this fires
        }
    }
    // Prints "no message available" three times. All three iterations run in
    // well under a microsecond, so a producer goroutine that is about to
    // send never gets a chance to be scheduled.

    // THE WORSE SHAPE: default inside a for loop with nothing to do is a
    // busy-wait. It pins a core at 100% to accomplish nothing, and starves
    // the very producer it is waiting on.
    //
    //   for {
    //       select {
    //       case v := <-ch:
    //           handle(v)
    //       default: // spins, burning CPU
    //       }
    //   }
    //
    // Deleting the default fixes it. A blocked select costs nothing: the
    // goroutine parks and the runtime wakes it when a case is ready. Reach
    // for default only when you have real work to do in the meantime.

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
```

---
