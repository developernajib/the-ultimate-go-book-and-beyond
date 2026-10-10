## 10C.30 Wrong Time Duration

`time.Duration` in Go is defined as `int64` nanoseconds. When you write `time.Sleep(5)`, you sleep for 5 **nanoseconds**. Not 5 seconds, not 5 milliseconds. This catches virtually every new Go developer.

### The Disaster

`time.Duration` is `int64` nanoseconds, so `time.Sleep(5)` sleeps for 5 nanoseconds, no sleep at all. The bug never triggers a compile error and produces no visible output difference in simple programs, making it a persistent source of timeouts and rate-limiting logic that silently does nothing.

```go
package main

import (
    "fmt"
    "time"
)

func main() {
    // WRONG: sleeps for 5 nanoseconds
    fmt.Println("sleeping for '5 seconds'...")
    start := time.Now()
    time.Sleep(5)                                   // 5 nanoseconds, effectively instant
    fmt.Printf("slept for %v\n", time.Since(start)) // ~0s

    // WRONG: fires every microsecond, not every second
    ticker := time.NewTicker(1000) // 1000 ns = 1 µs
    defer ticker.Stop()

    // WRONG: 30 nanoseconds, so it has already expired by the time you select on it
    timer := time.NewTimer(30)
    defer timer.Stop()

    // WRONG: a 500 ns deadline, so every request times out
    // ctx, cancel := context.WithTimeout(context.Background(), 500)

    // WHY: time.Duration is defined as:
    //   type Duration int64  (in nanoseconds)
    //
    // So time.Sleep(5) == time.Sleep(5 * time.Nanosecond).
    //
    // Note precisely WHY the compiler allows it: 5 is an untyped constant,
    // so it converts to Duration implicitly. This is the same rule that
    // makes `5 * time.Second` work, and you cannot have one without the
    // other. It is also why the bug only appears with literals:
    //
    //   n := 5
    //   time.Sleep(n) // compile error: cannot use n (int) as time.Duration
    //
    // The typed variable is caught. The literal never is, and neither
    // `go vet` nor any standard linter flags it.
    //
    // The constants in the time package convert for you:
    //   time.Nanosecond  = 1
    //   time.Microsecond = 1000
    //   time.Millisecond = 1_000_000
    //   time.Second      = 1_000_000_000
    //   time.Minute      = 60_000_000_000
    //   time.Hour        = 3_600_000_000_000
}
```

### Why It's Dangerous

- Code appears to work but timers and sleeps fire at the wrong time
- Tests may pass (because nanosecond sleeps still "complete") but production behavior is wrong
- Rate limiters configured with raw integers allow thousands of requests per second instead of the intended rate
- Timeouts expire instantly, causing spurious failures under any load

### The Fix: Always Use Duration Constants

Always multiply by the appropriate `time` constant to convert human-readable units into nanosecond-based `Duration` values.

```go
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

    // CORRECT: computing a duration from a variable.
    // Convert the NUMBER, then multiply by the UNIT.
    seconds := 10
    time.Sleep(time.Duration(seconds) * time.Second) // 10s

    // time.Second * time.Duration(seconds) is identical. Order does not
    // matter, only that the conversion and the unit are both present.
    //
    // The trap is the conversion WITHOUT the unit, which compiles cleanly
    // and is off by a factor of a billion:
    // time.Sleep(time.Duration(seconds)) // 10 nanoseconds

    // CORRECT: parsing a duration from a string. This is the right shape
    // for anything coming from config or a flag, since "30s" cannot be
    // silently misread as 30 nanoseconds the way a bare 30 can.
    d, err := time.ParseDuration("2h30m")
    if err == nil {
        fmt.Println("parsed duration:", d) // 2h30m0s
    }
    // flag.Duration does the same for command-line flags.
}
```

**The Rule:** Never pass a bare integer to any function expecting `time.Duration`. Always multiply by `time.Second`, `time.Millisecond`, etc. If you have a numeric variable, convert with `time.Duration(n) * time.Second`.

---
