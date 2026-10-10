// pkg/pipeline/checkpoint.go
package pipeline

import (
    "context"
    "fmt"
    "sync"
    "time"
)

// CheckpointCoordinator manages checkpoints
type CheckpointCoordinator struct {
    mu             sync.Mutex
    backend        StateBackend
    interval       time.Duration
    lastCheckpoint time.Time
    checkpoints    []CheckpointMetadata
}

type CheckpointMetadata struct {
    ID        CheckpointID
    Timestamp time.Time
    Size      int64
}

func NewCheckpointCoordinator(backend StateBackend) *CheckpointCoordinator {
    return &CheckpointCoordinator{
        backend:     backend,
        interval:    time.Minute,
        checkpoints: make([]CheckpointMetadata, 0),
    }
}

func (c *CheckpointCoordinator) WithInterval(interval time.Duration) *CheckpointCoordinator {
    c.interval = interval
    return c
}

func (c *CheckpointCoordinator) Start(ctx context.Context) error {
    ticker := time.NewTicker(c.interval)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        case <-ticker.C:
            if err := c.TriggerCheckpoint(ctx); err != nil {
                // Log error but continue
                fmt.Printf("Checkpoint error: %v\n", err)
            }
        }
    }
}

func (c *CheckpointCoordinator) TriggerCheckpoint(ctx context.Context) error {
    c.mu.Lock()
    defer c.mu.Unlock()

    // Create checkpoint
    checkpointID, err := c.backend.Checkpoint(ctx)
    if err != nil {
        return fmt.Errorf("failed to create checkpoint: %w", err)
    }

    // Record metadata
    metadata := CheckpointMetadata{
        ID:        checkpointID,
        Timestamp: time.Now(),
    }

    c.checkpoints = append(c.checkpoints, metadata)
    c.lastCheckpoint = time.Now()

    // Keep only recent checkpoints
    if len(c.checkpoints) > 10 {
        c.checkpoints = c.checkpoints[len(c.checkpoints)-10:]
    }

    return nil
}

func (c *CheckpointCoordinator) RestoreLatest(ctx context.Context) error {
    c.mu.Lock()
    defer c.mu.Unlock()

    if len(c.checkpoints) == 0 {
        return fmt.Errorf("no checkpoints available")
    }

    latest := c.checkpoints[len(c.checkpoints)-1]

    if err := c.backend.Restore(ctx, latest.ID); err != nil {
        return fmt.Errorf("failed to restore checkpoint: %w", err)
    }

    return nil
}

func (c *CheckpointCoordinator) ListCheckpoints() []CheckpointMetadata {
    c.mu.Lock()
    defer c.mu.Unlock()

    result := make([]CheckpointMetadata, len(c.checkpoints))
    copy(result, c.checkpoints)
    return result
}
