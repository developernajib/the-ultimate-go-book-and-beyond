## Summary

- **Heaps** provide O(log n) insert/extract and O(1) peek for min/max
- **Array representation** stores no child pointers, so a heap is compact and the tree shape lives entirely in index arithmetic. Compact is not the same as cache-friendly: sift paths jump between distant indices, which is why heap sort loses to pdqsort in practice (Section 71.6)
- **Go's container/heap** requires implementing heap.Interface, and your `Less` alone decides min-heap vs max-heap
- **Two-heap pattern** solves median-in-stream efficiently
- **Top K problems** use a heap of size K with *inverted* polarity: min-heap for the K largest, max-heap for the K smallest. The root must be the element you are willing to evict
- **Dijkstra's algorithm** uses a min-heap, and requires non-negative edge weights
- Build heap in O(n) using bottom-up heapify, not repeated insertions

Heaps are essential for priority queues and appear frequently in scheduling, graph algorithms, and stream processing problems.

### Junior → FAANG: Consolidating the Chapter

The summary above lists seven facts. Before moving on, verify that you can demonstrate each one with code, not just state it verbally. "Heaps provide O(log n) insert/extract" means you can write `siftUp` and `siftDown` from scratch. "Go's container/heap requires implementing heap.Interface" means you can write all five methods without looking. "Build heap in O(n)" means you can explain why bottom-up heapify is faster than n insertions.

The most important single skill to exit this chapter with is the ability to choose the correct heap polarity (min vs max) and correct heap size (K vs n-K) for any top-K problem in under 30 seconds, without trial and error. Practise with five random LeetCode top-K problems until this choice is automatic.

### Senior @ FAANG: Heap Mastery as a Platform Competency

At staff level, the summary points above are entry-level competency. The chapter's deeper value is the framework it provides for reasoning about priority and ordering in production systems.

Every production system with dynamic prioritization uses a heap or a heap-like structure: Go's runtime timer heap, Kubernetes scheduler queues, task queues in worker pools, event priority in game engines, and route priority in network switches. A staff engineer who has internalised heap semantics can look at any of these systems and immediately ask the right questions: what is the eviction policy when the heap is full? What happens to the invariant under concurrent modification? How is priority starvation prevented for low-priority elements?

The maturity model for heap usage across a team: Level 1 is "we use container/heap correctly." Level 2 is "we have type-specific heaps in hot paths with benchmarks showing the improvement." Level 3 is "we have a documented decision framework for when to use exact heaps, approximate top-K, and streaming quantile algorithms, and every new heap usage is reviewed against this framework." Driving a team from Level 1 to Level 3 is staff-level impact.
