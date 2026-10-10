## 90E.7 Backpressure and Flow Control

Backpressure prevents a fast event producer from overwhelming a slow consumer by making the queue depth a visible, actionable signal. Rather than silently dropping events or growing unbounded memory, a bounded processor rejects new work with an explicit error when its queue is full, giving the caller an opportunity to retry later or shed load gracefully. The `BoundedProcessor` below uses a buffered channel as the queue and a fixed goroutine pool as the workers, which bounds both memory usage and CPU consumption. The `LeakyBucket` rate limiter complements this by smoothing bursty ingestion. Tokens accumulate at a constant rate and each incoming event costs one token, so sustained overload is throttled rather than crashing the service.

```go
package backpressure

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"
)

// BoundedProcessor processes events with backpressure
type BoundedProcessor struct {
	queue     chan ProcessingJob
	workers   int
	processed atomic.Int64
	dropped   atomic.Int64
	logger    *slog.Logger
}

type ProcessingJob struct {
	Event   any
	Handler func(ctx context.Context, event any) error
	DoneC   chan error
}

func NewBoundedProcessor(queueSize, workers int) *BoundedProcessor {
	return &BoundedProcessor{
		queue:   make(chan ProcessingJob, queueSize),
		workers: workers,
		logger:  slog.Default(),
	}
}

func (p *BoundedProcessor) Start(ctx context.Context) {
	for i := 0; i < p.workers; i++ {
		go p.work(ctx)
	}
}

func (p *BoundedProcessor) work(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case job := <-p.queue:
			err := job.Handler(ctx, job.Event)
			p.processed.Add(1)
			if job.DoneC != nil {
				job.DoneC <- err
			}
		}
	}
}

// Submit adds an event for processing, applying backpressure
func (p *BoundedProcessor) Submit(ctx context.Context, event any, handler func(context.Context, any) error) error {
	job := ProcessingJob{Event: event, Handler: handler}

	select {
	case p.queue <- job:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	default:
		// Queue full - apply backpressure
		p.dropped.Add(1)
		return fmt.Errorf("processor queue full (%d/%d), backpressure applied",
			len(p.queue), cap(p.queue))
	}
}

// SubmitWait submits an event and waits for the result
func (p *BoundedProcessor) SubmitWait(ctx context.Context, event any, handler func(context.Context, any) error) error {
	done := make(chan error, 1)
	job := ProcessingJob{Event: event, Handler: handler, DoneC: done}

	select {
	case p.queue <- job:
	case <-ctx.Done():
		return ctx.Err()
	}

	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Stats returns processing statistics
func (p *BoundedProcessor) Stats() map[string]int64 {
	return map[string]int64{
		"processed":   p.processed.Load(),
		"dropped":     p.dropped.Load(),
		"queue_depth": int64(len(p.queue)),
		"queue_cap":   int64(cap(p.queue)),
	}
}

// LeakyBucket implements the leaky bucket rate limiter for event ingestion
type LeakyBucket struct {
	mu       sync.Mutex
	tokens   float64
	maxTokens float64
	refillRate float64 // tokens per second
	lastRefill time.Time
}

func NewLeakyBucket(maxTokens, refillRate float64) *LeakyBucket {
	return &LeakyBucket{
		tokens:     maxTokens,
		maxTokens:  maxTokens,
		refillRate: refillRate,
		lastRefill: time.Now(),
	}
}

func (lb *LeakyBucket) TryConsume(tokens float64) bool {
	lb.mu.Lock()
	defer lb.mu.Unlock()

	// Refill tokens based on elapsed time
	now := time.Now()
	elapsed := now.Sub(lb.lastRefill).Seconds()
	lb.tokens = min(lb.maxTokens, lb.tokens+elapsed*lb.refillRate)
	lb.lastRefill = now

	if lb.tokens < tokens {
		return false
	}
	lb.tokens -= tokens
	return true
}

// Note: Uses builtin min() available since Go 1.21
```

---
