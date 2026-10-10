## 71.9 Interview Tips

### Complexity Summary

| Operation | Binary Heap |
|-----------|-------------|
| Find min/max | O(1) |
| Insert | O(log n) |
| Extract min/max | O(log n) |
| Delete arbitrary | O(log n)* |
| Decrease/increase key | O(log n)* |
| Build heap | O(n) |
| Heap sort | O(n log n) |

*Requires index tracking

### When to Use Heaps

The heap's single superpower is O(1) access to the current minimum or maximum combined with O(log n) insertion and extraction, a profile that sorting cannot match when data arrives incrementally. The critical interview insight is the counterintuitive heap-size trick: to track the top-K largest elements seen so far, maintain a min-heap of exactly K elements, because the heap's minimum is the smallest of the K largest, making it the eviction candidate whenever a larger value arrives. Choosing the wrong heap polarity (min vs. max) or the wrong heap size (K vs. n−K) are the two most common mistakes in top-K and streaming-median problems.

```
┌─────────────────────────────────────────────────────────────────┐
│              WHEN TO USE HEAPS                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ✓ Use Heap when:                                               │
│    • Need repeated access to min/max element                    │
│    • Top K problems (k largest/smallest)                        │
│    • Merge K sorted sequences                                   │
│    • Median in a stream                                         │
│    • Priority-based scheduling                                  │
│    • Graph algorithms (Dijkstra, Prim)                          │
│    • Event-driven simulation                                    │
│                                                                 │
│  ✗ Avoid Heap when:                                             │
│    • Need to search for arbitrary element                       │
│    • Need sorted iteration (use BST or sorted array)            │
│    • Only need one-time min/max (use simple scan)               │
│    • Memory is very constrained                                 │
│                                                                 │
│  Min-Heap vs Max-Heap:                                          │
│    • Top K largest: Use min-heap of size K                      │
│    • Top K smallest: Use max-heap of size K                     │
│    • Dijkstra: Use min-heap                                     │
│    • Task with highest priority first: Depends on definition    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Common LeetCode Problems

| Problem | Difficulty | Key Insight |
|---------|------------|-------------|
| 215. Kth Largest Element | Medium | Min-heap of size k |
| 347. Top K Frequent | Medium | Min-heap by frequency |
| 23. Merge K Sorted Lists | Hard | Min-heap of list heads |
| 295. Find Median | Hard | Two heaps |
| 767. Reorganize String | Medium | Max-heap by frequency |
| 621. Task Scheduler | Medium | Math or heap simulation |
| 743. Network Delay Time | Medium | Dijkstra with heap |

### Junior → FAANG: Turning Tips into Interview Habits

The complexity table and the "when to use" decision chart are useful references, but they must become reflexes, not lookups. A concrete habit: when you read any new problem, spend the first 30 seconds asking three questions. Does the problem involve repeated access to the minimum or maximum of a changing collection? Does it mention "k largest", "k smallest", "k-way merge", or "streaming"? Does it involve a graph with weighted shortest paths? If any answer is yes, a heap is likely involved.

The most valuable investment before an interview is to do three timed sessions: LeetCode 215, 23, and 295 from scratch in one sitting. These three problems cover the three canonical heap patterns (top-K, k-way merge, two-heap median) and appear with disproportionate frequency at L4 and L5 interviews.

Common time-wasting mistake: spending too long deciding between QuickSelect and the heap for kth-largest problems. Default to the heap unless the interviewer explicitly asks for O(n) time. QuickSelect has O(n^2) worst case without median-of-medians, which the interviewer may probe.

### Senior @ FAANG: Bar-Raiser Signals in Heap Interviews

A bar-raiser interviewer is not just checking whether you can code a heap. They are assessing whether you can reason about the data structure in context and communicate trade-offs with precision. Several signals elevate a candidate from "hire" to "strong hire" at L5 and above.

The first signal is proactive complexity analysis. After writing the heap solution, volunteer the analysis: "This is O(n log k) time and O(k) space. If k is large (close to n), this degrades toward O(n log n), at which point sorting is just as good and simpler." Mentioning this boundary shows you understand the algorithm, not just the code.

The second signal is awareness of approximation alternatives. For streaming top-K, mention that Count-Min Sketch, Misra-Gries, or Space-Saving processes each event in O(1) with bounded error and fixed memory, which is the right trade for a truly unbounded stream. Keep the names straight, because conflating them is a tell: Misra-Gries (1982) and Space-Saving (2005) are distinct frequent-items algorithms, not two names for one thing, and Count-Min Sketch is a different construction again (a hashed counter matrix that can overestimate but never underestimate). Naming one precisely beats gesturing at all three.

The third signal is implementation hygiene. Call out `heap.Init` explicitly, explain why `Pop` removes from the back of the underlying slice, and show that you track both the heap polarity (min vs max) and the heap-size bound (k) as independent concerns. Engineers who confuse these produce subtle bugs that fail only on specific input orderings.

The fourth signal is production readiness framing. At L6, end the solution with a sentence about what you would add in production: a size bound to prevent unbounded memory growth, a metric for heap depth as a leading indicator of scheduler backpressure, or a circuit breaker that falls back to approximate top-K if the heap size exceeds a threshold. This frames the algorithm as an engineering artifact, not an academic exercise.
