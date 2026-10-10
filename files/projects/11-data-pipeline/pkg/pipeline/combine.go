// pkg/pipeline/combine.go
package pipeline

import (
    "context"
)

// CombineFn combines values
type CombineFn interface {
    CreateAccumulator() any
    AddInput(accumulator, input any) any
    MergeAccumulators(accumulators []any) any
    ExtractOutput(accumulator any) any
}

// CombineTransform applies a combine function
type CombineTransform struct {
    BaseTransform
    combineFn CombineFn
}

func NewCombineTransform(name string, fn CombineFn) *CombineTransform {
    return &CombineTransform{
        BaseTransform: BaseTransform{name: name},
        combineFn:     fn,
    }
}

func (t *CombineTransform) Process(ctx context.Context, in <-chan Element, out chan<- Element) error {
    // Accumulate by key and window
    accumulators := make(map[any]map[Window]any)

    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        case elem, ok := <-in:
            if !ok {
                // Input closed, emit results
                return t.emitResults(ctx, accumulators, out)
            }

            key := elem.Key

            var window Window
            var values []any

            if wv, ok := elem.Value.(WindowedValue); ok {
                window = wv.Window
                values = wv.Value.([]any)
            } else {
                window = GlobalWindow{}
                values = elem.Value.([]any)
            }

            if _, exists := accumulators[key]; !exists {
                accumulators[key] = make(map[Window]any)
            }

            if _, exists := accumulators[key][window]; !exists {
                accumulators[key][window] = t.combineFn.CreateAccumulator()
            }

            // Add all values to accumulator
            acc := accumulators[key][window]
            for _, value := range values {
                acc = t.combineFn.AddInput(acc, value)
            }
            accumulators[key][window] = acc
        }
    }
}

func (t *CombineTransform) emitResults(ctx context.Context, accumulators map[any]map[Window]any, out chan<- Element) error {
    for key, windows := range accumulators {
        for window, acc := range windows {
            result := t.combineFn.ExtractOutput(acc)

            elem := Element{
                Key:   key,
                Value: result,
            }

            if _, isGlobal := window.(GlobalWindow); !isGlobal {
                elem.Value = WindowedValue{
                    Value:  result,
                    Window: window,
                }
            }

            select {
            case out <- elem:
            case <-ctx.Done():
                return ctx.Err()
            }
        }
    }

    return nil
}

// SumInt64 combines integers by summing
type SumInt64 struct{}

func (c SumInt64) CreateAccumulator() any {
    return int64(0)
}

func (c SumInt64) AddInput(accumulator, input any) any {
    return accumulator.(int64) + input.(int64)
}

func (c SumInt64) MergeAccumulators(accumulators []any) any {
    sum := int64(0)
    for _, acc := range accumulators {
        sum += acc.(int64)
    }
    return sum
}

func (c SumInt64) ExtractOutput(accumulator any) any {
    return accumulator
}

// Count counts elements
type Count struct{}

func (c Count) CreateAccumulator() any {
    return int64(0)
}

func (c Count) AddInput(accumulator, input any) any {
    return accumulator.(int64) + 1
}

func (c Count) MergeAccumulators(accumulators []any) any {
    count := int64(0)
    for _, acc := range accumulators {
        count += acc.(int64)
    }
    return count
}

func (c Count) ExtractOutput(accumulator any) any {
    return accumulator
}

// Mean calculates average
type Mean struct{}

type meanAccumulator struct {
    sum   float64
    count int64
}

func (c Mean) CreateAccumulator() any {
    return meanAccumulator{}
}

func (c Mean) AddInput(accumulator, input any) any {
    acc := accumulator.(meanAccumulator)
    acc.sum += input.(float64)
    acc.count++
    return acc
}

func (c Mean) MergeAccumulators(accumulators []any) any {
    result := meanAccumulator{}
    for _, a := range accumulators {
        acc := a.(meanAccumulator)
        result.sum += acc.sum
        result.count += acc.count
    }
    return result
}

func (c Mean) ExtractOutput(accumulator any) any {
    acc := accumulator.(meanAccumulator)
    if acc.count == 0 {
        return 0.0
    }
    return acc.sum / float64(acc.count)
}
