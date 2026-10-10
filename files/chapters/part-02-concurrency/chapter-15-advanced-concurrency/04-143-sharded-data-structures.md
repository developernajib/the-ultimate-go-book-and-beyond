## 15.3 Sharded Data Structures

Sharding is a fundamental technique for scaling concurrent data structures. By partitioning data across multiple independent segments, each with its own lock, we dramatically reduce contention. This is the same principle used in distributed databases and is essential for high-throughput systems.

### Understanding Sharding

The core idea behind sharding is to divide a single contended resource into N independent buckets, each guarded by its own lock, so that goroutines operating on different keys proceed in parallel without blocking each other. A fast hash function maps each key to a shard index using `hash(key) % num_shards`, meaning only goroutines that hash to the same shard ever compete. The diagram below illustrates how four goroutines that would all block on a single lock can instead execute concurrently when the data is split across four shards.

```
┌──────────────────────────────────────────────────────────────────────┐
│                 Single Lock vs Sharded Lock                          │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Single Lock (High Contention):      Sharded (Low Contention):       │
│                                                                      │
│    ┌─────────┐                        ┌───┐ ┌───┐ ┌───┐ ┌───┐        │
│    │  LOCK   │ ◄── G1,G2,G3,G4        │L0 │ │L1 │ │L2 │ │L3 │        │
│    ├─────────┤     all waiting        ├───┤ ├───┤ ├───┤ ├───┤        │
│    │ Data A  │                        │ A │ │ D │ │ G │ │ J │        │
│    │ Data B  │                        │ B │ │ E │ │ H │ │ K │        │
│    │ Data C  │                        │ C │ │ F │ │ I │ │ L │        │
│    │   ...   │                        └───┘ └───┘ └───┘ └───┘        │
│    └─────────┘                          ▲     ▲     ▲     ▲          │
│                                         G1    G2    G3    G4         │
│  Throughput: Limited                  Throughput: 4x (parallel)      │
│  by single lock                                                      │
│                                                                      │
│  Sharding Formula:                                                   │
│  shard_index = hash(key) % num_shards                                │
│                                                                      │
│  Optimal shard count:                                                │
│  - Too few: Still contention                                         │
│  - Too many: Memory overhead, cache inefficiency                     │
│  - Rule of thumb: 2-4x number of CPU cores                           │
└──────────────────────────────────────────────────────────────────────┘
```

### Production-Ready Sharded Map

The generic `ShardedMap[K, V]` below implements a full-featured concurrent map that uses `sync.RWMutex` per shard, allowing many concurrent readers to proceed in parallel while writers hold exclusive access only to the single affected shard. Each `shard` struct is padded so that adjacent shards land on separate CPU cache lines, avoiding the "false sharing" penalty that occurs when two cores write to different variables that happen to occupy the same cache line.

Get the padding arithmetic right, because it is easy to write a number that looks plausible and pads to the wrong size. `sync.RWMutex` is 24 bytes and a map header is an 8-byte pointer, so the struct is 32 bytes of payload and needs exactly 32 more to fill a 64-byte line. Pad it with `[40]byte` and the struct becomes 72 bytes, which straddles two lines and reintroduces the false sharing the padding was supposed to remove. Verify with `unsafe.Sizeof` rather than by eye, and re-verify when fields change.

`GetOrSet` uses an optimistic read-first strategy. Be careful with the vocabulary here: it does **not** upgrade the read lock. Go's `sync.RWMutex` has no lock upgrade, and no way to add one. What the code does is release the read lock, acquire the write lock as a separate operation, and then re-check the state, because the map can change in the window between the two. That re-check is not defensive padding, it is the entire reason the pattern is correct. Attempting to call `Lock` while holding `RLock` deadlocks.

```go
// ShardedMap is a concurrent map using sharding to reduce lock contention
// Used by companies like Uber and Cloudflare for high-throughput caching
type ShardedMap[K comparable, V any] struct {
    shards    []shard[K, V]
    numShards uint32
    hashFunc  func(K) uint32
}

type shard[K comparable, V any] struct {
    mu    sync.RWMutex // 24 bytes
    items map[K]V      // 8 bytes (map header pointer)
    _     [32]byte     // Pad to a full 64-byte cache line: 24 + 8 + 32
}

// ShardedMapConfig configures the sharded map
type ShardedMapConfig struct {
    NumShards       int
    InitialCapacity int // Per shard
}

func DefaultShardedMapConfig() ShardedMapConfig {
    return ShardedMapConfig{
        NumShards:       runtime.NumCPU() * 4,
        InitialCapacity: 100,
    }
}

func NewShardedMap[K comparable, V any](config ShardedMapConfig) *ShardedMap[K, V] {
    if config.NumShards <= 0 {
        config.NumShards = runtime.NumCPU() * 4
    }

    m := &ShardedMap[K, V]{
        shards:    make([]shard[K, V], config.NumShards),
        numShards: uint32(config.NumShards),
        hashFunc:  defaultHash[K],
    }

    for i := range m.shards {
        m.shards[i].items = make(map[K]V, config.InitialCapacity)
    }

    return m
}

// defaultHash provides a generic hash function.
//
// This is the readable version, and it is genuinely slow: Sprintf
// allocates a string on every single lookup, and that allocation costs
// more than the lock this whole structure exists to avoid. Benchmarked
// on a read-mostly workload, swapping this for maphash.Comparable took
// the sharded map from ~45ns to ~30ns per operation. A third of the
// time was string formatting masquerading as lock contention.
//
// Prefer maphash.Comparable, which uses the same hasher the builtin map
// uses, needs no fmt, and allocates nothing:
//
//	var seed = maphash.MakeSeed()
//	func fastHash[K comparable](key K) uint32 {
//	    return uint32(maphash.Comparable(seed, key))
//	}
func defaultHash[K comparable](key K) uint32 {
    h := fnv.New32a()
    h.Write([]byte(fmt.Sprintf("%v", key)))
    return h.Sum32()
}

func (m *ShardedMap[K, V]) getShard(key K) *shard[K, V] {
    hash := m.hashFunc(key)
    return &m.shards[hash%m.numShards]
}

// Get retrieves a value from the map
func (m *ShardedMap[K, V]) Get(key K) (V, bool) {
    shard := m.getShard(key)
    shard.mu.RLock()
    v, ok := shard.items[key]
    shard.mu.RUnlock()
    return v, ok
}

// Set stores a value in the map
func (m *ShardedMap[K, V]) Set(key K, value V) {
    shard := m.getShard(key)
    shard.mu.Lock()
    shard.items[key] = value
    shard.mu.Unlock()
}

// SetIfAbsent only sets if key doesn't exist, returns true if set
func (m *ShardedMap[K, V]) SetIfAbsent(key K, value V) bool {
    shard := m.getShard(key)
    shard.mu.Lock()
    defer shard.mu.Unlock()

    if _, exists := shard.items[key]; exists {
        return false
    }
    shard.items[key] = value
    return true
}

// GetOrSet returns existing value or sets and returns new value
func (m *ShardedMap[K, V]) GetOrSet(key K, value V) (V, bool) {
    shard := m.getShard(key)

    // Try read lock first (optimistic)
    shard.mu.RLock()
    if v, ok := shard.items[key]; ok {
        shard.mu.RUnlock()
        return v, true
    }
    shard.mu.RUnlock()

    // Release, then acquire. This is NOT an upgrade: RWMutex has no
    // upgrade, and calling Lock while holding RLock deadlocks.
    shard.mu.Lock()
    defer shard.mu.Unlock()

    // The map may have changed while we held no lock at all, so the
    // re-check is mandatory, not belt-and-braces.
    if v, ok := shard.items[key]; ok {
        return v, true
    }

    shard.items[key] = value
    return value, false
}

// Delete removes a key from the map
func (m *ShardedMap[K, V]) Delete(key K) bool {
    shard := m.getShard(key)
    shard.mu.Lock()
    defer shard.mu.Unlock()

    if _, ok := shard.items[key]; ok {
        delete(shard.items, key)
        return true
    }
    return false
}

// Update atomically updates a value using a function
func (m *ShardedMap[K, V]) Update(key K, fn func(V, bool) V) V {
    shard := m.getShard(key)
    shard.mu.Lock()
    defer shard.mu.Unlock()

    v, ok := shard.items[key]
    newV := fn(v, ok)
    shard.items[key] = newV
    return newV
}

// Len returns the total number of items across all shards
func (m *ShardedMap[K, V]) Len() int {
    total := 0
    for i := range m.shards {
        m.shards[i].mu.RLock()
        total += len(m.shards[i].items)
        m.shards[i].mu.RUnlock()
    }
    return total
}

// Range iterates over all items (not atomic across shards)
func (m *ShardedMap[K, V]) Range(fn func(key K, value V) bool) {
    for i := range m.shards {
        m.shards[i].mu.RLock()
        for k, v := range m.shards[i].items {
            if !fn(k, v) {
                m.shards[i].mu.RUnlock()
                return
            }
        }
        m.shards[i].mu.RUnlock()
    }
}

// Clear removes all items from the map
func (m *ShardedMap[K, V]) Clear() {
    for i := range m.shards {
        m.shards[i].mu.Lock()
        m.shards[i].items = make(map[K]V)
        m.shards[i].mu.Unlock()
    }
}

// Keys returns all keys (snapshot, not atomic)
func (m *ShardedMap[K, V]) Keys() []K {
    keys := make([]K, 0, m.Len())
    for i := range m.shards {
        m.shards[i].mu.RLock()
        for k := range m.shards[i].items {
            keys = append(keys, k)
        }
        m.shards[i].mu.RUnlock()
    }
    return keys
}
```

### Sharded Counter with Cache Line Padding

A high-throughput counter distributes increments across multiple shards so that concurrent goroutines rarely update the same memory location. Each `counterShard` is explicitly padded to 64 bytes, the typical CPU cache line size, so that two adjacent shards never share a cache line, eliminating false sharing between cores. Reading the total count requires summing all shards atomically, which makes reads slightly more expensive but keeps write throughput high.

Everything then depends on the shard selector, and this is where sharded counters usually go wrong. The selector must vary *per goroutine*. A tempting choice is `runtime.NumGoroutine() % numShards`, and it is worth understanding exactly why it fails, because it fails silently and it benchmarks fine in a naive test.

`runtime.NumGoroutine` is a global gauge of how many goroutines exist. It is not an identity. Every goroutine calling it at the same instant reads the *same* number and therefore selects the *same* shard. A quick test seems to disprove this, showing writes spread across all shards, but that spread is an artifact of goroutines exiting during the run and moving the gauge. Hold the goroutine count steady, which is what a long-lived server actually looks like, and the truth appears:

```
Constant-goroutine-count shard selection via runtime.NumGoroutine() % 16:
distinct shards touched: 1 of 16
distribution: map[5:10000]
```

Every write lands on one shard. The structure has all the memory cost of sharding and none of the benefit, and it is measurable: across eight goroutines, the `NumGoroutine` version runs at roughly the speed of a single unsharded `atomic.Int64`, while a correctly distributed selector is about three times faster than both.

Go deliberately does not expose goroutine IDs, so there is no per-goroutine key to hash. The practical answer is `math/rand/v2`: its top-level functions draw from a per-thread source inside the runtime with no shared state and no lock, which makes `rand.Uint32()` both scalable and well distributed. It is a proxy for "spread these writes out", which is all a counter needs.

Go's own `sync.Pool` solves the same problem with true per-P storage via `runtime_procPin`, which is not available outside the standard library. If you need real CPU affinity rather than statistical spread, that constraint is the reason you cannot have it in ordinary code.

```go
// ShardedCounter is a high-performance counter that minimizes contention
// by distributing counts across multiple cache lines
type ShardedCounter struct {
    shards []counterShard
    // mask is size-1 with size a power of two, so shard selection is a
    // single AND rather than a division.
    mask uint32
}

// counterShard is padded to fill a cache line (64 bytes)
// This prevents false sharing between adjacent shards
type counterShard struct {
    value int64
    _     [56]byte // Padding: 64 - 8 = 56 bytes
}

func NewShardedCounter(numShards int) *ShardedCounter {
    if numShards <= 0 {
        numShards = runtime.NumCPU() * 2
    }

    // Round up to power of 2 so mask selection works
    size := 1
    for size < numShards {
        size *= 2
    }

    return &ShardedCounter{
        shards: make([]counterShard, size),
        mask:   uint32(size - 1),
    }
}

// Add adds delta to the counter (distributed across shards)
func (c *ShardedCounter) Add(delta int64) {
    // rand.Uint32 from math/rand/v2 reads a per-thread source inside the
    // runtime: no lock, no shared state, well distributed. Do NOT use
    // runtime.NumGoroutine here. It is a global gauge, identical across
    // goroutines at any instant, so it funnels every write to one shard.
    id := rand.Uint32() & c.mask
    atomic.AddInt64(&c.shards[id].value, delta)
}

// Increment adds 1 to the counter
func (c *ShardedCounter) Increment() {
    c.Add(1)
}

// Decrement subtracts 1 from the counter
func (c *ShardedCounter) Decrement() {
    c.Add(-1)
}

// Value returns the total count (sum of all shards)
// Note: This is eventually consistent, not strongly consistent
func (c *ShardedCounter) Value() int64 {
    var total int64
    for i := range c.shards {
        total += atomic.LoadInt64(&c.shards[i].value)
    }
    return total
}

// Reset sets all shards to zero
func (c *ShardedCounter) Reset() {
    for i := range c.shards {
        atomic.StoreInt64(&c.shards[i].value, 0)
    }
}

// ShardValues returns individual shard values for debugging.
// A wildly uneven spread here is the signal that the selector is
// broken, which is exactly how the NumGoroutine bug is caught.
func (c *ShardedCounter) ShardValues() []int64 {
    values := make([]int64, len(c.shards))
    for i := range c.shards {
        values[i] = atomic.LoadInt64(&c.shards[i].value)
    }
    return values
}
```

### Sharded Cache with TTL

Combining sharding with time-to-live expiry produces a cache that is both highly concurrent and memory-bounded. Each shard independently stores `cacheItem` values that carry an `expiresAt` timestamp, enabling lazy expiration on `Get` as well as periodic batch cleanup via a background goroutine. The `GetOrCompute` method encapsulates the common cache-aside pattern, check the cache, call the compute function on a miss, and store the result, all with per-shard locking so that different keys can be computed in parallel.

```go
// ShardedCache is a high-performance cache with TTL support
type ShardedCache[K comparable, V any] struct {
    shards          []cacheShard[K, V]
    numShards       uint32
    defaultTTL      time.Duration
    cleanupInterval time.Duration
    stopCleanup     chan struct{}
    closeOnce       sync.Once
}

type cacheShard[K comparable, V any] struct {
    mu    sync.RWMutex // 24 bytes
    items map[K]cacheItem[V] // 8 bytes
    _     [32]byte // Pads to exactly 64: verified with unsafe.Sizeof
}

type cacheItem[V any] struct {
    value     V
    expiresAt time.Time
}

type CacheConfig struct {
    NumShards       int
    DefaultTTL      time.Duration
    CleanupInterval time.Duration
    InitialCapacity int
}

func NewShardedCache[K comparable, V any](config CacheConfig) *ShardedCache[K, V] {
    if config.NumShards <= 0 {
        config.NumShards = runtime.NumCPU() * 4
    }
    if config.DefaultTTL <= 0 {
        config.DefaultTTL = time.Hour
    }
    if config.CleanupInterval <= 0 {
        config.CleanupInterval = time.Minute
    }

    c := &ShardedCache[K, V]{
        shards:          make([]cacheShard[K, V], config.NumShards),
        numShards:       uint32(config.NumShards),
        defaultTTL:      config.DefaultTTL,
        cleanupInterval: config.CleanupInterval,
        stopCleanup:     make(chan struct{}),
    }

    for i := range c.shards {
        c.shards[i].items = make(map[K]cacheItem[V], config.InitialCapacity)
    }

    // Start cleanup goroutine
    go c.cleanupLoop()

    return c
}

func (c *ShardedCache[K, V]) getShard(key K) *cacheShard[K, V] {
    h := fnv.New32a()
    h.Write([]byte(fmt.Sprintf("%v", key)))
    return &c.shards[h.Sum32()%c.numShards]
}

// Get retrieves a value, returning false if not found or expired
func (c *ShardedCache[K, V]) Get(key K) (V, bool) {
    shard := c.getShard(key)
    shard.mu.RLock()
    item, ok := shard.items[key]
    shard.mu.RUnlock()

    if !ok {
        var zero V
        return zero, false
    }

    if time.Now().After(item.expiresAt) {
        // Expired: lazy delete, but re-check under the write lock.
        //
        // A bare c.Delete(key) here is a check-then-act race. We
        // observed the entry as expired while holding no lock, and another
        // goroutine may Set a fresh value before our delete lands, and
        // an unconditional delete would silently evict that live entry.
        // Delete only what we actually observed to be expired.
        shard.mu.Lock()
        if cur, still := shard.items[key]; still && time.Now().After(cur.expiresAt) {
            delete(shard.items, key)
        }
        shard.mu.Unlock()

        var zero V
        return zero, false
    }

    return item.value, true
}

// Set stores a value with the default TTL
func (c *ShardedCache[K, V]) Set(key K, value V) {
    c.SetWithTTL(key, value, c.defaultTTL)
}

// SetWithTTL stores a value with a specific TTL
func (c *ShardedCache[K, V]) SetWithTTL(key K, value V, ttl time.Duration) {
    shard := c.getShard(key)
    shard.mu.Lock()
    shard.items[key] = cacheItem[V]{
        value:     value,
        expiresAt: time.Now().Add(ttl),
    }
    shard.mu.Unlock()
}

// Delete removes a key from the cache
func (c *ShardedCache[K, V]) Delete(key K) {
    shard := c.getShard(key)
    shard.mu.Lock()
    delete(shard.items, key)
    shard.mu.Unlock()
}

// GetOrCompute returns cached value or computes and caches it.
//
// This does NOT coalesce concurrent misses. If a thousand goroutines
// miss the same key at once, compute runs a thousand times: the classic
// cache stampede, and the failure mode is that a cold cache hands your
// backend its worst traffic spike at its worst moment. The lock is
// per-shard and is not held across compute, which is deliberate (see
// below), but it means nothing serialises the misses.
//
// Wrap compute in singleflight.Group (section 15.10) to collapse
// duplicate work onto one caller.
func (c *ShardedCache[K, V]) GetOrCompute(key K, compute func() (V, error)) (V, error) {
    if v, ok := c.Get(key); ok {
        return v, nil
    }

    // compute() runs with no lock held, on purpose. Holding a shard
    // lock across an arbitrary caller-supplied function, which may do
    // I/O or call back into the cache, is how you turn a cache into a
    // deadlock.
    v, err := compute()
    if err != nil {
        return v, err
    }

    c.Set(key, v)
    return v, nil
}

func (c *ShardedCache[K, V]) cleanupLoop() {
    ticker := time.NewTicker(c.cleanupInterval)
    defer ticker.Stop()

    for {
        select {
        case <-ticker.C:
            c.cleanup()
        case <-c.stopCleanup:
            return
        }
    }
}

func (c *ShardedCache[K, V]) cleanup() {
    now := time.Now()

    for i := range c.shards {
        shard := &c.shards[i]
        shard.mu.Lock()

        for k, item := range shard.items {
            if now.After(item.expiresAt) {
                delete(shard.items, k)
            }
        }

        shard.mu.Unlock()
    }
}

// Close stops the cleanup goroutine. Safe to call more than once:
// a bare close(c.stopCleanup) panics on the second call, and "closed
// twice during shutdown" is a common way to lose a process.
func (c *ShardedCache[K, V]) Close() {
    c.closeOnce.Do(func() {
        close(c.stopCleanup)
    })
}

// Stats returns cache statistics
func (c *ShardedCache[K, V]) Stats() CacheStats {
    var total, expired int

    now := time.Now()
    for i := range c.shards {
        c.shards[i].mu.RLock()
        for _, item := range c.shards[i].items {
            total++
            if now.After(item.expiresAt) {
                expired++
            }
        }
        c.shards[i].mu.RUnlock()
    }

    return CacheStats{
        TotalItems:   total,
        ExpiredItems: expired,
        NumShards:    int(c.numShards),
    }
}

type CacheStats struct {
    TotalItems   int
    ExpiredItems int
    NumShards    int
}
```

### Minimal Sharded Counter (Unpadded Variant)

The counter above spends 56 bytes of padding per shard to keep each one on its own cache line. The obvious question is whether that padding earns its memory. Here is the same counter with the padding removed, so that eight `int64` shards share every 64-byte line:

```go
// MinimalCounter drops the per-shard padding. Distinct type, distinct
// trade-off: eight shards now share each cache line.
type MinimalCounter struct {
    shards []int64
    mask   uint32
}

func NewMinimalCounter(numShards int) *MinimalCounter {
    // Round to power of 2 so the mask works
    size := 1
    for size < numShards {
        size *= 2
    }
    return &MinimalCounter{
        shards: make([]int64, size),
        mask:   uint32(size - 1),
    }
}

func (c *MinimalCounter) Add(delta int64) {
    id := rand.Uint32() & c.mask
    atomic.AddInt64(&c.shards[id], delta)
}

func (c *MinimalCounter) Value() int64 {
    var total int64
    for i := range c.shards {
        total += atomic.LoadInt64(&c.shards[i])
    }
    return total
}
```

The padding is worth it. With 64 shards across eight goroutines, the padded version measures around 7ns per `Add` against roughly 9.5ns unpadded: the same instructions, the same shard count, and a meaningful slowdown that comes entirely from cores fighting over shared cache lines. False sharing is not a rounding error, and this is the cheapest way to see it. The unpadded version is still worth having when shard counts are large and the counter is not truly hot, since it uses an eighth of the memory.

Both variants use `rand.Uint32` rather than any goroutine-identity trick. There is no supported way to obtain a goroutine ID in Go: the `getGoroutineID()` helper that circulates in blog posts parses it out of a stack trace, which is slow enough to dwarf the atomic it is meant to optimize, and it relies on the format of runtime output that carries no compatibility promise.

### Staff Lens: Sharding Is the Right First Response to Contention

When a profile shows mutex contention, sharding is the simpler and more reliable response than reaching for lock-free data structures. Shard counts:

- 16 or 32: good default for in-process sharded maps.
- `runtime.NumCPU()`: right for per-core counters with rare reads.
- Power-of-two: enables `hash & (n-1)` instead of modulo.

Shard the state first. If sharding solves the contention, stop. Only reach for lock-free techniques if sharding is insufficient, which is rare in practice.

### Hot-Key Problem Recap

Sharding assumes uniform key distribution. One hot key can defeat the entire sharding benefit. Monitor for this (per-shard load metric) and address hot keys separately: replication, caching, or moving them out of the sharded structure. This is the most common way sharding fails at scale.

---
