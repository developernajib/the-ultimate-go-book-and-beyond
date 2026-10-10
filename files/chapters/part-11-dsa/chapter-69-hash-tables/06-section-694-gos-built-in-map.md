## 69.4 Go's Built-in Map

### Map Characteristics

Go's built-in map is a runtime-managed hash table. Since Go 1.24 it is a Swiss Tables design: slots live in groups of 8, each group fronted by a 64-bit control word, and large maps spread their contents across several independent tables selected by extendible hashing, so growth splits one table at a time instead of rehashing the whole map at once. Each map gets its own randomized hash seed to blunt hash-flooding attacks, and iteration order is deliberately randomized so programs cannot accidentally depend on it.

```go
package main

import (
    "fmt"
    "runtime"
)

// Go's map characteristics (Swiss Tables, Go 1.24+):
// 1. Open-addressed hash table, slots grouped 8 at a time
// 2. A 64-bit control word per group holds a 7-bit fingerprint per slot,
//    scanned with SWAR arithmetic (not vector SIMD instructions)
// 3. Every map gets its own random hash seed (security)
// 4. Grows one table at a time, so no single whole-map rehash
// 5. NOT concurrent-safe (use sync.Map or a mutex)
// 6. Iteration order is randomized

func MapDemo() {
    // Declaration
    var m1 map[string]int        // nil map (cannot write)
    m2 := map[string]int{}       // empty map (can write)
    m3 := make(map[string]int)   // empty map with default capacity
    m4 := make(map[string]int, 100) // map with capacity hint

    fmt.Println(m1 == nil) // true
    fmt.Println(m2 == nil) // false
    fmt.Println(m3 == nil) // false
    fmt.Println(m4 == nil) // false

    // Basic operations
    m := make(map[string]int)

    // Insert
    m["one"] = 1
    m["two"] = 2

    // Update
    m["one"] = 10

    // Lookup
    val, ok := m["one"]
    fmt.Printf("one: %d, exists: %v\n", val, ok)

    // Delete
    delete(m, "one")

    // Check existence
    if _, exists := m["one"]; !exists {
        fmt.Println("one does not exist")
    }

    // Iteration (order not guaranteed)
    for key, value := range m {
        fmt.Printf("%s: %d\n", key, value)
    }

    // Get keys
    keys := make([]string, 0, len(m))
    for k := range m {
        keys = append(keys, k)
    }

    // Memory usage
    var ms runtime.MemStats
    runtime.ReadMemStats(&ms)
    fmt.Printf("Alloc: %d bytes\n", ms.Alloc)
}

// MapGrowthDemo shows how Go maps grow
func MapGrowthDemo() {
    m := make(map[int]int)

    for i := 0; i < 100; i++ {
        m[i] = i
        // Growth splits one table at a time, so no single
        // whole-map rehash stalls an insertion.
    }
}
```

### Concurrent Map Access

Go's built-in map is not safe for concurrent use. A write racing with any other access is a data race, and the runtime carries a lightweight detector that usually catches it and aborts the process with `fatal error: concurrent map writes` rather than letting the table corrupt silently. That check is best-effort, not a guarantee, so treat it as a backstop rather than as protection. Three patterns address this: a `sync.RWMutex` wrapper for general workloads, `sync.Map` for read-heavy workloads with stable keys, and a sharded map that partitions keys across independent lock domains to reduce contention under high write throughput.

```go
package main

import (
    "sync"
)

// Wrong: Race condition
func WrongConcurrentMap() {
    m := make(map[int]int)

    // This causes race condition!
    go func() {
        for i := 0; i < 100; i++ {
            m[i] = i
        }
    }()

    go func() {
        for i := 0; i < 100; i++ {
            _ = m[i]
        }
    }()
}

// Solution 1: Use sync.Mutex
type SafeMap struct {
    mu sync.RWMutex
    m  map[string]int
}

func NewSafeMap() *SafeMap {
    return &SafeMap{
        m: make(map[string]int),
    }
}

func (sm *SafeMap) Get(key string) (int, bool) {
    sm.mu.RLock()
    defer sm.mu.RUnlock()
    val, ok := sm.m[key]
    return val, ok
}

func (sm *SafeMap) Set(key string, value int) {
    sm.mu.Lock()
    defer sm.mu.Unlock()
    sm.m[key] = value
}

func (sm *SafeMap) Delete(key string) {
    sm.mu.Lock()
    defer sm.mu.Unlock()
    delete(sm.m, key)
}

// Solution 2: Use sync.Map (better for specific patterns)
// - Stable keys with frequent reads
// - Disjoint key sets per goroutine
func SyncMapDemo() {
    var m sync.Map

    // Store
    m.Store("key", "value")

    // Load
    val, ok := m.Load("key")
    if ok {
        _ = val.(string)
    }

    // LoadOrStore (atomic get-or-set)
    actual, loaded := m.LoadOrStore("key2", "value2")
    _ = actual.(string)
    _ = loaded

    // Delete
    m.Delete("key")

    // Range
    m.Range(func(key, value any) bool {
        // Return true to continue, false to stop
        return true
    })

    // LoadAndDelete (Go 1.15+)
    val, loaded = m.LoadAndDelete("key2")
}

// Solution 3: Sharded map for high-concurrency
type ShardedMap struct {
    shards    []*shard
    numShards int
}

type shard struct {
    mu sync.RWMutex
    m  map[string]int
}

func NewShardedMap(numShards int) *ShardedMap {
    sm := &ShardedMap{
        shards:    make([]*shard, numShards),
        numShards: numShards,
    }
    for i := 0; i < numShards; i++ {
        sm.shards[i] = &shard{m: make(map[string]int)}
    }
    return sm
}

func (sm *ShardedMap) getShard(key string) *shard {
    hash := fnv32(key)
    return sm.shards[hash%uint32(sm.numShards)]
}

func fnv32(key string) uint32 {
    hash := uint32(2166136261)
    for i := 0; i < len(key); i++ {
        hash *= 16777619
        hash ^= uint32(key[i])
    }
    return hash
}

func (sm *ShardedMap) Get(key string) (int, bool) {
    shard := sm.getShard(key)
    shard.mu.RLock()
    defer shard.mu.RUnlock()
    val, ok := shard.m[key]
    return val, ok
}

func (sm *ShardedMap) Set(key string, value int) {
    shard := sm.getShard(key)
    shard.mu.Lock()
    defer shard.mu.Unlock()
    shard.m[key] = value
}
```

### Junior -> FAANG: Go Map Rules You Must Know Cold

Four rules that appear constantly in interviews and first-job code reviews:

1. A nil map panics on write but returns zero values on read. Always initialize with `make` or a literal before writing.
2. Map iteration order is randomized every run. Do not sort a map by iterating it and expecting the same order twice.
3. A concurrent map write trips a runtime check that aborts the process with `fatal error: concurrent map writes`. This is a throw, not a panic: `recover` cannot stop it, so no amount of defensive error handling saves you. Note that this is genuinely a data race, and `go test -race` does report it as `WARNING: DATA RACE` pointing at `mapassign`. The runtime check is only a best-effort backstop for builds without the race detector. Use a mutex or `sync.Map`.
4. `delete(m, key)` is safe to call on a key that does not exist. It is a no-op, not an error.

The `make(map[K]V, n)` hint is important for performance-sensitive code: without it, the map starts small and reallocates multiple times as you insert. With it, the map pre-allocates enough buckets for n entries, eliminating reallocation. This matters when you know the size in advance (reading a file with a known number of records, building an index from a slice).

### Senior @ FAANG: Concurrent Map Strategy Selection

The three concurrency strategies shown (mutex wrapper, `sync.Map`, sharded map) have distinct performance profiles that must be understood before choosing one in a production service.

`sync.Map` was rewritten in Go 1.24 and is now backed by a concurrent hash-trie (`internal/sync.HashTrieMap`). Descriptions you will still find in older articles, which speak of a read-only snapshot map plus a dirty map and a promotion step once misses accumulate, describe the pre-1.24 implementation and no longer apply. The trie tuned away the pathology that made the old design fall over: writes now mutate a node of the trie under a fine-grained lock instead of forcing a whole-map promotion, so write-heavy and churning-key workloads degrade far more gracefully than they used to.

What did not change is the advice. `sync.Map` is still tuned for frequent loads, and it still costs more per operation than a plain map because every value moves through an `any` interface, which means boxing and an extra indirection. It remains a poor default. Reach for it when reads dominate or when goroutines touch disjoint key sets, and benchmark your actual access pattern rather than assuming, because `map` plus `sync.RWMutex` wins more often than people expect. The one thing worth un-learning is the old folk rule that `sync.Map` collapses when keys churn, since that was an artifact of the promotion mechanism the rewrite deleted.

The sharded map is the idiomatic choice for high-write workloads. Each shard is an independent `map+mutex`, so writers that land on different shards proceed in parallel and contention falls roughly in proportion to the shard count. The important caveat is that this only holds when keys spread evenly. A single hot key still serializes every writer onto one mutex no matter how many shards you configure, so sharding fixes contention, not skew. Pick a power of two for the shard count so selection can use a bit mask instead of the modulo shown above. The FNV-1a hash for shard selection must be an ordinary deterministic hash rather than Go's per-map randomized one, because a key must resolve to the same shard for the lifetime of the process.

A staff-level concern: the sharded map above does not expose an atomic `LoadOrStore` operation. Callers cannot build one correctly on top of `Get` and `Set`, because another goroutine can insert between the two calls. The operation has to live inside the shard lock, and documenting its absence in the interface contract matters as much as implementing the operations that are present. This is the kind of gap that escapes unit tests and surfaces under production load.
