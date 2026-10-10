## Part 2: Pipeline Definition and Transformations

This part covers how users define and compose data pipelines. We create a `Pipeline` struct that acts as the container for all processing steps, a `PCollection` that represents data flowing between steps, and a set of transforms (Map, Filter, FlatMap) that modify the data. The design uses a fluent API pattern so you can chain operations together in a readable way.

### Pipeline Builder

The `Pipeline` is the top-level object that holds your entire data processing job. You create one by giving it a name and configuration options like parallelism level and state backend. A `PCollection` (short for "parallel collection") represents a dataset at a particular point in the pipeline. You read data from a source into a `PCollection`, apply transforms to produce new `PCollection`s, and finally write results to a sink.

```go
// pkg/pipeline/pipeline.go
package pipeline

import (
    "context"
    "fmt"
    "sync"
)

// Pipeline represents a data processing pipeline
type Pipeline struct {
    name         string
    root         PCollection
    transforms   []Transform
    options      PipelineOptions
}

// PipelineOptions configures pipeline execution
type PipelineOptions struct {
    Runner           Runner
    Parallelism      int
    CheckpointDir    string
    MetricsReporter  MetricsReporter
    StateBackend     StateBackend
}

// NewPipeline creates a new pipeline
func NewPipeline(name string, opts PipelineOptions) *Pipeline {
    if opts.Parallelism <= 0 {
        opts.Parallelism = 4
    }

    return &Pipeline{
        name:       name,
        transforms: make([]Transform, 0),
        options:    opts,
    }
}

// PCollection represents a collection of elements in the pipeline
type PCollection struct {
    name      string
    pipeline  *Pipeline
    producer  Transform
    windowing WindowingStrategy
}

// WindowingStrategy defines how elements are windowed
type WindowingStrategy struct {
    WindowFn         WindowFn
    Trigger          Trigger
    AccumulationMode AccumulationMode
    AllowedLateness  time.Duration
}

// AccumulationMode determines how window panes accumulate
type AccumulationMode int

const (
    Discarding AccumulationMode = iota
    Accumulating
)

// ReadFrom creates a PCollection from a source
func (p *Pipeline) ReadFrom(source Source) *PCollection {
    pc := &PCollection{
        name:     fmt.Sprintf("Read(%s)", source.Name()),
        pipeline: p,
        windowing: WindowingStrategy{
            WindowFn: GlobalWindowFn{},
        },
    }

    readTransform := &SourceTransform{
        source: source,
        output: pc,
    }

    pc.producer = readTransform
    p.transforms = append(p.transforms, readTransform)

    return pc
}

// Apply applies a transform to a PCollection
func (pc *PCollection) Apply(name string, transform Transform) *PCollection {
    output := &PCollection{
        name:      name,
        pipeline:  pc.pipeline,
        producer:  transform,
        windowing: pc.windowing,
    }

    transform.SetInput(pc)
    transform.SetOutput(output)

    pc.pipeline.transforms = append(pc.pipeline.transforms, transform)

    return output
}

// Run executes the pipeline
func (p *Pipeline) Run(ctx context.Context) error {
    runner := p.options.Runner
    if runner == nil {
        runner = NewDirectRunner()
    }

    return runner.Run(ctx, p)
}
```

### Transform Interface

A transform is any operation that takes elements in and produces elements out. The `Transform` interface defines the contract: every transform must have a name, accept input and output collections, and implement a `Process` method that reads from an input channel and writes to an output channel. We provide a `BaseTransform` struct with shared logic, then build specific transforms on top of it. `MapTransform` applies a function to each element one-to-one, `FlatMapTransform` can produce zero or more output elements per input, and `FilterTransform` drops elements that do not match a predicate.

```go
// pkg/pipeline/transform.go
package pipeline

import "context"

// Transform represents a data transformation
type Transform interface {
    Name() string
    SetInput(pc *PCollection)
    SetOutput(pc *PCollection)
    Process(ctx context.Context, in <-chan Element, out chan<- Element) error
}

// BaseTransform provides common transform functionality
type BaseTransform struct {
    name   string
    input  *PCollection
    output *PCollection
}

func (t *BaseTransform) Name() string {
    return t.name
}

func (t *BaseTransform) SetInput(pc *PCollection) {
    t.input = pc
}

func (t *BaseTransform) SetOutput(pc *PCollection) {
    t.output = pc
}

// MapTransform applies a function to each element
type MapTransform struct {
    BaseTransform
    fn MapFn
}

type MapFn func(Element) (Element, error)

func NewMapTransform(name string, fn MapFn) *MapTransform {
    return &MapTransform{
        BaseTransform: BaseTransform{name: name},
        fn:            fn,
    }
}

func (t *MapTransform) Process(ctx context.Context, in <-chan Element, out chan<- Element) error {
    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        case elem, ok := <-in:
            if !ok {
                return nil
            }

            result, err := t.fn(elem)
            if err != nil {
                return fmt.Errorf("map function error: %w", err)
            }

            select {
            case out <- result:
            case <-ctx.Done():
                return ctx.Err()
            }
        }
    }
}

// FlatMapTransform expands each element into zero or more elements
type FlatMapTransform struct {
    BaseTransform
    fn FlatMapFn
}

type FlatMapFn func(Element) ([]Element, error)

func NewFlatMapTransform(name string, fn FlatMapFn) *FlatMapTransform {
    return &FlatMapTransform{
        BaseTransform: BaseTransform{name: name},
        fn:            fn,
    }
}

func (t *FlatMapTransform) Process(ctx context.Context, in <-chan Element, out chan<- Element) error {
    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        case elem, ok := <-in:
            if !ok {
                return nil
            }

            results, err := t.fn(elem)
            if err != nil {
                return fmt.Errorf("flatmap function error: %w", err)
            }

            for _, result := range results {
                select {
                case out <- result:
                case <-ctx.Done():
                    return ctx.Err()
                }
            }
        }
    }
}

// FilterTransform keeps only elements that match a predicate
type FilterTransform struct {
    BaseTransform
    predicate FilterFn
}

type FilterFn func(Element) (bool, error)

func NewFilterTransform(name string, predicate FilterFn) *FilterTransform {
    return &FilterTransform{
        BaseTransform: BaseTransform{name: name},
        predicate:     predicate,
    }
}

func (t *FilterTransform) Process(ctx context.Context, in <-chan Element, out chan<- Element) error {
    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        case elem, ok := <-in:
            if !ok {
                return nil
            }

            matches, err := t.predicate(elem)
            if err != nil {
                return fmt.Errorf("filter predicate error: %w", err)
            }

            if matches {
                select {
                case out <- elem:
                case <-ctx.Done():
                    return ctx.Err()
                }
            }
        }
    }
}
```

### Fluent API

The fluent API adds convenience methods directly on `PCollection` so you can chain operations together naturally. Instead of manually creating transform objects and wiring them up, you simply call methods like `.Map()`, `.Filter()`, `.GroupByKey()`, and `.WithFixedWindows()` in sequence. This makes pipeline definitions read almost like a description of the data flow, which is much easier to understand and maintain than manually constructing each step.

```go
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
```
