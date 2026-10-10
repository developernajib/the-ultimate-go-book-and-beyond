// internal/recovery/snapshot.go
package recovery

import (
	"context"
	"fmt"
	"time"

	"github.com/example/trading-system/pkg/types"
)

// Snapshot represents system state snapshot
type Snapshot struct {
	Timestamp time.Time
	Orders    map[types.OrderID]*types.Order
	Positions map[types.AccountID]map[types.Symbol]*types.Position
	Accounts  map[types.AccountID]*types.Account
	Sequence  uint64
}

// SnapshotManager manages state snapshots
type SnapshotManager struct {
	interval time.Duration
	storage  SnapshotStorage
}

// SnapshotStorage defines storage interface
type SnapshotStorage interface {
	Save(ctx context.Context, snapshot *Snapshot) error
	Load(ctx context.Context) (*Snapshot, error)
	List(ctx context.Context, limit int) ([]*Snapshot, error)
}

// NewSnapshotManager creates a snapshot manager
func NewSnapshotManager(interval time.Duration, storage SnapshotStorage) *SnapshotManager {
	return &SnapshotManager{
		interval: interval,
		storage:  storage,
	}
}

// CreateSnapshot creates a system snapshot
func (sm *SnapshotManager) CreateSnapshot(
	orders map[types.OrderID]*types.Order,
	positions map[types.AccountID]map[types.Symbol]*types.Position,
	accounts map[types.AccountID]*types.Account,
	sequence uint64,
) (*Snapshot, error) {
	return &Snapshot{
		Timestamp: time.Now(),
		Orders:    orders,
		Positions: positions,
		Accounts:  accounts,
		Sequence:  sequence,
	}, nil
}

// SaveSnapshot saves a snapshot
func (sm *SnapshotManager) SaveSnapshot(ctx context.Context, snapshot *Snapshot) error {
	return sm.storage.Save(ctx, snapshot)
}

// LoadSnapshot loads the latest snapshot
func (sm *SnapshotManager) LoadSnapshot(ctx context.Context) (*Snapshot, error) {
	return sm.storage.Load(ctx)
}

// Recover recovers system state from snapshot
func (sm *SnapshotManager) Recover(ctx context.Context) (*Snapshot, error) {
	snapshot, err := sm.LoadSnapshot(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to load snapshot: %w", err)
	}

	// Validate snapshot
	if time.Since(snapshot.Timestamp) > 24*time.Hour {
		return nil, fmt.Errorf("snapshot too old: %v", snapshot.Timestamp)
	}

	return snapshot, nil
}
