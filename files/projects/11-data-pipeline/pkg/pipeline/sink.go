// pkg/pipeline/sink.go
package pipeline

import "context"

// Sink writes data from the pipeline
type Sink interface {
    Name() string
    Write(ctx context.Context, elements <-chan Element) error
    Close() error
}

// SinkTransform wraps a sink as a transform
type SinkTransform struct {
    BaseTransform
    sink Sink
}

func (t *SinkTransform) Process(ctx context.Context, in <-chan Element, out chan<- Element) error {
    defer t.sink.Close()
    return t.sink.Write(ctx, in)
}
