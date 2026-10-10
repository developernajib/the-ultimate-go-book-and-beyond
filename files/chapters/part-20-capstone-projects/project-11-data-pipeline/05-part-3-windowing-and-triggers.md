## Part 3: Windowing and Triggers

Windowing and triggers work together to control when results are produced. The window assignment step places each element into one or more time-based windows, while triggers decide exactly when to emit the accumulated results for each window. Together they let you trade off between result completeness and processing latency.

### Window Assignment

The `WindowTransform` takes each incoming element, asks the window function which windows it belongs to, and then emits a copy of that element for each assigned window. For example, with sliding windows an element might belong to multiple overlapping windows, so it gets duplicated. The `WindowedValue` wrapper pairs the original value with its assigned window so downstream transforms know which window context they are operating in.

```go
// pkg/pipeline/windowing.go
package pipeline

import (
    "context"
    "sync"
)

// WindowTransform assigns elements to windows
type WindowTransform struct {
    BaseTransform
    windowFn WindowFn
}

func NewWindowTransform(name string, windowFn WindowFn) *WindowTransform {
    return &WindowTransform{
        BaseTransform: BaseTransform{name: name},
        windowFn:      windowFn,
    }
}

func (t *WindowTransform) Process(ctx context.Context, in <-chan Element, out chan<- Element) error {
    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        case elem, ok := <-in:
            if !ok {
                return nil
            }

            windows := t.windowFn.AssignWindows(elem)

            for _, window := range windows {
                windowedElem := elem.Clone()
                windowedElem.Value = WindowedValue{
                    Value:  elem.Value,
                    Window: window,
                }

                select {
                case out <- windowedElem:
                case <-ctx.Done():
                    return ctx.Err()
                }
            }
        }
    }
}

// WindowedValue wraps a value with its window
type WindowedValue struct {
    Value  any
    Window Window
}
```

### Trigger System

Triggers control when a window's accumulated results are emitted downstream. The `AfterWatermarkTrigger` fires when the watermark passes the end of the window, meaning the system believes all data for that window has arrived. The `AfterCountTrigger` fires after a certain number of elements have been seen, which is useful when you want results after every N records regardless of time. The `AfterProcessingTimeTrigger` fires based on wall-clock time, and `RepeatedlyTrigger` wraps another trigger to fire it multiple times. You can combine these to get early speculative results, an on-time result, and late corrections.

```go
// pkg/pipeline/trigger.go
package pipeline

import "time"

// Trigger determines when to emit window results
type Trigger interface {
    OnElement(element Element, window Window) TriggerResult
    OnTimer(timestamp time.Time, window Window) TriggerResult
    ShouldFire(window Window, watermark time.Time) bool
}

// TriggerResult indicates what action to take
type TriggerResult int

const (
    TriggerContinue TriggerResult = iota
    TriggerFire
    TriggerFireAndPurge
)

// AfterWatermarkTrigger fires when watermark passes window end
type AfterWatermarkTrigger struct {
    earlyTrigger Trigger
    lateTrigger  Trigger
}

func NewAfterWatermarkTrigger() *AfterWatermarkTrigger {
    return &AfterWatermarkTrigger{}
}

func (t *AfterWatermarkTrigger) WithEarlyFirings(trigger Trigger) *AfterWatermarkTrigger {
    t.earlyTrigger = trigger
    return t
}

func (t *AfterWatermarkTrigger) WithLateFirings(trigger Trigger) *AfterWatermarkTrigger {
    t.lateTrigger = trigger
    return t
}

func (t *AfterWatermarkTrigger) OnElement(element Element, window Window) TriggerResult {
    // Check early trigger
    if t.earlyTrigger != nil {
        return t.earlyTrigger.OnElement(element, window)
    }
    return TriggerContinue
}

func (t *AfterWatermarkTrigger) OnTimer(timestamp time.Time, window Window) TriggerResult {
    return TriggerFire
}

func (t *AfterWatermarkTrigger) ShouldFire(window Window, watermark time.Time) bool {
    return !watermark.Before(window.End())
}

// AfterCountTrigger fires after seeing N elements
type AfterCountTrigger struct {
    count    int
    counters map[Window]int
    mu       sync.Mutex
}

func NewAfterCountTrigger(count int) *AfterCountTrigger {
    return &AfterCountTrigger{
        count:    count,
        counters: make(map[Window]int),
    }
}

func (t *AfterCountTrigger) OnElement(element Element, window Window) TriggerResult {
    t.mu.Lock()
    defer t.mu.Unlock()

    t.counters[window]++

    if t.counters[window] >= t.count {
        t.counters[window] = 0
        return TriggerFire
    }

    return TriggerContinue
}

func (t *AfterCountTrigger) OnTimer(timestamp time.Time, window Window) TriggerResult {
    return TriggerContinue
}

func (t *AfterCountTrigger) ShouldFire(window Window, watermark time.Time) bool {
    t.mu.Lock()
    defer t.mu.Unlock()
    return t.counters[window] >= t.count
}

// AfterProcessingTimeTrigger fires after processing time duration
type AfterProcessingTimeTrigger struct {
    duration  time.Duration
    startTime map[Window]time.Time
    mu        sync.Mutex
}

func NewAfterProcessingTimeTrigger(duration time.Duration) *AfterProcessingTimeTrigger {
    return &AfterProcessingTimeTrigger{
        duration:  duration,
        startTime: make(map[Window]time.Time),
    }
}

func (t *AfterProcessingTimeTrigger) OnElement(element Element, window Window) TriggerResult {
    t.mu.Lock()
    defer t.mu.Unlock()

    if _, exists := t.startTime[window]; !exists {
        t.startTime[window] = time.Now()
    }

    if time.Since(t.startTime[window]) >= t.duration {
        delete(t.startTime, window)
        return TriggerFire
    }

    return TriggerContinue
}

func (t *AfterProcessingTimeTrigger) OnTimer(timestamp time.Time, window Window) TriggerResult {
    return TriggerFire
}

func (t *AfterProcessingTimeTrigger) ShouldFire(window Window, watermark time.Time) bool {
    t.mu.Lock()
    defer t.mu.Unlock()

    if startTime, exists := t.startTime[window]; exists {
        return time.Since(startTime) >= t.duration
    }

    return false
}

// RepeatedlyTrigger fires repeatedly
type RepeatedlyTrigger struct {
    trigger Trigger
}

func NewRepeatedlyTrigger(trigger Trigger) *RepeatedlyTrigger {
    return &RepeatedlyTrigger{trigger: trigger}
}

func (t *RepeatedlyTrigger) OnElement(element Element, window Window) TriggerResult {
    result := t.trigger.OnElement(element, window)
    if result == TriggerFire {
        return TriggerFire
    }
    return TriggerContinue
}

func (t *RepeatedlyTrigger) OnTimer(timestamp time.Time, window Window) TriggerResult {
    return t.trigger.OnTimer(timestamp, window)
}

func (t *RepeatedlyTrigger) ShouldFire(window Window, watermark time.Time) bool {
    return t.trigger.ShouldFire(window, watermark)
}
```
