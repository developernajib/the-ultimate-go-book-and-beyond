## Production Pitfalls: Distributed Cache Disasters

### Pitfall 1: The Split-Brain Catastrophe

**Real Incident Report**: A network partition caused a Redis cluster to split into two independent clusters, each accepting writes. When the partition healed, data was lost as nodes chose one master's data over the other. Result: 45 minutes of cache inconsistency affecting millions of requests.

**The Anti-Pattern**:
```go
// DANGEROUS: No quorum checking
func (c *Cluster) HandleWrite(key string, value []byte) error {
    node := c.getNodeForKey(key)
    // Writes succeed even if node is partitioned from majority
    return node.Set(key, value)
}
```

**The Better Approach**:
```go
type QuorumCluster struct {
    nodes          []*Node
    quorumSize     int
    partitionCheck *PartitionDetector
}

func (c *QuorumCluster) HandleWrite(ctx context.Context, key string, value []byte) error {
    // Check cluster health first
    if !c.partitionCheck.IsMajorityReachable() {
        return ErrClusterPartitioned
    }

    primary := c.getPrimaryForKey(key)
    replicas := c.getReplicasForKey(key)

    // Write to primary
    if err := primary.Set(ctx, key, value); err != nil {
        return err
    }

    // Wait for quorum acknowledgment
    ackCount := 1 // Primary already acked
    ackChan := make(chan bool, len(replicas))

    for _, replica := range replicas {
        go func(r *Node) {
            err := r.Replicate(ctx, key, value)
            ackChan <- (err == nil)
        }(replica)
    }

    timeout := time.After(100 * time.Millisecond)
    for i := 0; i < len(replicas); i++ {
        select {
        case ack := <-ackChan:
            if ack {
                ackCount++
            }
            if ackCount >= c.quorumSize {
                return nil // Quorum achieved
            }
        case <-timeout:
            break
        }
    }

    if ackCount >= c.quorumSize {
        return nil
    }

    // Rollback if quorum not achieved
    primary.Delete(ctx, key)
    return ErrQuorumNotReached
}

type PartitionDetector struct {
    nodes           []*Node
    reachableCount  atomic.Int32
    checkInterval   time.Duration
}

func (d *PartitionDetector) Start(ctx context.Context) {
    ticker := time.NewTicker(d.checkInterval)

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            reachable := 0
            for _, node := range d.nodes {
                if d.ping(node) {
                    reachable++
                }
            }
            d.reachableCount.Store(int32(reachable))
        }
    }
}

func (d *PartitionDetector) IsMajorityReachable() bool {
    majority := len(d.nodes)/2 + 1
    return int(d.reachableCount.Load()) >= majority
}
```

**Key Insight**: Implement quorum-based writes to prevent split-brain. Detect network partitions and refuse writes when unable to reach majority. Use fencing tokens for master election.

---

### Pitfall 2: The Hot Key Meltdown

**Real Incident Report**: A viral product launch caused 100,000 RPS to a single cache key. The node holding that key melted down, causing cascading failures as requests backed up across the cluster.

**The Anti-Pattern**:
```go
// DANGEROUS: Single key becomes bottleneck
func (c *Cache) Get(key string) ([]byte, error) {
    node := c.hashRing.GetNode(key)
    return node.Get(key) // All requests hit same node
}
```

**The Better Approach**:
```go
type HotKeyHandler struct {
    cache           *Cache
    localCache      *lru.Cache // Per-instance local cache
    hotKeyDetector  *HotKeyDetector
    replicationFactor int
}

type HotKeyDetector struct {
    counts   sync.Map // key -> *atomic.Int64
    threshold int64
    window   time.Duration
}

func (d *HotKeyDetector) RecordAccess(key string) bool {
    countPtr, _ := d.counts.LoadOrStore(key, &atomic.Int64{})
    count := countPtr.(*atomic.Int64).Add(1)
    return count > d.threshold
}

func (h *HotKeyHandler) Get(ctx context.Context, key string) ([]byte, error) {
    // Check local cache first (microsecond latency)
    if value, ok := h.localCache.Get(key); ok {
        return value.([]byte), nil
    }

    // Detect hot key
    isHot := h.hotKeyDetector.RecordAccess(key)

    if isHot {
        // For hot keys, read from random replica
        return h.getFromRandomReplica(ctx, key)
    }

    // Normal path
    value, err := h.cache.Get(ctx, key)
    if err != nil {
        return nil, err
    }

    // Cache locally for hot keys
    if isHot {
        h.localCache.Add(key, value)
    }

    return value, nil
}

func (h *HotKeyHandler) getFromRandomReplica(ctx context.Context, key string) ([]byte, error) {
    // Get all nodes that should have this key (primary + replicas)
    nodes := h.cache.GetNodesForKey(key, h.replicationFactor)

    // Pick random node to distribute load
    node := nodes[rand.IntN(len(nodes))]

    return node.Get(ctx, key)
}

// Proactive hot key replication
func (h *HotKeyHandler) SpreadHotKey(ctx context.Context, key string) error {
    value, err := h.cache.Get(ctx, key)
    if err != nil {
        return err
    }

    // Replicate to additional nodes
    additionalNodes := h.cache.GetAdditionalNodes(key, 5)
    for _, node := range additionalNodes {
        node.SetWithTTL(ctx, key, value, time.Minute)
    }

    return nil
}
```

**Key Insight**: Detect hot keys by tracking access frequency. Use local caching, read from replicas, and spread hot keys across additional nodes.

---

### Pitfall 3: The Memory Fragmentation Spiral

**Real Incident Report**: A cache server's memory usage kept growing despite LRU eviction. Investigation revealed severe memory fragmentation - the allocator couldn't reuse freed memory. The server eventually OOM'd with only 60% actual data stored.

**The Anti-Pattern**:
```go
// DANGEROUS: Variable-size allocations cause fragmentation
type Entry struct {
    Key   string
    Value []byte // Variable size causes fragmentation
}

func (c *Cache) Set(key string, value []byte) {
    c.entries[key] = &Entry{
        Key:   key,
        Value: value, // Each allocation is different size
    }
}
```

**The Better Approach**:
```go
type SlabAllocator struct {
    slabs      map[int]*Slab // Size class -> Slab
    sizeClasses []int         // e.g., 64, 128, 256, 512, 1024, 2048, 4096
}

type Slab struct {
    size      int
    chunks    [][]byte
    freeList  []int
    mu        sync.Mutex
}

func NewSlabAllocator() *SlabAllocator {
    sa := &SlabAllocator{
        slabs:       make(map[int]*Slab),
        sizeClasses: []int{64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768},
    }

    for _, size := range sa.sizeClasses {
        sa.slabs[size] = newSlab(size, 1000) // Pre-allocate 1000 chunks per class
    }

    return sa
}

func (sa *SlabAllocator) Allocate(size int) ([]byte, int) {
    // Find smallest size class that fits
    for _, sizeClass := range sa.sizeClasses {
        if size <= sizeClass {
            return sa.slabs[sizeClass].Allocate()
        }
    }

    // Too large for slabs, allocate directly
    return make([]byte, size), -1
}

func (s *Slab) Allocate() ([]byte, int) {
    s.mu.Lock()
    defer s.mu.Unlock()

    if len(s.freeList) == 0 {
        s.grow()
    }

    idx := s.freeList[len(s.freeList)-1]
    s.freeList = s.freeList[:len(s.freeList)-1]

    return s.chunks[idx], idx
}

func (s *Slab) Free(idx int) {
    s.mu.Lock()
    defer s.mu.Unlock()

    // Clear the chunk and return to free list
    for i := range s.chunks[idx] {
        s.chunks[idx][i] = 0
    }
    s.freeList = append(s.freeList, idx)
}

type FragmentationAwareCache struct {
    allocator  *SlabAllocator
    entries    map[string]*CacheEntry
    stats      *FragmentationStats
}

type CacheEntry struct {
    Data      []byte
    SlabClass int
    SlabIndex int
}

func (c *FragmentationAwareCache) Set(key string, value []byte) {
    // Free old entry if exists
    if old, exists := c.entries[key]; exists {
        if old.SlabClass >= 0 {
            c.allocator.slabs[old.SlabClass].Free(old.SlabIndex)
        }
    }

    chunk, slabIndex := c.allocator.Allocate(len(value))
    copy(chunk, value)

    c.entries[key] = &CacheEntry{
        Data:      chunk[:len(value)],
        SlabClass: c.findSlabClass(len(value)),
        SlabIndex: slabIndex,
    }
}
```

**Key Insight**: Use slab allocation with fixed-size chunks to prevent fragmentation. Pre-allocate memory pools for common sizes. Monitor fragmentation metrics and restart if necessary.

---

### Pitfall 4: The Replication Lag Cascade

**Real Incident Report**: A cache replica fell behind during a network blip. When it caught up, the flood of replication data saturated the network, causing other replicas to also fall behind. The cascade took down the entire cluster's replication.

**The Anti-Pattern**:
```go
// DANGEROUS: Unbounded replication catch-up
func (r *Replica) SyncFromMaster(master *Node) error {
    lastOffset := r.getLastOffset()

    // Requests ALL missing data at once
    data, err := master.GetDataSince(lastOffset)
    if err != nil {
        return err
    }

    // Massive write storm
    for _, entry := range data {
        r.Apply(entry)
    }

    return nil
}
```

**The Better Approach**:
```go
type ThrottledReplication struct {
    master       *Node
    replicas     []*Replica
    maxBatchSize int
    maxBytesPerSec int64
    rateLimiter  *rate.Limiter
}

func (r *ThrottledReplication) SyncReplica(ctx context.Context, replica *Replica) error {
    lastOffset := replica.getLastOffset()
    masterOffset := r.master.GetCurrentOffset()

    lag := masterOffset - lastOffset
    if lag == 0 {
        return nil // Already in sync
    }

    // Adaptive batch size based on lag
    batchSize := r.calculateBatchSize(lag)

    for lastOffset < masterOffset {
        select {
        case <-ctx.Done():
            return ctx.Err()
        default:
        }

        // Rate limit replication
        if err := r.rateLimiter.Wait(ctx); err != nil {
            return err
        }

        // Fetch batch
        endOffset := lastOffset + int64(batchSize)
        if endOffset > masterOffset {
            endOffset = masterOffset
        }

        entries, err := r.master.GetDataRange(lastOffset, endOffset)
        if err != nil {
            return err
        }

        // Apply with backpressure awareness
        for _, entry := range entries {
            if replica.WriteQueueFull() {
                // Wait for replica to catch up
                time.Sleep(10 * time.Millisecond)
            }
            replica.Apply(entry)
        }

        lastOffset = endOffset

        // Update progress metrics
        r.updateReplicationLag(replica.ID, masterOffset-lastOffset)
    }

    return nil
}

func (r *ThrottledReplication) calculateBatchSize(lag int64) int {
    // Small batches when close to sync, larger when far behind
    if lag < 1000 {
        return 100
    } else if lag < 10000 {
        return 500
    } else if lag < 100000 {
        return 1000
    }
    return r.maxBatchSize
}

// Monitor and alert on replication lag
func (r *ThrottledReplication) MonitorLag(ctx context.Context) {
    ticker := time.NewTicker(time.Second)

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            for _, replica := range r.replicas {
                lag := r.master.GetCurrentOffset() - replica.getLastOffset()

                // Metrics
                replicationLagGauge.WithLabelValues(replica.ID).Set(float64(lag))

                // Alert on excessive lag
                if lag > 100000 {
                    log.Warn("High replication lag",
                        "replica", replica.ID,
                        "lag", lag)
                }
            }
        }
    }
}
```

**Key Insight**: Rate-limit replication to prevent network saturation. Use adaptive batch sizes based on lag. Monitor lag and alert before it becomes critical.

---

### Pitfall 5: The Eviction Storm

**Real Incident Report**: Memory pressure triggered aggressive LRU eviction. The eviction process itself consumed so much CPU that the cache couldn't serve requests. A negative feedback loop developed: more eviction → slower responses → more timeouts → more retries → more memory pressure.

**The Anti-Pattern**:
```go
// DANGEROUS: Blocking eviction during write
func (c *Cache) Set(key string, value []byte) error {
    for c.usedMemory+len(value) > c.maxMemory {
        // Synchronous eviction blocks all writes!
        c.evictOne()
    }

    c.data[key] = value
    c.usedMemory += len(value)
    return nil
}

func (c *Cache) evictOne() {
    // Find LRU entry (expensive scan)
    oldest := c.findOldest()
    delete(c.data, oldest.Key)
    c.usedMemory -= len(oldest.Value)
}
```

**The Better Approach**:
```go
type BackgroundEvictionCache struct {
    data         sync.Map
    usedMemory   atomic.Int64
    maxMemory    int64
    evictionChan chan struct{}
    lru          *LRUIndex
    metrics      *EvictionMetrics
}

func (c *BackgroundEvictionCache) Set(key string, value []byte) error {
    valueSize := int64(len(value))

    // Check memory pressure
    memoryUsage := float64(c.usedMemory.Load()) / float64(c.maxMemory)

    if memoryUsage > 0.95 {
        // Critical: reject writes to prevent OOM
        return ErrMemoryPressure
    }

    if memoryUsage > 0.85 {
        // High pressure: trigger background eviction
        select {
        case c.evictionChan <- struct{}{}:
        default:
            // Already evicting
        }
    }

    // Store the value
    old, loaded := c.data.Swap(key, value)
    if loaded {
        c.usedMemory.Add(valueSize - int64(len(old.([]byte))))
    } else {
        c.usedMemory.Add(valueSize)
    }

    // Update LRU (non-blocking)
    c.lru.Touch(key)

    return nil
}

func (c *BackgroundEvictionCache) evictionWorker(ctx context.Context) {
    for {
        select {
        case <-ctx.Done():
            return
        case <-c.evictionChan:
            c.performEviction()
        }
    }
}

func (c *BackgroundEvictionCache) performEviction() {
    target := int64(float64(c.maxMemory) * 0.75) // Evict down to 75%

    evicted := 0
    startTime := time.Now()

    for c.usedMemory.Load() > target {
        // Evict in batches to reduce lock contention
        batch := c.lru.GetOldest(100)

        for _, key := range batch {
            if value, loaded := c.data.LoadAndDelete(key); loaded {
                c.usedMemory.Add(-int64(len(value.([]byte))))
                evicted++
            }
        }

        // Yield to prevent starvation
        if evicted%1000 == 0 {
            runtime.Gosched()
        }

        // Safety: don't evict for too long
        if time.Since(startTime) > 100*time.Millisecond {
            break
        }
    }

    c.metrics.EvictionCount.Add(float64(evicted))
    c.metrics.EvictionDuration.Observe(time.Since(startTime).Seconds())
}

// Proactive eviction based on TTL
func (c *BackgroundEvictionCache) ttlEvictionWorker(ctx context.Context) {
    ticker := time.NewTicker(time.Second)

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            expired := c.lru.GetExpired(100)
            for _, key := range expired {
                c.data.Delete(key)
            }
        }
    }
}
```

**Key Insight**: Run eviction in background workers. Set memory thresholds to trigger early eviction. Yield during eviction to prevent request starvation. Reject writes at critical pressure.

---

### Quick Reference: Distributed Cache Pitfalls

| Pitfall | Impact | Prevention |
|---------|--------|------------|
| Split-brain | Data loss, inconsistency | Quorum writes, partition detection |
| Hot key | Single node meltdown | Local cache, replica reads, key spreading |
| Memory fragmentation | OOM despite free space | Slab allocation, fixed-size chunks |
| Replication lag cascade | Cluster-wide degradation | Rate limiting, adaptive batching |
| Eviction storm | Complete service degradation | Background eviction, memory thresholds |

---

### Junior → FAANG: Split-Brain as the Distributed Systems Nightmare Scenario

The split-brain scenario (two partitioned nodes both accepting writes, then merging with conflicting data) is the textbook distributed systems failure mode. Know the cause (network partition without a quorum requirement for writes) and the prevention (requiring quorum acknowledgment before accepting writes, or using a primary-only write model where replicas refuse writes).

For FAANG interviews, the split-brain question often appears as "how do you prevent two leaders?" The answer is Raft or Paxos consensus, or a simpler primary-only approach with lease-based leadership (the primary holds a lease from a coordination service - if the lease expires, the primary steps down before the next leader can acquire the lease, preventing overlap).

The thundering herd (thousands of simultaneous cache misses after a cache restart) is the most operationally impactful pitfall for a deployed cache. The mitigation (singleflight to collapse duplicate concurrent requests, or request coalescing) is a specific pattern worth knowing by name and being able to implement.

### Senior @ FAANG: Pitfalls as Incident Classification System

At senior level, the pitfall table is a starting point for an incident classification system. Each class of incident has a detection mechanism (which alert fires first), a diagnostic process (what metrics to check, what logs to search), a mitigation procedure (how to stop the bleeding), and a remediation process (how to prevent recurrence).

Eviction storms (cache evicting aggressively during a traffic spike, causing a cascade of database requests that overwhelm the origin) are the most dangerous operational scenario for a cache tier. The mitigation requires coordination between the cache team and the application team: the cache team controls eviction thresholds and background eviction rate, the application team controls fallback behavior (circuit breaker to shed load when the database is overwhelmed). Neither team can fully prevent eviction storms without the other's cooperation.

Replication lag cascades (a slow replica lagging behind the master, causing the master's write buffer to fill, causing master write latency to increase, causing application latency to increase) are a feedback loop that must be broken by shedding replication load (disconnecting or throttling the slow replica) before it affects the master's write path. Monitoring replication lag as a metric and alerting before it reaches the buffer fill threshold is the proactive version of this response.

---
