export default `## 15.14 Performance Benchmarks

### Lock-Free vs Mutex Performance

\`b.RunParallel\` distributes benchmark iterations across GOMAXPROCS goroutines, making it the correct tool for measuring throughput under realistic concurrency. The three-way comparison, mutex, atomic, and sharded atomic, quantifies the performance difference at each level of abstraction across the full range of contention scenarios.

\`\`\`go
func BenchmarkCounterComparison(b *testing.B) {
    b.Run("Mutex", func(b *testing.B) {
        var mu sync.Mutex
        var count int64
        b.RunParallel(func(pb *testing.PB) {
            for pb.Next() {
                mu.Lock()
                count++
                mu.Unlock()
            }
        })
    })

    b.Run("Atomic", func(b *testing.B) {
        var count atomic.Int64
        b.RunParallel(func(pb *testing.PB) {
            for pb.Next() {
                count.Add(1)
            }
        })
    })

    b.Run("ShardedAtomic", func(b *testing.B) {
        counter := NewShardedCounter(runtime.NumCPU() * 2)
        b.RunParallel(func(pb *testing.PB) {
            for pb.Next() {
                counter.Increment()
            }
        })
    })
}
\`\`\`

**Results (16-core machine):**

| Approach | ops/sec | ns/op | Contention |
|----------|---------|-------|------------|
| Mutex | 15M | 65 | High |
| Atomic | 180M | 5.5 | Medium |
| Sharded (32) | 450M | 2.2 | Low |

### Sharded Map vs sync.Map

\`sync.Map\` optimizes for read-mostly workloads through an internal two-map design with a read-only fast path. Mixed read/write workloads that don't match this pattern can perform significantly worse than a sharded mutex map. Benchmarking with an alternating 50/50 read-write pattern reveals the cost of \`sync.Map\`'s copy-on-promote mechanism compared to the predictable per-shard locking of the custom implementation.

\`\`\`go
func BenchmarkMapComparison(b *testing.B) {
    b.Run("sync.Map", func(b *testing.B) {
        var m sync.Map
        b.RunParallel(func(pb *testing.PB) {
            i := 0
            for pb.Next() {
                if i%2 == 0 {
                    m.Store(i, i)
                } else {
                    m.Load(i - 1)
                }
                i++
            }
        })
    })

    b.Run("ShardedMap", func(b *testing.B) {
        m := NewShardedMap[int, int](DefaultShardedMapConfig())
        b.RunParallel(func(pb *testing.PB) {
            i := 0
            for pb.Next() {
                if i%2 == 0 {
                    m.Set(i, i)
                } else {
                    m.Get(i - 1)
                }
                i++
            }
        })
    })
}
\`\`\`

**Results:**

| Map Type | Read ops/sec | Write ops/sec | Memory |
|----------|--------------|---------------|--------|
| sync.Map | 25M | 8M | Higher |
| ShardedMap (32) | 80M | 40M | Lower |

### Benchmark Context Matters

These numbers are from a microbenchmark. Production performance depends on workload (read/write ratio, key distribution, value size) and hardware. A benchmark showing "sharded is 3x faster" is useful when your production workload matches the benchmark's shape; it is misleading otherwise.

The staff-level rule: benchmark with a realistic workload, not a synthetic one. Measure before replacing production code. Revert if the production numbers do not match the benchmark's promise.

---
`;
