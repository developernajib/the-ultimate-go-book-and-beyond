## Part 4: GroupBy and Aggregation

Grouping and aggregation are at the heart of most data processing tasks. GroupByKey collects all elements that share the same key into a single group, and combine functions then reduce each group into a summary value. These operations are how you answer questions like "how many clicks per user?" or "what is the average order value per region?"

### GroupByKey Transform

The `GroupByKeyTransform` collects all incoming elements, organizes them by their key and window, and then emits one output element per key-window combination. The output element's value is a slice containing all the original values for that group. This is a blocking operation: it must see all input elements before it can produce any output, because it needs the complete group. For streaming pipelines, the windowing system bounds how much data needs to be collected before results can be emitted.

```go
// pkg/pipeline/groupby.go
package pipeline

import (
    "context"
    "fmt"
    "sync"
)

// GroupByKeyTransform groups elements by key
type GroupByKeyTransform struct {
    BaseTransform
}

func NewGroupByKeyTransform(name string) *GroupByKeyTransform {
    return &GroupByKeyTransform{
        BaseTransform: BaseTransform{name: name},
    }
}

func (t *GroupByKeyTransform) Process(ctx context.Context, in <-chan Element, out chan<- Element) error {
    // Group elements by key and window
    groups := make(map[any]map[Window][]Element)
    var mu sync.Mutex

    // Collect all elements
    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        case elem, ok := <-in:
            if !ok {
                // Input closed, emit groups
                return t.emitGroups(ctx, groups, out)
            }

            mu.Lock()
            key := elem.Key

            var window Window
            if wv, ok := elem.Value.(WindowedValue); ok {
                window = wv.Window
                elem.Value = wv.Value
            } else {
                window = GlobalWindow{}
            }

            if _, exists := groups[key]; !exists {
                groups[key] = make(map[Window][]Element)
            }

            groups[key][window] = append(groups[key][window], elem)
            mu.Unlock()
        }
    }
}

func (t *GroupByKeyTransform) emitGroups(ctx context.Context, groups map[any]map[Window][]Element, out chan<- Element) error {
    for key, windows := range groups {
        for window, elements := range windows {
            // Extract values
            values := make([]any, len(elements))
            for i, elem := range elements {
                values[i] = elem.Value
            }

            // Create grouped element
            grouped := Element{
                Key:       key,
                Value:     values,
                EventTime: elements[0].EventTime,
                Timestamp: elements[0].Timestamp,
            }

            // Wrap with window if not global
            if _, isGlobal := window.(GlobalWindow); !isGlobal {
                grouped.Value = WindowedValue{
                    Value:  values,
                    Window: window,
                }
            }

            select {
            case out <- grouped:
            case <-ctx.Done():
                return ctx.Err()
            }
        }
    }

    return nil
}
```

### Combine Functions

A `CombineFn` reduces a collection of values into a single result using an accumulator pattern. It has four stages: create an initial accumulator, add each input value to it, merge multiple accumulators together (needed for parallel execution), and extract the final output. We provide built-in combiners for common operations like `SumInt64`, `Count`, and `Mean`. You can also write your own combiner for custom aggregation logic by implementing the `CombineFn` interface.

```go
// pkg/pipeline/combine.go
package pipeline

import (
    "context"
    "fmt"
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
```
