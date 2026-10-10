// pkg/pipeline/source.go
package pipeline

import (
    "context"
)

// Source reads data into the pipeline
type Source interface {
    Name() string
    Read(ctx context.Context) (<-chan Element, error)
    EstimateSize() int64
    Split(desiredBundles int) ([]Source, error)
}

// BoundedSource reads a finite amount of data
type BoundedSource interface {
    Source
    IsBounded() bool
}

// UnboundedSource reads continuous data
type UnboundedSource interface {
    Source
    GetWatermarkEstimator() WatermarkEstimator
}

// SourceTransform wraps a source as a transform
type SourceTransform struct {
    BaseTransform
    source Source
    output *PCollection
}

func (t *SourceTransform) Process(ctx context.Context, in <-chan Element, out chan<- Element) error {
    elements, err := t.source.Read(ctx)
    if err != nil {
        return err
    }

    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        case elem, ok := <-elements:
            if !ok {
                return nil
            }

            select {
            case out <- elem:
            case <-ctx.Done():
                return ctx.Err()
            }
        }
    }
}
