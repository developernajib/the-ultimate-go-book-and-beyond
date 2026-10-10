## Part 5: State Management

Long-running pipelines need to remember things between processing steps and across restarts. State management provides a way to store intermediate results, and checkpointing lets the pipeline save its progress so it can recover from failures without reprocessing everything from scratch. This part defines the state backend interface and two concrete implementations.

### State Backend Interface

The `StateBackend` interface abstracts where pipeline state is stored. It supports basic key-value operations (Get, Put, Delete) along with checkpointing (save a snapshot of all state) and restoration (reload from a snapshot). The `State` wrapper provides typed access through `ValueState` for single values and `BagState` for collections. By coding against this interface, you can swap between memory, disk, or remote storage without changing any pipeline logic.

```go
// pkg/pipeline/state.go
package pipeline

import (
    "context"
    "encoding/json"
    "fmt"
    "io"
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
```

### Memory State Backend

The `MemoryStateBackend` stores all state in a Go map, making it the fastest option but also the least durable since data is lost when the process exits. It is ideal for testing, development, and short-lived batch pipelines. Checkpoints are created by copying the entire map into a separate snapshot map, and restoration replaces the current state with a previous snapshot. All operations are protected by a read-write mutex for safe concurrent access.

```go
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
```

### File State Backend

The `FileStateBackend` persists state to the local filesystem, providing durability across process restarts. It uses an in-memory cache for fast reads while writing every update to disk so nothing is lost on crash. Checkpoints copy all state files into a timestamped directory along with a metadata file that lists all keys. This backend is a good middle ground between the simplicity of in-memory storage and the durability of a remote database.

```go
// pkg/pipeline/state_file.go
package pipeline

import (
    "context"
    "encoding/json"
    "fmt"
    "os"
    "path/filepath"
    "sync"
    "time"
)

// FileStateBackend stores state on disk
type FileStateBackend struct {
    mu          sync.RWMutex
    baseDir     string
    cache       map[string][]byte
    nextID      int64
}

func NewFileStateBackend(baseDir string) (*FileStateBackend, error) {
    if err := os.MkdirAll(baseDir, 0755); err != nil {
        return nil, fmt.Errorf("failed to create state directory: %w", err)
    }

    return &FileStateBackend{
        baseDir: baseDir,
        cache:   make(map[string][]byte),
    }, nil
}

func (b *FileStateBackend) keyPath(key string) string {
    return filepath.Join(b.baseDir, "state", key)
}

func (b *FileStateBackend) Get(ctx context.Context, key string) ([]byte, error) {
    b.mu.RLock()

    // Check cache
    if value, exists := b.cache[key]; exists {
        b.mu.RUnlock()
        result := make([]byte, len(value))
        copy(result, value)
        return result, nil
    }
    b.mu.RUnlock()

    // Read from disk
    path := b.keyPath(key)
    data, err := os.ReadFile(path)
    if os.IsNotExist(err) {
        return nil, nil
    }
    if err != nil {
        return nil, err
    }

    // Update cache
    b.mu.Lock()
    cached := make([]byte, len(data))
    copy(cached, data)
    b.cache[key] = cached
    b.mu.Unlock()

    return data, nil
}

func (b *FileStateBackend) Put(ctx context.Context, key string, value []byte) error {
    path := b.keyPath(key)

    // Ensure directory exists
    if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
        return err
    }

    // Write to disk
    if err := os.WriteFile(path, value, 0644); err != nil {
        return err
    }

    // Update cache
    b.mu.Lock()
    cached := make([]byte, len(value))
    copy(cached, value)
    b.cache[key] = cached
    b.mu.Unlock()

    return nil
}

func (b *FileStateBackend) Delete(ctx context.Context, key string) error {
    path := b.keyPath(key)

    if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
        return err
    }

    b.mu.Lock()
    delete(b.cache, key)
    b.mu.Unlock()

    return nil
}

func (b *FileStateBackend) Checkpoint(ctx context.Context) (CheckpointID, error) {
    b.mu.Lock()
    defer b.mu.Unlock()

    b.nextID++
    checkpointID := CheckpointID(fmt.Sprintf("checkpoint-%d-%d", b.nextID, time.Now().Unix()))

    checkpointDir := filepath.Join(b.baseDir, "checkpoints", string(checkpointID))
    if err := os.MkdirAll(checkpointDir, 0755); err != nil {
        return "", err
    }

    // Save metadata
    metadata := struct {
        ID        CheckpointID `json:"id"`
        Timestamp time.Time    `json:"timestamp"`
        Keys      []string     `json:"keys"`
    }{
        ID:        checkpointID,
        Timestamp: time.Now(),
        Keys:      make([]string, 0, len(b.cache)),
    }

    // Copy state files
    for key := range b.cache {
        metadata.Keys = append(metadata.Keys, key)

        srcPath := b.keyPath(key)
        dstPath := filepath.Join(checkpointDir, key)

        if err := os.MkdirAll(filepath.Dir(dstPath), 0755); err != nil {
            return "", err
        }

        data, err := os.ReadFile(srcPath)
        if err != nil {
            return "", err
        }

        if err := os.WriteFile(dstPath, data, 0644); err != nil {
            return "", err
        }
    }

    // Save metadata
    metadataPath := filepath.Join(checkpointDir, "_metadata.json")
    metadataBytes, err := json.Marshal(metadata)
    if err != nil {
        return "", err
    }

    if err := os.WriteFile(metadataPath, metadataBytes, 0644); err != nil {
        return "", err
    }

    return checkpointID, nil
}

func (b *FileStateBackend) Restore(ctx context.Context, checkpointID CheckpointID) error {
    checkpointDir := filepath.Join(b.baseDir, "checkpoints", string(checkpointID))

    // Load metadata
    metadataPath := filepath.Join(checkpointDir, "_metadata.json")
    metadataBytes, err := os.ReadFile(metadataPath)
    if err != nil {
        return fmt.Errorf("checkpoint not found: %w", err)
    }

    var metadata struct {
        ID        CheckpointID `json:"id"`
        Timestamp time.Time    `json:"timestamp"`
        Keys      []string     `json:"keys"`
    }

    if err := json.Unmarshal(metadataBytes, &metadata); err != nil {
        return err
    }

    b.mu.Lock()
    defer b.mu.Unlock()

    // Clear current state
    b.cache = make(map[string][]byte)

    stateDir := filepath.Join(b.baseDir, "state")
    os.RemoveAll(stateDir)
    os.MkdirAll(stateDir, 0755)

    // Restore files
    for _, key := range metadata.Keys {
        srcPath := filepath.Join(checkpointDir, key)
        dstPath := b.keyPath(key)

        data, err := os.ReadFile(srcPath)
        if err != nil {
            return err
        }

        if err := os.MkdirAll(filepath.Dir(dstPath), 0755); err != nil {
            return err
        }

        if err := os.WriteFile(dstPath, data, 0644); err != nil {
            return err
        }

        // Update cache
        cached := make([]byte, len(data))
        copy(cached, data)
        b.cache[key] = cached
    }

    return nil
}

func (b *FileStateBackend) Close() error {
    b.mu.Lock()
    defer b.mu.Unlock()

    b.cache = nil
    return nil
}
```
