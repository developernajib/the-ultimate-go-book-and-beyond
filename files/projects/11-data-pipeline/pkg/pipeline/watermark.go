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
