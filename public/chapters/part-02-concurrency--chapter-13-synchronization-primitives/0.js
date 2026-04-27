export default `# Chapter 13: Synchronization Primitives

*"Use channels when you want to coordinate or transfer data. Use mutexes when you want to protect shared state."* - Go Community

Channels are the idiomatic face of Go concurrency, but they are not the right tool for every job. When multiple goroutines need to read and modify a shared data structure, a cache, a connection pool, an in-memory index, channels introduce unnecessary copying and indirection. The \`sync\` package exists for exactly these cases: it provides the low-level primitives that the Go runtime itself uses internally, exposed with a clean, minimal API. \`sync.Mutex\` and \`sync.RWMutex\` protect critical sections with exclusive or shared-read/exclusive-write semantics respectively. \`sync.Once\` guarantees that initialization logic runs exactly once regardless of how many goroutines race to trigger it. \`sync.Cond\` enables goroutines to wait efficiently for arbitrary conditions without spinning. \`sync.Pool\` recycles short-lived allocations to reduce GC pressure in throughput-critical code paths.

The \`sync/atomic\` package sits one level below \`sync\`, providing hardware-level compare-and-swap, load, store, and add operations on integer and pointer types. Atomic operations are the building blocks of lock-free algorithms, data structures and counters that achieve concurrent safety without any lock acquisition, eliminating contention entirely in the happy path. Used correctly, atomics power some of the highest-throughput Go code in existence. Used incorrectly, they produce subtle memory ordering bugs that manifest only under specific CPU architectures or scheduling conditions. The Go memory model, the formal specification of which writes are guaranteed to be visible to which reads, is the indispensable reference for reasoning about both \`sync\` and \`sync/atomic\` usage, and this chapter covers its key guarantees in practical terms.

Knowing when to use each primitive is a skill that separates journeyman from senior Go engineers. A \`Mutex\` where a \`RWMutex\` would suffice serializes readers unnecessarily. A \`RWMutex\` where a \`Mutex\` is correct introduces promotion overhead. \`sync.Pool\` dramatically reduces allocation pressure in hot paths like HTTP request handling, but misusing it by storing pointers to live objects can produce subtle correctness bugs. \`sync.Map\` is optimized for append-only or read-mostly workloads and performs worse than a mutex-protected map for balanced read/write access. This chapter gives you the mental models and performance intuition to make these choices correctly, illustrated by patterns drawn directly from the Go standard library and production codebases at companies like Google, Dropbox, and CockroachDB.

**What you'll learn in this chapter:**

- **\`sync.Mutex\` and \`sync.RWMutex\`** - protecting shared state with appropriate lock granularity and avoiding common lock-ordering deadlocks
- **\`sync.Once\`** - lazy initialization, singleton patterns, and retry-on-error variants for expensive setup
- **\`sync.WaitGroup\` deep dive** - correct \`Add\`/\`Done\`/\`Wait\` sequencing and patterns for dynamic goroutine counts
- **\`sync.Cond\`** - waiting on arbitrary conditions with \`Wait\`/\`Signal\`/\`Broadcast\` and when to prefer it over channels
- **\`sync.Pool\`** - reducing GC pressure in high-throughput code with object recycling and correct usage semantics
- **\`sync.Map\`** - concurrent map for read-heavy and append-only workloads, and when a mutex-protected map is better
- **\`sync/atomic\` operations** - load, store, add, swap, and compare-and-swap on integers and pointers
- **Go memory model essentials** - happens-before guarantees, synchronization edges, and reasoning about visibility across goroutines

**Why this matters at scale:**

Google's \`groupcache\` (the predecessor to \`memcached\` replacement used internally) relies on \`sync.Once\` for lazy shard initialization and \`sync.RWMutex\` for its hot read path, correct lock choice is what allows it to serve millions of cache lookups per second per node. Dropbox's \`godropbox\` library uses \`sync.Pool\` in its connection pool implementation to eliminate per-request allocations under peak traffic. CockroachDB's storage engine uses \`sync/atomic\` operations extensively for its lock-free MVCC timestamp management, where mutex contention at the transaction rate would be prohibitive. Prometheus's Go client library wraps atomic counters in its metric types so that instrumentation overhead is unmeasurable even at very high event rates.

**Prerequisites:** Chapter 11 (Concurrency Fundamentals), goroutines, channels, and basic race condition awareness. Chapter 12 (Concurrency Patterns) is helpful but not strictly required.

> **For readers new to synchronization:** the primitives in this chapter look like a menu of options. The actual decision tree is small: default to \`sync.Mutex\`, upgrade to \`sync.RWMutex\` only when profiling shows read-heavy contention, reach for \`sync/atomic\` only for simple counters or flags. The other primitives serve specific, narrow purposes. Start with the defaults and graduate to the specialised primitives when the default is demonstrably insufficient.
>
> **For readers already senior at a FAANG-equivalent:** the leverage here is in the performance-and-benchmarks section (12.13), the pitfalls section (12.17), and the case studies (12.12). These are the sections you teach to mid-level engineers who are about to reach for \`sync.RWMutex\` as a default or use \`sync.Pool\` where it is wrong.

**Chapter navigation by career stage.**

- **Junior:** mutex, WaitGroup, Once. Sections 12.2, 12.4, and 12.6 cover the 80% of \`sync\` usage. Skip the rest until you have a reason to reach for it.
- **Mid-level:** add RWMutex, Cond, and the atomic basics. Recognise when to use each. Use profile evidence for primitive selection.
- **Senior:** the performance nuances (12.13), pitfalls (12.17), and case studies (12.12). Understand memory ordering, lock contention, and false sharing. Review code with this depth.
- **Staff or Principal:** the architectural question is "what is the contention profile of our services, and are we using the right primitives?". The case studies and performance benchmarks are the reference material for design reviews.

**Staff and Principal lens: synchronization is where performance goes to die.** Every lock is a serialisation point. Every contention event is a goroutine waiting when it could be computing. At scale, mutex contention is one of the top three performance bottlenecks in Go services. The staff-level work is not writing better mutex code. It is recognising which shared state has outgrown its current synchronization strategy and designing the transition: shard the state, move to atomics, move to lock-free structures, or remove the shared state entirely. Principal engineers who have watched a service melt because one mutex serialised a million requests per second per instance develop the instinct to profile synchronization early and often.

**Go 1.26 note.** The synchronization story has evolved: \`sync.OnceFunc\`, \`sync.OnceValue\`, and \`sync.OnceValues\` (Go 1.21) provide cleaner APIs than raw \`sync.Once\`. \`atomic.Int64\`, \`atomic.Pointer[T]\`, and friends (Go 1.19) replace the old function-based \`atomic.LoadInt64\`/\`StoreInt64\` with type-safe methods. \`testing/synctest\` (Go 1.25) enables deterministic testing of synchronization-heavy code. Modern Go code uses the modern APIs. When you see the old style, it is either legacy code or code written by someone not tracking the language.

---
`;
