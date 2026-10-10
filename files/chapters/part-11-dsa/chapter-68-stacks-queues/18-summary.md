## Summary

- **Stacks** follow LIFO order and are ideal for nested structure processing
- **Queues** follow FIFO order and are essential for BFS and scheduling
- **Monotonic stacks** solve next greater/smaller problems in O(n)
- **Deques** provide O(1) operations at both ends for sliding window problems
- Go's slice makes stack implementation trivial. Long-lived queues benefit from a ring buffer, for bounded memory rather than for speed
- Shrinking a slice of pointers without clearing the vacated slot retains the element: the leak that every structure in this chapter shares
- Expression evaluation and bracket matching are classic stack applications
- BFS with queue enables shortest path finding in unweighted graphs

Mastering these data structures and their applications is essential for solving a wide variety of algorithmic problems efficiently.

### Junior -> FAANG: Summary as a Pre-Interview Readiness Checklist

Before any interview round that may include stack or queue problems, verify that you can do the following from memory without reference material.

- Write a slice-based stack push and pop with a length guard in under sixty seconds.
- Write a two-stack queue (`push`, `pop`, `peek`, `empty`) with correct amortized O(1) reasoning in under ten minutes.
- Identify the monotonic stack variant required for "next greater," "next smaller," "previous greater," and "previous smaller" without pausing to re-derive the pop condition.
- Write the sliding window maximum deque algorithm from scratch in under fifteen minutes, storing indices, not values.
- Write `IsValid` for bracket matching in under five minutes, including the final `len(stack) == 0` check.
- State the three BFS variants (single-source, multi-source, state-space) and give a one-sentence example of each.
- Explain why the ring buffer deque achieves O(1) amortized for all four operations while the slice deque achieves it for only three: `PushFront` allocates and copies, and is the single genuinely O(n) operation in the chapter. `PopFront` on a slice is O(1), not O(n), and being able to say why is worth more than the algorithm itself.
- State what `s = s[1:]` and `s = s[:len(s)-1]` actually cost: O(1) time, and retention of everything the header moved past until the slot is cleared.

If any of these takes longer than the stated time or requires looking up code, spend one more focused practice session on that item specifically.

**Final first-job advice:** Stack and queue problems in production Go code arise most often in three contexts: middleware chains (which are stacks), worker pools with ordered dispatch (which are queues), and stream processing pipelines (which use monotonic deques). The thinking discipline these structures teach, specifically, maintaining invariants under mutation and reasoning about amortized cost, transfers directly to designing these production systems. An engineer who understands why the two-stack queue has amortized O(1) pop is holding the same accounting argument that justifies batching anywhere: buffered writers flushing on fill, LSM compaction, slice growth. An engineer who understands why the monotonic deque discards dominated elements also understands, without being told, why it cannot produce a percentile.

### Senior @ FAANG: Summary as a Platform Capability Assessment

The themes in this summary correspond to platform capability layers for teams that build systems involving ordered work processing.

**LIFO stacks as a middleware and parser primitive.** Any team building HTTP middleware chains, recursive descent parsers, or undo/redo systems is building on a stack. The team's shared library should include a well-tested, generic stack type with documented O(1) amortized push and pop, correct `(T, bool)` return semantics, and thread-safety documentation. The absence of such a type forces every service to reimplement the same six-line slice pattern with the same five pitfalls.

**FIFO queues as a back-pressure mechanism.** Any team building producer-consumer pipelines must choose between Go channels (blocking back-pressure, goroutine semantics) and explicit queues (non-blocking, inspectable occupancy). This choice should be an ADR, not an implicit decision made at implementation time. Document the back-pressure strategy, the queue bound, and the behavior when the queue is full.

**Monotonic stacks as an O(n) optimization opportunity.** Teams processing streaming or time-series data frequently need "next greater value," "nearest previous threshold," or "longest span above baseline" computations. These are all O(n) monotonic stack problems that are often implemented as O(n^2) nested loops because the pattern is not recognized. A team that has internalized the monotonic stack pattern can identify and fix these O(n^2) implementations during code review, which is a direct performance impact on production services.

**Monotonic deque as a sliding window infrastructure primitive.** The ring buffer deque with a monotonic invariant is the foundation for O(1) amortized sliding window maximum and minimum. It is not a foundation for percentiles, and a team that assumes otherwise will spend a sprint discovering it: the deque is O(1) precisely because it throws away every element dominated by a newer one, and those are the elements a p99 is computed from. Window quantiles need two heaps, an order-statistic tree, or a sketch such as t-digest. Teams building metrics pipelines, anomaly detection, or SLO dashboards need both tools and need to know which question each one answers. Investing in a shared, benchmarked deque eliminates duplicate O(n*k) implementations of the extremes case across services.

**Go channel as a concurrent queue with known semantics.** At the staff level, the decision between a Go channel and a custom ring buffer queue is an infrastructure ownership decision. Channels integrate with the scheduler and provide `select` multiplexing. Custom queues provide occupancy inspection and non-blocking semantics. Document the choice for every queue-like structure in a production system so that future engineers understand why the implementation takes the form it does.

**BFS as a graph reachability primitive.** Multi-source BFS is the production algorithm for nearest-resource problems: nearest replica, nearest gateway, nearest available worker. A team that recognizes these problems as multi-source BFS and has a well-tested BFS implementation in its shared library can implement these features correctly in hours rather than days.

**Expression evaluation and bracket matching as parser safety concerns.** Production systems that evaluate user-submitted expressions (formula engines, query builders, configuration DSLs) must implement these algorithms with input validation and nesting depth limits. The stack-based evaluator is the safe approach: it processes one token at a time, maintains explicit state, and can be instrumented with depth counters to reject malicious deeply-nested inputs. The absence of a depth limit is a denial-of-service vulnerability that should be caught in security review.
