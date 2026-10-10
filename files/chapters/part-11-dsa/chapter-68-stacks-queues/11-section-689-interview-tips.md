## 68.9 Interview Tips

### Complexity Summary

| Operation | Stack (Slice) | Queue (Slice) | Queue (Linked) | Deque (Ring) |
|-----------|---------------|---------------|----------------|--------------|
| Push/Enqueue | O(1)* | O(1)* | O(1) | O(1)* |
| Pop/Dequeue | O(1) | O(1)† | O(1) | O(1) |
| Peek | O(1) | O(1) | O(1) | O(1) |
| Size | O(1) | O(1) | O(1) | O(1) |

*Amortized (occasional O(n) reallocation, averaged over the sequence)

†O(1) in time. The slice queue's cost is memory, not speed: `q = q[1:]` walks the header forward and never reclaims what it passes, so peak memory tracks total elements enqueued rather than elements currently held. Every row in this table is O(1) or amortized O(1), which is the real headline: none of these structures differ meaningfully in per-operation *time*. They differ in memory behaviour and in whether capacity is bounded. Choose on that basis.

The one genuinely expensive operation in this chapter is `PushFront` on a slice-backed deque, which is O(n) because it allocates and copies. It is not in this table because the ring deque exists specifically to avoid it.

### Pattern Recognition

Choosing the right data structure is the first decision interviewers evaluate: stacks are the natural fit whenever processing order must be reversed or nested (LIFO), while queues preserve arrival order for level-by-level traversal (FIFO). A monotonic stack adds a further constraint (elements are kept in strictly increasing or decreasing order by popping dominated values), which enables O(n) solutions to "next greater element" problems that would otherwise require O(n²) pairwise comparisons.

```
┌─────────────────────────────────────────────────────────────────┐
│                  WHEN TO USE STACK vs QUEUE                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Use STACK when:                                                │
│  • Processing nested structures (brackets, recursion)           │
│  • Need to reverse order                                        │
│  • DFS traversal                                                │
│  • Undo/redo operations                                         │
│  • Expression evaluation                                        │
│  • Finding next greater/smaller (monotonic stack)               │
│                                                                 │
│  Use QUEUE when:                                                │
│  • BFS traversal                                                │
│  • Level-order processing                                       │
│  • Scheduling (FIFO order)                                      │
│  • Buffering                                                    │
│                                                                 │
│  Use DEQUE when:                                                │
│  • Sliding window problems                                      │
│  • Need both stack and queue operations                         │
│  • Maintaining sorted window                                    │
│                                                                 │
│  Use MONOTONIC STACK when:                                      │
│  • Next greater/smaller element                                 │
│  • Largest rectangle in histogram                               │
│  • Stock span problems                                          │
│  • Temperature problems                                         │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Common LeetCode Problems

| Problem | Type | Key Insight |
|---------|------|-------------|
| 20. Valid Parentheses | Stack | Match closing with most recent opening |
| 155. Min Stack | Stack | Auxiliary stack for minimums |
| 232. Queue using Stacks | Stack | Two stacks for amortized O(1) |
| 84. Largest Rectangle | Monotonic | Pop when smaller found |
| 42. Trapping Rain Water | Monotonic/DP | Track bounded height |
| 239. Sliding Window Max | Deque | Monotonic decreasing |
| 200. Number of Islands | BFS Queue | Flood fill per unvisited cell - mark on enqueue |
| 286. Walls and Gates | BFS Queue | Multi-source BFS: seed the queue with every gate |

### Junior -> FAANG: Using the Tips Under Interview Pressure

The complexity table is a tool for self-checking. If your linked list queue has O(n) enqueue, you forgot the `rear` pointer and are walking the list to find the end. If your ring buffer has O(n) anything, you are shifting elements instead of moving indices. Check your implementation against the table before saying you are done.

Do not "fix" a slice queue's O(1) dequeue into something slower because you were told reslicing is O(n). It is not, and this is the single most common piece of misinformation about Go slices. If you need to justify a ring buffer, justify it on memory, which is the actual reason it exists.

The pattern recognition diagram is the first step in every problem. Practice running through it in under ten seconds per problem. "Does this problem involve nested structure or reversal? Stack. Level by level processing? Queue. Both ends? Deque. Next greater/smaller? Monotonic stack."

**The LeetCode problem table for interview preparation.** You should be able to solve every problem in the table from memory before interview day. The expected times for an L4 candidate are: Easy problems in under ten minutes, Medium problems in under twenty minutes. If any problem takes longer, spend another practice session on it specifically.

**Follow-up preparation.** Four follow-ups recur in almost every round: "What if the input is very large?" (streaming, or bound the structure and apply back-pressure), "Can you do it in O(1) space?" (identify which auxiliary structure can be eliminated, as the two-pointer `Trap` eliminates the stack), "How would you handle concurrent access?" (mutex or channel, and note that an LRU-style touch-on-read makes RWMutex useless), and "What is the worst-case time complexity?" Answer that last one precisely and distinguish it from the amortized cost: the two-stack queue is O(1) amortized per operation with an O(n) worst case on a single operation, and saying "O(1)" without the qualifier is the mistake the question is fishing for.

**Pattern-to-problem shortcuts:**
- If the problem says "balanced parentheses," use a stack.
- If the problem says "shortest path in a grid," use BFS.
- If the problem says "next greater element" or "daily temperatures," use a monotonic stack.
- If the problem says "sliding window maximum/minimum," use a monotonic deque.
- If the problem says "process in order" or "level order," use a queue.

### Senior @ FAANG: Interview Tips as Bar-Raiser Calibration

**Using the complexity table in code reviews.** The complexity table represents the expected performance contract for each operation. A code review of a new queue implementation should verify: (1) enqueue is O(1), amortized or strict, and which one is documented. (2) dequeue is O(1) for all three backings, with the plain slice's unbounded memory growth documented rather than mislabelled as a time cost. (3) peek is O(1). (4) pops clear the vacated slot when the element type contains pointers. Any implementation that does not meet these contracts should either document the deviation with a rationale or be rewritten. Point (4) is the one that actually gets missed in review, because it is invisible in every test that does not measure the heap.

**The pattern recognition diagram as a team onboarding tool.** New engineers joining a team that does significant algorithmic work should receive the pattern recognition diagram as part of their onboarding materials. Being able to recognize which data structure to apply to a problem is a prerequisite for contributing to the codebase, not an advanced skill. Formalizing this pattern map as a team resource reduces the time from "new hire" to "independent contributor" on algorithmic feature work.

**Bar-raiser evaluation of the problem table.** A bar raiser who asks candidates to solve any problem in the table is not testing LeetCode memorization. They are testing whether the candidate can explain the key insight of the solution, identify the alternative approaches and their trade-offs, describe the edge cases and how the implementation handles them, and extend the problem to a harder variant. Candidates who can do all four for every problem in the table are demonstrating L5-level problem-solving fluency.

**Senior-specific follow-up: "How would you test this at scale?"** Beyond the four standard follow-ups, a senior interview adds: "How would you test this implementation at 10x the expected load?" The expected answer involves: (1) load testing with realistic input distributions (not just worst-case), (2) memory profiling to identify allocation hotspots, (3) goroutine leak detection for concurrent implementations, and (4) fault injection to verify correct behavior under partial failures (e.g., what happens when the queue consumer goroutine panics?). An L5 candidate who adds this question unprompted demonstrates senior-level ownership of their implementation.
