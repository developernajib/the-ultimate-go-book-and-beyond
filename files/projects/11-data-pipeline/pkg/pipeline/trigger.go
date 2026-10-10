// pkg/pipeline/trigger.go
package pipeline

import (
	"sync"
	"time"
)

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
