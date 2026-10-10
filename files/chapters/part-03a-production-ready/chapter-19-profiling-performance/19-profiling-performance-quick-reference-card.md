## Profiling & Performance Quick Reference Card

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│ PROFILING & PERFORMANCE QUICK REFERENCE                                         │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│ PROFILE TYPES:                                                                  │
│ ├── CPU: go tool pprof http://localhost:6060/debug/pprof/profile                │
│ ├── Heap: go tool pprof http://localhost:6060/debug/pprof/heap                  │
│ ├── Goroutine: go tool pprof http://localhost:6060/debug/pprof/goroutine        │
│ ├── Block: go tool pprof http://localhost:6060/debug/pprof/block                │
│ ├── Mutex: go tool pprof http://localhost:6060/debug/pprof/mutex                │
│ └── Trace: wget http://localhost:6060/debug/pprof/trace?seconds=5               │
│                                                                                 │
│ PPROF COMMANDS:                                                                 │
│ ┌─────────────────────────────────────────────────────────────────────────┐     │
│ │ (pprof) top # Top functions by CPU/memory                               │     │
│ │ (pprof) top -cum # Top by cumulative time (includes callees)            │     │
│ │ (pprof) list FuncName # Annotated source code                           │     │
│ │ (pprof) peek FuncName # Show callers and callees                        │     │
│ │ (pprof) web # Open flame graph in browser                               │     │
│ │ (pprof) weblist Func # Source + disassembly in browser                  │     │
│ │ (pprof) disasm Func # Assembly listing                                  │     │
│ └─────────────────────────────────────────────────────────────────────────┘     │
│                                                                                 │
│ MEMORY PROFILE MODES:                                                           │
│ ├── -inuse_space: Memory currently in use (for leak detection)                  │
│ ├── -alloc_space: Total allocated over time (for GC pressure)                   │
│ ├── -inuse_objects: Objects currently live                                      │
│ └── -alloc_objects: Total objects allocated                                     │
│                                                                                 │
│ BENCHMARKING:                                                                   │
│ ┌─────────────────────────────────────────────────────────────────────────┐     │
│ │ # Run benchmarks                                                        │     │
│ │ go test -bench=. -benchmem                                              │     │
│ │                                                                         │     │
│ │ # Generate profiles from benchmarks                                     │     │
│ │ go test -bench=. -cpuprofile cpu.prof -memprofile mem.prof              │     │
│ │                                                                         │     │
│ │ # Compare benchmarks                                                    │     │
│ │ go test -bench=. -count=5 > old.txt                                     │     │
│ │ # make changes                                                          │     │
│ │ go test -bench=. -count=5 > new.txt                                     │     │
│ │ benchstat old.txt new.txt                                               │     │
│ │                                                                         │     │
│ │ # Parallel benchmarks                                                   │     │
│ │ func BenchmarkParallel(b *testing.B) {                                  │     │
│ │ b.RunParallel(func(pb *testing.PB) {                                    │     │
│ │ for pb.Next() { doWork() }                                              │     │
│ │ })                                                                      │     │
│ │ }                                                                       │     │
│ └─────────────────────────────────────────────────────────────────────────┘     │
│                                                                                 │
│ ESCAPE ANALYSIS:                                                                │
│ ┌─────────────────────────────────────────────────────────────────────────┐     │
│ │ # View escape decisions                                                 │     │
│ │ go build -gcflags="-m" main.go                                          │     │
│ │ go build -gcflags="-m -m" main.go # More verbose                        │     │
│ │                                                                         │     │
│ │ # Common escape causes:                                                 │     │
│ │ • Returning pointer to local variable                                   │     │
│ │ • Storing in any (boxing)                                               │     │
│ │ • Captured by closure                                                   │     │
│ │ • Slice grows beyond stack size                                         │     │
│ │ • Variable size unknown at compile time                                 │     │
│ └─────────────────────────────────────────────────────────────────────────┘     │
│                                                                                 │
│ RUNTIME DEBUGGING:                                                              │
│ ┌─────────────────────────────────────────────────────────────────────────┐     │
│ │ # GC tracing                                                            │     │
│ │ GODEBUG=gctrace=1 ./myapp                                               │     │
│ │ # Output: gc 1 @0.012s 2%: 0.019+0.32+0.004 ms clock                    │     │
│ │ # ↑STW pause ↑GC CPU time                                               │     │
│ │                                                                         │     │
│ │ # Scheduler tracing                                                     │     │
│ │ GODEBUG=schedtrace=1000 ./myapp                                         │     │
│ │                                                                         │     │
│ │ # Memory limit (Go 1.19+)                                               │     │
│ │ GOMEMLIMIT=4GiB ./myapp                                                 │     │
│ │                                                                         │     │
│ │ # GC percentage (default 100)                                           │     │
│ │ GOGC=200 ./myapp # Less frequent GC, more memory                        │     │
│ └─────────────────────────────────────────────────────────────────────────┘     │
│                                                                                 │
│ COMMON OPTIMIZATIONS:                                                           │
│ ┌─────────────────────────────────────────────────────────────────────────┐     │
│ │ // Pre-allocate slices                                                  │     │
│ │ result := make([]T, 0, expectedSize)                                    │     │
│ │                                                                         │     │
│ │ // Use sync.Pool for frequently allocated objects                       │     │
│ │ var pool = sync.Pool{New: func() any { return &Buffer{} }}              │     │
│ │ buf := pool.Get().(*Buffer)                                             │     │
│ │ defer pool.Put(buf)                                                     │     │
│ │                                                                         │     │
│ │ // Avoid string concatenation in loops                                  │     │
│ │ var b strings.Builder                                                   │     │
│ │ for _, s := range items { b.WriteString(s) }                            │     │
│ │                                                                         │     │
│ │ // Avoid any boxing                                                     │     │
│ │ func process(v int) int // Good: no boxing                              │     │
│ │ func process(v any) any // Bad: boxing allocates                        │     │
│ │                                                                         │     │
│ │ // Use pointers for large structs in slices                             │     │
│ │ []LargeStruct // Copies on access                                       │     │
│ │ []*LargeStruct // Just pointer copy                                     │     │
│ └─────────────────────────────────────────────────────────────────────────┘     │
│                                                                                 │
│ TRACE ANALYSIS:                                                                 │
│ ├── go tool trace trace.out                                                     │
│ ├── View: Goroutine analysis, Network blocking, Syscall blocking                │
│ ├── User regions: trace.WithRegion(ctx, "name", func() {...})                   │
│ └── User tasks: ctx, task := trace.NewTask(ctx, "task")                         │
│                                                                                 │
│ OPTIMIZATION WORKFLOW:                                                          │
│ ┌─────────────────────────────────────────────────────────────────────────┐     │
│ │ 1. Set measurable goals (P99 < 50ms, allocs < 100/req)                  │     │
│ │ 2. Benchmark current state (baseline)                                   │     │
│ │ 3. Profile to find bottlenecks                                          │     │
│ │ 4. Optimize the #1 bottleneck only                                      │     │
│ │ 5. Re-benchmark to verify improvement                                   │     │
│ │ 6. Repeat until goals met                                               │     │
│ └─────────────────────────────────────────────────────────────────────────┘     │
│                                                                                 │
│ COST HIERARCHY (cheapest to most expensive; order-of-magnitude only)            │
│ ├── Stack allocation ~0                                                         │
│ ├── atomic.Load ~2ns                                                            │
│ ├── atomic.Add ~10ns                                                            │
│ ├── sync.RWMutex RLock/RUnlock ~17ns                                            │
│ ├── sync.Mutex lock/unlock ~20ns                                                │
│ ├── atomic.CompareAndSwap ~20ns                                                 │
│ ├── Channel send/receive ~40ns                                                  │
│ ├── Heap allocation (small, uncontended) ~50ns                                  │
│ ├── syscall (cached) ~100ns                                                     │
│ ├── syscall (actual) ~1μs                                                       │
│ ├── Network local ~100μs                                                        │
│ ├── SSD read (4KB) ~100μs                                                       │
│ ├── Network datacenter ~1ms                                                     │
│ └── HDD read (seek) ~10ms                                                       │
│                                                                                 │
│ RED FLAGS IN PROFILES:                                                          │
│ ├── runtime.mallocgc > 10%: Too many allocations                                │
│ ├── runtime.gcBgMarkWorker: GC working hard (reduce allocs)                     │
│ ├── sync.(*Mutex).Lock: Lock contention (reduce scope or shard)                 │
│ ├── runtime.selectgo: Complex select statements                                 │
│ ├── runtime.chanrecv: Receivers waiting (starved, not slow)                     │
│ └── encoding/json: Consider faster serialization                                │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

**About the cost hierarchy.** The Go-level figures above were measured with `benchstat` over 8 runs on the machine used for this book (linux/amd64, Go 1.27.1, uncontended, single goroutine). They are here to teach *relative orders of magnitude*, not to be quoted. Two cautions before you rely on any of them.

They move under contention, which is exactly when you care. An uncontended `sync.Mutex` costs about 20ns. A contended one costs whatever the other goroutine is doing plus a trip through the scheduler, which can be microseconds. The same is true of `atomic.CompareAndSwap` in a retry loop. These numbers describe the happy path only.

The allocation figure is the least stable of them. A small heap allocation measured around 50ns here, but with ±133% variance across runs, and that number excludes the GC work your allocation creates later. Allocation is not just the cost of `mallocgc`. It is also the cost of eventually collecting the garbage, paid by a different goroutine at an inconvenient time, which is why allocation reduction pays off more than this table suggests.

Use the shape of this list, which is stable: stack beats heap, atomics beat locks, locks beat channels, everything in-process beats a syscall, and a syscall beats the network by orders of magnitude. Do not use the digits. Measure your own.

### Staff Lens: Distribute This Card

Print this reference card for the team. The cost hierarchy is particularly useful: engineers reach for channels because they are idiomatic, not realizing channels cost 50ns. For hot paths, knowing the cost of each primitive informs design decisions. The card makes the knowledge tangible and reachable.
