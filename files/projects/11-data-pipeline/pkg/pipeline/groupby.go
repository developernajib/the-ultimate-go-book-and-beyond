// pkg/pipeline/groupby.go
package pipeline

import (
    "context"
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
