## Overview

Dynamic Programming (DP) is a technique for solving problems by breaking them into overlapping subproblems and storing their solutions to avoid redundant computation. It's one of the most powerful algorithmic techniques and appears frequently in coding interviews.

```
┌─────────────────────────────────────────────────────────────────┐
│                DYNAMIC PROGRAMMING ESSENCE                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Two Key Properties:                                            │
│                                                                 │
│  1. OPTIMAL SUBSTRUCTURE                                        │
│     Solution to problem can be built from solutions             │
│     to smaller subproblems                                      │
│                                                                 │
│     fib(5) = fib(4) + fib(3)                                    │
│                                                                 │
│  2. OVERLAPPING SUBPROBLEMS                                     │
│     Same subproblems are solved multiple times                  │
│                                                                 │
│                    fib(5)                                       │
│                   /     \                                       │
│               fib(4)    fib(3)  ← computed twice!               │
│              /    \    /    \                                   │
│          fib(3) fib(2) fib(2) fib(1)                            │
│         /    \                                                  │
│     fib(2) fib(1)                                               │
│                                                                 │
│  Two Approaches:                                                │
│                                                                 │
│  TOP-DOWN (Memoization):                                        │
│  • Start with main problem                                      │
│  • Recursively solve subproblems                                │
│  • Cache results in memo table                                  │
│                                                                 │
│  BOTTOM-UP (Tabulation):                                        │
│  • Start with smallest subproblems                              │
│  • Build up to main problem                                     │
│  • Fill dp table iteratively                                    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Junior → FAANG: Connecting the Concept to Interview Reality

The Fibonacci overlap diagram above is not just illustrative. Draw this tree on a whiteboard during an interview when explaining why naive recursion is O(2^n) and why memoization brings it to O(n). The visual makes the argument concrete and shows the interviewer that you understand the cost model, not just the solution.

The two-approach split is your first decision in any DP interview. Top-down memoization is faster to write correctly because the recursive structure mirrors the problem statement. Bottom-up tabulation is faster to execute and avoids stack depth issues. In a 45-minute interview, start top-down if you need to verify your recurrence quickly, then mention you would convert it to bottom-up for production. Narrating that trade-off out loud is worth as much as the code.

A common first-job mistake is writing the memo map with a string key (e.g., `fmt.Sprintf("%d_%d", i, j)`) when an integer pair or a 2D array would be both faster and safer. In Go, struct keys in maps are idiomatic for multi-dimensional memoization: `type key struct{ i, j int }` with `memo := make(map[key]int)`.

### Senior @ FAANG: The DP Mental Model at Scale

The diagram above compresses two ideas that become nuanced at the platform level. "Optimal substructure" is not a binary property. It is a spectrum. Some problems have optimal substructure only under specific constraint sets, and adding a new business constraint (e.g., "but you cannot use more than k distinct items") can break the existing recurrence and require a new state dimension. Senior engineers document the conditions under which the substructure holds so that future constraint additions can be evaluated against those conditions before modifying any code.

"Overlapping subproblems" also has a production implication beyond academic correctness. In distributed systems, the memoization table is often a shared cache (Redis, Memcached), and the eviction policy determines whether the overlap benefit is actually realized in production. A memoized algorithm that is linear on paper can degrade toward its unmemoized cost if eviction keeps throwing away entries before they are reused. Staff-level engineers model the working-set size of the DP table against the cache capacity and TTL before deploying a memoized approach at scale.

The top-down versus bottom-up choice is also a testability and debuggability choice. Top-down memoization allows writing tests at individual subproblem boundaries (test that `f(3, 5)` returns the expected value). Bottom-up tabulation makes the full table inspectable in a debugger or log dump, which aids postmortem analysis when a production result is wrong. Neither is universally superior. The team's operational context should drive the choice.

### Junior → FAANG: Internalizing the Two Properties Before Every Problem

Every DP interview starts with the same mental gate: does this problem have optimal substructure and overlapping subproblems? If you skip this check and jump to coding, you risk implementing an exponential recursion that happens to look like DP but provides no memoization benefit.

A reliable two-minute check: draw the recursion tree for the smallest non-trivial input (n=4 for Fibonacci, amount=5 for coin change with coins [1,2]). If the same sub-tree appears more than once, overlapping subproblems are confirmed. Then ask: "if I knew the optimal answer for each sub-tree, could I compute the full answer?" If yes, optimal substructure is confirmed. Only after both checks should you move to state definition and recurrence.

Go-specific first habit: always use a named key type for multi-dimensional memoization. Declare `type state struct{ i, j int }` and use it as the map key. String-keyed memos (`fmt.Sprintf("%d,%d", i, j)`) are slower due to string allocation and hashing, and they make the intent less clear to code reviewers.

### Senior @ FAANG: The Diagram as a Documentation Artifact

The Fibonacci recursion tree in this section is not just a teaching aid. It is the class of diagram that belongs in every ADR for a DP system. A well-drawn recursion tree for the problem at hand communicates three things to future maintainers: which subproblems are shared, why memoization is beneficial, and what the call depth is for the largest expected input. Attaching it to the PR that introduces a DP implementation saves the next engineer from reverse-engineering the recurrence out of the loop bounds.

For production systems, extend the diagram with a size annotation: label the number of unique subproblems (the number of nodes in the memoized tree) as a function of the input parameters. For 2D DP, this is the product of the state dimensions. For tree DP, it is the number of nodes. This annotation is the starting point for capacity planning: multiply the number of unique subproblems by the size of each stored value to get the working set size of the DP table in memory.
