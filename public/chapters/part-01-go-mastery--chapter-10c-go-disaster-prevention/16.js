export default `## 10C.15 Time Zone Handling Disasters

Time handling in Go has several non-obvious traps that only surface in production. \`time.Parse\` defaults to UTC even if your server is in a different timezone. Adding hours with \`time.Add\` does not account for Daylight Saving Time transitions. Comparing two \`time.Time\` values with \`==\` can return \`false\` even when they represent the same instant, because \`==\` also compares timezone metadata. Additionally, using \`time.After\` in a \`select\` loop creates a new timer on every iteration that leaks memory until it fires.

\`\`\`go
package main

import (
    "fmt"
    "time"
)

func main() {
    // TRAP 1: time.Parse uses UTC for timezone if no timezone in format
    t, _ := time.Parse("2006-01-02", "2024-03-15")
    fmt.Println(t.Location()) // UTC - even if you're in New York!

    // CORRECT: Specify location
    loc, _ := time.LoadLocation("America/New_York")
    t2, _ := time.ParseInLocation("2006-01-02", "2024-03-15", loc)
    fmt.Println(t2.Location()) // America/New_York

    // TRAP 2: time.Now() + date math ignores DST
    nyLoc, _ := time.LoadLocation("America/New_York")
    before := time.Date(2024, 3, 10, 1, 30, 0, 0, nyLoc) // 1:30 AM before DST
    after := before.Add(24 * time.Hour)                    // add exactly 24h
    fmt.Println(after) // 2:30 AM - correct for hours, but DST changed at 2AM!
    // If you wanted "same time tomorrow", use AddDate(0, 0, 1) instead
    tomorrow := before.AddDate(0, 0, 1) // correctly handles DST - gives 1:30 AM
    fmt.Println(tomorrow)

    // TRAP 3: time.Equal vs == for time comparison
    t3 := time.Now()
    t4 := t3.UTC()
    fmt.Println(t3 == t4)       // FALSE! different timezone metadata
    fmt.Println(t3.Equal(t4))   // TRUE - same moment in time, different timezone

    // TRAP 4: time.Time is not comparable with == across timezones - use Equal
    var times []time.Time
    times = append(times, t3, t4)
    // sort.Slice(times, func(i, j int) bool { return times[i].Before(times[j]) })

    // TRAP 5: time.After() in select creates a timer leak
    // Every time.After() creates a new Timer that is never garbage collected
    // until it fires (even if the select case is never taken)
    // for { select { case <-time.After(1*time.Second): ... } } // LEAKS TIMERS!

    // CORRECT: Use time.NewTimer and reset it
    timer := time.NewTimer(1 * time.Second)
    defer timer.Stop() // always stop to release resources
    select {
    case <-timer.C:
        fmt.Println("timer fired")
    }
}
\`\`\`

---
`;
