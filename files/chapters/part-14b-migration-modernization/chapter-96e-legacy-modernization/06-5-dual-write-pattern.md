## 5. Dual-Write Pattern

Dual-write ensures data written to the new service is also written to the legacy system (or vice versa) during migration, preventing divergence. During a migration, you cannot simply stop writing to the old database and start writing to the new one overnight. Instead, every write operation goes to both stores so that both remain in sync throughout the transition period. The coordinator below supports three modes: old-primary (write to legacy first, then async to new), new-primary (the reverse), and synchronous (write to both in parallel and require both to succeed). Old-primary is safest at the start of a migration, and you switch to new-primary once you trust the new store, and eventually drop the secondary write entirely.

```go
// file: internal/dualwrite/coordinator.go
package dualwrite

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/example/gobook/internal/domain"
	"github.com/example/gobook/internal/metrics"
)

// Mode controls how dual-write operates.
type Mode int

const (
	// ModeOldPrimary writes to old first - new is best-effort async.
	ModeOldPrimary Mode = iota
	// ModeNewPrimary writes to new first - old is best-effort async.
	ModeNewPrimary
	// ModeSynchronous writes to both synchronously - both must succeed.
	ModeSynchronous
)

// Coordinator manages dual-write operations across two repositories.
type Coordinator struct {
	old     domain.UserRepository
	new     domain.UserRepository
	mode    Mode
	logger  *slog.Logger
	metrics *metrics.MigrationMetrics
	async   chan asyncOp
}

// asyncOp represents a deferred write to the secondary store.
type asyncOp struct {
	operation string
	fn        func(ctx context.Context) error
	retries   int
}

// NewCoordinator initializes a dual-write coordinator.
func NewCoordinator(
	old, new domain.UserRepository,
	mode Mode,
	logger *slog.Logger,
	m *metrics.MigrationMetrics,
) *Coordinator {
	c := &Coordinator{
		old:     old,
		new:     new,
		mode:    mode,
		logger:  logger,
		metrics: m,
		async:   make(chan asyncOp, 500),
	}
	go c.processAsync()
	return c
}

// Create writes a new user through the coordinator.
func (c *Coordinator) Create(ctx context.Context, u *domain.User) error {
	switch c.mode {
	case ModeOldPrimary:
		return c.writePrimaryFirst(ctx, "create",
			func(ctx context.Context) error { return c.old.Create(ctx, u) },
			func(ctx context.Context) error { return c.new.Create(ctx, u) },
		)
	case ModeNewPrimary:
		return c.writePrimaryFirst(ctx, "create",
			func(ctx context.Context) error { return c.new.Create(ctx, u) },
			func(ctx context.Context) error { return c.old.Create(ctx, u) },
		)
	case ModeSynchronous:
		return c.writeSynchronous(ctx, "create",
			func(ctx context.Context) error { return c.old.Create(ctx, u) },
			func(ctx context.Context) error { return c.new.Create(ctx, u) },
		)
	default:
		return fmt.Errorf("unknown dual-write mode: %d", c.mode)
	}
}

// Update updates a user through the coordinator.
func (c *Coordinator) Update(ctx context.Context, u *domain.User) error {
	switch c.mode {
	case ModeOldPrimary:
		return c.writePrimaryFirst(ctx, "update",
			func(ctx context.Context) error { return c.old.Update(ctx, u) },
			func(ctx context.Context) error { return c.new.Update(ctx, u) },
		)
	case ModeNewPrimary:
		return c.writePrimaryFirst(ctx, "update",
			func(ctx context.Context) error { return c.new.Update(ctx, u) },
			func(ctx context.Context) error { return c.old.Update(ctx, u) },
		)
	case ModeSynchronous:
		return c.writeSynchronous(ctx, "update",
			func(ctx context.Context) error { return c.old.Update(ctx, u) },
			func(ctx context.Context) error { return c.new.Update(ctx, u) },
		)
	default:
		return fmt.Errorf("unknown dual-write mode: %d", c.mode)
	}
}

// Delete removes a user through the coordinator.
func (c *Coordinator) Delete(ctx context.Context, id domain.UserID) error {
	switch c.mode {
	case ModeOldPrimary:
		return c.writePrimaryFirst(ctx, "delete",
			func(ctx context.Context) error { return c.old.Delete(ctx, id) },
			func(ctx context.Context) error { return c.new.Delete(ctx, id) },
		)
	case ModeNewPrimary:
		return c.writePrimaryFirst(ctx, "delete",
			func(ctx context.Context) error { return c.new.Delete(ctx, id) },
			func(ctx context.Context) error { return c.old.Delete(ctx, id) },
		)
	case ModeSynchronous:
		return c.writeSynchronous(ctx, "delete",
			func(ctx context.Context) error { return c.old.Delete(ctx, id) },
			func(ctx context.Context) error { return c.new.Delete(ctx, id) },
		)
	default:
		return fmt.Errorf("unknown dual-write mode: %d", c.mode)
	}
}

// writePrimaryFirst writes to primary synchronously, enqueues secondary async.
func (c *Coordinator) writePrimaryFirst(
	ctx context.Context,
	op string,
	primary func(context.Context) error,
	secondary func(context.Context) error,
) error {
	start := time.Now()
	if err := primary(ctx); err != nil {
		c.metrics.RecordDualWriteError(op, "primary")
		return fmt.Errorf("dual-write %s primary: %w", op, err)
	}
	c.metrics.RecordDualWriteLatency(op, "primary", time.Since(start))

	// Enqueue secondary write with retries.
	select {
	case c.async <- asyncOp{operation: op, fn: secondary, retries: 3}:
	default:
		c.logger.Error("dual-write async queue full, secondary write dropped",
			"operation", op,
		)
		c.metrics.RecordDualWriteError(op, "async_queue_full")
	}
	return nil
}

// writeSynchronous writes to both stores within the same call.
// If the secondary fails, it logs and continues (eventual consistency).
func (c *Coordinator) writeSynchronous(
	ctx context.Context,
	op string,
	primary func(context.Context) error,
	secondary func(context.Context) error,
) error {
	errCh := make(chan error, 2)

	go func() {
		errCh <- primary(ctx)
	}()
	go func() {
		errCh <- secondary(ctx)
	}()

	var errs []error
	for i := 0; i < 2; i++ {
		if err := <-errCh; err != nil {
			errs = append(errs, err)
		}
	}

	if len(errs) > 0 {
		c.metrics.RecordDualWriteError(op, "synchronous")
		return fmt.Errorf("dual-write %s synchronous: %w", op, errors.Join(errs...))
	}
	return nil
}

// processAsync drains the async queue with retry logic.
func (c *Coordinator) processAsync() {
	for op := range c.async {
		c.executeWithRetry(op)
	}
}

// executeWithRetry attempts an async operation up to op.retries times.
func (c *Coordinator) executeWithRetry(op asyncOp) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	var lastErr error
	for attempt := 0; attempt <= op.retries; attempt++ {
		if attempt > 0 {
			backoff := time.Duration(attempt*attempt) * 100 * time.Millisecond
			time.Sleep(backoff)
		}
		if err := op.fn(ctx); err != nil {
			lastErr = err
			c.logger.Warn("dual-write async retry",
				"operation", op.operation,
				"attempt", attempt+1,
				"error", err,
			)
			continue
		}
		c.metrics.RecordDualWriteSuccess(op.operation, "async")
		return
	}

	c.logger.Error("dual-write async failed after retries",
		"operation", op.operation,
		"retries", op.retries,
		"final_error", lastErr,
	)
	c.metrics.RecordDualWriteError(op.operation, "async_exhausted")
}
```

### Junior → FAANG: Dual-Write as the Data Consistency Bridge

Dual-write is the pattern that enables zero-downtime data store migrations. Without it, the only safe migration strategy is a maintenance window where writes are stopped, data is copied, and then the new store is promoted. With dual-write, the migration can proceed while users continue writing data to both stores simultaneously.

The three modes in this implementation (old-primary, new-primary, synchronous) correspond to the three phases of a typical migration. Old-primary is safest for the early phase because failures in the new store do not affect users. New-primary signals that the team has enough confidence in the new store to prioritize its consistency. Synchronous is rarely used in high-throughput systems because it doubles the write latency and creates the risk of write failures when either store is unavailable.

The async retry queue in the old-primary mode is a critical safety net. If the new store write fails, the coordinator retries it with backoff rather than silently dropping it. The bounded channel prevents unbounded memory growth during extended new-store outages. Understanding this backpressure mechanism is important for correctly sizing the channel and setting the retry policy.

### Senior @ FAANG: Dual-Write Governance and the Consistency Model

At senior level, the dual-write pattern introduces consistency challenges that require explicit architectural decisions. In old-primary mode, the new store is eventually consistent with the old store: writes succeed in the old store and are asynchronously applied to the new store. This means that reads from the new store during the async window may not reflect the most recent writes.

The governance decision: what is the acceptable eventual consistency window, and how does the system behave when reads from the new store are served during that window. If the answer is "the new store should not serve reads for entities with in-flight async writes," the system needs a mechanism to track which entities have pending async writes. If the answer is "stale reads are acceptable with a bounded staleness window," the staleness bound needs to be defined and enforced.

The dual-write error taxonomy is the most important governance artifact for the operation of the migration. Errors in the primary store are production incidents. Errors in the secondary store are migration incidents. Each category has different alert routing, different on-call responses, and different escalation paths. Conflating the two error types in a single alert leads to incorrect prioritization during incidents.

---
