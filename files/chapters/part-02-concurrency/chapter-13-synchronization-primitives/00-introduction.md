# Chapter 13: Synchronization Primitives

*"Use channels when you want to coordinate or transfer data. Use mutexes when you want to protect shared state."* - Go Community

Channels are the idiomatic face of Go concurrency, but they are not the right tool for every job. When multiple goroutines need to read and modify a shared data structure, a cache, a connection pool, an in-memory index, channels introduce unnecessary copying and indirection. The `sync` package exists for exactly these cases: it provides the low-level primitives that the Go runtime itself uses internally, exposed with a clean, minimal API. `sync.Mutex` and `sync.RWMutex` protect critical sections with exclusive or shared-read/exclusive-write semantics respectively. `sync.Once` guarantees that initialization logic runs exactly once regardless of how many goroutines race to trigger it. `sync.Cond` enables goroutines to wait efficiently for arbitrary conditions without spinning. `sync.Pool` recycles short-lived allocations to reduce GC pressure in throughput-critical code paths.

The `sync/atomic` package sits one level below `sync`, providing hardware-level compare-and-swap, load, store, and add operations on integer and pointer types. Atomic operations are the building blocks of lock-free algorithms, data structures and counters that achieve concurrent safety without any lock acquisition, eliminating contention entirely in the happy path. Used correctly, atomics power some of the highest-throughput Go code in existence. Used incorrectly, they produce subtle memory ordering bugs that manifest only under specific CPU architectures or scheduling conditions. The Go memory model, the formal specification of which writes are guaranteed to be visible to which reads, is the indispensable reference for reasoning about both `sync` and `sync/atomic` usage, and this chapter covers its key guarantees in practical terms.

Knowing when to use each primitive is a skill that separates journeyman from senior Go engineers. A `Mutex` where a `RWMutex` would suffice serializes readers unnecessarily. A `RWMutex` where a plain `Mutex` is correct costs more per acquisition, because the reader path maintains extra bookkeeping that a single-writer workload never benefits from. `sync.Pool` reduces allocation pressure in hot paths like HTTP request handling, but misusing it by retaining pointers to objects that are still live can produce subtle correctness bugs. `sync.Map` is optimized for read-mostly and append-only workloads and performs worse than a mutex-protected map for balanced read/write access. This chapter gives you the mental models and performance intuition to make these choices correctly, illustrated by patterns drawn directly from the Go standard library and from production codebases.

**What you'll learn in this chapter:**

- **`sync.Mutex` and `sync.RWMutex`** - protecting shared state with appropriate lock granularity and avoiding common lock-ordering deadlocks
- **`sync.Once`** - lazy initialization, singleton patterns, and retry-on-error variants for expensive setup
- **`sync.WaitGroup` deep dive** - correct `Add`/`Done`/`Wait` sequencing and patterns for dynamic goroutine counts
- **`sync.Cond`** - waiting on arbitrary conditions with `Wait`/`Signal`/`Broadcast` and when to prefer it over channels
- **`sync.Pool`** - reducing GC pressure in high-throughput code with object recycling and correct usage semantics
- **`sync.Map`** - concurrent map for read-heavy and append-only workloads, and when a mutex-protected map is better
- **`sync/atomic` operations** - load, store, add, swap, and compare-and-swap on integers and pointers
- **Go memory model essentials** - happens-before guarantees, synchronization edges, and reasoning about visibility across goroutines

**Why this matters at scale:**

Every widely used Go caching library leans on the same small set of primitives, and the lock choice is what decides whether the cache scales. A read-mostly cache guarded by a `RWMutex` lets readers proceed in parallel, while the same cache behind a plain `Mutex` serializes every lookup behind every other lookup. Connection pools use `sync.Pool` or a hand-rolled free list to keep per-request allocation off the hot path. Storage engines reach for `sync/atomic` when a counter or a timestamp is updated at a rate where any lock acquisition would dominate the work being protected. Metrics libraries wrap atomic counters in their metric types precisely so that instrumenting a hot function does not turn the instrumentation into the bottleneck. None of these are exotic techniques. They are the same primitives in this chapter, applied with an understanding of the contention profile.

**Prerequisites:** Chapter 11 (Concurrency Fundamentals), goroutines, channels, and basic race condition awareness. Chapter 12 (Concurrency Patterns) is helpful but not strictly required.

> **For readers new to synchronization:** the primitives in this chapter look like a menu of options. The actual decision tree is small: default to `sync.Mutex`, upgrade to `sync.RWMutex` only when profiling shows read-heavy contention, reach for `sync/atomic` only for simple counters or flags. The other primitives serve specific, narrow purposes. Start with the defaults and graduate to the specialized primitives when the default is demonstrably insufficient.
>
> **For readers already senior at a FAANG-equivalent:** the real value here is in the performance-and-benchmarks section (13.12), the pitfalls section, and the case studies (13.11). These are the sections you teach to mid-level engineers who are about to reach for `sync.RWMutex` as a default or use `sync.Pool` where it is wrong.

**Chapter navigation by career stage.**

- **Junior:** mutex, WaitGroup, Once. Sections 13.2, 13.4, and 13.5 cover the 80% of `sync` usage. Skip the rest until you have a reason to reach for it.
- **Mid-level:** add RWMutex, Cond, and the atomic basics. Recognize when to use each. Use profile evidence for primitive selection.
- **Senior:** the performance nuances (13.12), the pitfalls section, and case studies (13.11). Understand memory ordering, lock contention, and false sharing. Review code with this depth.
- **Staff or Principal:** the architectural question is "what is the contention profile of our services, and are we using the right primitives?". The case studies and performance benchmarks are the reference material for design reviews.

**Staff and Principal lens: synchronization is where performance goes to die.** Every lock is a serialization point. Every contention event is a goroutine waiting when it could be computing. At scale, mutex contention is a recurring cause of Go services that stop scaling with added cores. The staff-level work is not writing better mutex code. It is recognizing which shared state has outgrown its current synchronization strategy and designing the transition: shard the state, move to atomics, move to lock-free structures, or remove the shared state entirely. Engineers who have watched a service flatline because one global mutex serialized every request develop the instinct to profile synchronization early and often.

**A note on modern Go.** The synchronization story has evolved: `sync.OnceFunc`, `sync.OnceValue`, and `sync.OnceValues` (Go 1.21) provide cleaner APIs than raw `sync.Once`. `atomic.Int64`, `atomic.Pointer[T]`, and friends (Go 1.19) replace the old function-based `atomic.LoadInt64`/`StoreInt64` with type-safe methods. `testing/synctest` (Go 1.25) enables deterministic testing of synchronization-heavy code. Modern Go code uses the modern APIs. When you see the old style, it is either legacy code or code written by someone not tracking the language.

---
