// pkg/pipeline/state.go
package pipeline

import (
    "context"
    "encoding/json"
    "fmt"
)

// StateBackend manages pipeline state
type StateBackend interface {
    // Get retrieves a value from state
    Get(ctx context.Context, key string) ([]byte, error)

    // Put stores a value in state
    Put(ctx context.Context, key string, value []byte) error

    // Delete removes a value from state
    Delete(ctx context.Context, key string) error

    // Checkpoint creates a state checkpoint
    Checkpoint(ctx context.Context) (CheckpointID, error)

    // Restore restores from a checkpoint
    Restore(ctx context.Context, checkpointID CheckpointID) error

    // Close closes the state backend
    Close() error
}

// CheckpointID identifies a checkpoint
type CheckpointID string

// StateKey represents a key in state
type StateKey struct {
    Namespace string
    Key       string
    Window    Window
}

func (k StateKey) String() string {
    return fmt.Sprintf("%s/%s/%v", k.Namespace, k.Key, k.Window)
}

// State provides typed access to backend state
type State struct {
    backend   StateBackend
    namespace string
}

func NewState(backend StateBackend, namespace string) *State {
    return &State{
        backend:   backend,
        namespace: namespace,
    }
}

// ValueState manages a single value
type ValueState struct {
    state  *State
    key    string
    window Window
}

func (s *State) Value(key string, window Window) *ValueState {
    return &ValueState{
        state:  s,
        key:    key,
        window: window,
    }
}

func (v *ValueState) Get(ctx context.Context) (any, error) {
    stateKey := StateKey{
        Namespace: v.state.namespace,
        Key:       v.key,
        Window:    v.window,
    }

    data, err := v.state.backend.Get(ctx, stateKey.String())
    if err != nil {
        return nil, err
    }

    if data == nil {
        return nil, nil
    }

    var value any
    if err := json.Unmarshal(data, &value); err != nil {
        return nil, err
    }

    return value, nil
}

func (v *ValueState) Set(ctx context.Context, value any) error {
    stateKey := StateKey{
        Namespace: v.state.namespace,
        Key:       v.key,
        Window:    v.window,
    }

    data, err := json.Marshal(value)
    if err != nil {
        return err
    }

    return v.state.backend.Put(ctx, stateKey.String(), data)
}

func (v *ValueState) Clear(ctx context.Context) error {
    stateKey := StateKey{
        Namespace: v.state.namespace,
        Key:       v.key,
        Window:    v.window,
    }

    return v.state.backend.Delete(ctx, stateKey.String())
}

// BagState manages a collection of values
type BagState struct {
    state  *State
    key    string
    window Window
}

func (s *State) Bag(key string, window Window) *BagState {
    return &BagState{
        state:  s,
        key:    key,
        window: window,
    }
}

func (b *BagState) Add(ctx context.Context, value any) error {
    // Get existing values
    values, err := b.Read(ctx)
    if err != nil {
        return err
    }

    values = append(values, value)

    stateKey := StateKey{
        Namespace: b.state.namespace,
        Key:       b.key,
        Window:    b.window,
    }

    data, err := json.Marshal(values)
    if err != nil {
        return err
    }

    return b.state.backend.Put(ctx, stateKey.String(), data)
}

func (b *BagState) Read(ctx context.Context) ([]any, error) {
    stateKey := StateKey{
        Namespace: b.state.namespace,
        Key:       b.key,
        Window:    b.window,
    }

    data, err := b.state.backend.Get(ctx, stateKey.String())
    if err != nil {
        return nil, err
    }

    if data == nil {
        return []any{}, nil
    }

    var values []any
    if err := json.Unmarshal(data, &values); err != nil {
        return nil, err
    }

    return values, nil
}

func (b *BagState) Clear(ctx context.Context) error {
    stateKey := StateKey{
        Namespace: b.state.namespace,
        Key:       b.key,
        Window:    b.window,
    }

    return b.state.backend.Delete(ctx, stateKey.String())
}
