# Chapter 73: Dynamic Programming

> *"Those who cannot remember the past are condemned to repeat it."*
> - George Santayana (and every DP algorithm ever written)

Dynamic programming states simply: break a problem into overlapping subproblems, solve each subproblem once, store the result, and reuse it. The gap between understanding that definition and recognizing a DP problem in the wild, then formulating the correct recurrence relation on the spot, is where most candidates stumble. Dynamic programming is less a single algorithm and more a problem-solving lens, and developing that lens takes deliberate, structured practice.

Go suits DP work well. Slice literals give clean one-dimensional and two-dimensional table initialization, and `make([][]int, m)` plus range loops keep the implementation readable so interviewers focus on your logic rather than your syntax. Go has no tail-call optimization, so iterative bottom-up DP is generally preferred over deep recursive memoization in production code, though both approaches are valid and you will practice both here.

This chapter walks you through the two primary DP paradigms, top-down memoization and bottom-up tabulation, and applies them to the canonical problem families: 0/1 Knapsack, unbounded Knapsack, Longest Common Subsequence, Longest Increasing Subsequence, interval DP, DP on trees, and DP on state machines. You will learn to identify the state variables, define the recurrence, determine the base cases, and choose the right iteration order. Complexity analysis, both time and space, including space-optimized rolling-array techniques, is covered for every pattern so you can reason about trade-offs in real time.

**What you'll learn in this chapter:**

- Identifying the four signals that indicate a problem is solvable with DP (optimal substructure, overlapping subproblems, decision at each step, ask for min/max/count/true-false)
- Implementing top-down memoization in Go using `map[string]int` and multi-key cache structs
- Building bottom-up tabulation tables with correct initialization, iteration order, and base cases
- Solving the complete 0/1 Knapsack family: subset sum, partition equal subset, target sum
- Solving LCS, LIS, Edit Distance, and their variants used in diff tools and bioinformatics
- Applying interval DP to matrix chain multiplication, burst balloons, and palindrome partitioning
- Optimizing space from O(n²) to O(n) using rolling arrays and in-place updates
- Recognizing the recurring DP patterns and their canonical Go implementations

**Why this matters in interviews:**

Dynamic programming shows up reliably in algorithmic onsite loops, and it is one of the topics candidates most often report as the reason a loop went badly. The variants differ by company and by interviewer: multi-dimensional state, 1D DP dressed in business framing (pricing, resource allocation), string DP such as Edit Distance and LCS, or a classic problem with an unfamiliar constraint bolted on. What stays constant is the signal being measured: whether you can formulate the recurrence relation independently, not just recall a memorized solution. The ability to say "this state is defined by (index, remaining capacity), the recurrence is dp[i][w] = max(dp[i-1][w], dp[i-1][w-weight[i]] + value[i])" fluently, in Go, under pressure, is the target skill this chapter builds.

**Prerequisites:** Chapter 65 (Complexity Analysis), Chapter 66 (Arrays and Strings), familiarity with recursion and backtracking, Go slices and maps, and comfort with O(n²) nested loop patterns.

---

### Junior → FAANG: Building the DP Recognition Reflex

Before you can implement a DP solution fluently in an interview, you need to recognize the pattern quickly. The four signals are worth memorizing as a checklist: optimal substructure (can I build this answer from sub-answers?), overlapping subproblems (will I compute the same thing twice?), an optimization or counting ask (min/max/count/feasibility), and a decision at each step (take or skip, buy or sell, match or skip).

The Fibonacci example is the entry point because it shows both properties visually. The naive recursive tree is exponential because the same subproblem is recomputed along every path that reaches it: in the tree for `fib(5)`, `fib(3)` is evaluated twice and `fib(2)` three times, and the duplication compounds as n grows. Memoization caches each result the first time and returns it instantly thereafter, dropping the work from O(2^n) to O(n). Tabulation flips the direction entirely, computing `dp[0]` through `dp[n]` iteratively, which avoids the call stack overhead and enables the further space optimization to O(1) by keeping only two rolling variables.

Your first-job habit here is to always declare which of the two approaches you are using and explain why. In interviews, saying "I'll use bottom-up tabulation because it avoids stack overflow risk for large n and has better cache locality" signals depth. Saying "I'll memoize because the problem has a natural recursive structure and I want to write it top-down first, then optimize" also signals depth. Either answer is acceptable. Silence is not.

Go-specific note: Go does not optimize tail calls, so deeply recursive memoized solutions on large inputs can overflow the goroutine stack. A goroutine stack starts small (a few kilobytes) and grows on demand, but it is capped: the default limit is 1 GB on 64-bit systems, adjustable with `runtime/debug.SetMaxStack`. Exceeding it is a fatal, unrecoverable error, not a panic you can recover from. For production code, prefer iterative tabulation unless the recursion depth is provably bounded and small.

### Senior @ FAANG: DP as an Architectural and Platform Lens

At the senior and staff level, DP fluency is assumed. The interview signal that separates L5 from L6 is not whether you can implement Fibonacci memoization but whether you can apply DP thinking to system design, production trade-off decisions, and platform-scale problems.

**DP in system architecture.** Many distributed systems decisions are fundamentally DP problems. Optimal task scheduling across heterogeneous machines is an assignment DP. Join order selection in a relational query planner (which join order is cheapest?) is the same shape as matrix chain multiplication, and System R's classic planner solved it with bottom-up DP over subsets of relations. Optimal offline caching is solved by Belady's rule rather than by DP, and knowing which problems yield to a greedy argument instead of a table is itself part of the lens. Recognizing these structural connections lets you reason about system behavior more precisely than ad-hoc intuition allows.

**ADR framing for DP decisions.** When a production system adopts DP, the architectural decision record should capture: the state definition and why those dimensions are sufficient, the recurrence correctness argument, the space complexity and whether the system can afford the working-set size at peak load, and the choice of top-down versus bottom-up with respect to the team's operational constraints (e.g., iterative is easier to profile under pprof, recursive is easier to unit-test in isolation). Skipping this documentation creates operational risk when the next engineer needs to modify the state definition to accommodate a new constraint.

**Maturity model for DP implementations.** A production-grade DP implementation goes through predictable maturity stages. Level 1: correctness, a naive implementation that passes all test cases. Level 2: space optimization, rolling arrays reduce memory pressure. Level 3: input validation and overflow guards, `dp[i-coin] + 1` can overflow if sentinels are not chosen carefully. Level 4: observability, instrumenting table-fill time and hit rates for memoized variants so that pathological inputs (adversarial inputs that maximize cache misses) are detectable in production. Level 5: parameterization, the state dimensions and capacity bounds are runtime-configurable rather than compile-time constants, enabling the system to adapt to changing business constraints without a code change.

**Bar-raiser signal: state explosion.** The canonical failure mode in production DP is state space explosion when a new business requirement adds a dimension to the state. A system designed around a 1D or 2D DP table can become intractable if a new constraint requires a third or fourth state dimension. Staff-level engineers anticipate this by analyzing which constraints are stable versus which are likely to evolve, and they design the state representation to be extensible from the start, sometimes accepting a small performance penalty in the current version to avoid a rewrite when requirements change.

### Junior → FAANG: First Steps Toward DP Fluency

Many candidates treat this chapter as a collection of memorizable templates. That approach fails the moment an interviewer introduces a minor variant. Instead, anchor every template to a question: "what does each state value represent, and what choice produces the transition?" For the introduction section specifically, practice narrating Fibonacci in both directions: top-down (start from `fib(n)`, cache on the way down) and bottom-up (start from `dp[0]`, build forward). Being able to switch directions on demand shows genuine understanding, not pattern recall.

First-job habit: when you encounter a DP problem at work (pricing engine, recommendation scoring, resource allocation), write the five-step framework in a comment block above the function before touching any logic. This disciplines your thinking and makes the code self-documenting for the next reader.

### Senior @ FAANG: Governing DP Adoption Across a Team

At the L6 level, your responsibility extends beyond writing correct DP code to ensuring your team adopts it safely. Three governance concerns dominate.

First, capacity planning for DP table memory: a DP table that fits comfortably on a developer's laptop may be orders of magnitude larger in production under peak load. Before merging any DP implementation, compute the worst-case table size in bytes, verify it fits within the service's memory budget at the 99th-percentile input size, and add an input validation gate that rejects inputs that would exceed that budget.

Second, complexity documentation: every DP function in production code should have a doc comment that states the state definition, the recurrence, the time complexity, and the space complexity. Without this, the next engineer cannot safely modify the function. A function comment that says "optimal knapsack allocation" without stating O(n * capacity) gives no guidance on whether doubling the capacity bound will double or quadruple the latency.

Third, regression test design: DP implementations are prone to silent regressions when the recurrence is modified to accommodate a new constraint. Property-based tests (the result cannot exceed the theoretical maximum, the result is monotone in the input size, the result matches a brute-force enumeration for small inputs) catch regressions that hand-picked test cases miss.
