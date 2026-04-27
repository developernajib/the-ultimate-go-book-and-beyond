export default `## 15.3 Sharded Data Structures

Sharding is a fundamental technique for scaling concurrent data structures. By partitioning data across multiple independent segments, each with its own lock, we dramatically reduce contention. This is the same principle used in distributed databases and is essential for high-throughput systems.

### Understanding Sharding

The core idea behind sharding is to divide a single contended resource into N independent buckets, each guarded by its own lock, so that goroutines operating on different keys proceed in parallel without blocking each other. A fast hash function maps each key to a shard index using \`hash(key) % num_shards\`, meaning only goroutines that hash to the same shard ever compete. The diagram below illustrates how four goroutines that would all block on a single lock can instead execute concurrently when the data is split across four shards.

\`\`\`
┌─────────────────────────────────────────────────────────────────────┐
│                 Single Lock vs Sharded Lock                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Single Lock (High Contention):      Sharded (Low Contention):      │
│                                                                      │
│    ┌─────────┐                        ┌───┐ ┌───┐ ┌───┐ ┌───┐       │
│    │  LOCK   │ ◄── G1,G2,G3,G4        │L0 │ │L1 │ │L2 │ │L3 │       │
│    ├─────────┤     all waiting        ├───┤ ├───┤ ├───┤ ├───┤       │
│    │ Data A  │                        │ A │ │ D │ │ G │ │ J │       │
│    │ Data B  │                        │ B │ │ E │ │ H │ │ K │       │
│    │ Data C  │                        │ C │ │ F │ │ I │ │ L │       │
│    │   ...   │                        └───┘ └───┘ └───┘ └───┘       │
│    └─────────┘                          ▲     ▲     ▲     ▲         │
│                                         G1    G2    G3    G4        │
│  Throughput: Limited                  Throughput: 4x (parallel)     │
│  by single lock                                                      │
│                                                                      │
│  Sharding Formula:                                                  │
│  shard_index = hash(key) % num_shards                               │
│                                                                      │
│  Optimal shard count:                                               │
│  - Too few: Still contention                                        │
│  - Too many: Memory overhead, cache inefficiency                    │
│  - Rule of thumb: 2-4x number of CPU cores                          │
└─────────────────────────────────────────────────────────────────────┘
\`\`\`

### Production-Ready Sharded Map

The generic \`ShardedMap[K, V]\` below implements a full-featured concurrent map that uses \`sync.RWMutex\` per shard, allowing many concurrent readers to proceed in parallel while writers hold exclusive access only to the single affected shard. Each \`shard\` struct includes a 40-byte padding field to push adjacent shards onto separate CPU cache lines, preventing the "false sharing" performance penalty that occurs when two CPU cores write to different variables that happen to occupy the same cache line. Operations like \`GetOrSet\` apply an optimistic read-first strategy, upgrading to a write lock only when necessary and always double-checking the state after the upgrade.

\`\`\`go
// ShardedMap is a concurrent map using sharding to reduce lock contention
// Used by companies like Uber and Cloudflare for high-throughput caching
type ShardedMap[K comparable, V any] struct {
    shards    []shard[K, V]
    numShards uint32
    hashFunc  func(K) uint32
}

type shard[K comparable, V any] struct {
    mu    sync.RWMutex
    items map[K]V
    _     [40]byte // Padding to prevent false sharing
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

// defaultHash provides a generic hash function
func defaultHash[K comparable](key K) uint32 {
    h := fnv.New32a()
    // Convert to bytes using fmt - not the fastest but works for any type
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

    // Upgrade to write lock
    shard.mu.Lock()
    defer shard.mu.Unlock()

    // Double-check after acquiring write lock
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
\`\`\`

### Sharded Counter with Cache Line Padding

A high-throughput counter distributes increments across multiple shards so that concurrent goroutines rarely update the same memory location. Each \`counterShard\` is explicitly padded to 64 bytes, the typical CPU cache line size, so that two adjacent shards never share a cache line, eliminating false sharing between cores. Reading the total count requires summing all shards atomically, which makes reads slightly more expensive but keeps write throughput near the hardware maximum.

\`\`\`go
// ShardedCounter is a high-performance counter that minimizes contention
// by distributing counts across multiple cache lines
type ShardedCounter struct {
    shards    []counterShard
    numShards int
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

    // Round up to power of 2 for efficient modulo
    size := 1
    for size < numShards {
        size *= 2
    }

    return &ShardedCounter{
        shards:    make([]counterShard, size),
        numShards: size,
    }
}

// Add adds delta to the counter (distributed across shards)
func (c *ShardedCounter) Add(delta int64) {
    // Use goroutine ID for shard selection (approximation)
    // In practice, you might use thread-local storage or processor ID
    id := runtime.NumGoroutine() % c.numShards
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

// ShardValues returns individual shard values for debugging
func (c *ShardedCounter) ShardValues() []int64 {
    values := make([]int64, c.numShards)
    for i := range c.shards {
        values[i] = atomic.LoadInt64(&c.shards[i].value)
    }
    return values
}
\`\`\`

### Sharded Cache with TTL

Combining sharding with time-to-live expiry produces a cache that is both highly concurrent and memory-bounded. Each shard independently stores \`cacheItem\` values that carry an \`expiresAt\` timestamp, enabling lazy expiration on \`Get\` as well as periodic batch cleanup via a background goroutine. The \`GetOrCompute\` method encapsulates the common cache-aside pattern, check the cache, call the compute function on a miss, and store the result, all with per-shard locking so that different keys can be computed in parallel.

\`\`\`go
// ShardedCache is a high-performance cache with TTL support
type ShardedCache[K comparable, V any] struct {
    shards     []cacheShard[K, V]
    numShards  uint32
    defaultTTL time.Duration
    cleanupInterval time.Duration
    stopCleanup chan struct{}
}

type cacheShard[K comparable, V any] struct {
    mu    sync.RWMutex
    items map[K]cacheItem[V]
    _     [32]byte // Padding
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
        // Expired - lazy delete
        c.Delete(key)
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

// GetOrCompute returns cached value or computes and caches it
func (c *ShardedCache[K, V]) GetOrCompute(key K, compute func() (V, error)) (V, error) {
    if v, ok := c.Get(key); ok {
        return v, nil
    }

    // Compute the value
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

// Close stops the cleanup goroutine
func (c *ShardedCache[K, V]) Close() {
    close(c.stopCleanup)
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
\`\`\`

### Minimal Sharded Counter (Bitmasked Variant)

The padded counter from the previous section optimizes for eliminating false sharing at the cost of memory. This leaner variant takes a different approach: it rounds the shard count up to a power of two so that the modulo operation can be replaced by a fast bitwise AND (\`& mask\`), which is a single CPU instruction rather than the more expensive integer division. Goroutine IDs serve as a proxy for CPU affinity to spread writes across shards without any per-goroutine bookkeeping. Reading the total requires summing all shards atomically, making this variant best suited for metrics aggregation where reads are infrequent compared to writes.

\`\`\`go
type ShardedCounter struct {
    shards []int64
    mask   int
}

func NewShardedCounter(numShards int) *ShardedCounter {
    // Round to power of 2
    size := 1
    for size < numShards {
        size *= 2
    }
    return &ShardedCounter{
        shards: make([]int64, size),
        mask:   size - 1,
    }
}

func (c *ShardedCounter) Add(delta int64) {
    // Use goroutine ID for distribution
    id := getGoroutineID() & c.mask
    atomic.AddInt64(&c.shards[id], delta)
}

func (c *ShardedCounter) Value() int64 {
    var total int64
    for i := range c.shards {
        total += atomic.LoadInt64(&c.shards[i])
    }
    return total
}
\`\`\`

### Staff Lens: Sharding Is the Right First Response to Contention

When a profile shows mutex contention, sharding is the simpler and more reliable response than reaching for lock-free data structures. Shard counts:

- 16 or 32: good default for in-process sharded maps.
- \`runtime.NumCPU()\`: right for per-core counters with rare reads.
- Power-of-two: enables \`hash & (n-1)\` instead of modulo.

Shard the state first. If sharding solves the contention, stop. Only reach for lock-free techniques if sharding is insufficient, which is rare in practice.

### Hot-Key Problem Recap

Sharding assumes uniform key distribution. One hot key can defeat the entire sharding benefit. Monitor for this (per-shard load metric) and address hot keys separately: replication, caching, or moving them out of the sharded structure. This is the most common way sharding fails at scale.

---
`;
