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
