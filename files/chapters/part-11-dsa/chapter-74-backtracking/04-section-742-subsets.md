## 74.2 Subsets

### Subsets I

Every element in the subset problem offers a binary choice (include it or exclude it), producing exactly 2^n subsets for an array of n elements. The backtracking formulation adds the current path to the result at every call (not just at leaf nodes), naturally collecting all subsets from the empty set to the full array.

```go
// Subsets returns all possible subsets
// LeetCode 78: Subsets
// Time: O(n * 2^n), Space: O(n)
func Subsets(nums []int) [][]int {
    result := [][]int{}
    path := []int{}

    var backtrack func(start int)
    backtrack = func(start int) {
        // Add current subset (make a copy)
        subset := make([]int, len(path))
        copy(subset, path)
        result = append(result, subset)

        for i := start; i < len(nums); i++ {
            path = append(path, nums[i])
            backtrack(i + 1)
            path = path[:len(path)-1]
        }
    }

    backtrack(0)
    return result
}

// SubsetsIterative using bit manipulation
func SubsetsIterative(nums []int) [][]int {
    n := len(nums)
    total := 1 << n // 2^n subsets
    result := make([][]int, 0, total)

    for mask := 0; mask < total; mask++ {
        subset := []int{}
        for i := 0; i < n; i++ {
            if mask&(1<<i) != 0 {
                subset = append(subset, nums[i])
            }
        }
        result = append(result, subset)
    }

    return result
}
```

### Subsets II (with duplicates)

When the input contains duplicate values, the same subset can be generated via different element orderings. Sorting the array first groups duplicates together, and the guard `i > start && nums[i] == nums[i-1]` skips a duplicate only when it would start a new branch at the same recursion depth, preserving the first occurrence while pruning all subsequent siblings that would produce an identical subset.

```go
import "slices"

// SubsetsWithDup returns subsets without duplicates
// LeetCode 90: Subsets II
// Time: O(n * 2^n), Space: O(n)
func SubsetsWithDup(nums []int) [][]int {
    slices.Sort(nums) // Sort to handle duplicates
    result := [][]int{}
    path := []int{}

    var backtrack func(start int)
    backtrack = func(start int) {
        subset := make([]int, len(path))
        copy(subset, path)
        result = append(result, subset)

        for i := start; i < len(nums); i++ {
            // Skip duplicates
            if i > start && nums[i] == nums[i-1] {
                continue
            }

            path = append(path, nums[i])
            backtrack(i + 1)
            path = path[:len(path)-1]
        }
    }

    backtrack(0)
    return result
}
```

### Junior → FAANG: Subsets as the Foundation Problem

Subsets is the simplest backtracking problem and the best one to start with because it exposes all the key mechanics without complex constraint logic. The two implementation approaches (backtracking and bit manipulation) each have interview value.

The backtracking approach builds every subset incrementally, adding the current element to the path and recursing. The bit manipulation approach uses the observation that each subset corresponds to a bitmask where bit i indicates whether element i is included. The bit manipulation approach is O(n * 2^n) time and space and produces all subsets in a predictable order (by bitmask value). It is worth knowing both and stating the trade-offs: bit manipulation is iterative and simpler to verify, but backtracking generalizes more readily to problems with additional constraints.

The SubsetsWithDup guard `i > start && nums[i] == nums[i-1]` is the most important line in this file. The condition `i > start` (not `i > 0`) is crucial: it skips the duplicate only when it would start a new branch at the current level, not when it appears as a continued element from an earlier branch. Getting this wrong either over-prunes (skipping valid subsets) or under-prunes (generating duplicates). Practice explaining this condition aloud until it is automatic.

### Senior @ FAANG: Subset Enumeration in Feature Combination Testing

Generating all subsets appears in production testing systems. Combinatorial feature testing (which combinations of feature flags should be tested together?) is a subset enumeration problem. For n feature flags, the full power set has 2^n elements, which is only practical for small n. Production testing frameworks use covering array theory (t-way coverage) to select a subset of the power set that covers all t-combinations while keeping the test count polynomial in n.

The SubsetsWithDup problem structure appears in data deduplication pipelines: given a multiset of items, enumerate all distinct multisubsets. The sorted-and-skip approach is the correct algorithm, but production systems must also handle the case where the input multiset itself is too large to sort in memory, requiring external sort and streaming deduplication.

A governance consideration for any system that generates subsets of user-controlled input: the cardinality 2^n makes it trivial to craft a denial-of-service input (n=30 generates over a billion subsets). Any API endpoint that calls subset generation must validate and cap the input size before calling the algorithm. Document the safe input size upper bound in the function's package-level documentation, not just in the README.

### Junior → FAANG: The Two Subset Implementations as Interview Choices

The backtracking and bit manipulation approaches to subsets each have a specific interview context where they are preferred. In an interview where the follow-up is likely to involve duplicate handling or additional constraints, start with the backtracking approach because it adapts directly (add a sort and a skip guard). In an interview where the follow-up asks about iterative implementations or asks you to avoid recursion, start with the bit manipulation approach because it is inherently iterative and requires no stack space.

The `SubsetsWithDup` guard is worth understanding at the level of "why does `i > start` matter rather than `i > 0`?" The condition `i > start` skips a duplicate only when it would start a *sibling* branch at the current recursion level, which is the only place an identical subset can be re-generated. Replace it with `i > 0` and you also reject the duplicate when it is a legitimate *continuation* deeper in a branch, where it is not a repeat at all but a second copy genuinely belonging to the subset.

Run `[1,2,2]` through both and count. The correct guard yields all 6 distinct subsets: `[]`, `[1]`, `[1,2]`, `[1,2,2]`, `[2]`, `[2,2]`. The `i > 0` guard yields only 4, silently losing exactly the two that need both 2s: `[1,2,2]` and `[2,2]`. That is the signature of over-pruning, and it is worse than under-pruning: duplicates in the output are obvious the moment you look, whereas a missing subset is invisible unless you already knew the count should be 6.

### Senior @ FAANG: Subset Generation Under Cardinality Constraints

The transition from full subset generation to t-way coverage testing (selecting a covering subset of the power set) is the production version of the subset enumeration problem. Combinatorial test design for n=30 feature flags requires t-way coverage, not full power set enumeration. The algorithm shifts from backtracking (enumerate all) to constraint-guided search (find a minimum covering set). Staff engineers who propose this shift need to understand both ends: why full enumeration is infeasible at n=30 (2^30 is over a billion configurations), and what t-way coverage actually promises. Be exact about that second half, because it is where the argument is usually oversold. t-way coverage does not give you the same guarantee as exhaustive testing. It guarantees only that every combination of t or fewer parameters appears somewhere in the suite, so it catches faults triggered by interactions among at most t parameters and can miss a fault that requires t+1 specific flags to align. The reason it is a good trade is empirical rather than logical: interaction faults in practice are dominated by low-order interactions, so small t buys most of the detection at a tiny fraction of the cost. Present it that way, as a defensible bet with a known blind spot, rather than as equivalence.

For the SubsetsWithDup problem in production data deduplication, the sorted-and-skip approach has a streaming variant. If the multiset arrives as a sorted stream (which it often does after an external sort phase), the "skip duplicate siblings" logic applies directly to the stream without materializing the full multiset in memory. The streaming variant processes one element at a time and maintains a stack depth proportional to the maximum nesting depth, making it suitable for very large inputs where even storing the input is a memory concern.
