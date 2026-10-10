// pkg/pipeline/transform.go
package pipeline

import (
	"context"
	"fmt"
)

// Transform represents a data transformation
type Transform interface {
    Name() string
    SetInput(pc *PCollection)
    SetOutput(pc *PCollection)
    GetInput() *PCollection
    GetOutput() *PCollection
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

func (t *BaseTransform) GetInput() *PCollection {
    return t.input
}

func (t *BaseTransform) GetOutput() *PCollection {
    return t.output
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
