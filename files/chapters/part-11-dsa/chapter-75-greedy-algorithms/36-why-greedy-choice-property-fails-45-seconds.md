## Why Greedy Choice Property Fails (45 seconds)
"The greedy choice property requires that making the locally
optimal choice leaves us with a subproblem whose optimal
solution, combined with our choice, gives global optimum.

For 0/1 knapsack:
- Choosing highest-ratio item reduces remaining capacity
- This might exclude combinations that would be better overall
- We can't know locally whether to include an item

Compare to fractional:
- Taking fraction of best-ratio item is always safe
- We can always adjust by taking less later"

### Junior → FAANG: Understanding Why Greedy Choice Property is the Gating Condition

Junior candidates often try greedy first and switch to DP only after getting a wrong answer. The more productive habit is to ask two questions before writing any code.

First: "Does making the best local choice now foreclose a better global choice later?" For fractional knapsack the answer is no, because fractions are infinitely divisible and any commitment can be partially walked back. For 0/1 knapsack, taking item A entirely removes the option of spending that capacity on B and C instead.

Second: "Can I state the exchange argument out loud?" If you cannot say why swapping the greedy choice into an arbitrary optimal solution never makes it worse, you do not have a reason to believe greedy works. You have a hope. The two questions are different: the first hunts for a counterexample, the second demands a proof, and a greedy algorithm needs to survive both. Answering them takes 30 seconds and tells you whether greedy is worth attempting at all.

### Senior @ FAANG: Formal Characterization of Greedy Failure and Approximation Regimes

At the senior level, the greedy choice property failure has precise consequences that inform system design. When the property does not hold, three options exist.

The first is exact DP, at O(nW) time and O(W) space with a rolling array, where W is the capacity. Note carefully that this is pseudo-polynomial, not polynomial: the cost scales with the *magnitude* of W, not with the number of bits used to write it down. That is exactly why 0/1 knapsack stays NP-hard despite having a DP, and it is a distinction interviewers probe. The DP is a fine choice when W is genuinely small, and useless when W is a budget in cents.

The second is branch-and-bound with pruning, which is exact and exponential in the worst case but often fast in practice, particularly with a greedy warm start supplying a good incumbent bound.

The third is an FPTAS, which trades exactness for a guarantee: a (1+epsilon) approximation in time polynomial in both n and 1/epsilon, achieved by scaling and rounding the item values so the DP runs over a coarser value space. The textbook bound is O(n^3/epsilon), so epsilon buys accuracy at a steep and explicit price. Do not quote it as O(n/epsilon).

Ad auction allocation, warehouse packing, and large-scale notification scheduling all tend to live in the regime where W is large and exact DP is infeasible, which is why approximation algorithms with proven guarantees are the norm rather than the exception in this space. A staff engineer owning such a system knows the theoretical approximation ratio of the heuristic in use, monitors the empirical gap on production traffic, and sets a threshold that triggers a switch to a heavier solver when the gap exceeds an acceptable business cost.
