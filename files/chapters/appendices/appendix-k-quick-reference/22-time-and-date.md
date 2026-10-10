## Time and Date

The `time` package provides everything you need for working with dates, times, durations, and timers. Go uses a unique reference time for formatting, `Mon Jan 2 15:04:05 MST 2006`, instead of abstract placeholders like `YYYY-MM-DD`, so you write the format by example. Durations are represented as `time.Duration` values, which you create by multiplying a number with constants like `time.Second` or `time.Millisecond`. Always use `t1.Equal(t2)` instead of `==` for time comparison, and prefer `time.Since(start)` for measuring elapsed time.

```go
import "time"

// Current time
now := time.Now()

// Create time
t := time.Date(2024, time.January, 15, 10, 30, 0, 0, time.UTC)

// Components
year := t.Year()
month := t.Month()      // time.Month (1-12)
day := t.Day()
hour := t.Hour()
minute := t.Minute()
second := t.Second()
weekday := t.Weekday()  // time.Weekday (0=Sunday)
yearDay := t.YearDay()  // Day of year (1-365/366)

// Unix time
unix := t.Unix()              // Seconds since epoch
unixNano := t.UnixNano()      // Nanoseconds since epoch
t = time.Unix(unix, 0)        // From unix timestamp

// Duration
d := 5 * time.Second
d := 300 * time.Millisecond
d := time.Minute + 30*time.Second
d := time.Hour

// Duration operations
hours := d.Hours()
minutes := d.Minutes()
seconds := d.Seconds()
milliseconds := d.Milliseconds()
microseconds := d.Microseconds()
nanoseconds := d.Nanoseconds()

// Time arithmetic
future := now.Add(24 * time.Hour)
past := now.Add(-1 * time.Hour)
diff := t2.Sub(t1)  // Returns Duration

// Truncate/Round
t = t.Truncate(time.Hour)     // Truncate to hour
t = t.Round(15 * time.Minute) // Round to 15 minutes

// Comparison
if t1.Before(t2) { }
if t1.After(t2) { }
if t1.Equal(t2) { }  // Use this, not ==

// Format (Go's reference time: Mon Jan 2 15:04:05 MST 2006)
s := t.Format("2006-01-02 15:04:05")
s := t.Format(time.RFC3339)
s := t.Format(time.Kitchen)

// Common layouts
time.Layout      = "01/02 03:04:05PM '06 -0700"
time.ANSIC       = "Mon Jan _2 15:04:05 2006"
time.UnixDate    = "Mon Jan _2 15:04:05 MST 2006"
time.RubyDate    = "Mon Jan 02 15:04:05 -0700 2006"
time.RFC822      = "02 Jan 06 15:04 MST"
time.RFC822Z     = "02 Jan 06 15:04 -0700"
time.RFC850      = "Monday, 02-Jan-06 15:04:05 MST"
time.RFC1123     = "Mon, 02 Jan 2006 15:04:05 MST"
time.RFC1123Z    = "Mon, 02 Jan 2006 15:04:05 -0700"
time.RFC3339     = "2006-01-02T15:04:05Z07:00"
time.RFC3339Nano = "2006-01-02T15:04:05.999999999Z07:00"
time.Kitchen     = "3:04PM"
time.Stamp       = "Jan _2 15:04:05"
time.StampMilli  = "Jan _2 15:04:05.000"
time.StampMicro  = "Jan _2 15:04:05.000000"
time.StampNano   = "Jan _2 15:04:05.000000000"
time.DateTime    = "2006-01-02 15:04:05"
time.DateOnly    = "2006-01-02"
time.TimeOnly    = "15:04:05"

// Parse
t, err := time.Parse("2006-01-02", "2024-01-15")
t, err := time.Parse(time.RFC3339, "2024-01-15T10:30:00Z")

// Parse in local time
t, err := time.ParseInLocation("2006-01-02", "2024-01-15", time.Local)

// Sleep
time.Sleep(5 * time.Second)

// Timer (fires once)
timer := time.NewTimer(5 * time.Second)
<-timer.C  // Block until timer fires

// Stop timer
if !timer.Stop() {
    <-timer.C
}

// Reset timer
timer.Reset(10 * time.Second)

// Ticker (fires repeatedly)
ticker := time.NewTicker(1 * time.Second)
defer ticker.Stop()

for t := range ticker.C {
    // Fires every second
}

// After (receive-only channel)
select {
case <-time.After(5 * time.Second):
    // Timeout
}

// AfterFunc
timer := time.AfterFunc(5*time.Second, func() {
    // Called after 5 seconds
})

// Time zones
loc, _ := time.LoadLocation("America/New_York")
t = t.In(loc)
t = t.UTC()
t = t.Local()

// Zero time
var t time.Time  // Zero time (0001-01-01 00:00:00 UTC)
if t.IsZero() {
    // Is zero time
}

// Measure elapsed time
start := time.Now()
// Do work
elapsed := time.Since(start)

// Or
elapsed := time.Now().Sub(start)
```

---
