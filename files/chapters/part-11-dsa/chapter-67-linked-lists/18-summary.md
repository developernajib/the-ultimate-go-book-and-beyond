## Summary

- **Singly linked lists** provide O(1) insertion at head but O(n) for tail operations
- **Doubly linked lists** provide O(1) for both head and tail but use more memory
- **Fast-slow pointers** solve cycle detection, middle finding, and many other problems
- **Dummy nodes** simplify edge cases when the head might change
- **In-place reversal** is a key technique for many list manipulation problems
- **Skip lists** provide O(log n) operations probabilistically
- Always draw diagrams and trace through small examples before coding

Understanding linked lists deeply prepares you for implementing more complex data structures like graphs, trees, and hash tables, which often use linked structures internally.

### Junior -> FAANG: Summary as a Pre-Interview Checklist

Before any interview round that may include linked list problems, verify that you can do the following from memory:

- Implement `ReverseList` iteratively in under two minutes using three pointers (`prev`, `curr`, `next`).
- Implement `HasCycle` with the correct loop guard (`fast != nil && fast.Next != nil`).
- Implement `MergeTwoLists` with a dummy head and without special-casing the initial head choice.
- State the O(1) space advantage of the fast-slow pointer over a hash set for cycle detection.
- State the difference between the two fast-slow termination conditions for middle finding (first vs. second middle).
- Explain why LRU cache requires a doubly linked list rather than a singly linked list.
- Explain why skip lists are used in Redis sorted sets instead of balanced BSTs, and why "for lock-free concurrency" is the wrong answer.

If you can do all seven from memory with clean code, you are ready for the linked list section of any L4/L5 interview. If any of them require looking up reference code, spend one more focused practice session on that specific item.

**Final first-job advice:** The most important linked list skill in production Go code is knowing when NOT to use a linked list. If your access pattern is sequential or indexed, use a slice. If your access pattern requires O(1) deletion by reference with maintained ordering, use a doubly linked list. If your access pattern requires O(log n) ordered access with range queries, use a skip list or a btree package. Most Go engineers go months or years between linked list implementations in production code. But the thinking discipline these structures teach, pointer manipulation, invariant maintenance, edge case enumeration, is used every day.

### Senior @ FAANG: Summary as a Platform Maturity Assessment

The themes in this summary correspond to platform capability layers for teams that work with ordered, pointer-connected data structures.

**Singly vs. doubly linked as a foundation decision.** Teams that operate large-scale caches, feed systems, or event queues need to make this decision explicitly in a design document. The wrong default choice (singly linked when doubly linked operations are needed) costs O(n) on every deletion, which becomes a latency regression at scale.

**Fast-slow pointers as an algorithmic library.** A team's shared algorithmic library should include `FindMiddle`, `HasCycle`, `DetectCycle`, and `GetIntersection` as tested, benchmarked primitives. Reimplementing these in each service creates fragmentation and reintroduces known bugs.

**Dummy nodes as a code style standard.** Teams should codify the dummy node pattern as a required coding style for any linked list function that modifies the head. This is a line in the team's style guide, not just informal knowledge.

**In-place reversal as a memory discipline indicator.** Engineers who can implement in-place reversal cleanly have internalized the principle of O(1) space mutation, which generalizes to in-place array rotation and the three-reversal rotation trick. Do not reach for the XOR swap as an example of this: it is folklore, not optimization. It is no faster than a temporary variable on any modern compiler, it is harder to read, and it silently zeroes the value when both operands are the same location, which is exactly the aliasing case an in-place algorithm hits. The discipline worth teaching is reusing existing storage, not eliminating a register. This principle is directly relevant to stream processing and embedded systems where allocation budget is constrained.

**Skip lists as a platform service decision.** At the staff level, the decision to implement a skip list natively vs. delegating to Redis ZSET is an infrastructure ownership decision with operational implications. Document the decision and its dependencies explicitly.

**LRU cache as a shared infrastructure component.** Any organization that has LRU caches in more than three services should have a shared, instrumented, tested LRU package. The implementation should expose hit rate, eviction rate, and current size as Prometheus metrics so cache efficiency can be monitored in production dashboards. The absence of such a shared package is a platform maturity gap at L6/staff level.
