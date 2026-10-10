# Chapter 68: Stacks and Queues

> *"Every time you use a stack, you are exploiting the principle of locality."* - Jon Bentley

Stacks and queues are the two most important abstract data types for managing ordered sequences of work. A stack enforces Last-In-First-Out (LIFO) order: the last element pushed is the first popped, mirroring the call stack your operating system uses to track function invocations. A queue enforces First-In-First-Out (FIFO) order: elements are processed in the order they arrive, mirroring how task schedulers, message brokers, and breadth-first search algorithms operate. Both structures deliver O(1) push and pop operations, making them efficient building blocks for algorithms that need to defer, reverse, or sequentially process work without the overhead of arbitrary access.

These two structures are deceptively simple yet unlock a remarkable range of algorithmic power. Stacks are the natural data structure for any problem involving matching, nesting, or backtracking. Validating balanced parentheses, evaluating postfix expressions, implementing undo/redo, and performing iterative depth-first search all reduce elegantly to stack operations. Queues power breadth-first graph traversal, level-order tree processing, and every real-time system that must process events in arrival order. The monotonic stack, a stack that maintains a sorted invariant, appears frequently in hard interview problems, enabling O(n) solutions to problems like "next greater element" and "largest rectangle in histogram" that would otherwise require O(n^2) brute force.

Go's standard library and runtime make heavy use of both structures. A buffered channel is semantically a concurrent bounded FIFO queue with O(1) send and receive. The `container/list` package provides the doubly linked list foundation needed for O(1) deque operations. The goroutine scheduler is a more interesting case, and it is worth knowing precisely rather than as a slogan, because it is a queue design under real constraints: each P owns a fixed 256-entry ring buffer accessed without a lock, plus a single `runnext` slot that deliberately breaks FIFO. A goroutine made runnable by the currently running one goes into `runnext` and jumps the queue, because the two are likely communicating and running them back to back keeps the data in cache. When a P's ring fills, half of it is spilled to a global queue, and that global queue is a linked list guarded by `sched.lock`. So the scheduler is not one lock-free FIFO. It is a bounded lock-free ring, a LIFO fast path for locality, and a lock-protected global overflow list. In production Go microservices, stacks appear in middleware chains (each handler wraps the next, unwinding in reverse), while queues appear in worker pool patterns where jobs are dispatched in order. Understanding the underlying mechanics lets you implement bounded queues, priority queues, and deques tailored to your system's specific throughput and latency requirements.

**What you'll learn in this chapter:**

- Implementing stacks and queues in Go using slices and linked lists, with clear performance trade-offs for each approach
- The monotonic stack pattern for O(n) solutions to "next greater/smaller element" class problems
- Using a stack to implement iterative DFS and evaluate arithmetic expressions
- BFS using a queue for shortest-path problems in unweighted graphs and level-order tree traversal
- Implementing a queue using two stacks and a stack using two queues - classic interview constructs
- The deque (double-ended queue) pattern and its applications in sliding window maximum problems
- Go channel semantics as a concurrent queue and how the scheduler's FIFO run queue works internally
- Edge case mastery: empty stack/queue operations, single-element edge cases, and overflow protection in bounded queues

**Why this matters in interviews:**

Stacks and queues are among the most frequently exercised structures in coding interviews, and they are prerequisite knowledge for the graph and tree chapters. Stack problems (valid parentheses, daily temperatures, largest rectangle in histogram) are commonly used as warm-ups before a harder graph or DP question, on the theory that a candidate who cannot solve these fluently will not survive what follows. BFS and queue problems, particularly shortest-path variants with a twist, are staples of online assessments and first rounds. Monotonic stack problems tend to appear as L4-to-L5 differentiators, since the pattern is hard to fake without understanding the invariant. Stack and queue mechanics also surface inside system design discussions such as designing a rate limiter or a task scheduler. Difficulty ranges from Easy to Hard, and a medium problem is typically expected within fifteen to twenty minutes.

**Prerequisites:** Chapter 65 (Complexity Analysis), Chapter 66 (Arrays and Strings), Chapter 67 (Linked Lists), Go interfaces and slices.

### Junior -> FAANG: What Stacks and Queues Test in Interviews

Interviewers use stack and queue problems because they test a specific type of reasoning: knowing when to defer processing and how to reverse or preserve order without auxiliary data structures. These are not memory-test problems. They are pattern-recognition problems.

The most important thing to internalize at this stage is the mapping from problem type to data structure. The opening intro above lists this mapping. Read it once, then try to reconstruct it from memory. "Nesting or matching" maps to stack. "Level-by-level processing" maps to queue. "Next greater element" maps to monotonic stack. "Sliding window maximum" maps to monotonic deque. Committing this mapping to memory is the first step.

The second most important thing is that Go has no built-in stack or queue type. You implement them with slices. `append` for push or enqueue. `s[:len(s)-1]` for pop. `s[1:]` for dequeue. These three idioms cover the large majority of stack and queue interview code.

Two caveats to file away now, since both are covered properly later in the chapter and both are things interviewers probe. First, `s[1:]` never reclaims the space at the front: it advances the slice header over a backing array that only grows, so a long-lived queue drained this way leaks. It is fine for an interview problem that processes n items and exits, and wrong for a service. That is the motivation for the ring buffer in section 68.2. Second, `s[:len(s)-1]` leaves the popped element in the backing array, so if it is a pointer the object stays reachable and cannot be collected. Both idioms are correct for throughput and wrong for lifetime, which is a distinction worth naming out loud in an interview.

**Common prerequisite gaps at entry level:**
- Confusing LIFO and FIFO: always restate which one you are using at the start of a problem.
- Forgetting to check `len(s) > 0` before indexing: this produces a runtime panic and is the most common single-line bug in stack/queue code.
- Not recognizing that monotonic stack is a variant of stack: it is the same data structure with a loop that maintains a sorted invariant on push.

**Interview entry-point framing:** When you see a problem involving "find next larger," "find nearest smaller," or "evaluate expression," say out loud "this is a stack problem" before writing anything. This signals pattern recognition to the interviewer.

### Senior @ FAANG: Stacks and Queues as Infrastructure Primitives

At the senior level, stacks and queues are not just interview topics. They are infrastructure primitives that appear in middleware chains, goroutine schedulers, message brokers, and rate limiters. The senior-track concern is whether the implementation matches the operational requirements of the system.

**Go channel as a concurrent FIFO queue.** A buffered Go channel `make(chan T, n)` is a bounded concurrent FIFO queue with O(1) send and receive, and internally it is exactly the ring buffer this chapter builds: `hchan` holds a circular array plus `sendx` and `recvx` indices, guarded by a mutex. Note it is not FIFO in every respect: the *values* come out in order, but which blocked goroutine is woken is governed by the sender and receiver wait queues, and an unbuffered channel hands the value directly from sender to receiver without touching the buffer at all. Understanding that a channel is a queue implementation with blocking semantics (send blocks when full, receive blocks when empty) allows you to choose between a channel and a custom ring buffer intelligently. Channels are appropriate when the producer and consumer are goroutines and blocking is the right back-pressure mechanism. Custom ring buffers are appropriate when you need non-blocking behavior (try-enqueue returning false instead of blocking) or when you need metrics like current occupancy.

**Middleware chains as stacks.** The `net/http` middleware pattern in Go is a stack of handlers. Each middleware wraps the next, creating a call chain that unwinds in LIFO order on the response path. The request travels down the stack (middleware A calls middleware B calls the handler) and the response travels back up (middleware B returns to middleware A). Understanding this structure as a stack allows you to reason about which middleware executes first on ingress vs. egress, which matters for authentication (must execute first on ingress), compression (should execute last on egress after all other middleware have added their headers), and logging (should capture the final response status, so it executes last on egress).

**ADR: bounded vs. unbounded queues.** Any queue in a production system should be bounded unless the bounding constraint is explicitly documented as "no bound." Unbounded queues are a latency and memory risk: if the consumer is slower than the producer, the queue grows without limit, consuming heap until OOM. A bounded queue (channel with capacity n, or ring buffer with fixed size) introduces back-pressure: the producer blocks or returns an error when the queue is full. Documenting the chosen bound and the rationale for its size is an L5 engineering standard.

---
