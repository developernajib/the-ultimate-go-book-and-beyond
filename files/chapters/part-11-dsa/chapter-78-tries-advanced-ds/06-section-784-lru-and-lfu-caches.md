## 78.4 LRU and LFU Caches

### LRU Cache

An LRU cache evicts the least recently used entry when capacity is exceeded, requiring O(1) get and put operations. The classic implementation pairs a hash map (for O(1) node lookup) with a doubly linked list (for O(1) node movement to the front on access), maintaining most-recently-used nodes at the head and the eviction candidate at the tail.

```go
// LRUCache implements Least Recently Used cache
// LeetCode 146: LRU Cache
type LRUCache struct {
    capacity int
    cache    map[int]*LRUNode
    head     *LRUNode
    tail     *LRUNode
}

type LRUNode struct {
    key, value int
    prev, next *LRUNode
}

func LRUConstructor(capacity int) LRUCache {
    head := &LRUNode{}
    tail := &LRUNode{}
    head.next = tail
    tail.prev = head

    return LRUCache{
        capacity: capacity,
        cache:    make(map[int]*LRUNode),
        head:     head,
        tail:     tail,
    }
}

func (c *LRUCache) remove(node *LRUNode) {
    node.prev.next = node.next
    node.next.prev = node.prev
}

func (c *LRUCache) addToHead(node *LRUNode) {
    node.prev = c.head
    node.next = c.head.next
    c.head.next.prev = node
    c.head.next = node
}

func (c *LRUCache) moveToHead(node *LRUNode) {
    c.remove(node)
    c.addToHead(node)
}

func (c *LRUCache) Get(key int) int {
    if node, ok := c.cache[key]; ok {
        c.moveToHead(node)
        return node.value
    }
    return -1
}

func (c *LRUCache) Put(key int, value int) {
    if node, ok := c.cache[key]; ok {
        node.value = value
        c.moveToHead(node)
        return
    }

    newNode := &LRUNode{key: key, value: value}
    c.cache[key] = newNode
    c.addToHead(newNode)

    if len(c.cache) > c.capacity {
        lru := c.tail.prev
        c.remove(lru)
        delete(c.cache, lru.key)
    }
}
```

### LFU Cache

An LFU cache evicts the entry with the lowest access frequency, and among ties, the least recently used among those. The O(1) implementation uses a hash map from frequency to a doubly linked list of nodes at that frequency, plus a `minFreq` tracker. When a node is accessed, it moves from its frequency list to the `freq+1` list, updating `minFreq` if the old frequency list becomes empty.

```go
// LFUCache implements Least Frequently Used cache
// LeetCode 460: LFU Cache
type LFUCache struct {
    capacity   int
    minFreq    int
    cache      map[int]*LFUNode
    freqLists  map[int]*LFUList
}

type LFUNode struct {
    key, value, freq int
    prev, next       *LFUNode
}

type LFUList struct {
    head, tail *LFUNode
    size       int
}

func newLFUList() *LFUList {
    head := &LFUNode{}
    tail := &LFUNode{}
    head.next = tail
    tail.prev = head
    return &LFUList{head: head, tail: tail}
}

func (l *LFUList) addToHead(node *LFUNode) {
    node.prev = l.head
    node.next = l.head.next
    l.head.next.prev = node
    l.head.next = node
    l.size++
}

func (l *LFUList) remove(node *LFUNode) {
    node.prev.next = node.next
    node.next.prev = node.prev
    l.size--
}

func (l *LFUList) removeTail() *LFUNode {
    if l.size == 0 {
        return nil
    }
    node := l.tail.prev
    l.remove(node)
    return node
}

func LFUConstructor(capacity int) LFUCache {
    return LFUCache{
        capacity:  capacity,
        cache:     make(map[int]*LFUNode),
        freqLists: make(map[int]*LFUList),
    }
}

func (c *LFUCache) Get(key int) int {
    if c.capacity == 0 {
        return -1
    }

    node, ok := c.cache[key]
    if !ok {
        return -1
    }

    c.updateFreq(node)
    return node.value
}

func (c *LFUCache) Put(key int, value int) {
    if c.capacity == 0 {
        return
    }

    if node, ok := c.cache[key]; ok {
        node.value = value
        c.updateFreq(node)
        return
    }

    if len(c.cache) >= c.capacity {
        list := c.freqLists[c.minFreq]
        removed := list.removeTail()
        delete(c.cache, removed.key)
    }

    node := &LFUNode{key: key, value: value, freq: 1}
    c.cache[key] = node
    if c.freqLists[1] == nil {
        c.freqLists[1] = newLFUList()
    }
    c.freqLists[1].addToHead(node)
    c.minFreq = 1
}

func (c *LFUCache) updateFreq(node *LFUNode) {
    freq := node.freq
    c.freqLists[freq].remove(node)

    if c.freqLists[freq].size == 0 && c.minFreq == freq {
        c.minFreq++
    }

    node.freq++
    if c.freqLists[node.freq] == nil {
        c.freqLists[node.freq] = newLFUList()
    }
    c.freqLists[node.freq].addToHead(node)
}
```

### Beyond Capacity Eviction: Expiring 10 Million Keys with Hashed Timing Wheels (O(1) Expiration)

Capacity-based eviction (LRU/LFU) discards entries when memory fills. However, high-scale caches and session stores also require **time-to-live (TTL) expiration**, where items must be deleted automatically after a duration delta-t.

In production systems holding millions of items, the conventional approaches collapse under scale, as analyzed in [Killing O(n): How Timing Wheels Expire 10 Million Keys Effortlessly in Golang](https://medium.com/@author/killing-o-n-how-timing-wheels-expire-10-million-keys-effortlessly-in-golang) by Ankur Anand:

#### The TTL Expiration Architecture Spectrum

1. **Naive O(n) Periodic Sweep**: A background goroutine periodically locks the cache map and iterates over all keys to delete entries where `now > expiresAt`.
   - At 10,000 keys: Scan completes in ~5 ms with negligible CPU overhead.
   - At 1,000,000 keys: Scan requires ~275 ms, blocking readers.
   - At 10,000,000 keys: Each scan burns **2,290 ms to 2,670 ms** of CPU time (229% CPU utilization on multi-core systems). Read latency spikes to **4.27 seconds**, and cleanup latency exceeds the 1-second interval itself - the expiration engine falls behind real time.
2. **Min-Heap Priority Queue**: Organizing TTLs in a min-heap allows inspecting the earliest expiring key in O(1) time. However, every cache insertion, read refresh, or deletion requires an O(log n) sift operation. For 10,000,000 keys, log2(10^7) ≈ 24 pointer comparisons and heap rebalancing operations per mutation, creating massive GC allocation pressure.
3. **Hashed Timing Wheel (Varghese & Lauck)**: Discretizes time into a circular buffer of buckets representing fixed time steps (e.g., 60 slots of 1 second each).
   - **Insertion**: O(1). Calculate `pos = (currentSlot + ttl/tick) % slotCount` and append entry to `slots[pos]`.
   - **Expiration**: O(1) amortized. On each tick, advance `currentSlot = (currentSlot + 1) % slotCount`, swap the active bucket under a short lock, and execute evictions outside the lock.
   - At 10,000,000 keys: Scan time drops from 2,670 ms to **< 0.1 ms**, average read latency drops to **0.05 ms**, and CPU overhead drops to **< 0.1%**.

```go
package cache

import (
	"sync"
	"time"
)

type WheelEntry struct {
	Key   string
	Value any
}

// TimingWheel implements a single-level circular timing wheel
type TimingWheel struct {
	tick       time.Duration
	slotCount  int
	current    int
	slots      [][]WheelEntry
	mu         sync.Mutex
	stopChan   chan struct{}
	onExpire   func(entry WheelEntry)
}

func NewTimingWheel(tick time.Duration, slotCount int, onExpire func(entry WheelEntry)) *TimingWheel {
	return &TimingWheel{
		tick:      tick,
		slotCount: slotCount,
		slots:     make([][]WheelEntry, slotCount),
		stopChan:  make(chan struct{}),
		onExpire:  onExpire,
	}
}

// Add schedules an entry for expiration in O(1) time
func (w *TimingWheel) Add(key string, val any, ttl time.Duration) {
	if ttl <= 0 {
		w.onExpire(WheelEntry{Key: key, Value: val})
		return
	}

	ticks := int(ttl / w.tick)
	if ticks == 0 {
		ticks = 1
	}

	w.mu.Lock()
	pos := (w.current + ticks) % w.slotCount
	w.slots[pos] = append(w.slots[pos], WheelEntry{Key: key, Value: val})
	w.mu.Unlock()
}

func (w *TimingWheel) Start() {
	ticker := time.NewTicker(w.tick)
	go func() {
		for {
			select {
			case <-ticker.C:
				w.tickOnce()
			case <-w.stopChan:
				ticker.Stop()
				return
			}
		}
	}()
}

func (w *TimingWheel) Stop() {
	close(w.stopChan)
}

// tickOnce advances the clock pointer and flushes only what is due right now
func (w *TimingWheel) tickOnce() {
	w.mu.Lock()
	bucket := w.slots[w.current]
	w.slots[w.current] = nil // Reset slot for next revolution
	w.current = (w.current + 1) % w.slotCount
	w.mu.Unlock()

	// Execute expiration callbacks OUTSIDE the lock to preserve reader concurrency
	for _, entry := range bucket {
		w.onExpire(entry)
	}
}

// TTLMapCache integrates the timing wheel with a concurrent Go map
type TTLMapCache struct {
	mu   sync.RWMutex
	data map[string]any
	tw   *TimingWheel
}

func NewTTLMapCache(tick time.Duration, slots int) *TTLMapCache {
	c := &TTLMapCache{
		data: make(map[string]any),
	}
	c.tw = NewTimingWheel(tick, slots, func(e WheelEntry) {
		c.mu.Lock()
		delete(c.data, e.Key)
		c.mu.Unlock()
	})
	c.tw.Start()
	return c
}

func (c *TTLMapCache) Set(key string, val any, ttl time.Duration) {
	c.mu.Lock()
	c.data[key] = val
	c.mu.Unlock()

	c.tw.Add(key, val, ttl)
}

func (c *TTLMapCache) Get(key string) (any, bool) {
	c.mu.RLock()
	val, ok := c.data[key]
	c.mu.RUnlock()
	return val, ok
}
```

### Junior → FAANG: LRU vs LFU: When the Eviction Policy Matters

LRU evicts the entry that has not been accessed for the longest time. LFU evicts the entry with the lowest access frequency, with LRU as the tiebreaker. In interviews, choose LRU unless the problem explicitly mentions frequency-based eviction. The implementation distinction matters: LRU uses one doubly linked list, while LFU requires a doubly linked list per frequency level plus a `minFreq` tracker.

The most common LFU bug is mishandling `minFreq`. It must reset to 1 whenever a `put` inserts a new entry, since that entry is now the least frequent thing in the cache, and it must advance when a frequency increment empties the list at the current minimum. Note the asymmetry in `updateFreq`: `minFreq` only ever increments by one there, and that is sufficient rather than lucky. The node just promoted moved from `freq` to `freq+1`, so if the `freq` list is now empty, the next non-empty level is exactly `freq+1`. Nothing can be skipped. Test both edge cases the moment you finish the implementation.

There is also a detail this implementation leaves on the floor, worth raising unprompted: `freqLists` never removes an empty list. A key accessed a million times leaves a million empty `LFUList` values in the map, none of which are ever read again. It does not affect correctness and no interviewer will fail you for it, but in a long-lived cache it is unbounded growth driven by access counts rather than by entry count, which is not a shape most people expect. Deleting the list when its size hits zero is a two-line fix.

### Senior @ FAANG: Cache Eviction Policies in Distributed Systems and Their Operational Tradeoffs

At the senior level, LRU and LFU are the two standard policies, but production distributed caches (Redis, Memcached) implement approximated versions for performance. Redis uses a probabilistic LRU that samples a pool of N random keys and evicts the least recently used among them, avoiding the overhead of a full doubly linked list. Redis also supports LFU mode (with exponential decay on counters to prevent stale-high-frequency entries from never being evicted). The staff-level concern is choosing the right policy for your access pattern: LRU performs well when recency correlates with future access (typical for session-based access patterns), while LFU performs better when frequency correlates with future access (typical for content serving where popular items remain popular over time). Scan resistance is a related concern: a full sequential scan of the dataset will flush an LRU cache entirely, while LFU with decay is more resistant. The ADR for a caching layer must document the expected access pattern (recency-dominated, frequency-dominated, or mixed), the chosen eviction policy and its rationale, the cache hit rate target and how it is monitored, and the degradation behavior when the cache is cold (thundering herd mitigation strategy).
