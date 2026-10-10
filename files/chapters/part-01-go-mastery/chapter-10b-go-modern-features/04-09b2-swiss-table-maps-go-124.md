## 10B.2 Swiss Table Maps (Go 1.24)

### What Changed

Go 1.24 replaced the traditional chaining hash map implementation with Swiss Tables, a flat open-addressing design using SWAR-accelerated metadata probing (SIMD-within-a-register, comparing all bytes of a control word with ordinary 64-bit arithmetic).

**Old (pre-1.24):**
```
Hash Table with chaining:
bucket[0] → [key0, val0] → [key3, val3] → nil  (collision chain)
bucket[1] → [key1, val1] → nil
bucket[2] → nil
bucket[3] → [key2, val2] → nil

Load factor: 81.25% growth trigger (6.5/8 average per bucket)
Lookup: compute hash, walk chain (pointer chasing = cache miss per node)
```

**New (Go 1.24 Swiss Table):**
```
Swiss Table: groups of 8 slots:
metadata: [h2_0, h2_1, h2_2, h2_3, h2_4, h2_5, h2_6, h2_7]  (1 byte per slot)
data:     [slot0, slot1, slot2, slot3, slot4, slot5, slot6, slot7]

metadata byte = lower 7 bits of hash (h2), or EMPTY/DELETED sentinel
SWAR probe: compare all 8 h2 bytes at once with 64-bit word operations
Load factor: 87.5% (7/8 slots filled before resize)
```

### Why Swiss Tables Are Faster

Swiss tables improve lookup performance by using one-byte metadata groups that enable byte-parallel slot scanning, checking a whole group per probe step instead of chasing overflow-bucket pointers as the old chained design did.

```go
// Benchmarking map operations to see Swiss Table improvement
func BenchmarkMapGet(b *testing.B) {
    m := make(map[string]int, 10000)
    keys := make([]string, 10000)
    for i := 0; i < 10000; i++ {
        k := fmt.Sprintf("key-%d", i)
        m[k] = i
        keys[i] = k
    }

    b.ResetTimer()
    b.RunParallel(func(pb *testing.PB) {
        i := 0
        for pb.Next() {
            _ = m[keys[i%10000]]
            i++
        }
    })
}

// Illustrative expectations (microbenchmarks, vary by workload and CPU):
// - Lookup throughput: noticeably faster, biggest wins on large maps
//   that no longer chase overflow buckets
// - Memory: lower overhead from the higher load factor (87.5% vs 81.25%)
//   and the elimination of overflow buckets
// - Iteration: faster due to better memory locality
```

### Fleet-Scale Impact: Small Overhead, Multiplied by Millions

Consider a metrics pipeline that processes data from millions of hosts, with each metric carrying 10-20 tags stored as `map[string]string`. At that scale, even small per-map overhead differences compound into very large fleet-wide memory totals. Upgrading to Go 1.24 required no code changes, the runtime swap was transparent.

```go
// Representative use case: tag cardinality maps
// A pipeline maintains maps like: map[string]string for metric tags
// With millions of active metrics, each having 10-20 tags
// Memory savings = (old_overhead - new_overhead) * num_metrics

// Before Go 1.24:
// - Buckets grow at 81.25% average load, with overflow buckets on top
// - Each bucket: 8 tophash bytes plus an overflow pointer of overhead

// After Go 1.24 Swiss Tables:
// - Load factor 87.5% → only 12.5% of slots empty at the growth point
// - No overflow buckets: flat layout
// - With hundreds of millions of map entries fleet-wide, the per-entry
//   savings add up to a real hardware difference
```

### When Map Performance Matters

Map performance becomes a bottleneck in lookup-intensive hot loops such as routing tables and cache lookups. The following benchmarks identify which patterns benefit most from Swiss tables.

```go
// Hot path identification: use pprof to find map hot spots
func profileMapOperations() {
    // Enable CPU profiling
    f, _ := os.Create("cpu.prof")
    pprof.StartCPUProfile(f)
    defer pprof.StopCPUProfile()

    // Your hot code here
}

// Alternative: use sync.Map for concurrent read-heavy workloads
var cache sync.Map

// Alternative: use pre-sized maps to avoid rehashing
m := make(map[string]int, expectedSize) // Hint prevents rehashing during fill

// Alternative: avoid map allocations in hot paths via object pool
var mapPool = sync.Pool{
    New: func() any {
        return make(map[string]int, 64)
    },
}

func processRequest(tags map[string]string) {
    m := mapPool.Get().(map[string]int)
    defer func() {
        // Clear and return to pool
        for k := range m {
            delete(m, k)
        }
        mapPool.Put(m)
    }()
    // ... use m
}
```

### Generic Type Aliases (Go 1.24)

Go 1.24 added support for generic type aliases, allowing an alias to carry type parameters. Before this change, a type alias could refer to a concrete instantiation like `map[string]int` but could not itself be parameterized. Now you can write `type StringMap[V any] = map[string]V` and use it anywhere the underlying type is accepted, with zero runtime cost, the alias is erased at compile time.

```go
// Go 1.24 allows generic type aliases
// Previously: type aliases couldn't have type parameters

// Old way (pre-1.24):
type StringIntMap = map[string]int  // Works but no type parameters

// New way (Go 1.24+):
type OrderedMap[K cmp.Ordered, V any] = btree.Map[K, V]
type StringMap[V any] = map[string]V

// Usage:
var m StringMap[int]       // same as map[string]int
var tree OrderedMap[string, User]

// Practical use: type-safe aliases for complex generic types
type Result[T any] = tuple.Pair[T, error]
type Future[T any] = chan Result[T]
```
