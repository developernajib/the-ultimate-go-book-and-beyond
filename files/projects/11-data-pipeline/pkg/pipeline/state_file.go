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
