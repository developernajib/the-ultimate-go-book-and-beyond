// pkg/pipeline/fluent.go
package pipeline

import "time"

// Map applies a mapping function
func (pc *PCollection) Map(fn MapFn) *PCollection {
    return pc.Apply("Map", NewMapTransform("Map", fn))
}

// FlatMap expands elements
func (pc *PCollection) FlatMap(fn FlatMapFn) *PCollection {
    return pc.Apply("FlatMap", NewFlatMapTransform("FlatMap", fn))
}

// Filter keeps matching elements
func (pc *PCollection) Filter(predicate FilterFn) *PCollection {
    return pc.Apply("Filter", NewFilterTransform("Filter", predicate))
}

// WithFixedWindows applies tumbling windows
func (pc *PCollection) WithFixedWindows(duration time.Duration) *PCollection {
    pc.windowing.WindowFn = TumblingWindow{Duration: duration}
    return pc
}

// WithSlidingWindows applies sliding windows
func (pc *PCollection) WithSlidingWindows(duration, period time.Duration) *PCollection {
    pc.windowing.WindowFn = SlidingWindow{
        Duration: duration,
        Period:   period,
    }
    return pc
}

// WithSessionWindows applies session windows
func (pc *PCollection) WithSessionWindows(gap time.Duration) *PCollection {
    pc.windowing.WindowFn = SessionWindow{GapDuration: gap}
    return pc
}

// GroupByKey groups elements by key
func (pc *PCollection) GroupByKey() *PCollection {
    return pc.Apply("GroupByKey", NewGroupByKeyTransform("GroupByKey"))
}

// CombinePerKey combines values for each key
func (pc *PCollection) CombinePerKey(fn CombineFn) *PCollection {
    return pc.Apply("CombinePerKey", NewCombineTransform("CombinePerKey", fn))
}

// WriteTo writes elements to a sink
func (pc *PCollection) WriteTo(sink Sink) {
    transform := &SinkTransform{
        BaseTransform: BaseTransform{name: "Write"},
        sink:          sink,
    }
    pc.Apply("Write", transform)
}
