## Exercises

### Exercise 1: Find First Bad Version
Given n versions and API isBadVersion(n), find the first bad version.

### Exercise 2: Sqrt with Decimal Precision
Implement sqrt with given decimal precision.

### Exercise 3: Aggressive Cows
Place cows in stalls to maximize minimum distance between any two cows.

### Exercise 4: Magnetic Force
Place balls in positions to maximize minimum force (distance).

### Junior -> FAANG: Exercise Strategy for Binary Search

Exercise 1 (First Bad Version) is the purest lower-bound problem: find the smallest index where `isBadVersion` returns true. Use the `left < right` template with `right = mid` on true and `left = mid + 1` on false. The answer is `left` after the loop. This is the canonical introduction to binary search on answer and should be solvable in under five minutes.

Exercise 3 (Aggressive Cows) and Exercise 4 (Magnetic Force) are the same problem structure: binary search on the answer (minimum distance), with a feasibility check that greedily places elements and verifies that the minimum spacing condition holds. Practice the feasibility check first: given a minimum distance d, sort positions and greedily place cows/balls as far apart as possible. If you can place all m cows, d is feasible. Then wrap this in a binary search over the distance range.

Both exercises require sorting the input first. The answer range for minimum distance is `[1, max_position - min_position]`. Each feasibility check is a single greedy O(n) pass, so the search itself is O(n log(max_pos)). Do not forget to add the sort: the honest total is O(n log n + n log(max_pos)). Interviewers notice when a candidate quotes the search cost and silently drops the preprocessing that made it possible.

### Senior @ FAANG: Exercise Extensions at Production Scale

Exercise 2 (Sqrt with Decimal Precision) at production scale is `math.Sqrt`, which the compiler lowers to a hardware square-root instruction on the common architectures and which returns the correctly-rounded IEEE 754 result. The interesting engineering question is not which is faster, because the hardware wins easily. It is when integer `MySqrt` is the only correct choice: when `floor(sqrt(x))` is the final answer and must be exact, as in tile dimensions or bin packing. As Section 77.7 shows, correct rounding is precisely what breaks the floor, since a root a hair below an integer rounds up to it and truncation then returns a value one too high. Document this distinction in code that switches between integer and floating-point sqrt based on the required output type.

Exercise 3 and 4 at production scale appear in facility location problems, where "maximize the minimum distance between any two facilities" is a capacity planning constraint. The same binary search on answer structure applies, but the feasibility check scales to continuous 2D space (where Euclidean distance replaces 1D spacing) and must be approximated rather than computed exactly. A senior engineer knows that the 2D generalization is NP-hard and requires heuristic algorithms, while the 1D version is polynomial and solvable exactly.
