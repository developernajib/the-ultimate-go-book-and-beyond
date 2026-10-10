// pkg/pipeline/windowing.go
package pipeline

import (
    "context"
)

// WindowTransform assigns elements to windows
type WindowTransform struct {
    BaseTransform
    windowFn WindowFn
}

func NewWindowTransform(name string, windowFn WindowFn) *WindowTransform {
    return &WindowTransform{
        BaseTransform: BaseTransform{name: name},
        windowFn:      windowFn,
    }
}

func (t *WindowTransform) Process(ctx context.Context, in <-chan Element, out chan<- Element) error {
    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        case elem, ok := <-in:
            if !ok {
                return nil
            }

            windows := t.windowFn.AssignWindows(elem)

            for _, window := range windows {
                windowedElem := elem.Clone()
                windowedElem.Value = WindowedValue{
                    Value:  elem.Value,
                    Window: window,
                }

                select {
                case out <- windowedElem:
                case <-ctx.Done():
                    return ctx.Err()
                }
            }
        }
    }
}

// WindowedValue wraps a value with its window
type WindowedValue struct {
    Value  any
    Window Window
}
