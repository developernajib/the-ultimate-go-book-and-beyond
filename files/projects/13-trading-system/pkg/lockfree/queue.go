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
