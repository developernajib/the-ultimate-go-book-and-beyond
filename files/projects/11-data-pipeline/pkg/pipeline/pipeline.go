// pkg/pipeline/pipeline.go
package pipeline

import (
	"context"
	"fmt"
	"time"
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
