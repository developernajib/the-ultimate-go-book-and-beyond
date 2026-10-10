## Overview

Stacks and queues are fundamental abstract data types that govern how elements are inserted and removed. While Go doesn't have built-in stack/queue types, they're easily implemented and are crucial for solving many algorithmic problems.

```
┌─────────────────────────────────────────────────────────────────┐
│                  STACK vs QUEUE vs DEQUE                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  STACK (LIFO - Last In First Out)                               │
│  ┌─────┐                                                        │
│  │  3  │ ← Top (push/pop here)                                  │
│  ├─────┤                                                        │
│  │  2  │                                                        │
│  ├─────┤                                                        │
│  │  1  │                                                        │
│  └─────┘                                                        │
│                                                                 │
│  QUEUE (FIFO - First In First Out)                              │
│  ┌───┬───┬───┬───┐                                              │
│  │ 1 │ 2 │ 3 │ 4 │                                              │
│  └───┴───┴───┴───┘                                              │
│    ↑           ↑                                                │
│  front       back                                               │
│  (dequeue)   (enqueue)                                          │
│                                                                 │
│  DEQUE (Double-Ended Queue)                                     │
│  ┌───┬───┬───┬───┐                                              │
│  │ 1 │ 2 │ 3 │ 4 │                                              │
│  └───┴───┴───┴───┘                                              │
│    ↑           ↑                                                │
│  front       back                                               │
│  (can add/remove from both ends)                                │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Junior -> FAANG: Reading the Diagram to Build the Right Mental Model

The three boxes in the diagram above map to three different problem shapes. When you see a problem, identify which box applies before picking a data structure.

- STACK (LIFO): The top is the only accessible element. Problems that require "the most recently seen X" or "reverse the order of X" map to this box. Bracket matching, DFS, undo/redo, expression evaluation.
- QUEUE (FIFO): The front dequeues, the back enqueues. Problems that require "process in arrival order" or "find shortest path level by level" map to this box. BFS, rate limiting, task scheduling.
- DEQUE: Both ends are accessible. Problems that require both "add to back" and "remove stale from front" simultaneously map to this box. Sliding window maximum/minimum, palindrome checking, k-end problems.

**The most common mistake at this level:** Using a queue when you need a stack or vice versa. This produces code that runs without panicking but produces wrong results, which is harder to debug than a crash. Before writing any code, state out loud which of the three boxes applies and why.

**Go-specific implementation note:** In Go, you almost always start with a slice-based stack (`[]int`) or a slice-based BFS queue (`[]SomeType`). Only upgrade to a linked list or ring buffer if you measure a performance problem. The slice-based implementations are correct, readable, and sufficient for all interview problems and most production uses.

### Senior @ FAANG: Stack, Queue, and Deque as ADR Categories

**When to choose a slice-based stack vs. a linked list stack.** The slice-based stack amortizes allocation across pushes (slice doubles in capacity). The linked list stack allocates one node per push with no amortization but no reallocation latency spikes. For latency-sensitive hot paths where the maximum stack depth is unknown but bounded, the linked list stack eliminates the occasional O(n) reallocation. For general use, the slice stack is preferable because it has better cache locality (elements are contiguous in memory) and lower per-element overhead (no pointer per element).

**When to choose a queue (channel) vs. a ring buffer.** Go channels are the idiomatic choice for producer-consumer patterns in concurrent code. They provide built-in back-pressure, blocking semantics, and select compatibility. Ring buffers are the right choice when: (1) you need non-blocking try-enqueue/dequeue semantics. (2) you need to inspect queue occupancy without dequeuing. (3) you need lower overhead than channel synchronization for single-goroutine use. Or (4) you are implementing a high-frequency event loop where channel contention is measurable.

**Deque as a platform primitive.** The monotonic deque pattern (a deque that maintains a sorted invariant) is the foundation of the sliding window maximum algorithm. In a platform context, it fits problems whose answer is an extreme of the window: peak memory usage over the last N seconds in a monitoring system, or "largest value in the last k events" in stream processing. It does not fit percentiles, and that boundary is worth being explicit about, because a monotonic deque is often proposed for latency percentile windows and cannot deliver them. The deque is O(n) precisely because it discards any element that a later, larger element dominates, and those discarded elements are exactly the ones a p99 depends on. Sliding-window quantiles need a structure that retains everything: two heaps for a median, an order-statistic tree for arbitrary ranks, or a t-digest or HDR histogram when an approximation is acceptable, which in latency monitoring it almost always is. A team that has the deque available as a tested library component can ship the extremes case in under a day, and a team that knows the boundary will not spend a sprint trying to make it produce a p99.
