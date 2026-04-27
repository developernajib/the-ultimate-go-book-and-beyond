export default `## 10C.30 Wrong Time Duration

\`time.Duration\` in Go is defined as \`int64\` nanoseconds. When you write \`time.Sleep(5)\`, you are sleeping for 5 **nanoseconds** - not 5 seconds, not 5 milliseconds. This catches virtually every new Go developer.

### The Disaster

\`time.Duration\` is \`int64\` nanoseconds, so \`time.Sleep(5)\` sleeps for 5 nanoseconds, no sleep at all. The bug never triggers a compile error and produces no visible output difference in simple programs, making it a persistent source of timeouts and rate-limiting logic that silently does nothing.

\`\`\`go
package main

import (
    "fmt"
    "time"
)

func main() {
    // WRONG: sleeps for 5 nanoseconds, not 5 seconds!
    fmt.Println("sleeping for '5 seconds'...")
    start := time.Now()
    time.Sleep(5) // 5 nanoseconds - completes instantly
    fmt.Printf("slept for %v\\n", time.Since(start)) // ~0s

    // WRONG: ticker fires every 1000 nanoseconds (1 microsecond), not every second!
    ticker := time.NewTicker(1000) // 1000 nanoseconds = 1 microsecond
    defer ticker.Stop()

    // WRONG: timeout of 30 nanoseconds - will always time out
    timer := time.NewTimer(30) // 30 nanoseconds
    defer timer.Stop()

    // WRONG: context with 500 nanosecond deadline - always expires
    // ctx, cancel := context.WithTimeout(context.Background(), 500) // 500 ns!

    // WHY: time.Duration is defined as:
    //   type Duration int64  (in nanoseconds)
    //
    // So time.Sleep(5) == time.Sleep(5 * time.Nanosecond)
    //
    // The constants in the time package convert for you:
    //   time.Nanosecond  = 1
    //   time.Microsecond = 1000
    //   time.Millisecond = 1_000_000
    //   time.Second      = 1_000_000_000
    //   time.Minute      = 60_000_000_000
    //   time.Hour        = 3_600_000_000_000
}
\`\`\`

### Why It's Dangerous

- Code appears to work but timers and sleeps fire at the wrong time
- Tests may pass (because nanosecond sleeps still "complete") but production behavior is wrong
- Rate limiters configured with raw integers allow thousands of requests per second instead of the intended rate
- Timeouts expire instantly, causing spurious failures under any load

### The Fix: Always Use Duration Constants

Always multiply by the appropriate \`time\` constant to convert human-readable units into nanosecond-based \`Duration\` values.

\`\`\`go
package main

import (
    "context"
    "fmt"
    "time"
)

func main() {
    // CORRECT: use duration constants
    time.Sleep(5 * time.Second)              // 5 seconds
    time.Sleep(100 * time.Millisecond)       // 100 milliseconds
    time.Sleep(time.Second / 2)              // 500 milliseconds (half a second)

    // CORRECT: tickers and timers
    ticker := time.NewTicker(1 * time.Second) // fires every 1 second
    defer ticker.Stop()

    timer := time.NewTimer(30 * time.Second)  // fires after 30 seconds
    defer timer.Stop()

    // CORRECT: context timeout
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()
    _ = ctx

    // CORRECT: computing duration from a variable
    seconds := 10
    time.Sleep(time.Duration(seconds) * time.Second)

    // WRONG way to compute from variable:
    // time.Sleep(time.Second * time.Duration(seconds))
    // Actually this is also correct - multiplication is commutative.
    // But NEVER do this:
    // time.Sleep(time.Duration(seconds))  // seconds as nanoseconds!

    // CORRECT: parsing duration from a string
    d, err := time.ParseDuration("2h30m")
    if err == nil {
        fmt.Println("parsed duration:", d) // 2h30m0s
    }
}
\`\`\`

**The Rule:** Never pass a bare integer to any function expecting \`time.Duration\`. Always multiply by \`time.Second\`, \`time.Millisecond\`, etc. If you have a numeric variable, convert with \`time.Duration(n) * time.Second\`.

---
`;
