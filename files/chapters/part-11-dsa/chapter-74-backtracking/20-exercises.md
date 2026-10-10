## Exercises

### Exercise 1: Combinations Sum IV
Count the number of possible combinations that add up to target (order matters).

### Exercise 2: Matchsticks to Square
Determine if matchsticks can form a square.

### Exercise 3: Beautiful Arrangement
Count arrangements where every element is divisible by its index or vice versa.

### Exercise 4: Splitting a String Into Descending Consecutive Values
Check if string can be split into strictly decreasing consecutive numbers.

### Junior → FAANG: Exercise Strategy for Backtracking

Combination Sum IV (LeetCode 377) is a follow-up to Combination Sum that asks for the count of ordered combinations (different orderings count separately). This is no longer a backtracking problem. It is a DP problem because counting ordered arrangements has optimal substructure and overlapping subproblems. Recognizing this switch from backtracking to DP is itself the exercise. If you find yourself generating all combinations and counting them, you are using the wrong tool.

Matchsticks to Square (LeetCode 473) is a harder backtracking problem: partition n matchsticks into four equal-sum groups. The pruning key is to sort the matchsticks in descending order before starting, then try to fill each of the four buckets with the largest available matchstick first. This early commitment of large elements dramatically reduces the search space. Without sorting, the algorithm may explore many branches that fail only at the very end when large elements cannot fit.

Beautiful Arrangement (LeetCode 526) is a permutation problem with a divisibility constraint. At each position `pos`, only elements that satisfy `element % pos == 0 || pos % element == 0` are valid. The pruning from the constraint is moderate, and the problem is designed to run within time limits for n <= 15. For larger n, DP over subsets (bitmask DP) is required because the arrangement count exhibits overlapping subproblems.

### Senior @ FAANG: Exercises as Signals for Backtracking Versus DP Boundary

Combination Sum IV is deliberately included here to test whether candidates know when to stop using backtracking. A senior engineer's response to "count the number of ordered combinations" should be immediate: "this is DP, not backtracking. The count for target T is the sum of counts for T minus each valid element, and these subproblems overlap." The recognition of this boundary, the point where backtracking's exponential search gives way to DP's polynomial memoization, is a staff-level interviewing signal.

Beautiful Arrangement for large n is the canonical case where bitmask DP is the correct approach, and it also rewards a second look at the state. The obvious state is `(position, used_set)`, which suggests n * 2^n entries. But `position` is not independent: you have filled exactly as many positions as there are bits set in `used_set`, so `position == popcount(used_set)` always. The mask alone determines it. Dropping the redundant dimension takes the table from n * 2^n to 2^n, a factor of n saved for free, and it is the kind of state minimization that separates a working bitmask DP from a good one. Each state does O(n) work choosing the next element, giving O(n * 2^n) overall. This is feasible for n up to roughly 20. Beyond that it requires a different formulation (approximation, sampling, or problem-specific structure exploitation). Staff engineers know these thresholds and can reason about which algorithm class applies for a given n.

### Junior → FAANG: Exercises as Backtracking-vs-DP Boundary Training

The four exercises in this file are specifically chosen to train the backtracking-versus-DP decision boundary. Combination Sum IV (LeetCode 377) looks like a backtracking problem (sum to target with candidates) but is a counting problem with overlapping subproblems, so DP is correct. Matchsticks to Square (LeetCode 473) looks like a knapsack but the partition-into-equal-groups constraint makes backtracking the right choice (DP would require exponential state). Beautiful Arrangement (LeetCode 526) uses backtracking with a divisibility constraint, but transitions to bitmask DP when n grows large. Splitting Into Descending Consecutive Values (LeetCode 1849) requires backtracking with a numerical constraint that prevents simple DP.

The diagnostic for each: does the problem have overlapping subproblems? For Combination Sum IV, yes (the count for target T does not depend on the path taken to reach T). For Matchsticks, no (whether you can form a square depends on which matchsticks you have already placed, not just the current totals). When overlapping subproblems exist, DP is preferred. When state-dependent history matters, backtracking is required.

Practice the transition: implement Combination Sum IV with backtracking first (generating all ordered combinations and counting them), observe that it times out for large targets, then implement the DP version. The process of seeing why the backtracking is slow and why DP fixes it is more instructive than reading the answer directly.

### Senior @ FAANG: Exercises as a Curriculum Design Tool

These four exercises represent the curriculum for "backtracking fluency level 2": beyond the basic template and pattern recognition, this level tests the ability to reason about when to abandon backtracking for a better algorithm. For senior engineers designing interview curricula, these four problems are the right level for L5 candidates (expected to know when DP is better than backtracking) and the starting point for L6 candidates (expected to derive the threshold at which algorithm classes change).

For L6 interview problem design, extend Beautiful Arrangement by asking: "how would you solve this for n=25?" This forces the candidate to reason about why bitmask DP runs out of room there (2^25 is about 33.5 million states, times O(n) work each, and at 8 bytes per entry the table alone is 256 MiB) and what applies beyond that threshold (randomized search, simulated annealing, or problem-specific mathematical structure). The ability to reason about multiple algorithm classes and their applicability thresholds at different input scales is the L6 differentiator.

---
