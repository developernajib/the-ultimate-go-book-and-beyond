## Summary

Synchronization primitives in Go's `sync` package provide essential tools for protecting shared state:

| Primitive | Use Case | Key Considerations |
|-----------|----------|-------------------|
| `Mutex` | Protect shared state | Keep critical sections short. Not reentrant. |
| `RWMutex` | Long read sections with real reader overlap | Duration matters more than ratio. Never re-enter `RLock`. |
| `Once` | One-time initialization | Cannot retry. A panic still marks it done. |
| `WaitGroup` | Wait for goroutine completion | `Add` before `go`. Prefer `wg.Go` (1.25) or `errgroup`. |
| `Cond` | Broadcast to many waiters on shared state | `Wait` cannot be cancelled. Prefer channels. |
| `Pool` | Object reuse on hot paths | Not for connections. Nothing may outlive `Put`. |
| `Map` | Write-once-read-many, or disjoint keys | Loses type safety and cross-key invariants. |
| `atomic` | Simple counters, flags, pointer swaps | Sequentially consistent. ~2-3x a mutex, not 10x. |

**Key Guidelines:**
1. Prefer channels for coordination, mutexes for state protection
2. Keep critical sections as short as possible, and never hold a lock across I/O, an RPC, a channel op, or a callback
3. Use `defer` for unlock, but watch the scope: `defer` runs at *function* exit, so a `defer Unlock` inside a loop holds every lock until the function returns
4. Never copy sync types after use
5. Maintain consistent lock ordering to prevent deadlocks, keyed on a stable ID, and handle the same-object case explicitly
6. Use `go vet` to detect common mistakes, and run `-race` in CI against tests that actually exercise concurrency
7. Benchmark before optimizing, simplicity often wins

The choice between primitives depends on access patterns, contention levels, and performance requirements. Start simple with `sync.Mutex`, then optimize based on profiling data.

**The one measurement to remember.** `RWMutex` converts reader concurrency into throughput, so it can only help when there is reader concurrency to convert. With a single map lookup under the lock it beat `Mutex` by only about 1.15x. With five microseconds of work under the lock it beat it by roughly 8x. And it loses outright to `Mutex` on writes. That is why "my workload is read-heavy" does not justify an `RWMutex`, and why an `RWMutex` whose read path takes the write lock, which is startlingly common, is strictly worse than the `Mutex` it replaced.

### For the Senior-at-FAANG Track

The most impactful practice is choosing the right primitive with profile evidence and pushing back in review on the wrong ones. RWMutex without evidence of concurrent-reader benefit, sync.Pool for stateful objects, sync.Map for balanced workloads, atomic for complex multi-field state. Each of these is a common mistake worth catching at review time.

### For the Staff and Principal Track

The deliverables are the org-wide synchronization conventions, the mutex-profile dashboards, and the incident-response process for contention problems. Principal engineers see the scaling ceiling of each primitive and drive the redesign before it becomes an incident. Staff engineers maintain the review discipline that keeps the team's synchronization code within the idiomatic lines. Both roles are unglamorous. Both pay compound dividends over years.

### Mental Model to Take Away

Synchronization is the necessary evil of shared state. The goal is not to use synchronization primitives cleverly. The goal is to design code that needs them less. Single-ownership goroutine-owned state, message-passing between goroutines, immutable data structures: each of these reduces the need for synchronization. The synchronization primitives in this chapter exist for the cases that remain. Use them correctly, but do not elevate them to the centerpiece of your concurrent design. The best synchronization is the one you did not need.

---
