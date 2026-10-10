## 12.10 Sharding Pattern

Distribute work by key for locality and reduced contention.

### Sharded Worker

Sharding routes items to a fixed shard determined by hashing the item's key, so all items with the same key are always processed by the same worker goroutine. That single invariant is what buys everything else. Because a key is only ever touched by one goroutine, per-key state needs no mutex at all: there is nothing to contend for. It also improves cache locality, since the state for a given key stays warm in the core running its shard rather than bouncing between cores.

```go
// ShardedWorker distributes work by key
type ShardedWorker[T any] struct {
    shards    []chan T
    numShards int
    processor func(T)
    wg        sync.WaitGroup
    ctx       context.Context
    cancel    context.CancelFunc
}

func NewShardedWorker[T any](numShards, bufferSize int, processor func(T)) *ShardedWorker[T] {
    ctx, cancel := context.WithCancel(context.Background())

    sw := &ShardedWorker[T]{
        shards:    make([]chan T, numShards),
        numShards: numShards,
        processor: processor,
        ctx:       ctx,
        cancel:    cancel,
    }

    for i := 0; i < numShards; i++ {
        sw.shards[i] = make(chan T, bufferSize)
        sw.wg.Add(1)
        go sw.worker(sw.shards[i])
    }

    return sw
}

func (sw *ShardedWorker[T]) worker(ch <-chan T) {
    defer sw.wg.Done()

    for {
        select {
        case <-sw.ctx.Done():
            return
        case item, ok := <-ch:
            if !ok {
                return
            }
            sw.processor(item)
        }
    }
}

// Submit sends work to the appropriate shard
func (sw *ShardedWorker[T]) Submit(key string, item T) {
    select {
    case <-sw.ctx.Done():
        return
    case sw.shards[sw.shardFor(key)] <- item:
    }
}

// shardFor reduces the hash modulo the shard count in unsigned space.
//
// Doing the modulo before the int conversion is not a style choice. On a
// 32-bit platform int is 32 bits, so int(h.Sum32()) is negative for any
// hash above MaxInt32, and a negative index panics. Reducing while still
// unsigned keeps the result in [0, numShards).
func (sw *ShardedWorker[T]) shardFor(key string) int {
    h := fnv.New32a()
    h.Write([]byte(key))
    return int(h.Sum32() % uint32(sw.numShards))
}

// Close stops all workers and waits for them to exit.
//
// Note what is absent: the shard channels are never closed. Closing them
// would race with Submit, and a send on a closed channel panics. The
// ctx.Done case in Submit already prevents callers from blocking after
// shutdown, so the close buys nothing and costs a panic under load.
//
// The tradeoff is that this is an abrupt stop: items still sitting in
// shard buffers are discarded. Draining them instead means not
// cancelling until the buffers empty, and guarding Submit against the
// close with a mutex, which is the shape the worker pool in section 12.4
// uses.
func (sw *ShardedWorker[T]) Close() {
    sw.cancel()
    sw.wg.Wait()
}
```

### Sharded Map for High Concurrency

A single `sync.RWMutex` protecting an entire map becomes a bottleneck under high write concurrency because every writer serializes against all readers globally. Partitioning the map into `N` independent shards, each with its own `RWMutex`, cuts the chance that two random keys collide on the same lock by roughly `N`.

Roughly, and not linearly. Two things cap the benefit. Keys are not uniformly distributed in practice, so one hot key pins one shard no matter how many shards exist (see the hot-key problem below). And past a point the shards themselves start competing for cache lines and memory bandwidth rather than for locks. Sharding moves the bottleneck, it does not delete it, and the honest expectation is a solid multiple rather than a factor of `N`.

The caller-supplied `hasher` keeps the implementation key-type agnostic, allowing string FNV hashing, integer modulo, or UUID-based routing depending on the workload. It also means the shard index is only as well-distributed as the hasher: a poor hasher silently collapses the sharding back into a single lock.

```go
// ShardedMap reduces lock contention with per-shard locks
type ShardedMap[K comparable, V any] struct {
    shards    []*mapShard[K, V]
    numShards int
    hasher    func(K) int
}

type mapShard[K comparable, V any] struct {
    mu    sync.RWMutex
    items map[K]V
}

func NewShardedMap[K comparable, V any](numShards int, hasher func(K) int) *ShardedMap[K, V] {
    sm := &ShardedMap[K, V]{
        shards:    make([]*mapShard[K, V], numShards),
        numShards: numShards,
        hasher:    hasher,
    }

    for i := 0; i < numShards; i++ {
        sm.shards[i] = &mapShard[K, V]{
            items: make(map[K]V),
        }
    }

    return sm
}

// getShard maps a key onto a shard.
//
// The hasher is caller-supplied and returns int, so it may well return
// a negative value: an "integer modulo" hasher on a negative key, or an
// FNV hash converted from uint32 on a 32-bit build, both do. In Go the
// sign of a % b follows a, so hash%numShards would then be negative and
// the index would panic. Convert to unsigned before reducing.
func (sm *ShardedMap[K, V]) getShard(key K) *mapShard[K, V] {
    hash := uint(sm.hasher(key))
    return sm.shards[hash%uint(sm.numShards)]
}

func (sm *ShardedMap[K, V]) Set(key K, value V) {
    shard := sm.getShard(key)
    shard.mu.Lock()
    shard.items[key] = value
    shard.mu.Unlock()
}

func (sm *ShardedMap[K, V]) Get(key K) (V, bool) {
    shard := sm.getShard(key)
    shard.mu.RLock()
    value, exists := shard.items[key]
    shard.mu.RUnlock()
    return value, exists
}

func (sm *ShardedMap[K, V]) Delete(key K) {
    shard := sm.getShard(key)
    shard.mu.Lock()
    delete(shard.items, key)
    shard.mu.Unlock()
}

func (sm *ShardedMap[K, V]) Len() int {
    total := 0
    for _, shard := range sm.shards {
        shard.mu.RLock()
        total += len(shard.items)
        shard.mu.RUnlock()
    }
    return total
}
```

### Sharding Count: Power of 2 and Cache Lines

Two tuning considerations for sharded maps:

1. **Power-of-2 shard count.** Enables `key & (shards-1)` as a cheap modulo. Non-power-of-2 requires modulo, which is slower. For 16 or 32 shards, the hash-and-mask pattern is idiomatic.
2. **Pad shard structs to cache line size (64 bytes on most CPUs).** Without padding, adjacent shards can share a cache line, causing false-sharing contention between goroutines that logically have no contention. Pad each shard's mutex-and-state to at least 64 bytes.

These are micro-optimizations that matter only at high contention. If your workload hits the sharded map millions of times per second, tune. Below that, the defaults are fine and the padding is just wasted memory.

### Hot-Key Problem

Sharding assumes uniform key distribution. When one key dominates traffic (e.g., a celebrity user in a social media system), that key's shard becomes the contention point, undoing the sharding benefit. Solutions:

- Detect hot keys and handle them separately (dedicated cache, read-through replica, CDN for web content).
- Replicate hot-key reads across shards.
- Move the hot key out of the sharded store to a specialized per-key cache.

The hot-key problem is fundamental to every sharded system. Recognize it, monitor for it, have a mitigation plan.

### sync.Map vs Sharded Map

Go's `sync.Map` is optimized for read-heavy workloads where keys rarely change. For balanced read-write workloads, a sharded `map[K]V` protected by per-shard `sync.RWMutex` often outperforms `sync.Map`. Benchmark both for your access pattern before choosing. `sync.Map` is not universally faster. Its specific access-pattern optimizations can be slower for general-purpose use.

### Staff Lens: Sharding Is a Last-Resort In-Process Optimization

Sharding adds complexity. Before reaching for it, confirm the contention is real with profile evidence. Options to try first: reduce the critical section, use RWMutex, use `sync/atomic` for simple counters, use `sync.Map` if access pattern fits. Sharding is correct when these are exhausted and the benchmark shows contention on the shared mutex. At that point, sharding is the right answer. Before that point, it is premature optimization.

### Principal Lens: In-Process Sharding vs Distributed Sharding

In-process sharding spreads load across cores on one machine. Distributed sharding spreads load across machines. They are different problems with different tools. In-process: `sync.RWMutex` per shard. Distributed: consistent hashing, rebalancing on node join/leave, replication for availability, routing layer. A principal engineer recognizes when the problem has outgrown in-process sharding and requires the distributed version. Signs: memory exceeds one machine, operations exceed one machine's CPU, data must survive individual machine failure. Distributed sharding is an order-of-magnitude more complex than in-process. Adopt only when the in-process version genuinely cannot scale further.

---
