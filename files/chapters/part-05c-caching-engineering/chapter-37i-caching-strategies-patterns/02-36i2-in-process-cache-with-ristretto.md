## 37I.2 In-Process Cache with Ristretto

### High-Performance Local Cache

Ristretto uses a TinyLFU admission policy and a cost-based eviction model, so `NumCounters` should be set to 10x the expected item count to keep the frequency sketch accurate. The generic `LocalCache[K, V]` wraps ristretto v2 with a type-safe interface and exposes a `Cost` function that estimates item size from its runtime type, preventing unbounded memory growth when storing variable-size strings or byte slices.

Ristretto v2 introduced Go generics (`ristretto.Cache[K, V]`) so callers no longer pay the cost of `any` boxing or the type assertion on every `Get`. If you are starting a new service in 2026, use v2. v1 is maintenance-only. For workloads that care more about hit rate than raw throughput - especially OLTP traffic with recency-sensitive access patterns - consider `maypok86/otter/v2`, which implements Caffeine's adaptive W-TinyLFU and publishes benchmark wins against ristretto on most non-frequency-skewed traces.

```go
// go.mod: require github.com/dgraph-io/ristretto/v2 v2.x.x

package cache

import (
	"fmt"
	"time"

	"github.com/dgraph-io/ristretto/v2"
)

// LocalCache wraps ristretto for type-safe in-process caching
type LocalCache[K ristretto.Key, V any] struct {
	cache *ristretto.Cache[K, V]
	ttl   time.Duration
}

// NewLocalCache creates a ristretto-backed local cache.
// maxItems:  maximum number of items (used to size the frequency sketch).
// maxSizeMB: soft cap on memory usage in MiB - eviction runs above this cost.
func NewLocalCache[K ristretto.Key, V any](maxItems int64, maxSizeMB int64, ttl time.Duration) (*LocalCache[K, V], error) {
	cache, err := ristretto.NewCache(&ristretto.Config[K, V]{
		NumCounters: maxItems * 10, // 10x for admission policy accuracy
		MaxCost:     maxSizeMB * 1024 * 1024,
		BufferItems: 64,        // per-Get buffer, reduces contention
		Metrics:     true,      // enable hit rate tracking
		Cost: func(value V) int64 {
			// Estimate size by runtime type. For domain structs, prefer
			// implementing a Sizer interface and using that here.
			switch v := any(value).(type) {
			case string:
				return int64(len(v))
			case []byte:
				return int64(len(v))
			default:
				return 1 // count-based if size unknown
			}
		},
	})
	if err != nil {
		return nil, fmt.Errorf("create ristretto cache: %w", err)
	}
	return &LocalCache[K, V]{cache: cache, ttl: ttl}, nil
}

// Get retrieves a value from the cache. With v2 generics, no type assertion
// is needed: the type parameter V is enforced at compile time.
func (c *LocalCache[K, V]) Get(key K) (V, bool) {
	return c.cache.Get(key)
}

// Set stores a value with optional custom TTL
func (c *LocalCache[K, V]) Set(key K, value V) bool {
	return c.cache.SetWithTTL(key, value, 0, c.ttl)
}

// SetWithTTL stores with a specific TTL
func (c *LocalCache[K, V]) SetWithTTL(key K, value V, ttl time.Duration) bool {
	return c.cache.SetWithTTL(key, value, 0, ttl)
}

// Delete removes a key from the cache
func (c *LocalCache[K, V]) Delete(key K) {
	c.cache.Del(key)
}

// Metrics returns cache performance statistics
func (c *LocalCache[K, V]) Metrics() CacheMetrics {
	m := c.cache.Metrics
	return CacheMetrics{
		HitRate:    m.Ratio(),
		Hits:       m.Hits(),
		Misses:     m.Misses(),
		KeysAdded:  m.KeysAdded(),
		KeysEvicted: m.KeysEvicted(),
	}
}

type CacheMetrics struct {
	HitRate     float64
	Hits        uint64
	Misses      uint64
	KeysAdded   uint64
	KeysEvicted uint64
}
```

### Thread-Safe TTL Cache (sync.Map based)

When per-item TTL precision matters more than throughput (such as short-lived auth tokens or per-user rate limit counters), `TTLCache` replaces ristretto's approximate eviction with exact expiry tracked in a plain map behind an `RWMutex`. A background goroutine ticks at `cleanupInterval` to purge expired entries, keeping memory bounded without paying ristretto's bookkeeping overhead.

```go
package cache

import (
	"sync"
	"time"
)

// TTLCache is a simple thread-safe cache with per-item TTL
// Use when you need precise per-item TTL without ristretto overhead
type TTLCache[K comparable, V any] struct {
	mu      sync.RWMutex
	items   map[K]*ttlItem[V]
	janitor *time.Ticker
	stop    chan struct{}
}

type ttlItem[V any] struct {
	value     V
	expiresAt time.Time
}

// NewTTLCache creates a cache with background cleanup
func NewTTLCache[K comparable, V any](cleanupInterval time.Duration) *TTLCache[K, V] {
	c := &TTLCache[K, V]{
		items:   make(map[K]*ttlItem[V]),
		janitor: time.NewTicker(cleanupInterval),
		stop:    make(chan struct{}),
	}
	go c.cleanup()
	return c
}

func (c *TTLCache[K, V]) Set(key K, value V, ttl time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.items[key] = &ttlItem[V]{
		value:     value,
		expiresAt: time.Now().Add(ttl),
	}
}

func (c *TTLCache[K, V]) Get(key K) (V, bool) {
	c.mu.RLock()
	item, found := c.items[key]
	c.mu.RUnlock()

	if !found || time.Now().After(item.expiresAt) {
		var zero V
		return zero, false
	}
	return item.value, true
}

func (c *TTLCache[K, V]) Delete(key K) {
	c.mu.Lock()
	delete(c.items, key)
	c.mu.Unlock()
}

func (c *TTLCache[K, V]) cleanup() {
	for {
		select {
		case <-c.janitor.C:
			c.mu.Lock()
			now := time.Now()
			for k, item := range c.items {
				if now.After(item.expiresAt) {
					delete(c.items, k)
				}
			}
			c.mu.Unlock()
		case <-c.stop:
			c.janitor.Stop()
			return
		}
	}
}

func (c *TTLCache[K, V]) Close() {
	close(c.stop)
}
```

### Alternative: Otter (Adaptive W-TinyLFU)

If your workload shows poor hit rates with ristretto - typical symptoms are high churn in the admission filter or a flat hit-rate curve that plateaus well below your cache's working-set ratio - swap in `maypok86/otter/v2`. The API is intentionally similar:

```go
// go.mod: require github.com/maypok86/otter/v2 v2.x.x
import "github.com/maypok86/otter/v2"

cache, err := otter.MustBuilder[string, *Product](100_000).
    WithTTL(5 * time.Minute).
    Cost(func(key string, value *Product) uint32 {
        return uint32(len(key) + productSize(value))
    }).
    Build()
if err != nil { return nil, err }

if p, ok := cache.Get("product:42"); ok { return p, nil }
cache.Set("product:42", product)
```

Otter's adaptive W-TinyLFU shifts weight between recency and frequency at runtime, which tends to win on mixed OLTP traces where ristretto's static TinyLFU admission rejects too many legitimate newcomers. Benchmark both against your own traffic before committing - the right answer depends on the shape of your key distribution.

### Junior → FAANG: reading ristretto's API without surprises

Ristretto has three knobs that confuse new users. `NumCounters` is not the cache capacity. It is the size of the count-min sketch that tracks approximate access frequency for the admission policy. The rule of thumb is `NumCounters = 10 * expected_item_count`. Undersize it and the sketch aliases unrelated keys, admission accuracy drops, and hit rate collapses. Oversize it and you waste a few megabytes but lose nothing else. `MaxCost` is the actual memory budget, measured in whatever units your `Cost` function returns. If `Cost` returns bytes, `MaxCost` is in bytes. If `Cost` returns 1 per item, `MaxCost` is the item count. Be consistent across calls or ristretto will evict unpredictably. `BufferItems` is the per-goroutine ring buffer size for coalescing Get operations into batched counter updates, and 64 is almost always correct.

The other junior trap is the `Set` return value. Ristretto's `Set` is asynchronous and returns a boolean indicating whether the item was accepted into the write buffer, not whether it was admitted to the cache. To observe your own write you must call `cache.Wait()` after `Set` in tests. In production code you never wait, because admission is eventually consistent and the cost of blocking every writer on the admission decision would eliminate the throughput benefit. New engineers see a test like `cache.Set("k", v, 1); _, ok := cache.Get("k"); assert ok` fail randomly and conclude ristretto is broken. It is not. Add `cache.Wait()` in the test, or restructure the test to use the async contract.

First-job worked example. A search service caches query result pages keyed by `user_id + query_hash + page_number`. The working set is roughly 50,000 unique keys, average payload 4KB. Sizing: `NumCounters = 500_000`, `MaxCost = 250_000_000` (250MB), `BufferItems = 64`, `Cost = func(v []byte) int64 { return int64(len(v)) }`. Set a default TTL of 2 minutes with 20 percent jitter. After deployment, watch `Metrics.Ratio()` for 24 hours. A healthy hit rate is above 85 percent for Zipfian query traffic. If it is below 70 percent, either the working set is larger than estimated (raise MaxCost) or the TTL is too short (raise TTL). If `KeysEvicted / KeysAdded` exceeds 0.5 sustained, you are undersized and admission is thrashing.

Interview entry points: why is ristretto's `Set` asynchronous (throughput plus admission sampling), why does TinyLFU beat LRU on scan-heavy workloads (admission gate rejects one-hit wonders before they displace hot items), and what is the count-min sketch (probabilistic frequency counter with bounded overcounting, never undercount). Be able to draw the count-min sketch on a whiteboard: `d` hash functions indexing into `w`-wide counter arrays, incrementing all `d` cells on observe, reading the minimum on query.

### Senior @ FAANG: library selection, memory safety, and the sizing ADR

At staff level the ristretto-versus-alternatives decision is a written ADR, not a vibe. The decision axes are: hit rate on your trace, allocation pressure and GC impact, memory safety and cgo avoidance, concurrency model fit, and operational observability.

**Ristretto v2** (2026 status, v2.x) uses TinyLFU admission over a sharded SLRU (Segmented LRU) with BP-Wrapper contention reduction. Sharded counters (256 shards by default) eliminate hotspot contention on the access-frequency sketch. Generics eliminate the v1 boxing tax. Hit rate on frequency-skewed traces (search, product catalog, DNS-style) is at or near the theoretical LFU optimum. Hit rate on recency-biased traces (session data, notification feeds) lags W-TinyLFU by 3 to 8 percentage points in published benchmarks. Pure-Go, no cgo, GC-friendly for structs but allocates on every admission decision.

**Otter v2** implements Caffeine's adaptive W-TinyLFU. The admission window is dynamic and adapts to the observed recency/frequency balance, giving near-optimal hit rates across mixed workloads. API is generic, pure-Go, no cgo. Throughput is competitive with ristretto on reads but slightly lower on writes due to adaptive bookkeeping. The right default in 2026 for general-purpose caches where you do not know the workload shape in advance.

**Theine** is another Caffeine port with adaptive W-TinyLFU, pure-Go, generics. Benchmarks close to otter. Smaller community than ristretto or otter. Pick it only if you have a specific reason, otherwise otter's maturity wins.

**Freecache** stores all data in a preallocated ring buffer of byte slices. No Go heap allocation per entry, so the GC never walks the cache. Hit rate is LRU-approximate (no frequency admission), so it loses to ristretto and otter on skewed traces, but it is unbeatable when your cache holds hundreds of millions of small entries and GC pause is the bottleneck. **Bigcache** is similar in spirit with a different shard design. Pick freecache or bigcache only when GC-pause profiling shows the cache is the culprit. Both require you to serialize values to bytes on write and deserialize on read, which shifts CPU cost to marshalling.

**Groupcache** and its modern successor **galaxycache** are not drop-in replacements. They are distributed in-process caches with consistent-hashing peer lookup and automatic singleflight across the group. Use them when you have a fleet of replicas, the same key is cacheable on any replica, and you cannot afford a Redis round-trip but also cannot afford to duplicate the entire working set in every process. Vimeo built galaxycache and runs it in this shape.

**go-cache v2** (a fork of patrickmn/go-cache with generics) is a mutex-guarded `map[K]V` with janitor-based expiry. Hit rate is trivially 100 percent for items still inside their TTL because there is no eviction policy beyond expiry. It has no admission, no frequency, no size cap. Use it for bounded-working-set caches where TTL is the only lifecycle concern (feature flags, config, short-lived tokens). Do not use it for anything that can grow unbounded.

**Memory safety and cgo avoidance** is a principal-level concern for teams shipping Go binaries to regulated environments. Any cache that depends on cgo adds a build-time and runtime dependency on a C toolchain, breaks static linking guarantees, complicates fuzzing, and expands the attack surface. All of ristretto, otter, theine, freecache, bigcache, groupcache, and galaxycache are pure-Go. Avoid wrappers around C caches (for example, any LibCache or RocksDB-backed cache) unless the ADR explicitly accepts the cgo trade-off.

**The in-process cache sizing ADR** should contain: measured working-set size (count of unique keys observed over the expected TTL window in production traces), measured average and p99 entry size, memory budget per replica derived from pod memory limit minus runtime and request buffer overhead, chosen library with benchmark evidence, admission and eviction policy with justification, TTL policy including jitter, invalidation mechanism, metrics exposed (hit ratio, byte hit ratio, evictions per second, admission rejections per second), SLO on hit rate with alerting threshold, and fallback behavior on cache failure. The ADR belongs in the service repo next to the code, not in a wiki, so that engineers reading the cache code find the rationale without a scavenger hunt.

**Eviction policy field guide** in one paragraph. MRU evicts the most recently used, useful only for scan-once workloads like full-table cursors. LRU evicts the least recently used, the baseline. LFU evicts the least frequently used, adapts slowly and can freeze the working set around old hot keys. ARC (IBM) splits recency and frequency with adaptive weighting, patented in some jurisdictions. W-TinyLFU (Caffeine and ristretto) adds a TinyLFU admission gate over an SLRU main cache. SIEVE (NSDI 2024) uses an LRU-like queue with a visited bit and a moving eviction hand, achieving LFU-class hit rates with LRU-class simplicity. **S3-FIFO** (CMU, SOSP 2023) sets the highest benchmark in hit rate per byte of metadata: a small FIFO admits new items, a main FIFO holds the hot set, and a ghost queue remembers recent evictions to avoid re-admitting one-hit wonders. Go implementations of S3-FIFO are beginning to appear in research repos in 2026 but have not reached ristretto or otter yet. Track the space and migrate when a production-grade S3-FIFO library ships.

---
