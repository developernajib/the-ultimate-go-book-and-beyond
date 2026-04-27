export default `## 10B.2 Swiss Table Maps (Go 1.24)

### What Changed

Go 1.24 replaced the traditional chaining hash map implementation with Swiss Tables, a flat open-addressing design using SIMD-accelerated metadata probing.

**Old (pre-1.24):**
\`\`\`
Hash Table with chaining:
bucket[0] → [key0, val0] → [key3, val3] → nil  (collision chain)
bucket[1] → [key1, val1] → nil
bucket[2] → nil
bucket[3] → [key2, val2] → nil

Load factor: ~65%
Lookup: compute hash, walk chain (pointer chasing = cache miss per node)
\`\`\`

**New (Go 1.24 Swiss Table):**
\`\`\`
Swiss Table - groups of 8 slots:
metadata: [h2_0, h2_1, h2_2, h2_3, h2_4, h2_5, h2_6, h2_7]  (1 byte per slot)
data:     [slot0, slot1, slot2, slot3, slot4, slot5, slot6, slot7]

metadata byte = high 7 bits of hash (h2), or EMPTY/DELETED sentinel
SIMD probe: compare all 8 h2 bytes simultaneously in one instruction
Load factor: 87.5% (7/8 slots filled before resize)
\`\`\`

### Why Swiss Tables Are Faster

Swiss tables improve lookup performance by using one-byte metadata groups that enable SIMD-parallel slot scanning, drastically reducing the average probe chain length compared to traditional quadratic probing.

\`\`\`go
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

// Expected improvements on amd64 with SIMD:
// - Lookup throughput: ~30% faster for small maps, ~15% for large
// - Memory: ~10% less due to better load factor (87.5% vs 65%)
// - Iteration: ~20% faster due to better memory locality
\`\`\`

### Datadog's Experience: Saving Hundreds of GB

Datadog's agent processes metrics from millions of hosts, with each metric carrying 10-20 tags stored as \`map[string]string\`. At that scale, even small per-map overhead differences compound into hundreds of gigabytes. Upgrading to Go 1.24 required no code changes, the runtime swap was transparent.

\`\`\`go
// Datadog's use case: tag cardinality maps
// They maintain maps like: map[string]string for metric tags
// With millions of active metrics, each having 10-20 tags
// Memory savings = (old_overhead - new_overhead) * num_metrics

// Before Go 1.24:
// - Hash table load factor 65% → 35% empty slots wasted
// - Each bucket: pointer + overflow pointer = 16 bytes overhead

// After Go 1.24 Swiss Tables:
// - Load factor 87.5% → only 12.5% empty
// - No overflow pointers - flat layout
// - For 100M map entries: ~200GB → ~150GB (rough estimate at scale)
\`\`\`

### When Map Performance Matters

Map performance becomes a bottleneck in lookup-intensive hot loops such as routing tables and cache lookups. The following benchmarks identify which patterns benefit most from Swiss tables.

\`\`\`go
// Hot path identification - use pprof to find map hot spots
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
\`\`\`

### Generic Type Aliases (Go 1.24)

Go 1.24 added support for generic type aliases, allowing an alias to carry type parameters. Before this change, a type alias could refer to a concrete instantiation like \`map[string]int\` but could not itself be parameterized. Now you can write \`type StringMap[V any] = map[string]V\` and use it anywhere the underlying type is accepted, with zero runtime cost, the alias is erased at compile time.

\`\`\`go
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
\`\`\`
`;
