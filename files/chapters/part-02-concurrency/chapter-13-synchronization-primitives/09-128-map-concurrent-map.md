## 13.8 Map: Concurrent Map

`sync.Map` is a concurrent map optimized for specific use cases.

### Basic Usage

`sync.Map` is optimized for two workloads: entries that are written once and read many times, and concurrent goroutines operating on disjoint sets of keys. For general-purpose maps with mixed read/write patterns, a `map` protected by a `sync.RWMutex` typically performs better. The Go 1.20+ `CompareAndSwap` method enables lock-free conditional updates on individual entries.

```go
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
    fmt.Printf("Value: %v, Was loaded: %v\n", actual, loaded)

    // LoadAndDelete: Get and remove atomically
    value, loaded = cache.LoadAndDelete("key1")

    // Delete
    cache.Delete("key2")

    // Range: Iterate (not atomic across all keys!)
    cache.Range(func(key, value any) bool {
        fmt.Printf("%v: %v\n", key, value)
        return true  // Continue iteration
    })

    // CompareAndSwap (Go 1.20+)
    cache.Store("counter", 0)
    cache.CompareAndSwap("counter", 0, 1)

    // CompareAndDelete (Go 1.20+)
    cache.CompareAndDelete("counter", 1)

    // Swap (Go 1.20+)
    old, hadPrevious := cache.Swap("key", "new-value")
    fmt.Printf("Swapped out %v (existed: %v)\n", old, hadPrevious)
}
```

One caveat on `CompareAndSwap` and `CompareAndDelete`: they compare with `==`, so the stored values must be comparable. Storing a slice, a map, or a func and then calling `CompareAndSwap` on that key panics at runtime rather than failing at compile time, because the value's static type is `any`.

### When to Use sync.Map

Understanding `sync.Map`'s performance model helps avoid using it where a plain map with a `sync.RWMutex` would serve better.

Be careful with what you may have read about its internals. For most of `sync.Map`'s life it was built from a read-only "read" map plus a "dirty" map, with atomic pointer swaps promoting one to the other. Go 1.24 replaced that implementation with a concurrent hash-trie. Most older blog posts, and any explanation that leans on the read/dirty promotion cycle to justify a recommendation, are describing a data structure the runtime no longer uses. The `GetOrCompute` helper below illustrates the canonical write-once lazy-initialization pattern, while the `FrequentUpdates` struct shows the mutex alternative.

The documented guidance survived the rewrite unchanged, and it is worth quoting exactly, because the reason it gives is not the one most people repeat: "The Map type is specialized. Most code should use a plain Go map instead, with separate locking or coordination, for better type safety and to make it easier to maintain other invariants along with the map content."

Type safety and invariants. Not speed. That distinction matters more after 1.24 than before it, and the benchmarks later in this section show why.

```go
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
```

### Type-Safe Wrapper

Because `sync.Map` stores values as `any`, every retrieval requires a type assertion that can panic if the wrong type is stored under a key. Wrapping it in a generic struct with type parameters for the key and value eliminates those scattered assertions and catches type mismatches at compile time. The `SyncMap[K, V]` implementation below delegates to `sync.Map` internally while presenting a fully typed API that mirrors the standard method set.

```go
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
func demo() {
    var userCache SyncMap[int64, *User]

    userCache.Store(123, &User{Name: "Alice"})

    user, ok := userCache.Load(123)
    if ok {
        fmt.Println(user.Name)
    }
}
```

The wrapper narrows the assertion to one place, but be clear about what it does not do. `value.(V)` still asserts at runtime. If some other code path stores a different type under the same key through the embedded `sync.Map`, the assertion panics inside the wrapper instead of at the call site. The type parameter constrains the wrapper's API, not the underlying storage.

### Performance Comparison

Benchmarking both approaches makes the trade-off concrete. `b.RunParallel` simulates concurrent access so the numbers reflect contention behavior rather than single-threaded throughput. The read benchmark uses one hot key, and the write benchmark hammers a thousand keys from every core.

```go
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

func BenchmarkMapMutexWrite(b *testing.B) {
    var mu sync.Mutex
    m := make(map[int]int)

    b.RunParallel(func(pb *testing.PB) {
        i := 0
        for pb.Next() {
            mu.Lock()
            m[i%1000] = i
            mu.Unlock()
            i++
        }
    })
}

func BenchmarkSyncMapWrite(b *testing.B) {
    var m sync.Map

    b.RunParallel(func(pb *testing.PB) {
        i := 0
        for pb.Next() {
            m.Store(i%1000, i)
            i++
        }
    })
}
```

Measured on an 8-core laptop CPU with a Go 1.26 toolchain:

```
BenchmarkMapMutex-8        	22082055	        27.14 ns/op
BenchmarkSyncMap-8         	142170391	         4.243 ns/op
BenchmarkMapMutexWrite-8   	 8812207	        64.80 ns/op
BenchmarkSyncMapWrite-8    	15071286	        40.56 ns/op
```

`sync.Map` wins the read benchmark by roughly 6x, which is unsurprising: a `Load` on a hot key touches no shared writable cache line, while `RLock` does an atomic read-modify-write that eight cores fight over.

The write benchmark is the interesting one, and it is where you should be suspicious of received wisdom. `sync.Map` also wins it, by about 1.6x. That contradicts the folklore that `sync.Map` collapses on write-heavy workloads. Two things are going on. First, the comparison is against a *single global mutex*, so every write in the mutex version serializes against every other write across all thousand keys, while `sync.Map` only contends on writes to the same key. Second, the Go 1.24 hash-trie rewrite improved the write path substantially over the old read/dirty design that the folklore was formed around.

Do not take the reverse lesson and start using `sync.Map` everywhere. Take the actual lesson: **the benchmark you inherit is measuring a specific shape, and that shape may not be yours.** A sharded `map[K]V` would change these results again. So would a workload where writes concentrate on a few hot keys, or where values are large, or where you need to read two keys as one consistent snapshot.

### When sync.Map Loses

`sync.Map` is optimized for two access patterns, stated in its own documentation:

1. The entry for a given key is only ever written once but read many times, as in caches that only grow.
2. Multiple goroutines read, write, and overwrite entries for disjoint sets of keys.

The strongest reasons to reach for a plain map with a mutex are not usually about speed:

- **Type safety.** `sync.Map` is `map[any]any`. Every read is a runtime assertion. A plain `map[string]*User` makes wrong types a compile error.
- **Invariants spanning more than one key.** This is the decisive one. A mutex protects *a critical section*, so you can update three keys and a counter as one atomic step, or read a consistent snapshot across keys. `sync.Map` gives you atomicity per operation and nothing wider. There is no way to make two `Store` calls atomic with respect to a concurrent `Range`.
- **`Range` is not a snapshot.** It reflects an arbitrary interleaving of concurrent writes. A key added during iteration may or may not be visited. `Len` does not exist at all, and counting via `Range` gives you a number that was never simultaneously true.

The review rule: default to `map[K]V` with a mutex, because it is type-safe and can hold invariants. Switch to `sync.Map` when the access pattern matches one of the two documented cases and a benchmark of *your* workload shows it helps. "My workload reads a lot" is not enough.

### Generic Wrapper Over map[K]V

Writing a generic map wrapper around `sync.RWMutex` takes a couple of dozen lines, gives you real compile-time type safety rather than a runtime assertion, and lets you extend it with operations that hold an invariant across several keys. Call it `MutexMap` to keep it distinct from the `SyncMap` wrapper shown earlier, which wraps `sync.Map`.

```go
type MutexMap[K comparable, V any] struct {
    mu sync.RWMutex
    m  map[K]V
}

func NewMutexMap[K comparable, V any]() *MutexMap[K, V] {
    return &MutexMap[K, V]{m: make(map[K]V)}
}

func (s *MutexMap[K, V]) Get(k K) (V, bool) {
    s.mu.RLock()
    defer s.mu.RUnlock()
    v, ok := s.m[k]
    return v, ok
}

func (s *MutexMap[K, V]) Set(k K, v V) {
    s.mu.Lock()
    defer s.mu.Unlock()
    s.m[k] = v
}

func (s *MutexMap[K, V]) Len() int {
    s.mu.RLock()
    defer s.mu.RUnlock()
    return len(s.m)
}

// The operation sync.Map cannot express: several keys, one atomic step.
func (s *MutexMap[K, V]) SetMany(entries map[K]V) {
    s.mu.Lock()
    defer s.mu.Unlock()
    for k, v := range entries {
        s.m[k] = v
    }
}
```

`Len` and `SetMany` are the point. Neither has a `sync.Map` equivalent, and no amount of wrapping produces one. For most use cases this is the right primitive. Teach it alongside `sync.Map` and let engineers pick based on benchmark evidence and on whether they need invariants wider than a single key.

### Staff Lens: sync.Map Is a Specialised Tool

A codebase littered with `sync.Map` is a codebase that read "use sync.Map for concurrent access" and stopped there. The staff-level review: flag `sync.Map` usage that does not match its intended pattern. Usually the fix is a generic `map[K]V` with a mutex, which is simpler, faster, and more type-safe. `sync.Map` has a narrow win zone and is overused far outside it.

---
