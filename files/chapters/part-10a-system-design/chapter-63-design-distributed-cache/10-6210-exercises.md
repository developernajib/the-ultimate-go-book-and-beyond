## Exercises with Complete Solutions

### Exercise 1: Implement an LRU Cache with TTL

Build an LRU cache that supports both capacity-based eviction and time-based expiration. The implementation uses a doubly-linked list for O(1) access-order maintenance and a map for O(1) key lookup. Expired entries are detected lazily on `Get` and proactively by a background cleanup goroutine, ensuring stale data is never returned while keeping the hot path fast.

**Solution:**

```go
package lrucache

import (
    "container/list"
    "sync"
    "time"
)

type LRUCache struct {
    capacity int
    cache    map[string]*list.Element
    list     *list.List
    mu       sync.RWMutex
}

type entry struct {
    key       string
    value     any
    expiresAt time.Time
}

func NewLRUCache(capacity int) *LRUCache {
    c := &LRUCache{
        capacity: capacity,
        cache:    make(map[string]*list.Element),
        list:     list.New(),
    }

    go c.expirationWorker()

    return c
}

func (c *LRUCache) Get(key string) (any, bool) {
    c.mu.Lock()
    defer c.mu.Unlock()

    elem, ok := c.cache[key]
    if !ok {
        return nil, false
    }

    e := elem.Value.(*entry)

    // Check expiration
    if !e.expiresAt.IsZero() && time.Now().After(e.expiresAt) {
        c.removeElement(elem)
        return nil, false
    }

    // Move to front (most recently used)
    c.list.MoveToFront(elem)

    return e.value, true
}

func (c *LRUCache) Set(key string, value any, ttl time.Duration) {
    c.mu.Lock()
    defer c.mu.Unlock()

    var expiresAt time.Time
    if ttl > 0 {
        expiresAt = time.Now().Add(ttl)
    }

    // Update existing entry
    if elem, ok := c.cache[key]; ok {
        c.list.MoveToFront(elem)
        e := elem.Value.(*entry)
        e.value = value
        e.expiresAt = expiresAt
        return
    }

    // Evict if at capacity
    for c.list.Len() >= c.capacity {
        c.evictOldest()
    }

    // Add new entry
    e := &entry{
        key:       key,
        value:     value,
        expiresAt: expiresAt,
    }
    elem := c.list.PushFront(e)
    c.cache[key] = elem
}

func (c *LRUCache) Delete(key string) bool {
    c.mu.Lock()
    defer c.mu.Unlock()

    elem, ok := c.cache[key]
    if !ok {
        return false
    }

    c.removeElement(elem)
    return true
}

func (c *LRUCache) evictOldest() {
    back := c.list.Back()
    if back != nil {
        c.removeElement(back)
    }
}

func (c *LRUCache) removeElement(elem *list.Element) {
    c.list.Remove(elem)
    e := elem.Value.(*entry)
    delete(c.cache, e.key)
}

func (c *LRUCache) expirationWorker() {
    ticker := time.NewTicker(time.Second)
    defer ticker.Stop()

    for range ticker.C {
        c.expireOldEntries()
    }
}

func (c *LRUCache) expireOldEntries() {
    c.mu.Lock()
    defer c.mu.Unlock()

    now := time.Now()
    var toRemove []*list.Element

    for elem := c.list.Back(); elem != nil; elem = elem.Prev() {
        e := elem.Value.(*entry)
        if !e.expiresAt.IsZero() && now.After(e.expiresAt) {
            toRemove = append(toRemove, elem)
        }
    }

    for _, elem := range toRemove {
        c.removeElement(elem)
    }
}

func (c *LRUCache) Len() int {
    c.mu.RLock()
    defer c.mu.RUnlock()
    return c.list.Len()
}

func (c *LRUCache) Stats() CacheStats {
    c.mu.RLock()
    defer c.mu.RUnlock()

    return CacheStats{
        Size:     c.list.Len(),
        Capacity: c.capacity,
    }
}

type CacheStats struct {
    Size     int
    Capacity int
}
```

### Exercise 2: Build a Write-Behind Cache with Batching

Implement a cache that batches write operations to the database. Note
the naming: because writes are acknowledged before the database write
happens, this is write-BEHIND semantics (63.4), not write-through. A
write-through cache with batching is a contradiction, batching implies
the caller returns before the database write completes.

**Solution:**

```go
package writecache

import (
    "context"
    "sync"
    "time"
)

type WriteOperation struct {
    Key       string
    Value     []byte
    Operation string // "set" or "delete"
    Timestamp time.Time
}

type WriteBehindCache struct {
    cache         map[string][]byte
    cacheMu       sync.RWMutex
    writeBuffer   []WriteOperation
    bufferMu      sync.Mutex
    database      Database
    batchSize     int
    flushInterval time.Duration
    stopCh        chan struct{}
    wg            sync.WaitGroup
}

type Database interface {
    BatchWrite(ctx context.Context, ops []WriteOperation) error
    Get(ctx context.Context, key string) ([]byte, error)
}

func NewWriteBehindCache(db Database, batchSize int, flushInterval time.Duration) *WriteBehindCache {
    c := &WriteBehindCache{
        cache:         make(map[string][]byte),
        writeBuffer:   make([]WriteOperation, 0, batchSize),
        database:      db,
        batchSize:     batchSize,
        flushInterval: flushInterval,
        stopCh:        make(chan struct{}),
    }

    c.wg.Add(1)
    go c.flushWorker()

    return c
}

func (c *WriteBehindCache) Get(ctx context.Context, key string) ([]byte, error) {
    c.cacheMu.RLock()
    if value, ok := c.cache[key]; ok {
        c.cacheMu.RUnlock()
        return value, nil
    }
    c.cacheMu.RUnlock()

    // Cache miss - fetch from database
    value, err := c.database.Get(ctx, key)
    if err != nil {
        return nil, err
    }

    // Populate cache
    c.cacheMu.Lock()
    c.cache[key] = value
    c.cacheMu.Unlock()

    return value, nil
}

func (c *WriteBehindCache) Set(ctx context.Context, key string, value []byte) error {
    // Update cache immediately
    c.cacheMu.Lock()
    c.cache[key] = value
    c.cacheMu.Unlock()

    // Add to write buffer
    c.bufferMu.Lock()
    c.writeBuffer = append(c.writeBuffer, WriteOperation{
        Key:       key,
        Value:     value,
        Operation: "set",
        Timestamp: time.Now(),
    })

    shouldFlush := len(c.writeBuffer) >= c.batchSize
    c.bufferMu.Unlock()

    if shouldFlush {
        return c.flush(ctx)
    }

    return nil
}

func (c *WriteBehindCache) Delete(ctx context.Context, key string) error {
    // Remove from cache immediately
    c.cacheMu.Lock()
    delete(c.cache, key)
    c.cacheMu.Unlock()

    // Add delete to write buffer
    c.bufferMu.Lock()
    c.writeBuffer = append(c.writeBuffer, WriteOperation{
        Key:       key,
        Operation: "delete",
        Timestamp: time.Now(),
    })
    c.bufferMu.Unlock()

    return nil
}

func (c *WriteBehindCache) flush(ctx context.Context) error {
    c.bufferMu.Lock()
    if len(c.writeBuffer) == 0 {
        c.bufferMu.Unlock()
        return nil
    }

    // Get operations and clear buffer
    ops := c.writeBuffer
    c.writeBuffer = make([]WriteOperation, 0, c.batchSize)
    c.bufferMu.Unlock()

    // Deduplicate - keep only latest operation per key
    deduplicated := c.deduplicateOps(ops)

    // Batch write to database
    return c.database.BatchWrite(ctx, deduplicated)
}

func (c *WriteBehindCache) deduplicateOps(ops []WriteOperation) []WriteOperation {
    latest := make(map[string]WriteOperation)

    for _, op := range ops {
        if existing, ok := latest[op.Key]; !ok || op.Timestamp.After(existing.Timestamp) {
            latest[op.Key] = op
        }
    }

    result := make([]WriteOperation, 0, len(latest))
    for _, op := range latest {
        result = append(result, op)
    }

    return result
}

func (c *WriteBehindCache) flushWorker() {
    defer c.wg.Done()

    ticker := time.NewTicker(c.flushInterval)
    defer ticker.Stop()

    for {
        select {
        case <-ticker.C:
            ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
            c.flush(ctx)
            cancel()
        case <-c.stopCh:
            // Final flush before stopping
            ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
            c.flush(ctx)
            cancel()
            return
        }
    }
}

func (c *WriteBehindCache) Close() error {
    close(c.stopCh)
    c.wg.Wait()
    return nil
}

func (c *WriteBehindCache) Stats() CacheStats {
    c.cacheMu.RLock()
    cacheSize := len(c.cache)
    c.cacheMu.RUnlock()

    c.bufferMu.Lock()
    bufferSize := len(c.writeBuffer)
    c.bufferMu.Unlock()

    return CacheStats{
        CacheSize:  cacheSize,
        BufferSize: bufferSize,
    }
}

type CacheStats struct {
    CacheSize  int
    BufferSize int
}
```

### Junior -> FAANG: Using Exercises to Build Interview Fluency

The six exercises in this file are structured to build the exact skills FAANG system design interviews test. Each one maps to a real production problem, not an academic exercise.

Exercise 1 (consistent hash ring) is a direct coding interview question at FAANG. Practice implementing it without looking at references. The key constraint is O(log n) lookup via binary search over sorted virtual node positions. If you can implement this in 30 minutes, you are prepared for the coding portion of a distributed systems interview.

Exercise 3 (stampede with mutex and singleflight) is a benchmarking exercise that teaches you what "exactly one database call" means in code. The insight is that `singleflight` deduplicated calls share a single return value, so all 1,000 goroutines receive the same fetched value without each waiting independently. Being able to demonstrate this in a benchmark (not just assert it) shows engineering rigor that interviewers remember.

Exercise 4 (write-through vs write-back with WAL) is the hardest exercise in this set and the one that separates strong candidates from exceptional ones. The write-ahead log for the write-back cache is the correct answer to "how do you avoid data loss during crashes?" Practice explaining why the WAL must be written before the cache is updated (not after), and why recovery replays the WAL in order.

A first-job habit: time yourself completing exercise 1 and exercise 3. If you cannot complete a consistent hash ring implementation in 45 minutes, practice until you can. FAANG coding interviews run 45-60 minutes and distributed systems coding problems at this complexity level are common.

### Senior @ FAANG: Extracting Architectural Depth from Implementation Exercises

Each exercise above has a surface implementation and a deeper architectural question. A senior candidate does not just write the code but also explains the limits of the implementation and the conditions under which a different design would be required.

**Exercise 2 (ARC eviction policy): when to use ARC vs LRU vs LFU in production**

ARC outperforms LRU on mixed workloads because it adapts between recency-weighted (LRU-like) and frequency-weighted (LFU-like) eviction based on recent hit patterns. The ADR question for a production system: do you implement ARC yourself or use a library? In Go, `maypok86/otter/v2` implements W-TinyLFU, which outperforms ARC on Zipf-distributed workloads in most benchmarks. The correct production answer is almost never "implement a custom eviction policy," because the policy alone accounts for maybe 10% of cache performance while key design, TTL tuning, and stampede prevention account for 90%. Implementing ARC is a useful learning exercise. Shipping custom ARC to production is almost never justified.

**Exercise 4 (WAL for write-back): the durability spectrum and its cost**

The write-ahead log in exercise 4 gives the write-back cache crash safety at the cost of a synchronous disk write per batch flush. The durability spectrum for a write-back cache is:

1. No WAL: maximum write throughput, zero durability (data lost on crash)
2. WAL with fsync per batch: strong durability, throughput bounded by fsync latency (typically 1-5ms per fsync on SSDs)
3. WAL with group commit: fsync is shared across concurrent flushes, improving throughput at the cost of slightly higher latency per individual flush
4. WAL replicated to a second node: crash safety plus hardware failure tolerance, at twice the write cost

A principal engineer chooses the point on this spectrum based on the business value of the data. For a rate-limiting cache, losing 500ms of data on crash is acceptable and no WAL is needed. For a session cache, losing sessions on crash causes user-visible logouts and a WAL with fsync is justified. Articulating this tradeoff is L6 thinking.

**Exercise 6 (cache warming): the cold-start problem as a reliability risk**

The 60-second window to reach 95% hit rate is a reliability SLO, not a performance goal. If a rolling deployment brings up new cache nodes one at a time and each node takes 5 minutes to warm, the cache hit rate degrades during the deployment window, increasing database load, which can cascade into a database availability incident. Cache warming strategy belongs in the deployment runbook, not as an afterthought. A staff engineer writes the warming coordinator as part of the initial design and includes a canary deployment step that holds at 5% traffic until the warmup SLO is achieved before proceeding.

---
