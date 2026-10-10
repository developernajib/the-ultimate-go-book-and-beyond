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
