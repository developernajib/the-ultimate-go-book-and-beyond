export default `## 13.11 Company Case Studies

### Google: sync.Pool in the Standard Library

The Go standard library itself is the best proof that \`sync.Pool\` delivers measurable allocation savings. Both \`encoding/json\` and \`fmt\` pool their internal encoder and printer state objects so that high-frequency calls avoid hitting the allocator on every invocation. The pattern is always the same: get from pool, reset, use, put back.

\`\`\`go
// From encoding/json - buffer pool for encoding
var encodeStatePool sync.Pool

func newEncodeState() *encodeState {
    if v := encodeStatePool.Get(); v != nil {
        e := v.(*encodeState)
        e.Reset()
        return e
    }
    return new(encodeState)
}

func (e *encodeState) marshal(v any, opts encOpts) error {
    defer func() {
        e.Reset()
        encodeStatePool.Put(e)
    }()
    // ... encoding logic
}

// From fmt - buffer pool for printf operations
var ppFree = sync.Pool{
    New: func() any { return new(pp) },
}

// Reduces allocations in high-frequency printf calls
\`\`\`

### Uber: Atomic Configuration at Scale

At Uber's scale, even a brief mutex contention spike on the configuration read path can cascade into latency regressions across thousands of microservices. Their approach stores configuration behind an \`atomic.Pointer\`, so every request reads the current config with a single atomic load, zero lock acquisition, zero contention. Updates swap in a new immutable struct and notify subscribers asynchronously.

\`\`\`go
// Uber's configuration pattern
type ServiceConfig struct {
    // Immutable configuration
    Timeout      time.Duration
    MaxRetries   int
    CircuitBreaker CircuitBreakerConfig
    Features     map[string]bool
}

type ConfigManager struct {
    current atomic.Pointer[ServiceConfig]

    // Subscribers notified on change
    mu          sync.RWMutex
    subscribers []func(*ServiceConfig)
}

func (cm *ConfigManager) Update(cfg *ServiceConfig) {
    old := cm.current.Swap(cfg)

    // Notify subscribers
    cm.mu.RLock()
    for _, sub := range cm.subscribers {
        go sub(cfg)
    }
    cm.mu.RUnlock()

    // Log change
    logConfigChange(old, cfg)
}

func (cm *ConfigManager) Get() *ServiceConfig {
    return cm.current.Load()
}

// Zero-lock reads in hot path
func (s *Service) HandleRequest(r *Request) {
    cfg := s.config.Get()  // Atomic load, no lock

    ctx, cancel := context.WithTimeout(r.Context(), cfg.Timeout)
    defer cancel()

    // Use cfg.Features, cfg.MaxRetries, etc.
}
\`\`\`

### Netflix: RWMutex for Cache Layers

Netflix's tiered caching architecture places an \`RWMutex\`-protected L1 in-memory cache in front of a distributed L2 (Redis/Memcached) and a database L3. Because reads vastly outnumber writes, \`RWMutex\` lets concurrent readers proceed in parallel while writes, cache fills from lower tiers, acquire exclusive access only briefly. A \`singleflight.Group\` prevents thundering herd on cache misses by coalescing concurrent requests for the same key into a single backend fetch.

\`\`\`go
// Netflix's multi-tier cache pattern
type TieredCache struct {
    l1 *L1Cache  // In-memory, RWMutex protected
    l2 *L2Cache  // Redis/Memcached
    l3 DataStore // Database

    // Prevent thundering herd
    singleflight singleflight.Group
}

type L1Cache struct {
    mu    sync.RWMutex
    items map[string]cacheEntry

    // LRU tracking
    lru   *list.List
    index map[string]*list.Element
}

func (c *L1Cache) Get(key string) (any, bool) {
    c.mu.RLock()
    entry, ok := c.items[key]
    c.mu.RUnlock()

    if !ok {
        return nil, false
    }

    if time.Now().After(entry.expiresAt) {
        c.Delete(key)
        return nil, false
    }

    // Update LRU (requires write lock)
    c.mu.Lock()
    if elem, ok := c.index[key]; ok {
        c.lru.MoveToFront(elem)
    }
    c.mu.Unlock()

    return entry.value, true
}

func (tc *TieredCache) Get(ctx context.Context, key string) (any, error) {
    // L1: In-memory (fastest)
    if val, ok := tc.l1.Get(key); ok {
        return val, nil
    }

    // Deduplicate requests to L2/L3
    val, err, _ := tc.singleflight.Do(key, func() (any, error) {
        // L2: Distributed cache
        if val, err := tc.l2.Get(ctx, key); err == nil {
            tc.l1.Set(key, val, time.Minute)
            return val, nil
        }

        // L3: Database
        val, err := tc.l3.Get(ctx, key)
        if err != nil {
            return nil, err
        }

        // Populate caches
        tc.l2.Set(ctx, key, val, 5*time.Minute)
        tc.l1.Set(key, val, time.Minute)

        return val, nil
    })

    return val, err
}
\`\`\`

### Stripe: sync.Map for Request Deduplication

Idempotency keys are a textbook write-once, read-many workload: the key is created when the first request arrives and then checked, but never updated, on every retry. \`sync.Map\` is an ideal fit here because it avoids the overhead of a full \`RWMutex\` for this access pattern. Stripe's approach uses \`LoadOrStore\` to atomically claim ownership of an idempotency key, while duplicate requests wait on a \`done\` channel for the original handler to finish.

\`\`\`go
// Stripe's idempotency pattern
type IdempotencyStore struct {
    // sync.Map is perfect: keys written once, read many
    requests sync.Map

    // Cleanup old entries
    cleaner *time.Ticker
}

type IdempotencyEntry struct {
    Key       string
    Response  []byte
    Status    int
    CreatedAt time.Time
    mu        sync.Mutex
    done      chan struct{}
}

func (s *IdempotencyStore) GetOrCreate(key string) (*IdempotencyEntry, bool) {
    entry := &IdempotencyEntry{
        Key:       key,
        CreatedAt: time.Now(),
        done:      make(chan struct{}),
    }

    actual, loaded := s.requests.LoadOrStore(key, entry)
    return actual.(*IdempotencyEntry), loaded
}

func (s *IdempotencyStore) HandleRequest(
    ctx context.Context,
    key string,
    handler func() ([]byte, int, error),
) ([]byte, int, error) {
    entry, existed := s.GetOrCreate(key)

    if existed {
        // Wait for original request to complete
        select {
        case <-entry.done:
            return entry.Response, entry.Status, nil
        case <-ctx.Done():
            return nil, 0, ctx.Err()
        }
    }

    // Execute handler
    response, status, err := handler()

    if err == nil {
        entry.Response = response
        entry.Status = status
    }
    close(entry.done)

    // Schedule cleanup
    go func() {
        time.Sleep(24 * time.Hour)
        s.requests.Delete(key)
    }()

    return response, status, err
}
\`\`\`

### Staff Lens: Pattern Extraction From Case Studies

Each of these case studies shows a synchronization pattern at scale. The lesson is not the specific code but the shape: how each team chose between atomics, mutexes, and channels for their specific contention profile. Google's groupcache uses \`sync.RWMutex\` because its cache-read hot path genuinely has concurrent readers. CockroachDB uses atomics because its lock-free MVCC cannot afford mutex contention at transaction rate. Dropbox uses \`sync.Pool\` because its connection pool's per-request allocation matters at peak load. Each pattern fits its specific problem. Copying them without understanding the profile is cargo cult.

### Principal Lens: Your Service Is Probably Not Google Scale

Most Go services do not face the contention profiles that drove these case studies. A service at 10K RPS does not need CockroachDB's lock-free MVCC. A service at 100 RPS does not need Dropbox's connection pool optimisation. Principal engineers resist the urge to import "big company" synchronization patterns without matching scale. The correct primitive for most services is \`sync.Mutex\` around a \`map[K]V\`. Optimisation comes later, with profile evidence, and usually takes the form of simpler code (eliminate the shared state) rather than more sophisticated synchronization (atomics and lock-free structures).

---
`;
