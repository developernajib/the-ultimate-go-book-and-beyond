## 10C.15 Time Zone Handling Disasters

Time handling in Go has several non-obvious traps that only surface in production. `time.Parse` defaults to UTC even if your server is in a different timezone. Adding hours with `time.Add` does not account for Daylight Saving Time transitions. Comparing two `time.Time` values with `==` can return `false` even when they represent the same instant, because `==` compares the struct fields, including the location pointer and the monotonic clock reading, rather than the instant.

```go
package main

import (
    "fmt"
    "time"
)

func main() {
    // TRAP 1: time.Parse uses UTC for timezone if no timezone in format
    t, _ := time.Parse("2006-01-02", "2024-03-15")
    fmt.Println(t.Location()) // UTC, no matter where the server sits

    // CORRECT: Specify location
    loc, _ := time.LoadLocation("America/New_York")
    t2, _ := time.ParseInLocation("2006-01-02", "2024-03-15", loc)
    fmt.Println(t2.Location()) // America/New_York

    // TRAP 2: Add() does elapsed-time math, not calendar math.
    // Add(24*time.Hour) means "24 hours of real time later", which is a
    // different question from "the same wall-clock time tomorrow". They
    // give different answers on the two days a year DST shifts.
    nyLoc, _ := time.LoadLocation("America/New_York")
    before := time.Date(2024, 3, 10, 1, 30, 0, 0, nyLoc) // 1:30 AM EST, spring-forward day
    after := before.Add(24 * time.Hour)
    fmt.Println(after) // 2:30 AM EDT: 24 real hours passed, but the clocks
                       // jumped 2AM to 3AM overnight, so the wall time slid

    // If you meant "same time tomorrow", that is calendar math: AddDate.
    tomorrow := before.AddDate(0, 0, 1)
    fmt.Println(tomorrow) // 1:30 AM EDT, only 23 real hours later

    // AddDate has its own trap: it normalizes overflow rather than clamping.
    // There is no January 31 + 1 month, so you get March 2 or 3, not
    // February 28. "Last day of next month" is not a thing Add or AddDate
    // will do for you.
    jan31 := time.Date(2024, 1, 31, 0, 0, 0, 0, time.UTC)
    fmt.Println(jan31.AddDate(0, 1, 0)) // 2024-03-02, not 2024-02-29

    // TRAP 3: == compares struct fields, Equal compares instants.
    // time.Time holds a wall clock, a location pointer, and possibly a
    // monotonic reading. == compares all of it. Two values can denote the
    // very same instant and still be unequal.
    t3 := time.Now()
    t4 := t3.UTC()
    fmt.Println(t3 == t4)     // false: different location, and UTC() strips the monotonic reading
    fmt.Println(t3.Equal(t4)) // true: same instant
    // Always use Equal, Before, and After. Never ==. This also means
    // time.Time is a poor map key, since two keys for the same instant will
    // land in different buckets.

    // TRAP 4: the monotonic clock is stripped by more operations than you expect.
    // time.Now() carries a monotonic reading, which is what makes Sub()
    // immune to wall-clock jumps (NTP steps, an operator setting the clock).
    // But UTC(), In(), Round(), Truncate(), and any round trip through
    // marshaling all strip it, silently downgrading later Sub() calls to
    // wall-clock subtraction.
    start := time.Now()
    stripped := start.Round(0) // the documented way to drop monotonic, on purpose
    _ = stripped
    elapsed := time.Since(start) // monotonic, correct even if the clock jumps
    fmt.Println(elapsed)

    // TRAP 5: time.After in a select loop.
    // Before Go 1.23 this leaked: each iteration allocated a Timer that the
    // runtime held until it fired, so a 1-hour timeout in a hot loop pinned
    // an hour's worth of timers. Go 1.23 changed timers to be ordinary
    // garbage, collectable as soon as nothing references them, which removed
    // the leak on this book's baseline.
    //
    // The pattern is still worth avoiding in a hot loop, for a plainer
    // reason: it allocates a fresh timer per iteration and restarts the
    // timeout each time, which is rarely the deadline you meant. Reuse one
    // timer when you want one deadline:
    timer := time.NewTimer(1 * time.Second)
    defer timer.Stop()
    <-timer.C
    fmt.Println("timer fired")
}
```

---
