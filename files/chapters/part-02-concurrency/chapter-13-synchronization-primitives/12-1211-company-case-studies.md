## 13.11 Company Case Studies

A note on how to read this section. The first case study is drawn from code you can open and read yourself, and the file references are given so you can. The remaining three are composite patterns, reconstructed from the shape of problems that recur at scale rather than lifted from any particular company's private source. They are labelled as patterns, not as any specific company's implementation, because attributing a specific line of code to a specific company you cannot verify teaches you to trust the logo instead of the reasoning. The reasoning is the transferable part.

### The Go Standard Library: sync.Pool in Practice

The standard library is the best available proof that `sync.Pool` delivers real allocation savings, and it has the advantage of being readable. Both `encoding/json` and `fmt` pool their internal encoder and printer state so that high-frequency calls avoid the allocator on every invocation. See `encoding/json/encode.go` (`encodeStatePool`, `newEncodeState`) and `fmt/print.go` (`ppFree`, `newPrinter`, `free`). The pattern is always the same: get from pool, reset, use, put back.

Note the detail in `newEncodeState` below. It calls `Get()` and checks for `nil` rather than supplying a `New` function, because it needs to `Reset` a recycled state but not a freshly allocated one. Note also that `marshal` resets on the way *out*, not only on the way in. Resetting before `Put` means the pooled object is not holding a reference to the last request's data while it sits in the pool, which matters both for memory footprint and for not keeping a caller's bytes reachable longer than necessary.

```go
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
```

### Pattern: Atomic Configuration at Scale

Configuration is the purest read-mostly workload a service has. Every request reads it, and an operator changes it maybe twice a week. Put a mutex on that path and you have added a contention point to literally every request in order to protect data that almost never changes. Store it behind an `atomic.Pointer` and every request reads it with a single atomic load: no lock, no contention, no possibility of a slow config reload blocking traffic. Updates swap in a new immutable struct and notify subscribers.

```go
// Read-mostly configuration behind an atomic pointer
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
    // Swap, not Store: we want the previous value for the change log,
    // and Swap gets it atomically. Load-then-Store would race with a
    // concurrent Update and could log a transition that never happened.
    old := cm.current.Swap(cfg)

    // Snapshot the subscriber list under the lock, then release it before
    // spawning. Never call unknown callbacks while holding a lock.
    cm.mu.RLock()
    subs := make([]func(*ServiceConfig), len(cm.subscribers))
    copy(subs, cm.subscribers)
    cm.mu.RUnlock()

    for _, sub := range subs {
        go func(sub func(*ServiceConfig)) {
            // A subscriber is third-party code. An unrecovered panic in a
            // goroutine takes down the whole process, so a bad config
            // callback would turn a routine config push into an outage.
            // Recover at the goroutine boundary.
            defer func() {
                if r := recover(); r != nil {
                    logSubscriberPanic(r)
                }
            }()
            sub(cfg)
        }(sub)
    }

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
```

### Pattern: RWMutex for Tiered Cache Layers

A tiered cache places an `RWMutex`-protected L1 in-memory cache in front of a distributed L2 (Redis or Memcached) and a database L3. Because reads vastly outnumber writes, `RWMutex` lets concurrent readers proceed in parallel while cache fills from lower tiers acquire exclusive access only briefly. A `singleflight.Group` prevents a thundering herd on cache misses by coalescing concurrent requests for the same key into a single backend fetch.

That is the theory, and the code below is where the theory usually dies. Read `L1Cache.Get` and find the write lock before continuing.

```go
// Multi-tier cache pattern
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

// BROKEN: this Get takes a write lock on every cache hit.
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
```

**The LRU update defeats the RWMutex.** Every cache hit takes `c.mu.Lock()` to move the entry to the front of the LRU list. A write lock excludes every other reader and writer, so on the hit path, which is the overwhelming majority of traffic in a working cache, this `RWMutex` behaves exactly like a `Mutex` with extra steps. The prose says readers proceed in parallel. The code says they do not. Every reader is a writer.

This is the single most common way `RWMutex` gets neutered in real code, and it is easy to miss in review because the write lock is justified in isolation: the LRU list genuinely is shared mutable state and genuinely does need exclusion. The bug is not the lock, it is that recency tracking made the read path a write path.

The ways out, roughly in order of how often they are the right answer:

- **Drop strict LRU.** Track recency approximately with an atomic timestamp on the entry, exactly as `KeyedLimiter` does, and let eviction sample rather than maintain a perfectly ordered list. Most caches do not need true LRU, they need "probably evict something cold". This keeps the hit path on `RLock`.
- **Use a cache library.** `hashicorp/golang-lru` and `dgraph-io/ristretto` have solved this. Ristretto in particular batches access records through a ring buffer specifically so the read path does not need exclusion.
- **Shard the cache.** Partition by key hash so a write lock on one shard blocks only that shard's readers. This narrows contention rather than removing it.
- **Keep strict LRU and accept a plain `Mutex`.** If you truly need exact LRU ordering, be honest and use `sync.Mutex`. You are paying for exclusion on every operation regardless, so at least pay less per operation and stop misleading the next reader with an `RWMutex` that never shares.

The general rule this illustrates: **an `RWMutex` is only an `RWMutex` if the read path never takes the write lock.** Before accepting one in review, find every `RLock` and check what happens after the `RUnlock`. If a `Lock` follows on the common path, the type is decoration.

### Pattern: sync.Map for Request Deduplication

Idempotency keys are a textbook write-once, read-many workload: the key is created when the first request arrives and then checked, but never updated, on every retry. `sync.Map`'s first documented use case is exactly this. The pattern uses `LoadOrStore` to atomically claim ownership of an idempotency key, while duplicate requests wait on a `done` channel for the original handler to finish.

`LoadOrStore` is the load-bearing call. It is what makes claiming a key atomic: exactly one concurrent caller gets `loaded == false` and becomes the owner that runs the handler, and everyone else gets `loaded == true` and waits. A `Load` followed by a `Store` would be a check-then-act race, and two requests would both execute a payment.

```go
// Idempotent request handling
type IdempotencyStore struct {
    // sync.Map fits: keys written once, read many
    requests sync.Map

    ttl  time.Duration
    stop chan struct{}
}

func NewIdempotencyStore(ttl time.Duration) *IdempotencyStore {
    s := &IdempotencyStore{ttl: ttl, stop: make(chan struct{})}
    go s.cleanupLoop()
    return s
}

type IdempotencyEntry struct {
    Key       string
    CreatedAt time.Time

    // Written by the owning goroutine before close(done), read by waiters
    // only after <-done returns. close/receive is the happens-before edge,
    // so no mutex is needed and none should be added.
    Response []byte
    Status   int
    Err      error

    done chan struct{}
}

func (s *IdempotencyStore) GetOrCreate(key string) (*IdempotencyEntry, bool) {
    entry := &IdempotencyEntry{
        Key:       key,
        CreatedAt: time.Now(),
        done:      make(chan struct{}),
    }

    // Exactly one caller gets loaded == false and owns execution.
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
        // Wait for the original request to complete
        select {
        case <-entry.done:
            // Propagate the original outcome, including failure.
            return entry.Response, entry.Status, entry.Err
        case <-ctx.Done():
            return nil, 0, ctx.Err()
        }
    }

    // We own this key. Whatever happens, publish an outcome and unblock
    // waiters exactly once, or every duplicate request hangs until its
    // own context expires.
    var (
        response []byte
        status   int
        err      error
    )
    func() {
        defer func() {
            if r := recover(); r != nil {
                // A panicking handler must not leave waiters blocked
                // forever on a done channel that never closes.
                err = fmt.Errorf("handler panicked: %v", r)
            }
        }()
        response, status, err = handler()
    }()

    entry.Response = response
    entry.Status = status
    entry.Err = err
    close(entry.done)

    // A failed attempt must not be cached as the permanent answer.
    // Drop the key so the client's retry can actually retry.
    if err != nil {
        s.requests.Delete(key)
    }

    return response, status, err
}

func (s *IdempotencyStore) cleanupLoop() {
    ticker := time.NewTicker(time.Hour)
    defer ticker.Stop()
    for {
        select {
        case <-s.stop:
            return
        case <-ticker.C:
            cutoff := time.Now().Add(-s.ttl)
            s.requests.Range(func(k, v any) bool {
                if e := v.(*IdempotencyEntry); e.CreatedAt.Before(cutoff) {
                    s.requests.Delete(k)
                }
                return true
            })
        }
    }
}

func (s *IdempotencyStore) Close() { close(s.stop) }
```

Four things were wrong with the naive version of this, and each one is the kind of bug that only shows up in production.

**Errors were silently converted into successes.** The original only assigned `Response` and `Status` when `err == nil`, then closed `done` unconditionally and returned the error to its own caller. Every *waiter*, though, returned `entry.Response, entry.Status, nil`: a zero-length body, status 0, and a nil error. The first caller correctly saw a failed payment. Concurrent duplicates saw a successful one. Carrying `Err` on the entry and returning it is what makes duplicates agree with the original.

**A failed attempt poisoned the key forever.** The entry stayed in the map with its `done` channel closed, so every future retry of that idempotency key instantly "succeeded" with an empty response, forever. Idempotency means a retry returns the original *outcome*, not that a transient failure becomes a permanent fabricated success. Deleting the key on error is what makes the client's retry meaningful.

**A panicking handler hung every duplicate.** With no recover, a panic in `handler()` unwinds past `close(entry.done)`, so the channel never closes and every waiter blocks until its own context expires. The panic also takes down the process, but if anything recovers higher up, you are left with a key that blocks forever. Publishing an outcome must be unconditional.

**Cleanup spawned a goroutine per request.** `go func() { time.Sleep(24 * time.Hour); ... }()` means a service at even modest request rates carries millions of goroutines whose entire purpose is to sleep for a day, each pinning its key and its stack. One janitor goroutine scanning with `Range` on a ticker does the same job at constant cost. The original struct even declared a `cleaner *time.Ticker` field for exactly this and then never used it.

### Staff Lens: Pattern Extraction From Case Studies

Each case study shows a synchronization choice driven by a contention profile. The lesson is never the specific code, it is the reasoning that selected the primitive:

- **Pooling** pays when a hot path allocates a non-trivial object per call and immediately discards it. The standard library pools encoder state because `json.Marshal` is called constantly and the state is pure scratch space. That is a *measured* property of that path, not a general rule about pooling.
- **Atomics** pay when the data is read on every request and written almost never, and the whole value can be swapped at once. Config is the archetype.
- **RWMutex** pays when reads genuinely run concurrently, which requires that the read path never takes the write lock. The tiered cache above is a case study in getting this wrong.
- **`sync.Map`** pays for write-once-read-many keys, which is why idempotency keys fit and a general mutable map does not.

Notice that three of the four are the same question: what is the actual read/write ratio, and how long is the critical section? Copying a pattern without answering that question for your own workload is cargo cult, and the tiered cache shows that you can copy the right primitive and still get the wrong result.

### Principal Lens: Your Service Is Probably Not At That Scale

Most Go services never face the contention profiles that motivate these patterns. A service handling a few thousand requests per second on a mutex-protected map is not going to be rescued by lock-free MVCC, and the engineer who proposes it is usually optimizing for their own interest rather than the system's bottleneck.

Resist importing "big company" synchronization patterns without a matching profile. The correct primitive for most services is a `sync.Mutex` around a `map[K]V`, and it will stay correct for far longer than anyone expects. When optimization does become necessary, let profile evidence choose the target, and prefer the change that removes shared state entirely over the one that synchronizes it more cleverly. Sophisticated synchronization is a cost you pay on every future read of that code, forever, by every engineer who touches it. Spend it deliberately.

---
