export default `## 12.10 Sharding Pattern

Distribute work by key for locality and reduced contention.

### Sharded Worker

Sharding routes items to a fixed shard determined by hashing the item's key, so all items with the same key are always processed by the same worker goroutine. This eliminates mutex contention for per-key state, each shard owns its portion of the key space exclusively, and improves cache locality since related items flow through the same goroutine's stack.

\`\`\`go
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
    shard := sw.hash(key) % sw.numShards

    select {
    case <-sw.ctx.Done():
        return
    case sw.shards[shard] <- item:
    }
}

func (sw *ShardedWorker[T]) hash(key string) int {
    h := fnv.New32a()
    h.Write([]byte(key))
    return int(h.Sum32())
}

// Close shuts down all workers
func (sw *ShardedWorker[T]) Close() {
    sw.cancel()
    for _, ch := range sw.shards {
        close(ch)
    }
    sw.wg.Wait()
}
\`\`\`

### Sharded Map for High Concurrency

A single \`sync.RWMutex\` protecting an entire map becomes a bottleneck under high write concurrency because every writer serializes against all readers globally. Partitioning the map into \`N\` independent shards, each with its own \`RWMutex\`, reduces the probability of two goroutines contending the same lock by a factor of \`N\`, approaching linear scalability as shard count increases. The caller-supplied \`hasher\` function keeps the implementation key-type agnostic, allowing string FNV hashing, integer modulo, or UUID-based routing depending on the workload.

\`\`\`go
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

func (sm *ShardedMap[K, V]) getShard(key K) *mapShard[K, V] {
    hash := sm.hasher(key)
    return sm.shards[hash%sm.numShards]
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
\`\`\`

### Sharding Count: Power of 2 and Cache Lines

Two tuning considerations for sharded maps:

1. **Power-of-2 shard count.** Enables \`key & (shards-1)\` as a cheap modulo. Non-power-of-2 requires modulo, which is slower. For 16 or 32 shards, the hash-and-mask pattern is idiomatic.
2. **Pad shard structs to cache line size (64 bytes on most CPUs).** Without padding, adjacent shards can share a cache line, causing false-sharing contention between goroutines that logically have no contention. Pad each shard's mutex-and-state to at least 64 bytes.

These are micro-optimizations that matter only at high contention. If your workload hits the sharded map under a million times per second, tune. Below that, defaults are fine.

### Hot-Key Problem

Sharding assumes uniform key distribution. When one key dominates traffic (e.g., a celebrity user in a social media system), that key's shard becomes the contention point, undoing the sharding benefit. Solutions:

- Detect hot keys and handle them separately (dedicated cache, read-through replica, CDN for web content).
- Replicate hot-key reads across shards.
- Move the hot key out of the sharded store to a specialised per-key cache.

The hot-key problem is fundamental to every sharded system. Recognise it, monitor for it, have a mitigation plan.

### sync.Map vs Sharded Map

Go's \`sync.Map\` is optimised for read-heavy workloads where keys rarely change. For balanced read-write workloads, a sharded \`map[K]V\` protected by per-shard \`sync.RWMutex\` often outperforms \`sync.Map\`. Benchmark both for your access pattern before choosing. \`sync.Map\` is not universally faster; its specific access-pattern optimisations can be slower for general-purpose use.

### Staff Lens: Sharding Is a Last-Resort In-Process Optimisation

Sharding adds complexity. Before reaching for it, confirm the contention is real with profile evidence. Options to try first: reduce the critical section, use RWMutex, use \`sync/atomic\` for simple counters, use \`sync.Map\` if access pattern fits. Sharding is correct when these are exhausted and the benchmark shows contention on the shared mutex. At that point, sharding is the right answer. Before that point, it is premature optimisation.

### Principal Lens: In-Process Sharding vs Distributed Sharding

In-process sharding spreads load across cores on one machine. Distributed sharding spreads load across machines. They are different problems with different tools. In-process: \`sync.RWMutex\` per shard. Distributed: consistent hashing, rebalancing on node join/leave, replication for availability, routing layer. A principal engineer recognises when the problem has outgrown in-process sharding and requires the distributed version. Signs: memory exceeds one machine, operations exceed one machine's CPU, data must survive individual machine failure. Distributed sharding is an order-of-magnitude more complex than in-process. Adopt only when the in-process version genuinely cannot scale further.

---
`;
