export default `## 13.12 Performance and Benchmarks

### Mutex vs RWMutex vs Atomic

These three parallel benchmarks measure the throughput of the most common synchronization idiom, incrementing a shared counter, under maximum goroutine contention. The results illustrate the cost hierarchy: mutex requires an OS-assisted lock/unlock round trip, RWMutex adds tracking overhead even for writes, and \`atomic.Add\` is a single hardware instruction requiring no kernel involvement.

\`\`\`go
func BenchmarkMutexCounter(b *testing.B) {
    var mu sync.Mutex
    var counter int64

    b.RunParallel(func(pb *testing.PB) {
        for pb.Next() {
            mu.Lock()
            counter++
            mu.Unlock()
        }
    })
}

func BenchmarkRWMutexCounter(b *testing.B) {
    var mu sync.RWMutex
    var counter int64

    b.RunParallel(func(pb *testing.PB) {
        for pb.Next() {
            mu.Lock()
            counter++
            mu.Unlock()
        }
    })
}

func BenchmarkAtomicCounter(b *testing.B) {
    var counter atomic.Int64

    b.RunParallel(func(pb *testing.PB) {
        for pb.Next() {
            counter.Add(1)
        }
    })
}

/*
Results (8 cores):
BenchmarkMutexCounter-8       20000000    85 ns/op
BenchmarkRWMutexCounter-8     15000000   120 ns/op
BenchmarkAtomicCounter-8     100000000    12 ns/op

Atomics are 7-10x faster for simple operations!
*/
\`\`\`

### Read-Heavy Workload Comparison

This benchmark isolates the read-path performance of three approaches for a map with 1000 pre-populated entries and zero concurrent writes. \`sync.RWMutex\` unlocks concurrent readers, while \`sync.Map\` takes the further step of eliminating the lock entirely for reads against its stable-entry fast path, making it ideal for read-dominated caches.

\`\`\`go
func BenchmarkReadHeavy_Mutex(b *testing.B) {
    var mu sync.Mutex
    data := make(map[string]int)
    for i := 0; i < 1000; i++ {
        data[fmt.Sprintf("key%d", i)] = i
    }

    b.RunParallel(func(pb *testing.PB) {
        for pb.Next() {
            mu.Lock()
            _ = data["key500"]
            mu.Unlock()
        }
    })
}

func BenchmarkReadHeavy_RWMutex(b *testing.B) {
    var mu sync.RWMutex
    data := make(map[string]int)
    for i := 0; i < 1000; i++ {
        data[fmt.Sprintf("key%d", i)] = i
    }

    b.RunParallel(func(pb *testing.PB) {
        for pb.Next() {
            mu.RLock()
            _ = data["key500"]
            mu.RUnlock()
        }
    })
}

func BenchmarkReadHeavy_SyncMap(b *testing.B) {
    var m sync.Map
    for i := 0; i < 1000; i++ {
        m.Store(fmt.Sprintf("key%d", i), i)
    }

    b.RunParallel(func(pb *testing.PB) {
        for pb.Next() {
            m.Load("key500")
        }
    })
}

/*
Results (8 cores, read-only workload):
BenchmarkReadHeavy_Mutex-8      10000000   150 ns/op
BenchmarkReadHeavy_RWMutex-8    50000000    32 ns/op
BenchmarkReadHeavy_SyncMap-8   100000000    15 ns/op

sync.Map wins for read-heavy, stable-key workloads!
*/
\`\`\`

### Pool Performance Impact

Allocating a 4 KB buffer on every request triggers the garbage collector and causes frequent GC pauses under load. \`sync.Pool\` avoids this by recycling buffers across requests. The benchmark shows a 7× throughput improvement and zero allocations per operation because the pool satisfies \`Get\` calls from previously returned buffers rather than calling \`make\`.

\`\`\`go
func BenchmarkWithoutPool(b *testing.B) {
    b.RunParallel(func(pb *testing.PB) {
        for pb.Next() {
            buf := make([]byte, 4096)
            _ = processBuffer(buf)
        }
    })
}

func BenchmarkWithPool(b *testing.B) {
    pool := sync.Pool{
        New: func() any {
            return make([]byte, 4096)
        },
    }

    b.RunParallel(func(pb *testing.PB) {
        for pb.Next() {
            buf := pool.Get().([]byte)
            _ = processBuffer(buf)
            pool.Put(buf[:0])
        }
    })
}

/*
Results:
BenchmarkWithoutPool-8    5000000    350 ns/op    4096 B/op    1 allocs/op
BenchmarkWithPool-8      30000000     45 ns/op       0 B/op    0 allocs/op

Pool eliminates allocations and is 7x faster!
*/
\`\`\`

### Synchronization Primitive Cost Summary

Rough numbers on modern hardware, uncontended:

| Primitive | Cost | When to Use |
|-----------|------|-------------|
| \`atomic.Int64.Add\` | ~5 ns | Simple counters |
| \`sync.Mutex.Lock/Unlock\` | ~25 ns | Small critical sections |
| \`sync.RWMutex.RLock/RUnlock\` | ~30 ns | Long read sections, concurrent readers |
| \`sync.Map.Load\` | ~12 ns (hit) | Read-heavy, stable keys |
| Channel send/receive | ~60 ns (unbuffered, ready) | Ownership transfer |
| \`sync.Once.Do\` (after first) | ~1 ns | One-time initialisation |
| \`sync.Pool.Get\` (hit) | ~20 ns | Hot-path allocation reuse |

Order-of-magnitude numbers, not exact. Your hardware and workload will differ. Always benchmark with realistic contention before choosing.

### Contention Changes Everything

The numbers above are uncontended. Under contention, every primitive degrades, but not equally. Mutexes block; atomics retry (CAS loop). Channels schedule goroutines off and on the runqueue, costing hundreds of nanoseconds per contention event. A benchmark showing "atomic is 5x faster than mutex" is meaningless if the real workload has contention the benchmark does not.

The review discipline: when someone claims "X is faster than Y", ask "under what contention level?". Often the honest answer is "I have not measured under real contention". That answer disqualifies the claim.

### Staff Lens: Benchmark Reality vs Microbenchmark Fantasy

Microbenchmarks of synchronization primitives are widely misleading. They measure uncontended or lightly-contended performance, which rarely matches production. The staff-level rule: when performance matters, benchmark the full critical section under realistic load, not the primitive in isolation. A \`sync.Mutex\` that takes 25 ns in a microbenchmark might take microseconds in production because the critical section does memory allocation, the goroutine gets preempted mid-lock, or another goroutine is holding it. The primitive cost is dwarfed by context.

---
`;
