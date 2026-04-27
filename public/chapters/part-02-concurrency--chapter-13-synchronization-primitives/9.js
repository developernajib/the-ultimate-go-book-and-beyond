export default `## 13.8 Map: Concurrent Map

\`sync.Map\` is a concurrent map optimized for specific use cases.

### Basic Usage

\`sync.Map\` is optimized for two workloads: entries that are written once and read many times, and concurrent goroutines operating on disjoint sets of keys. For general-purpose maps with mixed read/write patterns, a \`map\` protected by a \`sync.RWMutex\` typically performs better. The Go 1.20+ \`CompareAndSwap\` method enables lock-free conditional updates on individual entries.

\`\`\`go
var cache sync.Map

func main() {
    // Store
    cache.Store("key1", "value1")
    cache.Store("key2", 42)

    // Load
    value, ok := cache.Load("key1")
    if ok {
        fmt.Println(value.(string))
    }

    // LoadOrStore: Load if exists, store if not
    actual, loaded := cache.LoadOrStore("key3", "default")
    fmt.Printf("Value: %v, Was loaded: %v\\n", actual, loaded)

    // LoadAndDelete: Get and remove atomically
    value, loaded = cache.LoadAndDelete("key1")

    // Delete
    cache.Delete("key2")

    // Range: Iterate (not atomic across all keys!)
    cache.Range(func(key, value any) bool {
        fmt.Printf("%v: %v\\n", key, value)
        return true  // Continue iteration
    })

    // CompareAndSwap (Go 1.20+)
    cache.Store("counter", 0)
    cache.CompareAndSwap("counter", 0, 1)

    // CompareAndDelete (Go 1.20+)
    cache.CompareAndDelete("counter", 1)

    // Swap (Go 1.20+)
    old, loaded := cache.Swap("key", "new-value")
}
\`\`\`

### When to Use sync.Map

Understanding \`sync.Map\`'s performance model helps avoid accidentally using it where a plain map with a \`sync.RWMutex\` would be faster. Its internal design uses separate "read" and "dirty" maps plus atomic pointer swaps, which excels at high-read, low-write workloads but adds overhead when entries are updated frequently. The \`GetOrCompute\` helper below illustrates the canonical write-once lazy-initialization pattern, while the \`FrequentUpdates\` struct shows the mutex alternative that should be preferred when keys change often.

\`\`\`go
/*
sync.Map is optimized for two specific patterns:

1. Write-once, read-many: Keys are written once but read many times
   Example: Caching expensive computations

2. Disjoint key sets: Different goroutines access disjoint keys
   Example: Per-connection state

For other patterns, use map + sync.RWMutex!
*/

// Good use case: Lazy computation cache
type ComputeCache struct {
    cache sync.Map
}

func (c *ComputeCache) GetOrCompute(key string, compute func() any) any {
    // Fast path: already computed
    if value, ok := c.cache.Load(key); ok {
        return value
    }

    // Slow path: compute and store
    value := compute()
    actual, _ := c.cache.LoadOrStore(key, value)
    return actual
}

// Bad use case: Frequent updates
// Use map + mutex instead!
type FrequentUpdates struct {
    mu   sync.RWMutex
    data map[string]int
}
\`\`\`

### Type-Safe Wrapper

Because \`sync.Map\` stores values as \`any\`, every retrieval requires a type assertion that can panic if the wrong type is stored under a key. Wrapping it in a generic struct with type parameters for the key and value eliminates those scattered assertions and catches type mismatches at compile time. The \`SyncMap[K, V]\` implementation below delegates to \`sync.Map\` internally while presenting a fully typed API that mirrors the standard method set.

\`\`\`go
// Generic type-safe wrapper for sync.Map
type SyncMap[K comparable, V any] struct {
    m sync.Map
}

func (sm *SyncMap[K, V]) Load(key K) (V, bool) {
    value, ok := sm.m.Load(key)
    if !ok {
        var zero V
        return zero, false
    }
    return value.(V), true
}

func (sm *SyncMap[K, V]) Store(key K, value V) {
    sm.m.Store(key, value)
}

func (sm *SyncMap[K, V]) Delete(key K) {
    sm.m.Delete(key)
}

func (sm *SyncMap[K, V]) LoadOrStore(key K, value V) (V, bool) {
    actual, loaded := sm.m.LoadOrStore(key, value)
    return actual.(V), loaded
}

func (sm *SyncMap[K, V]) Range(f func(key K, value V) bool) {
    sm.m.Range(func(k, v any) bool {
        return f(k.(K), v.(V))
    })
}

// Usage
func main() {
    var userCache SyncMap[int64, *User]

    userCache.Store(123, &User{Name: "Alice"})

    user, ok := userCache.Load(123)
    if ok {
        fmt.Println(user.Name)
    }
}
\`\`\`

### Performance Comparison

Benchmarking both approaches under a read-heavy, stable-key workload makes the performance gap concrete and guides the right choice for a given access pattern. \`b.RunParallel\` simulates realistic concurrent readers so the numbers reflect contention behaviour rather than single-threaded throughput. The results embedded in the comments show \`sync.Map\` achieving roughly 3× lower latency per read than an \`RWMutex\`-protected map in this specific scenario.

\`\`\`go
func BenchmarkMapMutex(b *testing.B) {
    var mu sync.RWMutex
    m := make(map[string]int)
    m["key"] = 42

    b.RunParallel(func(pb *testing.PB) {
        for pb.Next() {
            mu.RLock()
            _ = m["key"]
            mu.RUnlock()
        }
    })
}

func BenchmarkSyncMap(b *testing.B) {
    var m sync.Map
    m.Store("key", 42)

    b.RunParallel(func(pb *testing.PB) {
        for pb.Next() {
            m.Load("key")
        }
    })
}

/*
Results (read-heavy, same key):
BenchmarkMapMutex-8     50000000    35 ns/op
BenchmarkSyncMap-8      100000000   12 ns/op

sync.Map wins for stable, read-heavy workloads!
*/
\`\`\`

### When sync.Map Loses

\`sync.Map\` is optimised for two access patterns:

1. Each key is written once and read many times (read-mostly).
2. Keys are written by one goroutine and read by many others with disjoint keys (no contention on individual keys).

Outside these patterns, \`sync.Map\` is slower than a plain \`map[K]V\` protected by \`sync.RWMutex\` or \`sync.Mutex\`. The overhead of its internal atomic operations and type-assertion machinery dominates the per-operation cost.

The review rule: default to \`map[K]V\` with a mutex. Switch to \`sync.Map\` only when profile evidence shows the access pattern fits. "My workload reads a lot" is not enough; benchmark with the real distribution.

### Generic Wrapper Over map[K]V

Writing a generic \`SyncMap[K, V]\` with \`sync.RWMutex\` takes 30 lines and is often faster than \`sync.Map\` for balanced workloads. It also has a cleaner API (no type assertions).

\`\`\`go
type SyncMap[K comparable, V any] struct {
    mu sync.RWMutex
    m  map[K]V
}
func (s *SyncMap[K, V]) Get(k K) (V, bool) { ... }
func (s *SyncMap[K, V]) Set(k K, v V) { ... }
\`\`\`

For most use cases, this is the right primitive. Teach it alongside \`sync.Map\` and let engineers pick based on benchmark evidence.

### Staff Lens: sync.Map Is a Specialised Tool

A codebase littered with \`sync.Map\` is a codebase that read "use sync.Map for concurrent access" and stopped there. The staff-level review: flag \`sync.Map\` usage that does not match its intended pattern. Usually the fix is a generic \`map[K]V\` with a mutex, which is simpler, faster, and more type-safe. \`sync.Map\` has a narrow win zone and is overused far outside it.

---
`;
