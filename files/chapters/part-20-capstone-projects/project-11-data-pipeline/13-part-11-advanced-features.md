## Part 11: Advanced Features

This part adds two powerful capabilities to the framework: joins and side inputs. Joins let you combine two separate data collections based on a shared key, just like a SQL JOIN. Side inputs let you enrich streaming data with a lookup table or reference dataset. These features are essential for pipelines that need to correlate data from multiple sources.

### Join Transformation

The `JoinTransform` combines two `PCollection`s by matching elements that share the same key and window. It supports four join types: inner join (only matching keys), left join (all left keys, matching right keys), right join (all right keys, matching left keys), and full outer join (all keys from both sides). The implementation collects all elements from both sides into maps, then iterates through all keys and windows to produce the joined output. The `Join` helper method on `PCollection` makes it easy to use in a fluent chain.

```go
// pkg/pipeline/join.go
package pipeline

import (
    "context"
    "fmt"
    "sync"
)

// JoinType specifies the type of join
type JoinType int

const (
    InnerJoin JoinType = iota
    LeftJoin
    RightJoin
    FullOuterJoin
)

// JoinTransform joins two PCollections
type JoinTransform struct {
    BaseTransform
    leftInput  *PCollection
    rightInput *PCollection
    joinType   JoinType
}

func NewJoinTransform(name string, joinType JoinType) *JoinTransform {
    return &JoinTransform{
        BaseTransform: BaseTransform{name: name},
        joinType:      joinType,
    }
}

func (t *JoinTransform) SetLeftInput(pc *PCollection) {
    t.leftInput = pc
}

func (t *JoinTransform) SetRightInput(pc *PCollection) {
    t.rightInput = pc
}

func (t *JoinTransform) Process(ctx context.Context, left <-chan Element, right <-chan Element, out chan<- Element) error {
    // Collect all elements from both sides
    leftMap := make(map[any]map[Window][]Element)
    rightMap := make(map[any]map[Window][]Element)

    var wg sync.WaitGroup
    errChan := make(chan error, 2)

    // Collect left side
    wg.Add(1)
    go func() {
        defer wg.Done()

        for {
            select {
            case <-ctx.Done():
                errChan <- ctx.Err()
                return
            case elem, ok := <-left:
                if !ok {
                    return
                }

                key := elem.Key
                window := GlobalWindow{}
                if wv, ok := elem.Value.(WindowedValue); ok {
                    window = wv.Window
                }

                if _, exists := leftMap[key]; !exists {
                    leftMap[key] = make(map[Window][]Element)
                }
                leftMap[key][window] = append(leftMap[key][window], elem)
            }
        }
    }()

    // Collect right side
    wg.Add(1)
    go func() {
        defer wg.Done()

        for {
            select {
            case <-ctx.Done():
                errChan <- ctx.Err()
                return
            case elem, ok := <-right:
                if !ok {
                    return
                }

                key := elem.Key
                window := GlobalWindow{}
                if wv, ok := elem.Value.(WindowedValue); ok {
                    window = wv.Window
                }

                if _, exists := rightMap[key]; !exists {
                    rightMap[key] = make(map[Window][]Element)
                }
                rightMap[key][window] = append(rightMap[key][window], elem)
            }
        }
    }()

    wg.Wait()
    close(errChan)

    for err := range errChan {
        if err != nil {
            return err
        }
    }

    // Perform join
    return t.performJoin(ctx, leftMap, rightMap, out)
}

func (t *JoinTransform) performJoin(
    ctx context.Context,
    leftMap, rightMap map[any]map[Window][]Element,
    out chan<- Element,
) error {
    // Get all keys
    allKeys := make(map[any]bool)
    for key := range leftMap {
        allKeys[key] = true
    }
    for key := range rightMap {
        allKeys[key] = true
    }

    for key := range allKeys {
        leftWindows := leftMap[key]
        rightWindows := rightMap[key]

        // Get all windows
        allWindows := make(map[Window]bool)
        for window := range leftWindows {
            allWindows[window] = true
        }
        for window := range rightWindows {
            allWindows[window] = true
        }

        for window := range allWindows {
            leftElems := leftWindows[window]
            rightElems := rightWindows[window]

            switch t.joinType {
            case InnerJoin:
                if len(leftElems) > 0 && len(rightElems) > 0 {
                    if err := t.emitJoined(ctx, key, window, leftElems, rightElems, out); err != nil {
                        return err
                    }
                }

            case LeftJoin:
                if len(leftElems) > 0 {
                    if err := t.emitJoined(ctx, key, window, leftElems, rightElems, out); err != nil {
                        return err
                    }
                }

            case RightJoin:
                if len(rightElems) > 0 {
                    if err := t.emitJoined(ctx, key, window, leftElems, rightElems, out); err != nil {
                        return err
                    }
                }

            case FullOuterJoin:
                if err := t.emitJoined(ctx, key, window, leftElems, rightElems, out); err != nil {
                    return err
                }
            }
        }
    }

    return nil
}

func (t *JoinTransform) emitJoined(
    ctx context.Context,
    key any,
    window Window,
    leftElems, rightElems []Element,
    out chan<- Element,
) error {
    leftValues := make([]any, len(leftElems))
    for i, elem := range leftElems {
        if wv, ok := elem.Value.(WindowedValue); ok {
            leftValues[i] = wv.Value
        } else {
            leftValues[i] = elem.Value
        }
    }

    rightValues := make([]any, len(rightElems))
    for i, elem := range rightElems {
        if wv, ok := elem.Value.(WindowedValue); ok {
            rightValues[i] = wv.Value
        } else {
            rightValues[i] = elem.Value
        }
    }

    joined := KV{
        Key:   leftValues,
        Value: rightValues,
    }

    elem := Element{
        Key:   key,
        Value: joined,
    }

    if _, isGlobal := window.(GlobalWindow); !isGlobal {
        elem.Value = WindowedValue{
            Value:  joined,
            Window: window,
        }
    }

    select {
    case out <- elem:
        return nil
    case <-ctx.Done():
        return ctx.Err()
    }
}

// Join helper method for PCollection
func (pc *PCollection) Join(other *PCollection, joinType JoinType) *PCollection {
    transform := NewJoinTransform("Join", joinType)
    transform.SetLeftInput(pc)
    transform.SetRightInput(other)

    output := &PCollection{
        name:      fmt.Sprintf("Join(%s, %s)", pc.name, other.name),
        pipeline:  pc.pipeline,
        producer:  transform,
        windowing: pc.windowing,
    }

    transform.SetOutput(output)
    pc.pipeline.transforms = append(pc.pipeline.transforms, transform)

    return output
}
```

### Side Inputs

A side input is a secondary dataset that a transform can look up while processing its main input. For example, you might enrich click events with user profile data stored in a side input. The `SideInput` struct holds a key-value map that is populated before processing begins, and the `EnrichTransform` waits for the side input to be marked ready before it starts processing elements. This pattern avoids the need to join two full streams when one side is a relatively small, static dataset.

```go
// pkg/pipeline/side_input.go
package pipeline

import (
    "context"
    "sync"
)

// SideInput provides additional data to transforms
type SideInput struct {
    mu    sync.RWMutex
    data  map[any]any
    ready chan struct{}
}

func NewSideInput() *SideInput {
    return &SideInput{
        data:  make(map[any]any),
        ready: make(chan struct{}),
    }
}

func (s *SideInput) Set(key, value any) {
    s.mu.Lock()
    defer s.mu.Unlock()
    s.data[key] = value
}

func (s *SideInput) Get(key any) (any, bool) {
    s.mu.RLock()
    defer s.mu.RUnlock()
    value, exists := s.data[key]
    return value, exists
}

func (s *SideInput) MarkReady() {
    close(s.ready)
}

func (s *SideInput) Wait(ctx context.Context) error {
    select {
    case <-s.ready:
        return nil
    case <-ctx.Done():
        return ctx.Err()
    }
}

// EnrichTransform enriches elements with side input data
type EnrichTransform struct {
    BaseTransform
    sideInput *SideInput
    enrichFn  EnrichFn
}

type EnrichFn func(elem Element, sideInput *SideInput) (Element, error)

func NewEnrichTransform(name string, sideInput *SideInput, fn EnrichFn) *EnrichTransform {
    return &EnrichTransform{
        BaseTransform: BaseTransform{name: name},
        sideInput:     sideInput,
        enrichFn:      fn,
    }
}

func (t *EnrichTransform) Process(ctx context.Context, in <-chan Element, out chan<- Element) error {
    // Wait for side input to be ready
    if err := t.sideInput.Wait(ctx); err != nil {
        return err
    }

    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        case elem, ok := <-in:
            if !ok {
                return nil
            }

            enriched, err := t.enrichFn(elem, t.sideInput)
            if err != nil {
                return err
            }

            select {
            case out <- enriched:
            case <-ctx.Done():
                return ctx.Err()
            }
        }
    }
}
```

---
