## Learning Objectives

By the end of this chapter, you will:
- Understand heap properties and array-based implementation
- Implement min-heap and max-heap from scratch
- Master Go's container/heap interface
- Solve top-K problems, merge K sorted lists, and median finding
- Apply heaps to scheduling and graph algorithms

### Junior → FAANG: Anchoring the Learning Objectives

Before diving into code, take five minutes to map each objective to a concrete interview problem. "Implement min-heap and max-heap from scratch" maps to the manual siftUp/siftDown code you will write when an interviewer blocks the use of `container/heap`. "Master Go's container/heap interface" maps to every LeetCode Hard involving a priority queue. "Solve median finding" maps directly to LeetCode 295, a problem that regularly separates candidates at the senior boundary.

A common junior gap is treating these objectives as sequential reading rather than skills that must be practiced separately under timed conditions. For each objective, write the code from memory on a blank editor, then verify it compiles and passes tests. Reading solutions does not build retrieval speed under interview pressure.

### Senior @ FAANG: Maturity Model for Heap Mastery

For staff-level engineers, the learning objectives carry an additional dimension: operational maturity. Knowing when to use a heap is L5 competency. L6 competency is knowing when the heap becomes a bottleneck, how to measure it, and how to replace it with a more appropriate structure or algorithm without breaking the abstraction boundary for downstream consumers.

At L7, the scope expands to platform decisions: should the team standardize on a single generic heap implementation, or allow each service to optimize independently? The cost of standardization is reduced per-service tuning. The cost of fragmentation is duplicated bugs (wrong `Pop` semantics, missing `heap.Init` calls) across dozens of services. A staff engineer frames this as a governance question and writes an RFC that establishes a recommended implementation with opt-out justification criteria, rather than mandating or prohibiting either approach. That is the difference between senior individual contribution and staff-level platform thinking.
