# Chapter 71: Heaps and Priority Queues

> *"A heap hands you the most important element for free and charges only a logarithm for everything else."*
> - Unknown

A heap is a complete binary tree stored compactly in an array, where every parent node satisfies the heap property: in a min-heap, the parent is always smaller than or equal to its children. In a max-heap, the parent is always larger. This invariant guarantees that the minimum (or maximum) element is always at the root, index 0 of the backing array, and can be accessed in O(1). Insertion and deletion of the root both operate in O(log n) by bubbling elements up or down the tree to restore the heap property. The heap is the most efficient data structure for repeatedly extracting the highest-priority element from a dynamically changing collection, which is exactly what schedulers, event loops, and streaming algorithms need to do continuously.

The heap's O(log n) push and O(log n) pop operations, combined with O(1) peek, make it the natural implementation for a priority queue, an abstract data type that dequeues elements in priority order rather than arrival order. Priority queues are architectural primitives in production systems: the Go runtime keeps a per-P timer heap ordered by expiry, so every `time.Sleep` and `context.WithDeadline` registers a heap entry. Kubernetes uses priority queues to schedule pods. Dijkstra's shortest-path algorithm relies on a min-heap for O((V + E) log V) performance. Huffman coding builds an optimal compression tree by repeatedly merging the two lowest-frequency heap entries. In data streaming, a fixed-size min-heap of k elements maintains the k largest values seen so far in O(n log k) time, the foundation of "top-k" analytics at scale.

Go's standard library provides heap functionality through the `container/heap` interface, which requires implementing `Len`, `Less`, `Swap`, `Push`, and `Pop` on any slice type. The design is intentionally generic and interface-driven: you bring the data type, the heap package provides the O(log n) sift operations. This pattern is idiomatic Go, composable and testable. However, the interface-based approach introduces indirection overhead that matters in hot paths. Production Go services often implement inline min-heaps for specific types to eliminate interface dispatch. Understanding both the standard library approach and the underlying array-index arithmetic (`parent = (i-1)/2`, `left = 2i+1`, `right = 2i+2`) gives you the foundation to implement either.

**What you'll learn in this chapter:**

- Heap structure and the complete binary tree-to-array mapping: parent/child index arithmetic and why it works
- Building a heap from an unsorted array in O(n) using the heapify-down (Floyd's algorithm) approach, faster than n insertions
- Go's `container/heap` interface: implementing a custom min-heap and max-heap for integer and struct types
- Heap sort: an in-place O(n log n) sorting algorithm derived directly from heap operations
- The "k largest / k smallest elements" pattern using a fixed-size heap for O(n log k) streaming solutions
- Merge k sorted lists/arrays using a min-heap for O(n log k) time, a canonical FAANG hard problem
- Median of a data stream: maintaining two heaps (max-heap for lower half, min-heap for upper half) for O(log n) insert and O(1) median
- Go runtime timer heap and Kubernetes scheduler priority queue as real-world case studies

**Why this matters in interviews:**

Heaps are a staple of senior-level coding rounds, and the frequency rises at staff level and above. A heap question tests whether you know when a fully sorted structure is unnecessary overkill: "you do not need a BST here, a heap suffices" is a signal of mature algorithmic thinking. System design rounds frequently ask for top-k leaderboards or real-time analytics, which demand heap-based solutions at scale. Media and audio pipelines are priority-queue-driven, and so are most task schedulers, so the topic surfaces well beyond the algorithms round. Difficulty: Medium to Hard. The k-way merge and median-of-stream problems are considered Hard and are among the most valuable patterns to master before any senior engineering interview.

**Prerequisites:** Chapter 65 (Complexity Analysis), Chapter 66 (Arrays and Strings), Chapter 70 (Trees and Binary Search Trees), Go interfaces and the `container/heap` package.

### Junior → FAANG: Understanding Why Heaps Exist

Many entry-level candidates can implement a sort but have never thought about what happens when data keeps arriving. The heap's origin story is straightforward: sorting the entire collection every time a new element arrives costs O(n log n) per insertion, which is unacceptable for streaming data. The heap solves this by maintaining just enough structure to answer one specific question, "what is the current minimum or maximum?", in O(1) while inserting or removing in O(log n).

The array representation is the part that surprises most juniors. There is no `left` or `right` pointer anywhere. The entire binary-tree shape is encoded in the index arithmetic: parent at `(i-1)/2`, left child at `2i+1`, right child at `2i+2`. Draw a small heap (seven elements), label the indices 0 through 6, and verify the formulas by hand before your interview. This exercise takes ten minutes and permanently locks the layout in memory.

Common first-job mistakes include: using `container/heap` without calling `heap.Init`, forgetting that `Pop` removes from the internal back of the slice (not the conceptual root), and choosing a max-heap when a min-heap is needed for top-K largest problems. The min-heap-for-K-largest trick is counterintuitive but worth memorizing as a rule: "to keep the K biggest, evict the smallest, so use a min-heap of size K."

Entry-level interview entry point: be ready to write the `heap.Interface` boilerplate in under two minutes. Practice until it is mechanical.

### Senior @ FAANG: Heap-Aware Platform and System Design

A bar-raiser at L6/L7 does not just ask whether you know the `container/heap` interface. The evaluation centers on whether you understand the hidden costs and know when to deviate from the standard approach.

**Interface dispatch overhead in hot paths.** Go's `container/heap` calls `Less` and `Swap` through an interface, paying a vtable dispatch and a potential cache miss on every comparison. In services processing tens of millions of events per second (ad auction tick processing, real-time bidding, telemetry ingestion), this overhead is measurable. Staff engineers at this scale write type-specific inline heaps: a `[]uint64` with siftDown inlined, zero allocations per operation, and CPU-cache-friendly access patterns. An ADR for this decision should document: measured interface overhead in nanoseconds, the allocation profile under `pprof`, and the business latency SLA that justifies the maintenance cost of a hand-rolled implementation.

**Memory pressure and GC interaction.** A heap of pointers (common in priority-queue-of-tasks patterns) places pressure on the garbage collector because every GC cycle must trace every pointer. For long-lived heaps with thousands of elements, switching from `[]*Task` to `[]Task` (value types) eliminates pointer tracing entirely and reduces GC pause contribution. This is a staff-level observation that separates engineers who tune systems from engineers who only implement algorithms.

**Fibonacci heap as a theoretical ceiling.** The Fibonacci heap achieves O(1) amortized decrease-key, which is why Dijkstra's algorithm has a theoretical O(V log V + E) bound with it. In practice, Fibonacci heaps have large constants and poor cache behavior, making the simpler binary heap faster for graphs with millions of edges on modern hardware. A senior engineer should be able to explain this trade-off precisely, including why Go's standard library does not ship a Fibonacci heap and why that is the correct decision.

**Platform thinking: heap as a service primitive.** The conceptual heap surfaces all over distributed systems. The Kubernetes scheduler, for example, drains a heap-backed active queue and parks failed pods in a backoff queue, tuned so low-priority pods do not starve. Staff-level engineers own the decision of which data structure backs these queues. An architectural decision here includes: bounded vs. unbounded queue semantics, eviction policy under memory pressure, and observability hooks (queue depth, wait time percentiles) to detect priority inversion before it causes SLA breaches.

**Bar-raiser signal.** At L6 and above, the interviewer is testing whether you can identify the moment when a heap-based solution becomes a liability, not just when it is appropriate. A bounded `k=50` heap streams the top 50 of a huge event feed in one O(n log k) pass with 50 slots of memory, which beats sorting outright. But top-k *by frequency* first needs a counter per distinct key, and that table, not the heap, is what blows up: distinct keys grow without bound while k stays at 50. Recognizing that the heap was never the bottleneck, and reaching for a Count-Min Sketch plus approximate top-k to bound the counting side, is the level of precision expected.

---
