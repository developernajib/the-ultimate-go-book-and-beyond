## Part 1: Core Data Model

Every data pipeline needs a consistent way to represent the data flowing through it. In this part, we define the fundamental building blocks: elements (individual data records), key-value pairs (for grouping and aggregation), windows (for time-based processing), and watermarks (for tracking event-time progress). These types form the backbone of the entire PipelineX framework.

### Element and Key-Value Types

An `Element` is the smallest unit of data in our pipeline. Think of it as an envelope that wraps your actual data along with metadata like timestamps and keys. The `KV` type lets us pair a key with a value, which is essential for operations like grouping and joining. Every piece of data that moves through the pipeline is wrapped in an `Element`, so understanding this type is crucial.

```go
// pkg/pipeline/element.go
package pipeline

import (
    "encoding/json"
    "fmt"
    "time"
)

// Element represents a single piece of data in the pipeline
type Element struct {
    Value     any
    Timestamp time.Time
    EventTime time.Time
    Key       any
    Pane      PaneInfo
}

// PaneInfo describes the timing of a window pane
type PaneInfo struct {
    IsFirst  bool
    IsLast   bool
    Timing   PaneTiming
    Index    int64
    OnTimeIndex int64
}

// PaneTiming indicates whether data is early, on-time, or late
type PaneTiming int

const (
    PaneEarly PaneTiming = iota
    PaneOnTime
    PaneLate
)

// KV represents a key-value pair
type KV struct {
    Key   any
    Value any
}

// NewElement creates a new element with the current processing time
func NewElement(value any) Element {
    now := time.Now()
    return Element{
        Value:     value,
        Timestamp: now,
        EventTime: now,
    }
}

// NewElementWithEventTime creates an element with explicit event time
func NewElementWithEventTime(value any, eventTime time.Time) Element {
    return Element{
        Value:     value,
        Timestamp: time.Now(),
        EventTime: eventTime,
    }
}

// WithKey attaches a key to the element
func (e Element) WithKey(key any) Element {
    e.Key = key
    return e
}

// Clone creates a deep copy of the element
func (e Element) Clone() Element {
    return Element{
        Value:     e.Value,
        Timestamp: e.Timestamp,
        EventTime: e.EventTime,
        Key:       e.Key,
        Pane:      e.Pane,
    }
}

// String returns a string representation of the element
func (e Element) String() string {
    return fmt.Sprintf("Element{Value: %v, EventTime: %v, Key: %v}",
        e.Value, e.EventTime, e.Key)
}

// ElementCodec handles serialization and deserialization
type ElementCodec struct{}

// Encode serializes an element to bytes
func (c ElementCodec) Encode(e Element) ([]byte, error) {
    return json.Marshal(e)
}

// Decode deserializes bytes to an element
func (c ElementCodec) Decode(data []byte) (Element, error) {
    var e Element
    err := json.Unmarshal(data, &e)
    return e, err
}
```

### Window Specifications

Windows divide an infinite stream of data into finite chunks for processing. A tumbling window creates fixed, non-overlapping time intervals (for example, every 5 minutes). A sliding window creates overlapping intervals (a 10-minute window that slides every 2 minutes). A session window groups events that happen close together in time, with gaps separating different sessions. The `GlobalWindow` is a special window that contains all elements, which is the default when no windowing is applied.

```go
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
```

### Watermark Management

In streaming systems, data often arrives out of order. A watermark is the pipeline's way of saying "I believe I have received all data up to this point in time." This lets the system know when it is safe to produce results for a window. The `MonotonicWatermarkEstimator` assumes data arrives roughly in order, while the `BoundedOutOfOrdernessWatermark` accounts for data that may arrive late by a configurable amount. Watermarks are critical for balancing result correctness against processing latency.

```go
// pkg/pipeline/watermark.go
package pipeline

import (
    "sync"
    "time"
)

// Watermark represents the event time progress
type Watermark struct {
    mu        sync.RWMutex
    timestamp time.Time
}

// NewWatermark creates a new watermark
func NewWatermark() *Watermark {
    return &Watermark{
        timestamp: time.Time{}, // Minimum time
    }
}

// Get returns the current watermark
func (w *Watermark) Get() time.Time {
    w.mu.RLock()
    defer w.mu.RUnlock()
    return w.timestamp
}

// Update advances the watermark if the new time is later
func (w *Watermark) Update(t time.Time) {
    w.mu.Lock()
    defer w.mu.Unlock()

    if t.After(w.timestamp) {
        w.timestamp = t
    }
}

// WatermarkEstimator estimates watermarks based on data
type WatermarkEstimator interface {
    ObserveTimestamp(t time.Time)
    CurrentWatermark() time.Time
}

// MonotonicWatermarkEstimator tracks the minimum timestamp
type MonotonicWatermarkEstimator struct {
    mu            sync.RWMutex
    minTimestamp  time.Time
    maxTimestamp  time.Time
}

func NewMonotonicWatermarkEstimator() *MonotonicWatermarkEstimator {
    return &MonotonicWatermarkEstimator{
        minTimestamp: time.Now(),
        maxTimestamp: time.Time{},
    }
}

func (e *MonotonicWatermarkEstimator) ObserveTimestamp(t time.Time) {
    e.mu.Lock()
    defer e.mu.Unlock()

    if e.maxTimestamp.IsZero() || t.After(e.maxTimestamp) {
        e.maxTimestamp = t
    }
}

func (e *MonotonicWatermarkEstimator) CurrentWatermark() time.Time {
    e.mu.RLock()
    defer e.mu.RUnlock()
    return e.maxTimestamp
}

// BoundedOutOfOrdernessWatermark allows for some out-of-orderness
type BoundedOutOfOrdernessWatermark struct {
    mu            sync.RWMutex
    maxTimestamp  time.Time
    maxOutOfOrder time.Duration
}

func NewBoundedOutOfOrdernessWatermark(maxOutOfOrder time.Duration) *BoundedOutOfOrdernessWatermark {
    return &BoundedOutOfOrdernessWatermark{
        maxTimestamp:  time.Time{},
        maxOutOfOrder: maxOutOfOrder,
    }
}

func (w *BoundedOutOfOrdernessWatermark) ObserveTimestamp(t time.Time) {
    w.mu.Lock()
    defer w.mu.Unlock()

    if w.maxTimestamp.IsZero() || t.After(w.maxTimestamp) {
        w.maxTimestamp = t
    }
}

func (w *BoundedOutOfOrdernessWatermark) CurrentWatermark() time.Time {
    w.mu.RLock()
    defer w.mu.RUnlock()

    if w.maxTimestamp.IsZero() {
        return time.Time{}
    }

    return w.maxTimestamp.Add(-w.maxOutOfOrder)
}
```
