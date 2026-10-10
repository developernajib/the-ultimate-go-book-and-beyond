## Learning Objectives

By the end of this chapter, you will:
- Implement stacks and queues from scratch using slices and linked lists
- Master monotonic stacks for next greater/smaller element problems
- Understand deque operations and their applications
- Solve bracket matching, expression evaluation, and sliding window problems
- Apply priority queues (heaps) for scheduling and ordering problems

### Junior -> FAANG: Mapping Objectives to Interview Readiness

Each objective in this list has a direct interview application. Implementing stacks and queues from scratch means you can write the six-line slice-based stack without looking it up. Mastering monotonic stacks means you can solve "next greater element" in O(n) instead of O(n^2). Deque operations are the key to sliding window maximum (LeetCode 239). Bracket matching is a common warm-up problem. Priority queues appear in "merge k sorted lists" and scheduling variants.

**First interview habit:** For any problem that involves maintaining a "running" comparison (temperatures warmer than today, rectangles larger than current, brackets not yet matched), ask "does a stack help here?" For any problem that involves processing in order of arrival, or shortest path level by level, ask "does a queue help here?" These two questions redirect most candidates from brute-force O(n^2) to optimal O(n) solutions.

**Prerequisite gap to close:** Many junior candidates know that heaps exist but have never implemented `heap.Interface` in Go. Before interview season, implement a min-heap and a max-heap using `container/heap` and use them in at least two problems. The `container/heap` interface requires five methods: `Len`, `Less`, and `Swap` come from the embedded `sort.Interface`, and `Push` and `Pop` are heap's own. Two details trip people up. `Push` and `Pop` operate on the *end of the slice* and must be defined on a pointer receiver since they change its length, while `Less` and `Swap` can take a value receiver. And `heap.Init` is only needed to heapify a slice that already holds data. If you build the heap by calling `heap.Push` on an empty one, the invariant holds at every step and `Init` is redundant. Fluency with this interface is required for k-way merge, sliding window median, and scheduling problems.

### Senior @ FAANG: Learning Objectives as Team Capability Assessment

At the senior level, these objectives represent a capability baseline that an entire team should meet, not just an individual. The concern is platform readiness: can the team implement and maintain correct, efficient stack and queue structures when a production need arises?

**Governance objective: monotonic stacks.** The monotonic stack pattern is underutilized in production systems because engineers who learned about it in interview preparation do not recognize it in non-interview problem shapes. Production instances include: maintaining a running minimum or maximum over a streaming sensor feed, and finding the nearest previous timestamp with a higher value in a time series, which is a building block for anomaly detection. Be careful about the boundary of the pattern, though. A monotonic structure gives you extremes, not order statistics: it cannot produce a p99 over a sliding window, because discarding dominated elements is exactly what makes it O(n), and a quantile needs the elements a max-deque throws away. Sliding-window quantiles need a different tool, such as two heaps, an order-statistic tree, or a sketch like t-digest if an approximation is acceptable. A team that knows which of these applies can implement running extremes in O(n) instead of O(n^2), and will not reach for a deque on a problem it cannot solve.

**Platform objective: deque as a sliding window primitive.** The ring buffer deque implementation in this chapter is the correct foundation for any sliding window problem in a streaming context. Teams that process time-series data at scale (metrics ingestion, event stream processing) repeatedly solve variants of the sliding window maximum/minimum problem. Having a well-tested, benchmarked ring deque in the team's shared library eliminates duplicate implementations across services.

**Staff-level concern: priority queue correctness under mutation.** The `heap.Fix` function in Go's `container/heap` package is required when a heap element's priority changes after insertion. Teams that use priority queues for task scheduling (as in the task scheduler case study in this chapter) must call `heap.Fix` after updating a task's priority, or the heap invariant is violated silently, causing incorrect scheduling order. "Silently" is the operative word: the heap does not detect the violation, `Pop` simply starts returning the wrong element, and the symptom surfaces far from the mutation that caused it. Code reviews of priority queue implementations should explicitly verify `heap.Fix` is called on every in-place priority update.
