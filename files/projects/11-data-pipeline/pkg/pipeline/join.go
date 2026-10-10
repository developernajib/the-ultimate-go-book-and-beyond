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

// windowKey is a string key for windows in maps
type windowKey = string

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

// Process implements a two-input join. Uses a separate method signature.
func (t *JoinTransform) ProcessJoin(ctx context.Context, left <-chan Element, right <-chan Element, out chan<- Element) error {
	// Collect all elements from both sides
	leftMap := make(map[any]map[windowKey][]Element)
	rightMap := make(map[any]map[windowKey][]Element)

	var wg sync.WaitGroup
	errChan := make(chan error, 2)

	// Collect left side
	wg.Go(func() {

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
				var wk windowKey = "global"
				if wv, ok := elem.Value.(WindowedValue); ok {
					wk = wv.Window.String()
				}

				if _, exists := leftMap[key]; !exists {
					leftMap[key] = make(map[windowKey][]Element)
				}
				leftMap[key][wk] = append(leftMap[key][wk], elem)
			}
		}
	})

	// Collect right side
	wg.Go(func() {

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
				var wk windowKey = "global"
				if wv, ok := elem.Value.(WindowedValue); ok {
					wk = wv.Window.String()
				}

				if _, exists := rightMap[key]; !exists {
					rightMap[key] = make(map[windowKey][]Element)
				}
				rightMap[key][wk] = append(rightMap[key][wk], elem)
			}
		}
	})

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

// Process implements Transform interface (single input - no-op for join)
func (t *JoinTransform) Process(ctx context.Context, in <-chan Element, out chan<- Element) error {
	// JoinTransform requires two inputs; use ProcessJoin instead
	return nil
}

func (t *JoinTransform) performJoin(
	ctx context.Context,
	leftMap, rightMap map[any]map[windowKey][]Element,
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

		// Get all window keys
		allWindowKeys := make(map[windowKey]bool)
		for wk := range leftWindows {
			allWindowKeys[wk] = true
		}
		for wk := range rightWindows {
			allWindowKeys[wk] = true
		}

		for wk := range allWindowKeys {
			leftElems := leftWindows[wk]
			rightElems := rightWindows[wk]

			switch t.joinType {
			case InnerJoin:
				if len(leftElems) > 0 && len(rightElems) > 0 {
					if err := t.emitJoined(ctx, key, leftElems, rightElems, out); err != nil {
						return err
					}
				}

			case LeftJoin:
				if len(leftElems) > 0 {
					if err := t.emitJoined(ctx, key, leftElems, rightElems, out); err != nil {
						return err
					}
				}

			case RightJoin:
				if len(rightElems) > 0 {
					if err := t.emitJoined(ctx, key, leftElems, rightElems, out); err != nil {
						return err
					}
				}

			case FullOuterJoin:
				if err := t.emitJoined(ctx, key, leftElems, rightElems, out); err != nil {
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
