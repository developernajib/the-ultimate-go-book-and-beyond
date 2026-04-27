export default `## 15.10 Performance Optimization

### False Sharing Prevention

False sharing occurs when two goroutines on different CPU cores write to distinct variables that happen to share the same 64-byte cache line. Every write forces the cache line to be invalidated on the other core, causing cache bouncing that can reduce throughput dramatically. Padding each counter to a full cache line boundary with \`[56]byte\` padding eliminates the contention entirely.

\`\`\`go
// Bad: counters share cache line
type BadCounters struct {
    a int64
    b int64
}

// Good: padding prevents false sharing
type GoodCounters struct {
    a int64
    _ [56]byte  // Padding to 64-byte cache line
    b int64
    _ [56]byte
}
\`\`\`

### Batch Processing

Processing items in batches amortizes the goroutine creation overhead across multiple items, which is especially beneficial when individual items are small. The batch size controls the trade-off: too small and scheduling overhead dominates, too large and parallelism is reduced because fewer goroutines are active simultaneously.

\`\`\`go
func BatchProcess[T any](items []T, batchSize int, fn func([]T)) {
    var wg sync.WaitGroup

    for i := 0; i < len(items); i += batchSize {
        end := i + batchSize
        if end > len(items) {
            end = len(items)
        }

        wg.Add(1)
        batch := items[i:end]
        go func() {
            defer wg.Done()
            fn(batch)
        }()
    }

    wg.Wait()
}
\`\`\`

### Ring Buffer for Lock-Free Communication

A ring buffer backed by atomic head and tail counters avoids mutexes entirely: producers increment \`head\` and consumers increment \`tail\`, and both use a bitmask (\`head & mask\`) to index into the fixed-size backing array, which requires the capacity to be a power of two. Because each increment is an atomic add rather than a lock acquisition, multiple goroutines can access opposite ends of the buffer without blocking each other, making this structure well-suited for single-producer/single-consumer pipelines where mutex overhead would otherwise dominate.

\`\`\`go
type RingBuffer[T any] struct {
    buffer []T
    head   atomic.Uint64
    tail   atomic.Uint64
    mask   uint64
}

func NewRingBuffer[T any](size int) *RingBuffer[T] {
    // Size must be power of 2
    return &RingBuffer[T]{
        buffer: make([]T, size),
        mask:   uint64(size - 1),
    }
}

func (r *RingBuffer[T]) Push(item T) bool {
    head := r.head.Load()
    tail := r.tail.Load()

    if head-tail >= uint64(len(r.buffer)) {
        return false // Full
    }

    r.buffer[head&r.mask] = item
    r.head.Add(1)
    return true
}

func (r *RingBuffer[T]) Pop() (T, bool) {
    tail := r.tail.Load()
    head := r.head.Load()

    if tail >= head {
        var zero T
        return zero, false // Empty
    }

    item := r.buffer[tail&r.mask]
    r.tail.Add(1)
    return item, true
}
\`\`\`

### Staff Lens: Cache-Line Padding and False Sharing

The padding patterns in this section matter only on high-throughput concurrent code where cache-line bouncing is a measured cost. For general code, they add complexity without benefit. Reach for padding only when:

1. Profile shows false-sharing as a cost.
2. The hot path is tight enough that the per-access cost is measurable.
3. The code is critical enough to justify the added complexity.

If all three apply, pad. Otherwise, leave the default layout. Most Go code does not need this.

### Principal Lens: The Optimization Ladder

Performance optimisation has a ladder:

1. **Reduce work.** Do less. The fastest code is the code that does not run.
2. **Avoid allocations.** GC pressure is often the real bottleneck.
3. **Reduce contention.** Shard, use read-mostly primitives, eliminate shared state.
4. **Tune primitives.** Mutex vs atomic, pool sizes, buffer capacities.
5. **Cache-line-aware layout.** False sharing, cache-friendly access patterns.
6. **Assembly.** The last resort.

Most teams jump from 1 to 5 without trying 2, 3, and 4. The lower rungs usually have bigger wins with less complexity. Principal engineers who enforce the ladder save teams from over-optimizing the wrong layer.

---
`;
