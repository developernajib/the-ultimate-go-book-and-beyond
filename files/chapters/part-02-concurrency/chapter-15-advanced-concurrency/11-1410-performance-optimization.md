## 15.10 Performance Optimization

### False Sharing Prevention

False sharing occurs when two goroutines on different CPU cores write to distinct variables that happen to share the same 64-byte cache line. Every write forces the cache line to be invalidated on the other core, causing cache bouncing that can reduce throughput dramatically. Padding each counter to a full cache line boundary with `[56]byte` padding eliminates the contention entirely.

```go
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
```

### Batch Processing

Processing items in batches amortizes the goroutine creation overhead across multiple items, which is especially beneficial when individual items are small. The batch size controls the trade-off: too small and scheduling overhead dominates, too large and parallelism suffers because there are not enough batches to keep every core busy.

Batching is not a substitute for a concurrency bound, and conflating the two is how this function goes wrong. Batch size divides the *work*, it does not cap the *goroutines*. A million items at a batch size of ten still fans out a hundred thousand goroutines at once, and a small batch size makes the fan-out worse rather than better. Section 15.6 states the rule plainly, that every fan-out needs a bound, and this function is not exempt from it. The semaphore below is what makes the batch size a tuning knob rather than a memory hazard.

```go
func BatchProcess[T any](items []T, batchSize, workers int, fn func([]T)) {
    if batchSize < 1 {
        batchSize = 1
    }
    if workers < 1 {
        workers = runtime.GOMAXPROCS(0)
    }

    var wg sync.WaitGroup
    // Bounds goroutines, not just concurrent work: the acquire happens
    // on this goroutine, before the go statement.
    sem := make(chan struct{}, workers)

    for i := 0; i < len(items); i += batchSize {
        end := min(i+batchSize, len(items))
        batch := items[i:end]

        wg.Add(1)
        sem <- struct{}{}

        go func() {
            defer func() {
                <-sem
                wg.Done()
            }()
            fn(batch)
        }()
    }

    wg.Wait()
}
```

Each batch is a disjoint sub-slice, so the goroutines share a backing array without sharing any element, and `wg.Wait` gives the caller the happens-before edge to read the results.

### Ring Buffer for Lock-Free Communication

A ring buffer backed by atomic head and tail counters avoids mutexes entirely: the producer advances `head`, the consumer advances `tail`, and both use a bitmask (`head & mask`) to index into the fixed-size backing array, which requires the capacity to be a power of two. Because publication is an atomic store rather than a lock acquisition, the producer and consumer work at opposite ends without ever blocking each other.

> **This structure is single-producer, single-consumer only, and it does not enforce that.** The restriction is not a performance note, it is a correctness precondition. `Push` reads `head`, writes the slot, and only then advances `head`. Two producers running that sequence read the same `head`, write the same slot, and each advance it by one: one item is silently overwritten, and the slot the counter skipped past is never written at all. Four producers pushing 800 items leave lost writes and a data race the detector reports immediately. The name `RingBuffer` invites exactly this misuse, so if more than one goroutine may push, use a channel, which is an MPMC ring buffer that the runtime already wrote for you and got right.

Note also that the power-of-two requirement is a real precondition, not a suggestion. With `size = 10` the mask becomes 9, and `head & 9` maps index 2 to slot 2 but index 8 to slot 8 and index 10 back to slot 0 while the fullness check still believes there are ten slots. Distinct positions quietly alias onto each other. A comment saying "size must be power of 2" is not a check, so the constructor rounds up and makes the invariant true rather than hoping.

```go
// RingBuffer is a lock-free SPSC queue.
//
// Exactly one goroutine may call Push and exactly one may call Pop.
// Concurrent Push callers corrupt the buffer. This is not enforceable
// by the type system, so it is on you.
type RingBuffer[T any] struct {
    buffer []T
    head   atomic.Uint64 // Written only by the producer
    tail   atomic.Uint64 // Written only by the consumer
    mask   uint64
}

func NewRingBuffer[T any](size int) *RingBuffer[T] {
    // Round up to a power of two rather than trusting the caller: a
    // non-power-of-two mask aliases distinct slots onto each other.
    n := 1
    for n < size {
        n *= 2
    }
    return &RingBuffer[T]{
        buffer: make([]T, n),
        mask:   uint64(n - 1),
    }
}

// Push is safe for exactly one producer goroutine.
func (r *RingBuffer[T]) Push(item T) bool {
    head := r.head.Load()
    tail := r.tail.Load() // Acquire: pairs with the consumer's tail.Add

    if head-tail >= uint64(len(r.buffer)) {
        return false // Full
    }

    r.buffer[head&r.mask] = item

    // This store publishes the slot write above. It must come last.
    r.head.Add(1)
    return true
}

// Pop is safe for exactly one consumer goroutine.
func (r *RingBuffer[T]) Pop() (T, bool) {
    tail := r.tail.Load()
    head := r.head.Load() // Acquire: pairs with the producer's head.Add

    if tail >= head {
        var zero T
        return zero, false // Empty
    }

    item := r.buffer[tail&r.mask]

    // Publishes the free slot to the producer. Must come last.
    r.tail.Add(1)
    return item, true
}
```

The atomic counters are what make the plain slot read and write race-free. The consumer only touches `buffer[tail]` after observing `head > tail`, and that observation is ordered after the producer's `head.Add`, which is ordered after the slot write. The happens-before chain runs through the counters, not the data.

### Staff Lens: Cache-Line Padding and False Sharing

The padding patterns in this section matter only on high-throughput concurrent code where cache-line bouncing is a measured cost. For general code, they add complexity without benefit. Reach for padding only when:

1. Profile shows false-sharing as a cost.
2. The hot path is tight enough that the per-access cost is measurable.
3. The code is critical enough to justify the added complexity.

If all three apply, pad. Otherwise, leave the default layout. Most Go code does not need this.

### Principal Lens: The Optimization Ladder

Performance optimization has a ladder:

1. **Reduce work.** Do less. The fastest code is the code that does not run.
2. **Avoid allocations.** GC pressure is often the real bottleneck.
3. **Reduce contention.** Shard, use read-mostly primitives, eliminate shared state.
4. **Tune primitives.** Mutex vs atomic, pool sizes, buffer capacities.
5. **Cache-line-aware layout.** False sharing, cache-friendly access patterns.
6. **Assembly.** The last resort.

Most teams jump from 1 to 5 without trying 2, 3, and 4. The lower rungs usually have bigger wins with less complexity. Principal engineers who enforce the ladder save teams from over-optimizing the wrong layer.

---
