# Chapter 67: Linked Lists

> *"A data structure is not just a way of organizing data, but also a way of thinking about problems."* - Robert Sedgewick

A linked list is a chain of nodes where each node holds a value and a pointer to the next node (and in doubly linked lists, also to the previous). Unlike arrays, linked lists require no contiguous memory. Each node can live anywhere on the heap, connected only by pointers. This makes insertion and deletion O(1) when you already hold a reference to the target node, at the cost of O(n) access time since there is no index-based arithmetic to jump directly to position k. The trade-off is fundamental: linked lists trade random access for structural flexibility, making them the right tool for problems that require frequent mid-sequence modifications at known positions.

Linked lists are a staple of technical interviews because they test pointer manipulation, recursive thinking, and the ability to reason about memory without a safety net. Interviewers use linked list problems to assess whether candidates can manage multiple moving pointers simultaneously without losing track of node references, a skill that maps directly to debugging complex state machines and concurrent data structures in production. Problems like reversing a list in-place, detecting cycles with Floyd's algorithm, and merging k sorted lists are considered fundamental knowledge at the senior engineer level, expected to be solved fluently and discussed in terms of their O(n) time and O(1) space characteristics.

In Go, linked lists appear in several important places. The `container/list` package implements a general purpose doubly linked list. The runtime uses intrusive linked lists internally: a goroutine carries a `schedlink` field so the scheduler can thread it onto the global run queue without a separate allocation, and `sync.Pool` chains its per-P storage as a linked list of ring buffers. LRU caches, a canonical system design component, are implemented as a doubly linked list paired with a hash map, combining O(1) lookup with O(1) insertion and eviction. Go's garbage collector traces pointer graphs that are, structurally, linked list traversals. Understanding linked list mechanics at the pointer level prepares you to reason about these real systems and to implement custom, allocation-efficient data structures when the standard library falls short.

**What you'll learn in this chapter:**

- Singly and doubly linked list structures in Go using structs and pointers, with clear node and list type definitions
- Pointer manipulation fundamentals: safe traversal, nil checks, and avoiding dangling references
- Floyd's cycle detection algorithm (fast and slow pointer) for O(1) space cycle finding
- In-place reversal of singly and doubly linked lists in O(n) time and O(1) space
- Merge operations: merging two sorted lists and merging k sorted lists using a min-heap
- Finding the middle node, kth node from the end, and intersection point of two lists
- Implementing an LRU cache from scratch using a doubly linked list and a Go map
- Recursive vs. iterative linked list solutions and when each approach is cleaner in Go

**Why this matters in interviews:**

Linked list problems are a recurring category in coding interview rounds at large technology companies. A common variant combines linked lists with recursion, such as reversing nodes in k-groups or flattening a multilevel doubly linked list, testing both pointer fluency and recursive reasoning. Interviewers also use linked list questions to evaluate clean code structure and edge case handling (empty list, single node, even/odd length). System design rounds often require candidates to implement or describe LRU/LFU cache internals, making the doubly linked list plus hash map pattern essential knowledge. Difficulty spans Easy (reverse a list) through Hard (reverse k-group, merge k sorted lists), and a medium problem is typically expected to be solved and explained within about twenty minutes.

**Prerequisites:** Chapter 65 (Complexity Analysis), Chapter 66 (Arrays and Strings), Go pointers and structs (Chapter 4).

### Junior -> FAANG: Building the Pointer Mental Model

New engineers often struggle with linked lists because they conflate the node, the pointer to the node, and the list itself. The first habit to build is drawing boxes and arrows before writing a single line of code. Draw each node as a box, draw each pointer as an arrow, then trace through your algorithm on paper for a three-node list. Only write code after the diagram is correct.

The second gap is nil handling. Every function that receives a `*ListNode` must treat nil as a valid input representing the empty list, not an error. Omitting the nil guard is the most common cause of runtime panics in entry-level linked list code.

The third gap is understanding why interviewers use linked lists. They are not testing whether you know the definition. They are testing whether you can reason about mutable shared state: two pointers pointing at the same node, a loop that modifies the structure it is iterating, and an algorithm that must return a node from the middle of a list without losing the head. These concerns map directly to concurrency bugs and state-machine errors in production code.

**Entry-level interview framing:** When you see a linked list problem, say out loud what the head pointer represents, what invariant the list maintains after each operation, and what must remain true when your function returns. Interviewers evaluate this narration as a signal of structured thinking.

**Common first-job habits to develop:**
- Always use a dummy head node when the function might change the head pointer.
- Keep a local `curr` cursor and never reassign the parameter `head` during iteration.
- After any pointer reassignment, verify the old pointer is either saved or no longer needed.
- Test every function on nil, a one-node list, and a two-node list before claiming correctness.

### Senior @ FAANG: Linked Lists as a Platform Capability

At the senior level, linked list problems in interviews are evaluated on dimensions beyond correctness. The interviewer is looking for evidence that you think about data structure choice systematically, can articulate trade-offs at the architectural level, and have seen these structures inside real systems.

**ADR framing: when to choose a linked list over a slice.** In Go, the default sequential container is the slice. Choosing a linked list over a slice requires a justification that survives a code review. The two cases where a linked list wins unambiguously are: (1) O(1) deletion of a node when you already hold a direct reference to it, which is the core property that makes LRU cache eviction possible without heap operations. And (2) intrusive lists in systems programming where nodes are embedded inside larger structs to avoid secondary allocations. The `runtime` package uses intrusive lists in its goroutine scheduler precisely because every allocation in the scheduler is a latency hazard.

**Platform thinking: designing generic list infrastructure.** A staff-level concern is whether a linked list implementation belongs in the application or in a shared internal library. An application-level LRU cache duplicated across twenty services becomes a maintenance liability when the eviction policy needs to change. The right answer is a well-tested, benchmarked, concurrency-safe LRU package with a stable interface that teams import. The interface should expose the policy, not the mechanism: callers should not need to know that the implementation uses a doubly linked list paired with a hash map.

**Maturity model for linked list usage in production Go code:**
- Level 1: Uses `container/list` with interface{} values and type assertions. Works but is not type-safe.
- Level 2: Implements a typed doubly linked list with generics, with a documented eviction or ordering policy.
- Level 3: Instruments the implementation with Prometheus metrics (hit rate, eviction rate, list depth), has benchmarks at realistic sizes, and uses `sync.RWMutex` with documented lock granularity rationale.
- Level 4: Considers whether the list is the right abstraction at all. For LRU caches above a certain size, a sharded implementation with per-shard locks eliminates contention at the cost of slightly imprecise eviction ordering, which is an acceptable trade-off documented in a design doc.

**Bar-raiser interview signal.** When a bar raiser asks "how would you implement an LRU cache for a distributed system?" the expected answer goes beyond a doubly linked list plus hash map. The answer should address: where does the cache live (in-process vs sidecar vs Redis), how do you handle eviction across nodes (approximate LRU with local shards is often sufficient), how do you measure cache effectiveness (hit rate percentile by key cardinality), and how do you safely invalidate entries when the backing store changes (version vectors or TTL). Candidates who give only the single-node implementation answer signal L4 thinking at best.

**L6/L7 concern: memory pressure and GC impact.** A large linked list with millions of pointer-connected nodes creates significant GC pressure in Go because the collector must trace every pointer on every mark cycle. Go's mark phase runs concurrently, so the visible symptom is usually not a longer stop-the-world pause but higher background GC CPU and more mark assist work stolen from your own goroutines. For extremely large lists, replacing node pointers with a flat slice of nodes plus integer indices (a "pool allocator" pattern) removes those pointers from the scan graph entirely, and if the element type ends up pointer-free the allocator can mark the whole span as containing no pointers and skip scanning it. Measure before adopting this, and record the benchmark evidence in a design doc.

---
