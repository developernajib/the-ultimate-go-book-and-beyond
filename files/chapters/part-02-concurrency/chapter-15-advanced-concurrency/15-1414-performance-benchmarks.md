## 15.14 Performance Benchmarks

### Lock-Free vs Mutex Performance

`b.RunParallel` distributes benchmark iterations across GOMAXPROCS goroutines, making it the correct tool for measuring throughput under realistic concurrency. The three-way comparison, mutex, atomic, and sharded atomic, quantifies the performance difference at each level of abstraction across the full range of contention scenarios.

```go
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
```

**Results.** Measured on an 8-thread laptop CPU (Intel i7-10510U), `-cpu=8`:

| Approach | ns/op | Relative |
|----------|-------|----------|
| Mutex | 58.1 | 1.0x |
| Atomic | 20.3 | 2.9x faster |
| Sharded atomic (64) | 5.7 | 10.2x faster |

Read the shape, not the digits. The ordering and the rough ratios are the durable result: an uncontended-looking `atomic.Add` on a single hot address is still limited by cache-line ping-pong between cores, and spreading the writes across shards is what actually removes the bottleneck. The absolute numbers belong to this machine and will not reproduce on yours.

Be suspicious of counter benchmarks that report a *contended* atomic at low single-digit nanoseconds while also reporting a mutex at tens of nanoseconds. A single cache line has a hard throughput ceiling that no amount of atomics gets past, so numbers like that usually mean the benchmark accidentally stopped contending.

### Sharded Map vs sync.Map

`sync.Map` optimizes for read-mostly workloads. Since Go 1.24 it is built on a concurrent hash-trie, so reads proceed lock-free down the trie rather than through the old read/dirty promotion design. Key churn is still its most expensive case, but for a different reason than the old folklore gives: growing and rebalancing trie structure, not promoting a dirty map.

The benchmark that measures this has to be written carefully, and the obvious version is not fair. This one is worth studying as a broken benchmark:

```go
// BROKEN BENCHMARK: do not copy
b.RunParallel(func(pb *testing.PB) {
    i := 0 // each goroutine starts at 0
    for pb.Next() {
        if i%2 == 0 {
            m.Store(i, i)
        } else {
            m.Load(i - 1)
        }
        i++
    }
})
```

Every parallel goroutine declares its own `i` starting at zero, so they all write the same key sequence and every goroutine's `Load` hits a key it just wrote itself. It fixes the write ratio at exactly 50%, which is `sync.Map`'s documented worst case, and then reports the result as though it were a general verdict. Rigging a benchmark against the read-mostly structure by making it write half the time proves nothing except that you read the wrong tool's documentation.

A fair comparison shares a key space across goroutines, samples keys randomly, and sweeps the write ratio, because the write ratio is the entire variable of interest:

```go
const keySpace = 10000

func benchSyncMap(b *testing.B, writePct int) {
    var m sync.Map
    for i := 0; i < keySpace; i++ {
        m.Store(i, i) // Pre-populate: measure steady state, not warmup
    }
    b.ResetTimer()
    b.RunParallel(func(pb *testing.PB) {
        for pb.Next() {
            k := int(rand.Uint32()) % keySpace
            if int(rand.Uint32()%100) < writePct {
                m.Store(k, k)
            } else {
                m.Load(k)
            }
        }
    })
}

func BenchmarkMapReadMostly1pct(b *testing.B) {
    b.Run("sync.Map", func(b *testing.B) { benchSyncMap(b, 1) })
    b.Run("ShardedMap", func(b *testing.B) { benchSharded(b, 1) })
}
func BenchmarkMapMixed50pct(b *testing.B) { /* writePct = 50 */ }
func BenchmarkMapWriteHeavy90pct(b *testing.B) { /* writePct = 90 */ }
```

**Results.** Same 8-thread laptop, `-cpu=8`, sharded map at `NumCPU()*4` shards:

| Workload | sync.Map | ShardedMap | Winner |
|----------|----------|------------|--------|
| 1% writes | 14.8 ns | 29.8 ns | sync.Map, ~2x |
| 50% writes | 39.0 ns | 56.8 ns | sync.Map |
| 90% writes | 60.1 ns | 58.2 ns | roughly even |
| 100% new keys | 142.5 ns | 121.4 ns | ShardedMap, ~15% |

This does not match the folklore, and the folklore is what needed correcting. `sync.Map` is not a trap that a sharded map beats once you add writes. On this machine it wins comfortably when reads dominate, stays ahead at an even mix, and only falls behind under relentless key churn, which is the one case its design explicitly trades away. Even there the margin is modest, nothing like the multiples usually quoted.

Two honest caveats. Core count matters: with many more cores, `sync.Map`'s lock-free read path stretches its lead further, while the sharded map's per-shard `RWMutex` starts to contend, so do not extrapolate a laptop to a 96-core server in either direction. And the hash function matters more than expected. The `defaultHash` from section 15.3 routes keys through `fmt.Sprintf("%v", key)` before FNV, which allocates on every single lookup: swapping it for `maphash.Comparable` cut the sharded map's read-mostly time from 45ns to 30ns. Half of that "lock contention" was never contention at all, it was string formatting. Profile before you conclude which part is slow.

### Benchmark Context Matters

These numbers are from microbenchmarks. Production performance depends on the workload (read/write ratio, key distribution, value size) and on the hardware. A benchmark showing "sharded is 3x faster" is useful only when your production workload matches the benchmark's shape, and misleading otherwise.

The map results above are the lesson in miniature. The same two structures traded places purely on the write ratio, and the published wisdom that a sharded map beats `sync.Map` on mixed workloads did not survive a benchmark that was not rigged in its favour. Almost every misleading concurrency benchmark shares one of two defects: it picks the workload that flatters the conclusion, or it accidentally measures something else entirely, such as a hash function that allocates.

The staff-level rules follow from that. Benchmark the workload you actually have, including its read/write ratio and key distribution. Check what fraction of the time is going where before attributing it to locking. Sweep the parameter you are reasoning about instead of testing one point. Measure before replacing production code, and revert if production does not reproduce the benchmark's promise.

---
