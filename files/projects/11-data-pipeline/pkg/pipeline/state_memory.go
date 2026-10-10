// pkg/pipeline/state_memory.go
package pipeline

import (
    "context"
    "fmt"
    "sync"
    "time"
)

// MemoryStateBackend stores state in memory
type MemoryStateBackend struct {
    mu           sync.RWMutex
    data         map[string][]byte
    checkpoints  map[CheckpointID]map[string][]byte
    nextID       int64
}

func NewMemoryStateBackend() *MemoryStateBackend {
    return &MemoryStateBackend{
        data:        make(map[string][]byte),
        checkpoints: make(map[CheckpointID]map[string][]byte),
    }
}

func (b *MemoryStateBackend) Get(ctx context.Context, key string) ([]byte, error) {
    b.mu.RLock()
    defer b.mu.RUnlock()

    value, exists := b.data[key]
    if !exists {
        return nil, nil
    }

    // Return a copy
    result := make([]byte, len(value))
    copy(result, value)
    return result, nil
}

func (b *MemoryStateBackend) Put(ctx context.Context, key string, value []byte) error {
    b.mu.Lock()
    defer b.mu.Unlock()

    // Store a copy
    data := make([]byte, len(value))
    copy(data, value)
    b.data[key] = data

    return nil
}

func (b *MemoryStateBackend) Delete(ctx context.Context, key string) error {
    b.mu.Lock()
    defer b.mu.Unlock()

    delete(b.data, key)
    return nil
}

func (b *MemoryStateBackend) Checkpoint(ctx context.Context) (CheckpointID, error) {
    b.mu.Lock()
    defer b.mu.Unlock()

    // Create checkpoint ID
    b.nextID++
    checkpointID := CheckpointID(fmt.Sprintf("checkpoint-%d-%d", b.nextID, time.Now().Unix()))

    // Copy current state
    snapshot := make(map[string][]byte, len(b.data))
    for key, value := range b.data {
        data := make([]byte, len(value))
        copy(data, value)
        snapshot[key] = data
    }

    b.checkpoints[checkpointID] = snapshot

    return checkpointID, nil
}

func (b *MemoryStateBackend) Restore(ctx context.Context, checkpointID CheckpointID) error {
    b.mu.Lock()
    defer b.mu.Unlock()

    snapshot, exists := b.checkpoints[checkpointID]
    if !exists {
        return fmt.Errorf("checkpoint not found: %s", checkpointID)
    }

    // Restore state
    b.data = make(map[string][]byte, len(snapshot))
    for key, value := range snapshot {
        data := make([]byte, len(value))
        copy(data, value)
        b.data[key] = data
    }

    return nil
}

func (b *MemoryStateBackend) Close() error {
    b.mu.Lock()
    defer b.mu.Unlock()

    b.data = nil
    b.checkpoints = nil

    return nil
}
