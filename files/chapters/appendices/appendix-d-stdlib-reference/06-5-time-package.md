## 5. time Package

### Time Basics

Go's `time.Time` represents an instant in time with nanosecond precision. Always store and compare times in UTC. Convert to local time only for display. Use `time.Now()` for the current time, `time.Date()` to construct a specific instant, and `time.Parse()` to read strings.

```go
package main

import (
    "fmt"
    "time"
)

func timeBasics() {
    // Current time
    now := time.Now()
    fmt.Println("Now:", now)

    // Create specific time
    t := time.Date(2024, time.January, 1, 12, 30, 0, 0, time.UTC)
    fmt.Println("Specific time:", t)

    // Parse time from string
    layout := "2006-01-02 15:04:05"
    parsed, _ := time.Parse(layout, "2024-01-01 12:30:00")
    fmt.Println("Parsed:", parsed)

    // Time components
    fmt.Println("Year:", now.Year())
    fmt.Println("Month:", now.Month())
    fmt.Println("Day:", now.Day())
    fmt.Println("Hour:", now.Hour())
    fmt.Println("Minute:", now.Minute())
    fmt.Println("Second:", now.Second())
    fmt.Println("Weekday:", now.Weekday())
    fmt.Println("Unix:", now.Unix())
    fmt.Println("UnixMilli:", now.UnixMilli())
    fmt.Println("UnixNano:", now.UnixNano())
}
```

### Time Formatting (Reference Time: Jan 2, 2006 at 3:04:05 PM MST)

```go
package main

import (
    "fmt"
    "time"
)

func timeFormatting() {
    t := time.Date(2024, 3, 15, 14, 30, 45, 0, time.UTC)

    // Common formats
    fmt.Println(t.Format("2006-01-02"))                 // 2024-03-15
    fmt.Println(t.Format("2006-01-02 15:04:05"))        // 2024-03-15 14:30:45
    fmt.Println(t.Format("Jan 2, 2006"))                // Mar 15, 2024
    fmt.Println(t.Format("Monday, January 2, 2006"))    // Friday, March 15, 2024
    fmt.Println(t.Format("15:04:05"))                   // 14:30:45
    fmt.Println(t.Format("3:04 PM"))                    // 2:30 PM
    fmt.Println(t.Format(time.RFC3339))                 // 2024-03-15T14:30:45Z
    fmt.Println(t.Format(time.RFC1123))                 // Fri, 15 Mar 2024 14:30:45 UTC

    // Custom format
    custom := "Monday, Jan 2, 2006 at 3:04:05.000 PM MST"
    fmt.Println(t.Format(custom))
}

// Predefined layouts
const (
    RFC3339Layout = "2006-01-02T15:04:05Z07:00"
    ISO8601       = "2006-01-02T15:04:05-0700"
    DateOnly      = "2006-01-02"
    TimeOnly      = "15:04:05"
)
```

### Duration and Time Arithmetic

```go
package main

import (
    "fmt"
    "time"
)

func durationExamples() {
    // Duration constants
    fmt.Println(time.Nanosecond)   // 1ns
    fmt.Println(time.Microsecond)  // 1000ns
    fmt.Println(time.Millisecond)  // 1000000ns
    fmt.Println(time.Second)       // 1000000000ns
    fmt.Println(time.Minute)       // 60s
    fmt.Println(time.Hour)         // 60m

    // Creating durations
    d1 := 5 * time.Second
    d2 := 100 * time.Millisecond
    d3 := time.ParseDuration("1h30m")

    fmt.Println(d1)     // 5s
    fmt.Println(d2)     // 100ms
    fmt.Println(d3)     // 1h30m0s (if no error)

    // Duration arithmetic
    total := d1 + d2
    fmt.Println(total)  // 5.1s

    // Duration methods
    fmt.Println(d1.Seconds())      // 5.0
    fmt.Println(d1.Milliseconds()) // 5000
    fmt.Println(d1.Nanoseconds())  // 5000000000

    // Time arithmetic
    now := time.Now()
    later := now.Add(5 * time.Minute)
    earlier := now.Add(-1 * time.Hour)

    fmt.Println("Now:", now)
    fmt.Println("Later:", later)
    fmt.Println("Earlier:", earlier)

    // Time difference
    diff := later.Sub(now)
    fmt.Println("Difference:", diff) // 5m0s

    // Time comparison
    fmt.Println(later.After(now))   // true
    fmt.Println(earlier.Before(now)) // true
    fmt.Println(now.Equal(now))      // true
}
```

### Timers and Tickers

```go
package main

import (
    "fmt"
    "time"
)

func timerExample() {
    // One-shot timer
    timer := time.NewTimer(2 * time.Second)
    fmt.Println("Timer started")
    <-timer.C
    fmt.Println("Timer expired")

    // Simpler one-shot delay
    time.Sleep(1 * time.Second)

    // AfterFunc - execute function after delay
    time.AfterFunc(1*time.Second, func() {
        fmt.Println("AfterFunc executed")
    })

    // Stop a timer
    timer2 := time.NewTimer(5 * time.Second)
    go func() {
        <-timer2.C
        fmt.Println("Timer 2 expired")
    }()

    stopped := timer2.Stop()
    if stopped {
        fmt.Println("Timer 2 stopped before expiring")
    }
}

func tickerExample() {
    // Repeating ticker
    ticker := time.NewTicker(1 * time.Second)
    defer ticker.Stop()

    count := 0
    for range ticker.C {
        count++
        fmt.Println("Tick", count)
        if count >= 5 {
            break
        }
    }
}

// Practical: Rate limiting
type RateLimiter struct {
    ticker *time.Ticker
}

func NewRateLimiter(rate time.Duration) *RateLimiter {
    return &RateLimiter{
        ticker: time.NewTicker(rate),
    }
}

func (rl *RateLimiter) Wait() {
    <-rl.ticker.C
}

func (rl *RateLimiter) Stop() {
    rl.ticker.Stop()
}

func rateLimitingExample() {
    limiter := NewRateLimiter(100 * time.Millisecond)
    defer limiter.Stop()

    for i := 0; i < 5; i++ {
        limiter.Wait()
        fmt.Println("Request", i+1, "at", time.Now().Format("15:04:05.000"))
    }
}
```

### Time Zones

```go
package main

import (
    "fmt"
    "time"
)

func timeZoneExample() {
    // Load timezone
    ny, _ := time.LoadLocation("America/New_York")
    tokyo, _ := time.LoadLocation("Asia/Tokyo")

    // Create time in specific timezone
    t := time.Date(2024, 1, 1, 12, 0, 0, 0, time.UTC)

    fmt.Println("UTC:", t.Format("15:04 MST"))
    fmt.Println("New York:", t.In(ny).Format("15:04 MST"))
    fmt.Println("Tokyo:", t.In(tokyo).Format("15:04 MST"))

    // Parse with timezone
    layout := "2006-01-02 15:04:05 MST"
    parsed, _ := time.ParseInLocation(layout, "2024-01-01 12:00:00 EST", ny)
    fmt.Println("Parsed:", parsed)
}

// Best practice: Always store times in UTC
func storeTime(t time.Time) time.Time {
    return t.UTC()
}

func displayTime(t time.Time, loc *time.Location) string {
    return t.In(loc).Format("2006-01-02 15:04:05 MST")
}
```

### Time Measurement and Benchmarking

```go
package main

import (
    "fmt"
    "time"
)

func measureExecution() {
    start := time.Now()

    // Do some work
    time.Sleep(100 * time.Millisecond)

    elapsed := time.Since(start)
    fmt.Printf("Operation took %v\n", elapsed)
}

// More precise timing
func preciseTimingExample() {
    start := time.Now()

    // Do work
    sum := 0
    for i := 0; i < 1000000; i++ {
        sum += i
    }

    duration := time.Since(start)
    fmt.Printf("Computed sum in %v (%d ns)\n", duration, duration.Nanoseconds())
}

// Timeout pattern
func operationWithTimeout() error {
    timeout := time.After(5 * time.Second)
    done := make(chan bool)

    go func() {
        // Do work
        time.Sleep(3 * time.Second)
        done <- true
    }()

    select {
    case <-done:
        fmt.Println("Operation completed")
        return nil
    case <-timeout:
        return fmt.Errorf("operation timed out")
    }
}
```

---
