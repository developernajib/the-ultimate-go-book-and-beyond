## Part 2: Lock-Free Data Structures

For ultra-low latency, we need lock-free data structures to minimize contention. Traditional mutexes force goroutines to wait in line, which adds unpredictable delays that are unacceptable in high-frequency trading. Lock-free structures use atomic CPU instructions (like compare-and-swap) to let multiple goroutines read and write concurrently without blocking each other. The trade-off is that lock-free code is harder to write correctly, but the latency improvement is dramatic, often reducing p99 latency by an order of magnitude.

### Lock-Free Queue
Lock-free data structures use atomic compare-and-swap operations instead of mutexes to coordinate concurrent access, eliminating scheduler preemptions as a latency source. In the microsecond-sensitive order processing path, avoiding OS-level synchronization primitives can meaningfully improve tail latency percentiles.

```go
// pkg/lockfree/queue.go
package lockfree

import (
	"runtime"
	"sync/atomic"
	"unsafe"
)

// Queue is a lock-free MPMC queue
// Based on the Michael-Scott algorithm with optimizations
type Queue[T any] struct {
	head unsafe.Pointer
	tail unsafe.Pointer
	len  atomic.Int64
}

type node[T any] struct {
	value T
	next  unsafe.Pointer
}

// NewQueue creates a new lock-free queue
func NewQueue[T any]() *Queue[T] {
	n := unsafe.Pointer(&node[T]{})
	return &Queue[T]{
		head: n,
		tail: n,
	}
}

// Enqueue adds an item to the queue
func (q *Queue[T]) Enqueue(value T) {
	n := &node[T]{value: value}

	for {
		tail := load[T](&q.tail)
		next := load[T](&tail.next)

		// Check if tail is still the last node
		if tail == load[T](&q.tail) {
			if next == nil {
				// Try to link new node
				if cas(&tail.next, next, n) {
					// Enqueue done, try to swing tail
					cas(&q.tail, tail, n)
					q.len.Add(1)
					return
				}
			} else {
				// Tail was not pointing to last node, try to swing it
				cas(&q.tail, tail, next)
			}
		}
	}
}

// Dequeue removes and returns an item from the queue
func (q *Queue[T]) Dequeue() (value T, ok bool) {
	for {
		head := load[T](&q.head)
		tail := load[T](&q.tail)
		next := load[T](&head.next)

		// Are head, tail, and next consistent?
		if head == load[T](&q.head) {
			if head == tail {
				// Is queue empty or tail falling behind?
				if next == nil {
					// Queue is empty
					return value, false
				}
				// Tail is falling behind, try to advance it
				cas(&q.tail, tail, next)
			} else {
				// Read value before CAS
				value = next.value

				// Try to swing head to next node
				if cas(&q.head, head, next) {
					q.len.Add(-1)
					return value, true
				}
			}
		}

		// Give other goroutines a chance
		runtime.Gosched()
	}
}

// Len returns approximate queue length
func (q *Queue[T]) Len() int64 {
	return q.len.Load()
}

// IsEmpty returns true if queue is empty
func (q *Queue[T]) IsEmpty() bool {
	return q.Len() == 0
}

// Helper functions for type-safe atomic operations
func load[T any](p *unsafe.Pointer) *node[T] {
	return (*node[T])(atomic.LoadPointer(p))
}

func cas[T any](p *unsafe.Pointer, old, new *node[T]) bool {
	return atomic.CompareAndSwapPointer(p, unsafe.Pointer(old), unsafe.Pointer(new))
}
```

### Ring Buffer

The ring buffer provides a fixed-size, lock-free SPSC (single-producer, single-consumer) queue. The producer and consumer each own a cursor that advances atomically, with the buffer wrapping around when it reaches the end.

```go
// pkg/lockfree/ringbuffer.go
package lockfree

import (
	"sync/atomic"
)

// RingBuffer is a lock-free single-producer single-consumer ring buffer
// Optimized for low latency with padding to prevent false sharing
type RingBuffer[T any] struct {
	_padding0   [8]uint64 // Prevent false sharing
	buffer      []T
	bufferMask  uint64
	_padding1   [8]uint64
	writePos    atomic.Uint64
	_padding2   [8]uint64
	readPos     atomic.Uint64
	_padding3   [8]uint64
}

// NewRingBuffer creates a ring buffer with size as power of 2
func NewRingBuffer[T any](size uint64) *RingBuffer[T] {
	// Round up to next power of 2
	size = roundUpPowerOf2(size)

	return &RingBuffer[T]{
		buffer:     make([]T, size),
		bufferMask: size - 1,
	}
}

// Write writes a value to the buffer
// Returns false if buffer is full
func (rb *RingBuffer[T]) Write(value T) bool {
	writePos := rb.writePos.Load()
	readPos := rb.readPos.Load()

	// Check if buffer is full
	if writePos-readPos >= uint64(len(rb.buffer)) {
		return false
	}

	// Write value
	rb.buffer[writePos&rb.bufferMask] = value

	// Advance write position
	rb.writePos.Store(writePos + 1)

	return true
}

// Read reads a value from the buffer
// Returns false if buffer is empty
func (rb *RingBuffer[T]) Read() (value T, ok bool) {
	readPos := rb.readPos.Load()
	writePos := rb.writePos.Load()

	// Check if buffer is empty
	if readPos >= writePos {
		return value, false
	}

	// Read value
	value = rb.buffer[readPos&rb.bufferMask]

	// Advance read position
	rb.readPos.Store(readPos + 1)

	return value, true
}

// Len returns the number of items in buffer
func (rb *RingBuffer[T]) Len() uint64 {
	writePos := rb.writePos.Load()
	readPos := rb.readPos.Load()
	return writePos - readPos
}

// Cap returns buffer capacity
func (rb *RingBuffer[T]) Cap() uint64 {
	return uint64(len(rb.buffer))
}

// IsFull returns true if buffer is full
func (rb *RingBuffer[T]) IsFull() bool {
	return rb.Len() >= rb.Cap()
}

// IsEmpty returns true if buffer is empty
func (rb *RingBuffer[T]) IsEmpty() bool {
	return rb.Len() == 0
}

func roundUpPowerOf2(v uint64) uint64 {
	v--
	v |= v >> 1
	v |= v >> 2
	v |= v >> 4
	v |= v >> 8
	v |= v >> 16
	v |= v >> 32
	v++
	return v
}
```
