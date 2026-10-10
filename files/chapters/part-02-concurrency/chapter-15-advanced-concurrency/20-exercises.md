## Exercises

1. **Lock-Free Stack with sync/atomic**: Implement a thread-safe stack using only `sync/atomic`, no mutexes. Support `Push` and `Pop` via a compare-and-swap loop on the head. Verify with 1,000 concurrent goroutines each pushing and popping 100 items, asserting no items are lost or duplicated, and run it under `go test -race`. Then go further, because a clean `-race` run does not prove this stack correct: the detector finds unsynchronized access, not broken algorithms. Construct the A-B-A interleaving from section 15.1 by hand (pop A, pop B, push the same node A back while a third goroutine is mid-`Pop`) and show whether your stack resurrects node B. If it does, fix it by versioning the head record, and confirm the same interleaving now fails the CAS.

2. **Barrier Synchronization**: Build a reusable `Barrier` type that blocks a fixed number of goroutines until all of them have reached the barrier point, then releases them simultaneously. The barrier must be resettable so it can be used across multiple phases of computation. Test it by launching N goroutines that each perform work in two phases, asserting that no goroutine starts phase 2 before all goroutines have completed phase 1.

3. **Read-Heavy Cache with sync.RWMutex**: Design a generic in-memory cache backed by `sync.RWMutex` supporting `Get`, `Set`, and `Delete`. Reads hold only a read lock. Writes take the write lock directly. Note the trap in the wording you will see elsewhere: `RWMutex` has **no lock upgrade**, and calling `Lock` while holding `RLock` deadlocks. A read-then-write operation must `RUnlock`, then `Lock`, then *re-check* the state, because the map can change while you hold no lock at all. Then benchmark against a mutex-only implementation with a 95% read / 5% write workload across 8 goroutines. Report what you measure rather than what you expect: `RWMutex` has more bookkeeping than `Mutex`, so for very short critical sections it can lose. Find the critical-section length where it starts to win.

4. **Compare-and-Swap Counter**: Implement an `AtomicCounter` exposing `Increment`, `Decrement`, `Add(delta int64)`, and `Value`, built exclusively on `atomic.CompareAndSwapInt64`, without using `atomic.AddInt64`. Explain in a comment why the CAS loop is correct under contention. Then benchmark it against both a mutex-guarded counter and a plain `atomic.AddInt64` counter at 4, 8, and 16 goroutines. The expected finding is that your CAS loop *loses* to `atomic.AddInt64`, which compiles to a single instruction that cannot fail and never retries. The exercise is to understand why a CAS loop is the wrong tool for a plain increment, and what it would take for the loop to be justified (a new value computed from the old, such as a running maximum or a saturating counter).

5. **Concurrent Skip List**: Build a lock-free concurrent skip list that supports `Insert`, `Search`, and `Delete` with O(log n) expected complexity. Use `sync/atomic` for pointer manipulation and hazard-pointer-style techniques to prevent use-after-free during concurrent deletes. Verify correctness with a test that inserts 10,000 randomly ordered integers across 16 goroutines, then iterates the list and asserts it is sorted with no missing or duplicate entries.

6. **Memory Ordering and Happens-Before**: Write a program that demonstrates the Go memory model's happens-before guarantees. Create three scenarios: (a) a correctly synchronized counter using a channel as a happens-before edge, (b) the same counter without synchronization to show a race, and (c) the counter protected by `sync/atomic`. Run all three scenarios under `go run -race` and document which scenarios trigger the race detector and why, citing the Go memory model specification in your comments.

7. **Singleflight for Deduplicating Concurrent Requests**: Use `golang.org/x/sync/singleflight` to build a `DeduplicatingFetcher` that wraps an expensive data-fetching function (simulate with a 100 ms sleep). When multiple goroutines request the same key simultaneously, only one fetch should execute and its result should be shared with all waiting callers. Write a test that fires 50 concurrent requests for the same key, asserts the underlying fetch was called exactly once, and measures that all 50 callers received the result within 150 ms of the first request completing.

Each exercise targets a specific concurrency primitive or pattern. Complete them in order, since later exercises build on techniques from earlier ones.

### Staff / Principal Track

8. **Advanced-concurrency review bar.** Author the one-page document that defines when advanced concurrency techniques are allowed in your org's codebase. Include required profile evidence, review requirements, and maintenance commitments. Socialise with the senior pool. Publish.

9. **Contention audit.** For one high-throughput service, enable mutex profiling. Identify the top contention sites. Propose and land fixes using the simplest sufficient technique (often sharding, rarely lock-free).

10. **Advanced-concurrency rollback study.** If your org has ever deployed and later rolled back a lock-free or sharded data structure, write up the retrospective: why it was introduced, why it was rolled back, what the replacement looks like. This is teaching material for future decisions.

11. **Stdlib-first discipline.** Audit the codebase for hand-rolled implementations of things in `sync`, `sync/atomic`, or `golang.org/x/sync`. Propose migrations. Measure complexity reduction.

12. **Memory-model workshop.** Design and deliver a two-hour workshop on Go's memory model and lock-free programming pitfalls. Target the senior pool. Measure comprehension via a follow-up exercise. This is specialist training worth repeating every 18 months.
