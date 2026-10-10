// pkg/pipeline/window.go
package pipeline

import (
    "fmt"
    "time"
)

// Window represents a time interval for grouping elements
type Window interface {
    Start() time.Time
    End() time.Time
    Contains(t time.Time) bool
    String() string
}

// IntervalWindow represents a fixed time interval
type IntervalWindow struct {
    start time.Time
    end   time.Time
}

func NewIntervalWindow(start, end time.Time) *IntervalWindow {
    return &IntervalWindow{start: start, end: end}
}

func (w *IntervalWindow) Start() time.Time {
    return w.start
}

func (w *IntervalWindow) End() time.Time {
    return w.end
}

func (w *IntervalWindow) Contains(t time.Time) bool {
    return !t.Before(w.start) && t.Before(w.end)
}

func (w *IntervalWindow) String() string {
    return fmt.Sprintf("[%v, %v)", w.start, w.end)
}

// WindowFn assigns elements to windows
type WindowFn interface {
    AssignWindows(e Element) []Window
    MergeWindows(windows []Window) []Window
}

// TumblingWindow assigns elements to fixed, non-overlapping windows
type TumblingWindow struct {
    Duration time.Duration
}

func (w TumblingWindow) AssignWindows(e Element) []Window {
    start := e.EventTime.Truncate(w.Duration)
    end := start.Add(w.Duration)
    return []Window{NewIntervalWindow(start, end)}
}

func (w TumblingWindow) MergeWindows(windows []Window) []Window {
    // Tumbling windows don't merge
    return windows
}

// SlidingWindow assigns elements to overlapping windows
type SlidingWindow struct {
    Duration time.Duration
    Period   time.Duration
}

func (w SlidingWindow) AssignWindows(e Element) []Window {
    var windows []Window

    // Find the first window that contains this element
    start := e.EventTime.Truncate(w.Period)
    for start.Add(w.Duration).After(e.EventTime) {
        start = start.Add(-w.Period)
    }

    // Assign to all overlapping windows
    for {
        end := start.Add(w.Duration)
        if start.After(e.EventTime) {
            break
        }
        if end.After(e.EventTime) {
            windows = append(windows, NewIntervalWindow(start, end))
        }
        start = start.Add(w.Period)
    }

    return windows
}

func (w SlidingWindow) MergeWindows(windows []Window) []Window {
    // Sliding windows don't merge
    return windows
}

// SessionWindow groups events that occur near each other in time
type SessionWindow struct {
    GapDuration time.Duration
}

func (w SessionWindow) AssignWindows(e Element) []Window {
    // Initially assign to a window starting at event time
    return []Window{NewIntervalWindow(e.EventTime, e.EventTime.Add(w.GapDuration))}
}

func (w SessionWindow) MergeWindows(windows []Window) []Window {
    if len(windows) <= 1 {
        return windows
    }

    // Sort windows by start time
    sorted := make([]*IntervalWindow, len(windows))
    for i, win := range windows {
        sorted[i] = win.(*IntervalWindow)
    }

    // Merge overlapping windows
    var merged []Window
    current := sorted[0]

    for i := 1; i < len(sorted); i++ {
        next := sorted[i]

        // If windows overlap or are within gap duration, merge them
        if !current.End().Before(next.Start()) {
            // Extend current window
            if next.End().After(current.End()) {
                current = NewIntervalWindow(current.Start(), next.End())
            }
        } else {
            merged = append(merged, current)
            current = next
        }
    }

    merged = append(merged, current)
    return merged
}

// GlobalWindow represents a single, unbounded window
type GlobalWindow struct{}

func (w GlobalWindow) Start() time.Time {
    return time.Time{}
}

func (w GlobalWindow) End() time.Time {
    return time.Unix(1<<63-1, 999999999) // Max time
}

func (w GlobalWindow) Contains(t time.Time) bool {
    return true
}

func (w GlobalWindow) String() string {
    return "GlobalWindow"
}

// GlobalWindowFn assigns all elements to the global window
type GlobalWindowFn struct{}

func (w GlobalWindowFn) AssignWindows(e Element) []Window {
    return []Window{GlobalWindow{}}
}

func (w GlobalWindowFn) MergeWindows(windows []Window) []Window {
    return []Window{GlobalWindow{}}
}
