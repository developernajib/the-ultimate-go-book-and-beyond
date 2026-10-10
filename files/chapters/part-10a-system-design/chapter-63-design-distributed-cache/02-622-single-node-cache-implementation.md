## 63.2 Single-Node Cache Implementation

### Core Cache Structure

The single-node cache is implemented as an LRU (Least Recently Used) eviction structure backed by a doubly-linked list and a map, providing O(1) get and set operations while bounding memory usage by evicting the least recently accessed entry when capacity is reached. A `sync.RWMutex` protects the data structure, allowing concurrent reads while serializing writes to prevent race conditions under load. TTL-based expiration is checked lazily on access rather than eagerly with background timers, keeping the implementation simple while avoiding serving stale data.

```go
// cache/cache.go
package cache

import (
    "container/list"
    "errors"
    "sync"
    "time"
)

var ErrCacheFull = errors.New("cache full")

// EvictionPolicy defines the interface for cache eviction algorithms
type EvictionPolicy interface {
    OnAdd(e *entry)
    OnAccess(e *entry)
    OnRemove(e *entry)
    SelectVictim() string
}

// Cache implements an in-memory cache with eviction
type Cache struct {
    mu          sync.RWMutex
    data        map[string]*entry
    maxSize     int64
    currentSize int64
    eviction    EvictionPolicy
    onEvict     func(key string, value []byte)

    // TTL tracking
    ttlHeap     *ttlHeap
    ttlMu       sync.Mutex
}

type entry struct {
    key       string
    value     []byte
    size      int64
    expiresAt time.Time
    element   *list.Element // For LRU/LFU
    frequency int           // For LFU
    createdAt time.Time
    accessAt  time.Time
}

// Config holds cache configuration
type Config struct {
    MaxSize       int64
    EvictionPolicy EvictionPolicy
    DefaultTTL    time.Duration
    OnEvict       func(key string, value []byte)
}

// NewCache creates a new cache
func NewCache(config Config) *Cache {
    c := &Cache{
        data:     make(map[string]*entry),
        maxSize:  config.MaxSize,
        eviction: config.EvictionPolicy,
        onEvict:  config.OnEvict,
        ttlHeap:  newTTLHeap(),
    }

    // Start background expiration
    go c.expirationLoop()

    return c
}

// Get retrieves a value from the cache
func (c *Cache) Get(key string) ([]byte, bool) {
    c.mu.RLock()
    e, ok := c.data[key]
    c.mu.RUnlock()

    if !ok {
        return nil, false
    }

    // Check expiration
    if !e.expiresAt.IsZero() && time.Now().After(e.expiresAt) {
        c.Delete(key)
        return nil, false
    }

    // Update access for eviction policy
    c.mu.Lock()
    e.accessAt = time.Now()
    c.eviction.OnAccess(e)
    c.mu.Unlock()

    return e.value, true
}

// Set stores a value in the cache
func (c *Cache) Set(key string, value []byte, ttl time.Duration) error {
    c.mu.Lock()
    defer c.mu.Unlock()

    size := int64(len(key) + len(value))

    // Check if key exists
    if existing, ok := c.data[key]; ok {
        c.currentSize -= existing.size
        c.eviction.OnRemove(existing)
    }

    // Evict if necessary
    for c.currentSize+size > c.maxSize {
        if !c.evictOne() {
            return ErrCacheFull
        }
    }

    // Create entry
    now := time.Now()
    e := &entry{
        key:       key,
        value:     value,
        size:      size,
        createdAt: now,
        accessAt:  now,
    }

    if ttl > 0 {
        e.expiresAt = now.Add(ttl)
        c.ttlMu.Lock()
        c.ttlHeap.Add(key, e.expiresAt)
        c.ttlMu.Unlock()
    }

    c.data[key] = e
    c.currentSize += size
    c.eviction.OnAdd(e)

    return nil
}

// Delete removes a key from the cache
func (c *Cache) Delete(key string) bool {
    c.mu.Lock()
    defer c.mu.Unlock()

    e, ok := c.data[key]
    if !ok {
        return false
    }

    delete(c.data, key)
    c.currentSize -= e.size
    c.eviction.OnRemove(e)

    if c.onEvict != nil {
        c.onEvict(key, e.value)
    }

    return true
}

func (c *Cache) evictOne() bool {
    key := c.eviction.SelectVictim()
    if key == "" {
        return false
    }

    e, ok := c.data[key]
    if !ok {
        return false
    }

    delete(c.data, key)
    c.currentSize -= e.size
    c.eviction.OnRemove(e)

    if c.onEvict != nil {
        c.onEvict(key, e.value)
    }

    return true
}

// expirationLoop actively expires keys
func (c *Cache) expirationLoop() {
    ticker := time.NewTicker(time.Second)
    defer ticker.Stop()

    for range ticker.C {
        c.expireKeys()
    }
}

func (c *Cache) expireKeys() {
    now := time.Now()
    keysToDelete := make([]string, 0)

    c.ttlMu.Lock()
    for c.ttlHeap.Len() > 0 {
        key, expiresAt := c.ttlHeap.Peek()
        if expiresAt.After(now) {
            break
        }
        c.ttlHeap.PopMin()
        keysToDelete = append(keysToDelete, key)
    }
    c.ttlMu.Unlock()

    for _, key := range keysToDelete {
        c.Delete(key)
    }
}

// Stats returns cache statistics
func (c *Cache) Stats() CacheStats {
    c.mu.RLock()
    defer c.mu.RUnlock()

    return CacheStats{
        Size:      c.currentSize,
        MaxSize:   c.maxSize,
        ItemCount: len(c.data),
    }
}

type CacheStats struct {
    Size      int64
    MaxSize   int64
    ItemCount int
}
```

### LRU Eviction Policy

The LRU policy uses Go's standard `container/list` doubly-linked list to track access order, pushing newly added or recently accessed entries to the front so that the back of the list always holds the least recently used entry. `OnAdd`, `OnAccess`, and `OnRemove` hooks are called by the cache on every state change, keeping the list in sync with the underlying data map. When `SelectVictim` is invoked during an eviction, it simply returns the key stored in the back element, giving O(1) victim selection without scanning the entire cache.

```go
// cache/lru.go
package cache

import (
    "container/list"
)

// LRUPolicy implements Least Recently Used eviction
type LRUPolicy struct {
    list     *list.List
    capacity int
}

// NewLRUPolicy creates a new LRU policy
func NewLRUPolicy() *LRUPolicy {
    return &LRUPolicy{
        list: list.New(),
    }
}

// OnAdd is called when a new entry is added
func (p *LRUPolicy) OnAdd(e *entry) {
    e.element = p.list.PushFront(e)
}

// OnAccess is called when an entry is accessed
func (p *LRUPolicy) OnAccess(e *entry) {
    p.list.MoveToFront(e.element)
}

// OnRemove is called when an entry is removed
func (p *LRUPolicy) OnRemove(e *entry) {
    if e.element != nil {
        p.list.Remove(e.element)
    }
}

// SelectVictim returns the key to evict
func (p *LRUPolicy) SelectVictim() string {
    if p.list.Len() == 0 {
        return ""
    }
    back := p.list.Back()
    if back == nil {
        return ""
    }
    return back.Value.(*entry).key
}
```

### LFU Eviction Policy

The LFU policy maintains a min-heap ordered by access frequency, so the entry with the fewest accesses is always at the root and can be selected as a victim in O(log n) time. When two entries share the same frequency, the `lastAccess` timestamp acts as a tie-breaker, evicting the one that was accessed longer ago and giving a combined LFU-LRU behavior that avoids cache pollution from one-time bulk reads. The `heap.Fix` call after each access efficiently repositions the updated entry within the heap without a full rebuild, keeping per-operation cost bounded even under heavy write traffic.

```go
// cache/lfu.go
package cache

import (
    "container/heap"
    "time"
)

// LFUPolicy implements Least Frequently Used eviction
type LFUPolicy struct {
    frequencies map[string]*lfuEntry
    minHeap     *lfuHeap
}

type lfuEntry struct {
    key       string
    frequency int
    lastAccess int64 // Tie-breaker
    index     int    // Heap index
}

type lfuHeap []*lfuEntry

func (h lfuHeap) Len() int { return len(h) }

func (h lfuHeap) Less(i, j int) bool {
    if h[i].frequency == h[j].frequency {
        return h[i].lastAccess < h[j].lastAccess
    }
    return h[i].frequency < h[j].frequency
}

func (h lfuHeap) Swap(i, j int) {
    h[i], h[j] = h[j], h[i]
    h[i].index = i
    h[j].index = j
}

func (h *lfuHeap) Push(x any) {
    n := len(*h)
    entry := x.(*lfuEntry)
    entry.index = n
    *h = append(*h, entry)
}

func (h *lfuHeap) Pop() any {
    old := *h
    n := len(old)
    entry := old[n-1]
    old[n-1] = nil
    entry.index = -1
    *h = old[0 : n-1]
    return entry
}

// NewLFUPolicy creates a new LFU policy
func NewLFUPolicy() *LFUPolicy {
    h := &lfuHeap{}
    heap.Init(h)
    return &LFUPolicy{
        frequencies: make(map[string]*lfuEntry),
        minHeap:     h,
    }
}

func (p *LFUPolicy) OnAdd(e *entry) {
    lfu := &lfuEntry{
        key:        e.key,
        frequency:  1,
        lastAccess: time.Now().UnixNano(),
    }
    p.frequencies[e.key] = lfu
    heap.Push(p.minHeap, lfu)
}

func (p *LFUPolicy) OnAccess(e *entry) {
    lfu, ok := p.frequencies[e.key]
    if !ok {
        return
    }
    lfu.frequency++
    lfu.lastAccess = time.Now().UnixNano()
    heap.Fix(p.minHeap, lfu.index)
}

func (p *LFUPolicy) OnRemove(e *entry) {
    lfu, ok := p.frequencies[e.key]
    if !ok {
        return
    }
    heap.Remove(p.minHeap, lfu.index)
    delete(p.frequencies, e.key)
}

func (p *LFUPolicy) SelectVictim() string {
    if p.minHeap.Len() == 0 {
        return ""
    }
    return (*p.minHeap)[0].key
}
```

### TTL Heap

The TTL heap is a min-heap sorted by expiration time, so the soonest-to-expire key is always at the root and the background expiration loop can stop scanning the moment it finds an entry that has not yet expired. A companion `keyMap` provides O(1) lookup by key name, allowing the expiration time of an existing entry to be updated in place via `heap.Fix` rather than removing and reinserting it. This structure is kept under its own `ttlMu` mutex, separate from the main cache lock, so TTL writes do not block concurrent reads of unrelated cache entries.

```go
// cache/ttl_heap.go
package cache

import (
    "container/heap"
    "time"
)

type ttlEntry struct {
    key       string
    expiresAt time.Time
    index     int
}

type ttlHeap struct {
    entries []*ttlEntry
    keyMap  map[string]*ttlEntry
}

func newTTLHeap() *ttlHeap {
    h := &ttlHeap{
        entries: make([]*ttlEntry, 0),
        keyMap:  make(map[string]*ttlEntry),
    }
    heap.Init(h)
    return h
}

func (h *ttlHeap) Len() int { return len(h.entries) }

func (h *ttlHeap) Less(i, j int) bool {
    return h.entries[i].expiresAt.Before(h.entries[j].expiresAt)
}

func (h *ttlHeap) Swap(i, j int) {
    h.entries[i], h.entries[j] = h.entries[j], h.entries[i]
    h.entries[i].index = i
    h.entries[j].index = j
}

func (h *ttlHeap) Push(x any) {
    n := len(h.entries)
    entry := x.(*ttlEntry)
    entry.index = n
    h.entries = append(h.entries, entry)
}

func (h *ttlHeap) Pop() any {
    old := h.entries
    n := len(old)
    entry := old[n-1]
    old[n-1] = nil
    entry.index = -1
    h.entries = old[0 : n-1]
    return entry
}

// Add inserts or updates a key's expiry. It cannot be called Push:
// that name is already taken by the heap.Interface method above, and
// Go does not allow two methods with the same name.
func (h *ttlHeap) Add(key string, expiresAt time.Time) {
    if existing, ok := h.keyMap[key]; ok {
        existing.expiresAt = expiresAt
        heap.Fix(h, existing.index)
        return
    }

    entry := &ttlEntry{key: key, expiresAt: expiresAt}
    heap.Push(h, entry)
    h.keyMap[key] = entry
}

func (h *ttlHeap) Peek() (string, time.Time) {
    if h.Len() == 0 {
        return "", time.Time{}
    }
    return h.entries[0].key, h.entries[0].expiresAt
}

// PopMin removes and returns the soonest-expiring key, distinct from
// the heap.Interface Pop method for the same reason Add is not Push.
func (h *ttlHeap) PopMin() (string, time.Time) {
    if h.Len() == 0 {
        return "", time.Time{}
    }
    entry := heap.Pop(h).(*ttlEntry)
    delete(h.keyMap, entry.key)
    return entry.key, entry.expiresAt
}
```

### Junior -> FAANG: Understanding the Data Structure Choices

The LRU cache uses a doubly-linked list plus a map because each provides O(1) for what the other cannot. The map gives O(1) key lookup but has no ordering. The linked list gives O(1) move-to-front and O(1) back-of-list access (for eviction) but O(n) lookup. Together they give O(1) get, O(1) set, and O(1) evict. Interviewers frequently ask "how would you implement an LRU cache?" and expect this doubly-linked list plus map answer. Know it cold.

The LFU policy uses a min-heap for O(log n) victim selection. The heap is ordered by frequency, with a timestamp tie-breaker for entries that have the same frequency. The timestamp tie-breaker gives LFU a bias toward recently accessed entries when frequencies are equal, which improves hit rates for access patterns where new entries start at frequency=1 and would otherwise be immediately evicted by any other frequency=1 entry.

The separate `ttlMu` mutex for the TTL heap is a concurrency optimization: reads of the cache data (`c.mu.RLock()`) do not need to acquire the TTL lock. Without the separate mutex, every read would need to acquire the write lock on the TTL heap to check expiration times, serializing all reads even though TTL checks are read-only operations.

The `expirationLoop` goroutine that runs every second is a production concern: it must not hold the `ttlMu` lock for the entire expiration pass. The implementation correctly unlocks `ttlMu` after collecting the expired keys, then calls `c.Delete` (which acquires `c.mu`) for each key. This avoids deadlock and allows concurrent reads during the deletion pass.

### Senior @ FAANG: Production Hardening for a Single-Node Cache

**The `onEvict` callback is an integration point**

The `onEvict func(key string, value []byte)` parameter allows the cache to notify callers when an entry is evicted. This is useful for write-behind caching: when an entry is evicted before being flushed to the database, the evict callback triggers an immediate synchronous flush. Without this callback, the write-behind cache would silently lose updates on eviction. The production pattern is to register an `onEvict` callback that sends the key-value pair to a persistence queue, and have the queue processor write to the database.

**Memory accounting accuracy**

The `size` calculation (`int64(len(key) + len(value))`) underestimates actual memory usage. Each `entry` struct adds roughly 80-100 bytes of overhead (key string header, value slice header, time.Time for expires and access, int for frequency, pointer for list element). At 1 million small entries with 20-byte keys and 50-byte values, the structural overhead (100MB) exceeds the data overhead (70MB). For an accurate memory-bounded cache, account for struct overhead in the size calculation. A simple approach is to add a fixed overhead constant per entry (e.g., 128 bytes) to the size calculation.

**The `expirationLoop` is a goroutine that needs a shutdown path**

The `expirationLoop` goroutine started in `NewCache` runs forever. If the `Cache` is garbage collected or if the application is shutting down, this goroutine leaks. The production fix is to accept a `context.Context` in `NewCache` (or provide a `Close` method) and have the expiration loop exit when the context is canceled. This is a goroutine lifecycle management concern that code reviewers at FAANG always flag.

**Benchmark the O(1) claims**

The LRU and LFU descriptions claim O(1) for get and set. The LFU implementation uses `heap.Fix` after each access, which is O(log n). This is technically O(log n), not O(1). A bar-raiser will notice this discrepancy. The production trade-off is accepted: O(log n) for access tracking is negligible for typical cache sizes (under 1M entries), and the improved eviction accuracy of LFU over LRU is worth it. Know this trade-off and be able to justify it.

---
