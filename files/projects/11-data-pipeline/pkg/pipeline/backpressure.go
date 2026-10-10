// pkg/pipeline/backpressure.go
package pipeline

import (
	"context"
	"sync"
	"sync/atomic"
	"time"
)

// BackpressureStrategy controls flow rate
type BackpressureStrategy interface {
	ShouldThrottle(metrics *FlowMetrics) bool
	GetDelay(metrics *FlowMetrics) time.Duration
}

// FlowMetrics tracks flow statistics
type FlowMetrics struct {
	Throughput     float64 // Elements per second
	BufferSize     int64
	BufferCapacity int64
	Latency        time.Duration
}

// AdaptiveBackpressure adjusts based on metrics
type AdaptiveBackpressure struct {
	targetUtilization float64 // Target buffer utilization (0-1)
	minDelay          time.Duration
	maxDelay          time.Duration
}

func NewAdaptiveBackpressure() *AdaptiveBackpressure {
	return &AdaptiveBackpressure{
		targetUtilization: 0.7,
		minDelay:          time.Millisecond,
		maxDelay:          time.Second,
	}
}

func (b *AdaptiveBackpressure) ShouldThrottle(metrics *FlowMetrics) bool {
	if metrics.BufferCapacity == 0 {
		return false
	}

	utilization := float64(metrics.BufferSize) / float64(metrics.BufferCapacity)
	return utilization > b.targetUtilization
}

func (b *AdaptiveBackpressure) GetDelay(metrics *FlowMetrics) time.Duration {
	if metrics.BufferCapacity == 0 {
		return 0
	}

	utilization := float64(metrics.BufferSize) / float64(metrics.BufferCapacity)

	if utilization <= b.targetUtilization {
		return 0
	}

	// Linear delay based on over-utilization
	overUtilization := utilization - b.targetUtilization
	delayFactor := overUtilization / (1.0 - b.targetUtilization)

	delay := min(time.Duration(float64(b.maxDelay-b.minDelay)*delayFactor)+b.minDelay, b.maxDelay)

	return delay
}

// RateLimiter limits throughput
type RateLimiter struct {
	mu          sync.Mutex
	rate        float64 // Elements per second
	tokensAvail float64
	lastUpdate  time.Time
}

func NewRateLimiter(rate float64) *RateLimiter {
	return &RateLimiter{
		rate:        rate,
		tokensAvail: rate,
		lastUpdate:  time.Now(),
	}
}

func (r *RateLimiter) Allow() bool {
	r.mu.Lock()
	defer r.mu.Unlock()

	now := time.Now()
	elapsed := now.Sub(r.lastUpdate).Seconds()

	// Add tokens based on elapsed time
	r.tokensAvail += elapsed * r.rate
	if r.tokensAvail > r.rate {
		r.tokensAvail = r.rate
	}

	r.lastUpdate = now

	if r.tokensAvail >= 1.0 {
		r.tokensAvail -= 1.0
		return true
	}

	return false
}

func (r *RateLimiter) Wait(ctx context.Context) error {
	for {
		if r.Allow() {
			return nil
		}

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Millisecond):
		}
	}
}

// BufferedChannel wraps a channel with backpressure
type BufferedChannel struct {
	ch       chan Element
	capacity int64
	size     int64
	strategy BackpressureStrategy
	metrics  *FlowMetrics
	mu       sync.Mutex
}

func NewBufferedChannel(capacity int, strategy BackpressureStrategy) *BufferedChannel {
	return &BufferedChannel{
		ch:       make(chan Element, capacity),
		capacity: int64(capacity),
		strategy: strategy,
		metrics: &FlowMetrics{
			BufferCapacity: int64(capacity),
		},
	}
}

func (b *BufferedChannel) Send(ctx context.Context, elem Element) error {
	for {
		// Check backpressure
		b.mu.Lock()
		b.metrics.BufferSize = atomic.LoadInt64(&b.size)

		if b.strategy.ShouldThrottle(b.metrics) {
			delay := b.strategy.GetDelay(b.metrics)
			b.mu.Unlock()

			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(delay):
				continue
			}
		}
		b.mu.Unlock()

		// Try to send
		select {
		case <-ctx.Done():
			return ctx.Err()
		case b.ch <- elem:
			atomic.AddInt64(&b.size, 1)
			return nil
		default:
			// Channel full, wait and retry
			time.Sleep(time.Millisecond)
		}
	}
}

func (b *BufferedChannel) Receive() <-chan Element {
	// Wrap receive to track size
	out := make(chan Element)

	go func() {
		defer close(out)

		for elem := range b.ch {
			atomic.AddInt64(&b.size, -1)
			out <- elem
		}
	}()

	return out
}

func (b *BufferedChannel) Close() {
	close(b.ch)
}
