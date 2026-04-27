export default `# Chapter 15: Advanced Concurrency

*"The ability to write correct concurrent programs is one of the most valuable skills a Go programmer can have."* - Go Community

Most production Go services are built entirely from the primitives covered in Chapters 11-14: goroutines, channels, mutexes, and context. But a small, critical class of problems demands more. When a mutex becomes a measurable bottleneck, visible in CPU profiles as lock contention, the answer is not a bigger machine. It is a lock-free or lock-reduced data structure. When work arrives unevenly and idle workers waste CPU while busy workers queue backlog, work-stealing improves utilization without adding complexity to the producer. When a hash map is the shared resource under thousands of concurrent readers and writers, sharding it across N independent maps with N independent locks reduces contention by a factor of N at the cost of a single hash operation. These are the techniques that separate systems capable of handling tens of thousands of requests per second from those that handle millions.

Lock-free programming in Go is built on the \`sync/atomic\` package's compare-and-swap (CAS) primitives. CAS is the hardware instruction that makes lock-free algorithms possible: it atomically reads a memory location, compares it to an expected value, and writes a new value only if the comparison succeeds, all without acquiring a lock. The ABA problem, memory ordering constraints, and the hazard pointer technique for safe memory reclamation are the conceptual obstacles that make lock-free programming hard. This chapter explains each concretely and shows how the Go standard library itself navigates them in packages like \`sync.Mutex\` (which uses atomics internally) and \`sync/atomic.Pointer\`. Understanding these foundations is what lets you read and reason about the Go runtime source code, and write your own correct lock-free structures when profiling justifies the complexity.

The Go memory model is the formal foundation beneath all of this. It defines the "happens-before" relationship: the set of ordering guarantees that the language and runtime provide across goroutines. Without the memory model, statements like "goroutine A writes X before goroutine B reads X" have no precise meaning, the compiler and CPU are both free to reorder operations in ways that make informal reasoning wrong. This chapter introduces the memory model in practical terms, covers the synchronization edges that establish happens-before (channel sends, mutex unlocks, \`atomic.Store\`), and explains why seemingly correct lock-free code can fail on architectures with weaker memory ordering than the x86 TSO model most developers test on.

**What this chapter covers:**

- **Lock-free data structures** - implementing lock-free stacks and queues using CAS, understanding the ABA problem, and when lock-free outperforms mutex-based alternatives
- **Compare-and-swap patterns** - retry loops, exponential backoff under contention, and composing CAS operations correctly
- **\`sync/atomic.Pointer\`** - safe atomic pointer swaps in Go 1.19+, replacing unsafe pointer arithmetic with a type-safe API
- **Work-stealing schedulers** - designing dynamic work distribution that rebalances load from busy workers to idle ones
- **Sharded data structures** - eliminating lock contention by partitioning shared maps and counters across independent shards
- **Hazard pointers and safe memory reclamation** - preventing use-after-free in lock-free structures when GC is insufficient
- **Go memory model** - happens-before guarantees, synchronization edges, and the practical impact on concurrent code correctness
- **Lock-free ring buffers** - implementing high-throughput single-producer/single-consumer and MPMC queues for inter-goroutine communication

**Why this matters at scale:**

Google's \`groupcache\` and \`bigcache\` use lock-free or sharded designs to serve billions of cache lookups per day without becoming lock-contention bottlenecks. Uber's \`zap\` logging library uses a lock-free ring buffer for its async write path, enabling structured log emission at rates that would stall under a conventional mutex. CockroachDB's transaction layer relies on atomic compare-and-swap for its timestamp oracle to achieve the throughput needed for a globally distributed SQL database. Fastly's edge compute platform uses sharded counters in their Go-based rate limiter to handle millions of rate-check operations per second across thousands of concurrent requests without any centralized lock.

**Prerequisites:** Chapters 11-14 (all concurrency chapters). Proficiency with \`sync/atomic\` basics (Chapter 13). Comfort reading CPU profiles and benchmark output is strongly recommended.

> **For readers new to advanced concurrency:** this chapter is specialised material. Ninety-nine percent of Go services do not need it. Read it for background and mental model, but do not reach for these techniques without profile evidence that a simpler design is insufficient.
>
> **For readers already senior at a FAANG-equivalent:** the leverage here is in recognising when a junior or mid-level engineer is reaching for lock-free techniques prematurely. The answer is almost always "use a mutex, and profile first".

**Chapter navigation by career stage.**

- **Junior or mid-level:** skim. Know the concepts exist. Do not implement them without supervision.
- **Senior:** read for the pattern vocabulary. Most teams do not need these techniques, but recognising when they apply is a senior skill.
- **Staff or Principal:** the architectural question is "does our service have a contention profile that justifies advanced concurrency, and if so, which technique fits?". This chapter's case studies help you answer that.

**Staff and Principal lens: advanced concurrency is a narrow tool.** The techniques in this chapter are correct for specific, measured problems. They are wrong for general use. A codebase that reaches for lock-free queues where channels would work, sharded maps where mutex-protected maps would work, or hazard pointers where Go's GC would work, is a codebase paying complexity interest without gain. The staff-level discipline is resisting the temptation. Advanced techniques are exciting to implement and easy to get wrong. Profile first; prefer the simpler option; reach for advanced techniques only when the profile leaves no alternative and the benefit justifies the cost.

**Go 1.26 note.** Much of what used to require hand-rolled lock-free code is now in \`sync\` or \`x/sync\`: \`atomic.Pointer[T]\` (Go 1.19) for type-safe atomic pointer swaps, \`sync.Map\` for read-mostly concurrent maps, \`singleflight\` for request coalescing. Before implementing any advanced technique from this chapter, check whether the stdlib or \`x/sync\` already provides it. They almost always do it better than a hand-rolled version.

---
`;
