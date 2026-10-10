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
