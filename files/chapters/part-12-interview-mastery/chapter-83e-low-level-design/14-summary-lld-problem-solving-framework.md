## 83E.14 LLD Problem-Solving Framework

Every LLD interview follows the same underlying arc: discover what needs to exist, define how it behaves, model the data, implement the critical path, then reason about quality. Internalizing this five-step sequence prevents the most common failure mode, jumping straight to structs before understanding what the system actually needs to do. Use this framework as a mental checklist to stay on track and signal structured thinking to your interviewer.

```
1. CLARIFY requirements (5 min)
   - What entities exist?
   - What operations are needed?
   - What are the constraints?

2. DEFINE interfaces (5 min)
   - What behaviors does the system expose?
   - What can be abstracted for flexibility?

3. DESIGN structs (5 min)
   - What data does each entity hold?
   - What are the relationships?

4. IMPLEMENT core logic (15 min)
   - Start with the most important operation
   - Handle edge cases
   - Add concurrency safety

5. DISCUSS trade-offs (5 min)
   - SOLID principles applied
   - What would change at scale?
   - How would you test this?
```

### Quick Reference: Which Pattern for Which Problem

| Problem | Key Pattern | Key Data Structure |
|---|---|---|
| Parking Lot | Strategy (fee calc) | Map + Mutex |
| Library | State machine (book status) | Maps + Queue (reservations) |
| Elevator | Strategy (dispatch) + State machine | Priority queue |
| Snake Game | Simulation | Deque + Set |
| LRU Cache | - | Hash map + Doubly linked list |
| Min Stack | Auxiliary data structure | Two stacks |
| Twitter Feed | K-way merge | Heap |
| Rate Limiter | Strategy (algorithm) | Token bucket / Window counter |
| Task Scheduler | Greedy | Max-heap |
| File System | Composite (tree) | Trie / N-ary tree |


### Junior → FAANG: LLD Problem-Solving Framework Summary

The LLD problem-solving framework: (1) identify entities and their responsibilities, (2) define the interfaces for each entity, (3) sketch the key data structures and their access patterns, (4) implement the core business logic, (5) handle edge cases and error conditions, (6) discuss extensibility and testability. Following this order prevents the common mistake of jumping straight to implementation and then discovering that the interface design does not support the required behaviors.

### Senior @ FAANG: LLD Framework as a Design Review Checklist

Senior engineers should use the LLD framework as a design review checklist in practice, not just in interviews. Before submitting a code review for a new component, verify: does each type have a single well-defined responsibility, is the component testable in isolation without dependencies on infrastructure, are the interfaces defined at the minimum granularity required by callers, and does the design have clear extension points for the requirements likely to come next quarter. This habit, applied consistently in production code reviews, raises the quality floor for the entire team and directly produces the behavioral stories that work at the L6 level in FAANG interviews.
