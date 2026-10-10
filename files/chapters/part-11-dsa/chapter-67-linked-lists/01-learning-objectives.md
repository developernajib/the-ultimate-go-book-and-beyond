## Learning Objectives

By the end of this chapter, you will:
- Understand all linked list variants: singly, doubly, circular, and skip lists
- Master the fast-slow pointer technique for cycle detection and middle finding
- Apply dummy nodes to simplify edge cases
- Implement in-place reversal and merge techniques
- Solve classic linked list problems with optimal time and space complexity

### Junior -> FAANG: Translating Objectives into Interview Habits

Each learning objective in this chapter maps to a specific interview checkpoint. Understanding singly and doubly linked lists means you can choose between them in an interview design question, not just define them. Mastering fast-slow pointers means you can apply the pattern to cycle detection, palindrome checking, and middle-finding without needing to re-derive the approach from scratch. Applying dummy nodes is a reflex, not a deliberate decision.

The most important prerequisite gap for junior candidates is the difference between solving a problem and explaining a solution. Interviewers at FAANG evaluate narration as heavily as correctness. Practice saying the invariant that holds after every pointer assignment. Practice explaining why you chose a dummy node rather than treating it as a default habit.

**Interview entry-point framing:** For any linked list problem, establish four things before coding: the structure type (singly, doubly, circular), whether the head can change, whether cycles are possible, and what constitutes an edge case (nil, one node, two nodes). Answering these four questions out loud takes thirty seconds and prevents the most common classes of bugs.

### Senior @ FAANG: Learning Objectives as Platform Maturity Indicators

Senior engineers are evaluated not just on whether they can implement these constructs, but on whether they have internalized them deeply enough to teach, review, and govern their use across a team.

**ADR signal for each objective:** The ability to choose between singly and doubly linked lists under constraints (memory vs. O(1) tail deletion) is an architectural judgment, not a textbook answer. During design reviews, the right question is "what operations does the consumer actually need?" rather than "which list variant is better?" A singly linked list with a tail pointer satisfies most queue workloads with half the pointer overhead of a doubly linked list.

**Governance concern: skip lists.** Skip lists are listed as an objective but are rarely implemented from scratch in production Go code. Redis uses one for sorted sets, paired with a hash table that maps member to score, because a skip list gives ordered range queries with far less implementation complexity than a balanced tree. The often repeated claim that Redis chose skip lists for lock-free concurrency is wrong: Redis executes commands on a single thread, so there is no concurrency for the structure to be free of. In Go services, the equivalent need is usually satisfied by `btree` packages or sorted-set abstractions over Redis itself. A senior engineer's job is to recognize when a skip list is the right native implementation versus when an external system already provides the capability with better operational characteristics.

**Bar-raiser indicator for fast-slow pointers.** A candidate who demonstrates Floyd's algorithm with the mathematical proof (L = nC - K) rather than memorizing the two-phase structure signals deep algorithmic reasoning. The proof shows why the approach works, which allows the candidate to adapt the technique to novel problems that share the same mathematical structure, such as finding the entry point of a rho-shaped path in a functional linked list.

**Staff-level concern: teaching and code review.** At L6 and L7, the ability to identify which objective a junior engineer is missing from a code review is as valuable as the ability to implement the objective yourself. A code reviewer who sees `curr.Next.Next` without a nil guard and can immediately point to "missing fast-slow loop termination condition" with a reference to the correct pattern is operating at the governance level, not just the implementation level.
