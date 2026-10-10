## 13.12 Performance and Benchmarks

### Mutex vs RWMutex vs Atomic

These three parallel benchmarks measure the throughput of the most common synchronization idiom, incrementing a shared counter, under maximum goroutine contention.

Before the numbers, correct a myth that this section used to repeat: **an uncontended `sync.Mutex` does not involve the OS.** `Lock` on a free mutex is a single compare-and-swap in userspace, and `Unlock` on a mutex with no waiters is an atomic add. There is no syscall and no kernel transition. Only the *contended* path parks the goroutine, and even that goes through the Go runtime's scheduler rather than straight to a kernel futex in most cases. This matters because it explains the measurements: if a mutex were an OS round trip it would cost microseconds, not the ~12 ns you will actually measure. What makes a contended mutex expensive is not the kernel, it is cache-line ping-pong between cores plus the scheduling work of parking and unparking goroutines.

```go
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

```

Measured on an 8-core laptop CPU:

```
BenchmarkMutexCounter-8     	15004633	        39.48 ns/op
BenchmarkRWMutexCounter-8   	11430249	        51.65 ns/op
BenchmarkAtomicCounter-8    	43285479	        13.40 ns/op
```

Atomics are about 3x faster than a mutex here, and `RWMutex` is about 30% *slower* than a plain `Mutex` for writes, which is the expected result: `RWMutex.Lock` has to exclude readers as well as writers, so it does strictly more bookkeeping than `Mutex.Lock` and offers nothing in return when there are no readers. Using an `RWMutex` for a write-only workload is pure overhead.

Note the shape of the win, not just its size. All three of these serialize on one cache line, so none of them scales with cores. The atomic is faster per operation, not more parallel. If a counter is genuinely hot enough for 3x to matter, the real fix is to stop sharing the cache line at all: shard the counter per-P or per-core and sum the shards on read. That changes the scaling curve instead of the constant.

### Read-Heavy Workload Comparison

This benchmark isolates the read-path performance of three approaches for a map with 1000 pre-populated entries and zero concurrent writes. `sync.RWMutex` unlocks concurrent readers, while `sync.Map` takes the further step of eliminating the lock entirely for reads against its stable-entry fast path, making it ideal for read-dominated caches.

```go
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

```

Measured on the same machine:

```
BenchmarkReadHeavy_Mutex-8     	10052202	        60.28 ns/op
BenchmarkReadHeavy_RWMutex-8   	16074422	        35.44 ns/op
BenchmarkReadHeavy_SyncMap-8   	100000000	         6.216 ns/op
```

`sync.Map` wins decisively for read-heavy stable-key workloads, and the reason is worth stating precisely: its read path touches no shared writable memory. `RWMutex.RLock` still does an atomic increment on a shared reader counter, so eight cores bounce that one cache line between them even though they are "only reading". `sync.Map`'s hot path reads immutable state, so the cores genuinely do not interact.

That is also why `RWMutex` only manages about 1.7x over `Mutex` here despite this being a pure read workload with zero writers, which is the most favorable case it will ever see. If a read-only benchmark is the best `RWMutex` can do, be skeptical of it in code where writes actually happen.

### Pool Performance Impact

Allocating a 4 KB buffer on every request creates garbage collector pressure under load. `sync.Pool` avoids this by recycling buffers across requests. This benchmark is also a good excuse to show two ways a synchronization benchmark can lie to you, because the obvious version of it does both.

```go
var sink []byte

//go:noinline
func useBuffer(b []byte) {
    b[0] = 1
    b[len(b)-1] = 2
    sink = b // force the buffer to escape
}

func BenchmarkWithoutPool(b *testing.B) {
    b.ReportAllocs()
    b.RunParallel(func(pb *testing.PB) {
        for pb.Next() {
            buf := make([]byte, 4096)
            useBuffer(buf)
        }
    })
}

func BenchmarkWithPool(b *testing.B) {
    b.ReportAllocs()
    pool := sync.Pool{
        New: func() any {
            s := make([]byte, 4096)
            return &s // *[]byte: a slice header would box and allocate
        },
    }

    b.RunParallel(func(pb *testing.PB) {
        for pb.Next() {
            bp := pool.Get().(*[]byte)
            useBuffer(*bp)
            pool.Put(bp)
        }
    })
}
```

Measured results:

```
BenchmarkWithoutPool-8   	  899010	       579.6 ns/op	    4096 B/op	       1 allocs/op
BenchmarkWithPool-8      	62168511	         9.526 ns/op	       0 B/op	       0 allocs/op
```

Now the two traps, because both were present in the naive version of this benchmark and both produce confidently wrong conclusions.

**Trap 1: the compiler deleted the thing being measured.** The original `BenchmarkWithoutPool` called a `processBuffer` that only read `len(buf)`. Escape analysis proved the buffer never leaves the loop, so the allocation was removed entirely. The benchmark reported **0.2178 ns/op and 0 allocs/op**: it was measuring an empty loop, and it made the un-pooled version look infinitely fast. Any benchmark of allocation that reports zero allocations has not measured allocation. `sink` and `//go:noinline` exist to force the buffer to genuinely escape. Always check `allocs/op` against what you believe the code does.

**Trap 2: the pooled version silently stopped doing the work.** The original did `pool.Put(buf[:0])`, putting back a **zero-length** slice. Every subsequent `Get` returned a slice of length 0, so `processBuffer` was handed an empty buffer while the un-pooled benchmark got a full 4096 bytes. The two benchmarks were doing different amounts of work, and the pooled one looked fast partly because it was doing nothing. Pooling a `*[]byte` and never reslicing the length away avoids this, and as a bonus avoids the allocation that boxing a slice header into `any` would cost on every `Put`.

With both traps fixed, the pool is genuinely worth it here: about 61x faster and, as promised, zero allocations. That is a real result, and notice it is far larger than the fabricated "7x" this section used to claim. Honest measurement cuts both ways.

### Synchronization Primitive Cost Summary

Measured single-goroutine, uncontended, on an 8-core laptop CPU (`-cpu=1`):

| Primitive | Cost | When to Use |
|-----------|------|-------------|
| `sync.Once.Do` (after first) | ~0.5 ns | One-time initialization |
| `atomic.Int64.Add` | ~5.8 ns | Simple counters |
| `sync.RWMutex.RLock/RUnlock` | ~10 ns | Long read sections, concurrent readers |
| `sync.Pool.Get`+`Put` (hit) | ~11 ns | Hot-path allocation reuse |
| `sync.Mutex.Lock/Unlock` | ~12 ns | Small critical sections |
| `sync.Map.Load` (hit) | ~15 ns | Read-heavy, stable keys |
| Channel send (buffered, not full) | ~41 ns | Ownership transfer |
| Channel send (unbuffered, ready receiver) | ~180 ns | Synchronous handoff |

Order-of-magnitude numbers, not exact. Your hardware and workload will differ, and these were taken on a laptop under thermal constraints. Always benchmark before choosing.

Three things in this table are worth pausing on, because each contradicts something people commonly believe.

`sync.Once.Do` after the first call is essentially free. It is an atomic load and a branch, so there is no reason to "optimize away" a `Once` on a hot path.

**Uncontended `RWMutex.RLock` is slightly cheaper than `Mutex.Lock` here**, which looks like it contradicts the advice to prefer `Mutex`. It does not, and this is precisely why single-threaded microbenchmarks mislead. The uncontended costs are within noise of each other. What separates them is what happens with eight cores hammering the same lock, which the earlier `RunParallel` benchmarks measured and which is the number that decides your architecture. Never pick a lock based on this table.

**An unbuffered channel send costs roughly 15x an atomic add** because it is a goroutine handoff, not a memory operation: the sender parks, the receiver is made runnable, and the scheduler gets involved. Channels are a coordination primitive with a coordination price. That price is worth paying for ownership transfer and completely wasted on a counter.

### Contention Changes Everything

The numbers above are uncontended. Under contention, every primitive degrades, but not equally. Mutexes block, atomics retry (CAS loop). Channels schedule goroutines off and on the runqueue, costing hundreds of nanoseconds per contention event. A benchmark showing "atomic is 5x faster than mutex" is meaningless if the real workload has contention the benchmark does not.

The review discipline: when someone claims "X is faster than Y", ask "under what contention level?". Often the honest answer is "I have not measured under real contention". That answer disqualifies the claim.

### Staff Lens: Benchmark Reality vs Microbenchmark Fantasy

Microbenchmarks of synchronization primitives are widely misleading, and this section is a demonstration rather than a warning. Every fabricated number that used to be in this file pointed at a defensible conclusion, and the measured numbers changed several of them: `RWMutex` turned out to be slower than `Mutex` for writes, the pool turned out to be worth far more than claimed, and the un-pooled benchmark turned out to be measuring an empty loop.

The staff-level rule: when performance matters, benchmark the full critical section under realistic load, not the primitive in isolation. A `sync.Mutex` that takes 12 ns in a microbenchmark can take microseconds in production because the critical section allocates, the goroutine gets preempted while holding the lock, or eight other goroutines want it. The primitive's cost is usually dwarfed by its context.

The habits that keep you honest:

- **Check `allocs/op` against your mental model.** A mismatch means the compiler outsmarted your benchmark, not that your code is fast.
- **Make both arms do identical work.** The pooled and un-pooled versions must produce the same result, or you are comparing a program to a different program.
- **Report the contention level.** "Atomic is 3x faster than mutex" is not a claim until it says at what parallelism, and `-cpu=1` and `-cpu=8` can invert conclusions.
- **Distrust round numbers.** Real measurements are 39.48 and 51.65. Numbers like "85" and "120" tend to be remembered, estimated, or invented.
- **Re-measure after upgrades.** `sync.Map` was rewritten in Go 1.24, and benchmarks published before it describe a data structure that no longer exists.

---
