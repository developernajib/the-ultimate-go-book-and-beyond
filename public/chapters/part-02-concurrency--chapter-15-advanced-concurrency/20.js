export default `## Exercises

1. **Lock-Free Stack with sync/atomic**: Implement a thread-safe stack using only \`sync/atomic\` operations, no mutexes allowed. The stack must support \`Push\` and \`Pop\` operations using a compare-and-swap loop on the head pointer. Verify correctness by running 1,000 concurrent goroutines each pushing and popping 100 items, then assert that no items are lost or duplicated. Use the race detector (\`go test -race\`) to confirm zero data races.

2. **Barrier Synchronization**: Build a reusable \`Barrier\` type that blocks a fixed number of goroutines until all of them have reached the barrier point, then releases them simultaneously. The barrier must be resettable so it can be used across multiple phases of computation. Test it by launching N goroutines that each perform work in two phases, asserting that no goroutine starts phase 2 before all goroutines have completed phase 1.

3. **Read-Heavy Cache with sync.RWMutex**: Design a generic in-memory cache backed by \`sync.RWMutex\` that supports \`Get\`, \`Set\`, and \`Delete\` operations. Reads should hold only a read lock. Writes must upgrade to a write lock. Benchmark the cache against a naive mutex-only implementation using \`go test -bench\` with a 95% read / 5% write workload across 8 goroutines, and confirm measurable throughput improvement from the RW lock.

4. **Compare-and-Swap Counter**: Implement an \`AtomicCounter\` struct that exposes \`Increment\`, \`Decrement\`, \`Add(delta int64)\`, and \`Value\` methods, all built exclusively on \`atomic.CompareAndSwapInt64\` - do not use \`atomic.AddInt64\`. Explain in a comment why the CAS loop is correct under high contention. Write a benchmark comparing your CAS-based counter against a mutex-guarded counter to quantify the performance difference at 4, 8, and 16 concurrent goroutines.

5. **Concurrent Skip List**: Build a lock-free concurrent skip list that supports \`Insert\`, \`Search\`, and \`Delete\` with O(log n) expected complexity. Use \`sync/atomic\` for pointer manipulation and hazard-pointer-style techniques to prevent use-after-free during concurrent deletes. Verify correctness with a test that inserts 10,000 randomly ordered integers across 16 goroutines, then iterates the list and asserts it is sorted with no missing or duplicate entries.

6. **Memory Ordering and Happens-Before**: Write a program that demonstrates the Go memory model's happens-before guarantees. Create three scenarios: (a) a correctly synchronized counter using a channel as a happens-before edge, (b) the same counter without synchronization to show a race, and (c) the counter protected by \`sync/atomic\`. Run all three scenarios under \`go run -race\` and document which scenarios trigger the race detector and why, citing the Go memory model specification in your comments.

7. **Singleflight for Deduplicating Concurrent Requests**: Use \`golang.org/x/sync/singleflight\` to build a \`DeduplicatingFetcher\` that wraps an expensive data-fetching function (simulate with a 100 ms sleep). When multiple goroutines request the same key simultaneously, only one fetch should execute and its result should be shared with all waiting callers. Write a test that fires 50 concurrent requests for the same key, asserts the underlying fetch was called exactly once, and measures that all 50 callers received the result within 150 ms of the first request completing.

Each exercise targets a specific concurrency primitive or pattern. Complete them in order, later exercises build on techniques from earlier ones.

### Staff / Principal Track

8. **Advanced-concurrency review bar.** Author the one-page document that defines when advanced concurrency techniques are allowed in your org's codebase. Include required profile evidence, review requirements, and maintenance commitments. Socialise with the senior pool. Publish.

9. **Contention audit.** For one high-throughput service, enable mutex profiling. Identify the top contention sites. Propose and land fixes using the simplest sufficient technique (often sharding, rarely lock-free).

10. **Advanced-concurrency rollback study.** If your org has ever deployed and later rolled back a lock-free or sharded data structure, write up the retrospective: why it was introduced, why it was rolled back, what the replacement looks like. This is teaching material for future decisions.

11. **Stdlib-first discipline.** Audit the codebase for hand-rolled implementations of things in \`sync\`, \`sync/atomic\`, or \`golang.org/x/sync\`. Propose migrations. Measure complexity reduction.

12. **Memory-model workshop.** Design and deliver a two-hour workshop on Go's memory model and lock-free programming pitfalls. Target the senior pool. Measure comprehension via a follow-up exercise. This is specialist training worth repeating every 18 months.
`;
