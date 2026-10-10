## Section 6: Bulkheads

A bulkhead isolates failures within a partition of the system, preventing resource exhaustion in one area from cascading to others. Named after the watertight compartments of a ship's hull.

```go
// file: internal/resilience/bulkhead.go
package resilience

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"
)

// ErrBulkheadFull is returned when the bulkhead has no available capacity.
var ErrBulkheadFull = errors.New("bulkhead capacity exceeded")

// BulkheadConfig defines a bulkhead's resource limits.
type BulkheadConfig struct {
	Name            string
	MaxConcurrent   int           // max in-flight calls
	MaxQueueSize    int           // max calls waiting for capacity
	QueueTimeout    time.Duration // max time to wait in queue
}

// Bulkhead limits concurrent access to a resource.
type Bulkhead struct {
	cfg    BulkheadConfig
	sem    chan struct{}
	queue  chan struct{}
	mu     sync.Mutex
	active int
	logger *slog.Logger
}

func NewBulkhead(cfg BulkheadConfig, logger *slog.Logger) *Bulkhead {
	return &Bulkhead{
		cfg:    cfg,
		sem:    make(chan struct{}, cfg.MaxConcurrent),
		queue:  make(chan struct{}, cfg.MaxQueueSize),
		logger: logger.With("component", "bulkhead", "name", cfg.Name),
	}
}

// Execute runs fn within the bulkhead's resource constraints.
func (b *Bulkhead) Execute(ctx context.Context, fn func(ctx context.Context) error) error {
	// Try to enqueue (non-blocking).
	select {
	case b.queue <- struct{}{}:
	default:
		return fmt.Errorf("%w: name=%s, queue_size=%d", ErrBulkheadFull, b.cfg.Name, b.cfg.MaxQueueSize)
	}

	// Wait for a semaphore slot, respecting context and queue timeout.
	queueCtx, cancel := context.WithTimeout(ctx, b.cfg.QueueTimeout)
	defer cancel()

	select {
	case b.sem <- struct{}{}:
		<-b.queue // dequeue once we have the semaphore
	case <-queueCtx.Done():
		<-b.queue // dequeue on timeout too
		if errors.Is(queueCtx.Err(), context.DeadlineExceeded) {
			return fmt.Errorf("bulkhead queue timeout for %s: %w", b.cfg.Name, ErrBulkheadFull)
		}
		return queueCtx.Err()
	}

	b.mu.Lock()
	b.active++
	active := b.active
	b.mu.Unlock()

	b.logger.DebugContext(ctx, "bulkhead slot acquired", "active", active)

	defer func() {
		<-b.sem
		b.mu.Lock()
		b.active--
		b.mu.Unlock()
	}()

	return fn(ctx)
}

// Stats returns current bulkhead metrics.
func (b *Bulkhead) Stats() map[string]any {
	b.mu.Lock()
	defer b.mu.Unlock()
	return map[string]any{
		"name":          b.cfg.Name,
		"active":        b.active,
		"capacity":      b.cfg.MaxConcurrent,
		"queue_waiting": len(b.queue),
		"queue_capacity": b.cfg.MaxQueueSize,
	}
}
```

---

### Junior -> FAANG: Bulkheads as Resource Isolation, Not Just Error Isolation

The bulkhead pattern is named for watertight compartments in a ship. If one compartment floods, the ship stays afloat because the flood does not propagate to other compartments. In software, the flood is resource exhaustion: goroutines, connection pool slots, memory, or CPU. A bulkhead limits how many resources any single category of work can consume, preventing one category from starving all others.

The most common interview context for bulkheads is: "How do you prevent a surge in low-priority batch requests from degrading high-priority user-facing requests that share the same service?" The answer is: use a bulkhead that allocates a fixed number of goroutines (or connection pool slots) to batch requests and a separate pool to user-facing requests. When the batch pool is full, batch requests queue or reject. User-facing requests are unaffected because they draw from a separate pool.

The Go implementation using buffered channels as semaphores is worth memorizing. A buffered channel of size N, where each goroutine acquires a slot on entry and releases it on exit, limits concurrency to N without any explicit semaphore library. This is idiomatic Go: use channels for synchronization primitives.

### Senior @ FAANG: Bulkhead Sizing and Platform-Level Resource Governance

**Bulkhead sizing requires a concurrency capacity model.** Setting the bulkhead size to "10 concurrent requests" is arbitrary without a model. The correct derivation is: what is the maximum acceptable latency for this request category, what is the average request duration, and what is the target throughput? If max latency is 200ms, average request duration is 50ms, and target throughput is 100 RPS, then you need at most `100 RPS * 0.05s = 5 concurrent requests` to maintain throughput. Set the bulkhead to 5 with a 10% headroom: 6. Without this model, teams set arbitrarily large bulkheads that provide no isolation.

**Queue depth at the bulkhead entry.** When the bulkhead semaphore is full, subsequent requests can either fail immediately (no queue) or wait in a queue up to some maximum depth. No-queue (immediate rejection) is correct for user-facing endpoints where queuing adds latency that degrades user experience. A short queue is acceptable for backend processing where some latency is tolerable. The queue depth should be set to the maximum number of requests that can drain through the bulkhead within the RTO budget for that category.

**Per-tenant bulkheads for multi-tenant systems.** At FAANG scale, services often serve multiple tenants. Without per-tenant bulkheads, a noisy tenant that generates high request volume can consume the entire goroutine pool and starve other tenants. Per-tenant bulkheads limit each tenant to a maximum concurrent request count, ensuring that one tenant's traffic surge does not impact others. This is particularly important for services with free-tier and paid-tier tenants: the free tier should never impact the paid tier's SLA.

**Bulkhead observability and queue depth alerting.** The bulkhead implementation should expose two metrics: the current semaphore utilization (how many slots are in use out of the maximum) and the current queue depth (how many requests are waiting for a slot). An alert at 80% semaphore utilization gives the on-call engineer lead time to scale before the bulkhead starts rejecting requests at 100%. An alert on non-zero queue depth signals that the bulkhead is actively delaying requests, which may indicate an approaching capacity limit or a downstream slowdown.

**Bulkheads at multiple system layers.** A complete bulkhead strategy isolates at the HTTP handler layer (limiting concurrent requests per category), the database connection pool (limiting concurrent queries per query type or tenant), and the outbound HTTP client pool (limiting concurrent outbound requests per downstream). Isolating at only one layer still allows resource exhaustion at the others. A principal engineer designs bulkhead isolation as a cross-cutting concern applied at each resource-contention point, documented in a resource isolation ADR.

