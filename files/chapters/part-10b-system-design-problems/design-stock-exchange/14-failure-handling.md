## Failure Handling

The primary risk in a hot-standby exchange failover is split-brain: if the backup mistakenly believes the primary is down and promotes itself, both nodes may accept and match orders independently, corrupting the order book.

It is worth separating two things that are easy to conflate, because they solve different problems. Replaying the WAL from the last snapshot makes the backup's state *correct*, so it resumes from precisely where the primary left off. It does nothing whatsoever about split-brain: two nodes with perfectly correct state that both accept orders are still two exchanges quoting the same stock. Mutual exclusion is a separate mechanism, and it is the distributed lock (etcd or ZooKeeper) plus the monotonically increasing fencing token it hands out. The backup acquires the lock before it rebuilds anything, and every order it accepts carries its epoch. If the original primary recovers and resumes accepting orders, its epoch is now stale and the order gateway rejects it, which works even though the old primary is entirely convinced it is still in charge. That last property is the whole point: a fencing token defends against a node that is wrong rather than a node that is down. The `Heartbeat` monitor uses a configurable timeout rather than a fixed value so that operators can tune the tradeoff between fast failover and false-positive promotions caused by transient network hiccups.

```go
package failover

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"
)

// Lock is a distributed lock (etcd, ZooKeeper) that returns a fencing token.
// The token is the actual split-brain defense: it increases on every
// acquisition, and the order gateway refuses any command stamped with an
// epoch lower than the highest it has seen, so a recovered old primary is
// ignored no matter what it believes about itself.
type Lock interface {
	Acquire(ctx context.Context) (epoch int64, err error)
}

type Snapshot struct {
	Sequence int64
	Data     []byte
}

type WALEntry struct {
	Sequence int64
	Type     byte
	Data     []byte
}

type WALReader interface {
	LatestSnapshot(ctx context.Context) (Snapshot, error)
	ReadFrom(ctx context.Context, fromSeq int64) ([]WALEntry, error)
}

type Order struct {
	ID string
}

type MatchingEngine struct{}

func (m *MatchingEngine) LoadSnapshot(data []byte) error { return nil }
func (m *MatchingEngine) ApplyRecovered(o *Order) error  { return nil }
func (m *MatchingEngine) ApplyRecoveredCancel(data []byte) error { return nil }

func deserializeOrder(data []byte) (*Order, error) {
	return &Order{}, nil
}

type PrimaryBackupFailover struct {
	mu          sync.Mutex
	isPrimary   bool
	epoch       int64
	lock        Lock
	walReader   WALReader
	matchEngine *MatchingEngine
}

func (f *PrimaryBackupFailover) PromoteToActive(ctx context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()

	if f.isPrimary {
		return fmt.Errorf("already primary")
	}

	// Take the lock before rebuilding state, not after. Acquiring it is what
	// grants the right to be primary, and the epoch it returns is what makes
	// the old primary's orders rejectable.
	epoch, err := f.lock.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("acquire primary lock: %w", err)
	}

	// Load the most recent snapshot, then replay only what came after it.
	// Replaying from genesis would take hours at exchange volumes.
	snap, err := f.walReader.LatestSnapshot(ctx)
	if err != nil {
		return fmt.Errorf("load snapshot: %w", err)
	}
	if err := f.matchEngine.LoadSnapshot(snap.Data); err != nil {
		return fmt.Errorf("restore snapshot: %w", err)
	}

	entries, err := f.walReader.ReadFrom(ctx, snap.Sequence+1)
	if err != nil {
		return fmt.Errorf("read WAL from %d: %w", snap.Sequence+1, err)
	}

	for _, e := range entries {
		switch e.Type {
		case 'O':
			order, err := deserializeOrder(e.Data)
			if err != nil {
				return fmt.Errorf("corrupt order at sequence %d: %w", e.Sequence, err)
			}
			// Apply straight to the book. Routing through SubmitOrder here
			// would append the order to the WAL a second time and republish
			// its trades, so recovery would duplicate the very executions it
			// exists to restore.
			if err := f.matchEngine.ApplyRecovered(order); err != nil {
				return fmt.Errorf("replay order at sequence %d: %w", e.Sequence, err)
			}
		case 'C':
			if err := f.matchEngine.ApplyRecoveredCancel(e.Data); err != nil {
				return fmt.Errorf("replay cancel at sequence %d: %w", e.Sequence, err)
			}
		case 'T':
			// Trades are derived state. Replaying the orders through a
			// deterministic engine reproduces them exactly, which is the
			// point of determinism. They are logged for the audit trail.
		}
	}

	f.epoch = epoch
	f.isPrimary = true
	log.Printf("promoted at epoch %d: snapshot %d + %d replayed entries",
		epoch, snap.Sequence, len(entries))
	return nil
}

// Epoch is the fencing token the gateway stamps onto accepted orders.
func (f *PrimaryBackupFailover) Epoch() int64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.epoch
}

type Heartbeat struct {
	interval, timeout time.Duration
	onPrimaryDown     func()

	mu       sync.Mutex
	lastSeen time.Time
}

// Beat records a heartbeat from the primary. It is called on the receive path
// while Monitor reads on a timer, so lastSeen is shared mutable state and
// needs the lock. Promoting a healthy primary because of a torn read is a
// self-inflicted split-brain.
func (h *Heartbeat) Beat() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.lastSeen = time.Now()
}

func (h *Heartbeat) sinceLastSeen() time.Duration {
	h.mu.Lock()
	defer h.mu.Unlock()
	return time.Since(h.lastSeen)
}

func (h *Heartbeat) Monitor(ctx context.Context) {
	ticker := time.NewTicker(h.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if h.sinceLastSeen() > h.timeout {
				h.onPrimaryDown()
				return
			}
		}
	}
}
```

---
