## 74.4 Combinations

### Combinations

Combinations select exactly k elements from n without regard to order. Passing a `start` index to each recursive call ensures that elements are only considered in increasing index order, which prevents duplicate combinations and bounds each path to exactly k elements before being added to the result.

```go
// Combine returns all k-combinations
// LeetCode 77: Combinations
// Time: O(k * C(n,k)), Space: O(k)
func Combine(n int, k int) [][]int {
    result := [][]int{}

    var backtrack func(start int, path []int)
    backtrack = func(start int, path []int) {
        if len(path) == k {
            comb := make([]int, k)
            copy(comb, path)
            result = append(result, comb)
            return
        }

        // Pruning: need k-len(path) more elements
        // Can only start from positions that leave enough elements
        need := k - len(path)
        for i := start; i <= n-need+1; i++ {
            path = append(path, i)
            backtrack(i+1, path)
            path = path[:len(path)-1]
        }
    }

    backtrack(1, []int{})
    return result
}
```

### Combination Sum

Combination Sum differs from fixed-size combinations in two ways: the target is a sum rather than a count, and elements can be reused indefinitely. Passing `i` (not `i+1`) as the next start index allows the same candidate to appear multiple times in a path, while subtracting the chosen value from `remaining` at each step drives the recursion toward the base case of zero without exceeding the target. `CombinationSum2` restores the single-use constraint and skips sorted duplicates using the same sibling-pruning guard seen in Subsets II.

```go
// CombinationSum finds combinations that sum to target
// LeetCode 39: Combination Sum (can reuse elements)
// Time: O(n^(target/min)), Space: O(target/min) recursion depth
//
// Precondition: all candidates are strictly positive. A zero or negative
// candidate never shrinks `remaining`, so the `backtrack(i, ...)` reuse call
// recurses forever and overflows the stack. This is a hang, not a wrong answer.
func CombinationSum(candidates []int, target int) [][]int {
    result := [][]int{}

    var backtrack func(start, remaining int, path []int)
    backtrack = func(start, remaining int, path []int) {
        if remaining == 0 {
            comb := make([]int, len(path))
            copy(comb, path)
            result = append(result, comb)
            return
        }

        for i := start; i < len(candidates); i++ {
            // continue, not break: candidates are unsorted here, so an
            // oversized candidate implies nothing about the ones after it
            if candidates[i] > remaining {
                continue
            }

            path = append(path, candidates[i])
            backtrack(i, remaining-candidates[i], path) // i, not i+1
            path = path[:len(path)-1]
        }
    }

    backtrack(0, target, []int{})
    return result
}

import "slices"

// CombinationSum2 each number used once
// LeetCode 40: Combination Sum II
// Note: sorts candidates in place, reordering the caller's slice.
func CombinationSum2(candidates []int, target int) [][]int {
    slices.Sort(candidates) // licenses BOTH the break and the duplicate skip
    result := [][]int{}

    var backtrack func(start, remaining int, path []int)
    backtrack = func(start, remaining int, path []int) {
        if remaining == 0 {
            comb := make([]int, len(path))
            copy(comb, path)
            result = append(result, comb)
            return
        }

        for i := start; i < len(candidates); i++ {
            // Pruning: remaining elements too large
            if candidates[i] > remaining {
                break
            }

            // Skip duplicates
            if i > start && candidates[i] == candidates[i-1] {
                continue
            }

            path = append(path, candidates[i])
            backtrack(i+1, remaining-candidates[i], path)
            path = path[:len(path)-1]
        }
    }

    backtrack(0, target, []int{})
    return result
}

// CombinationSum3 k numbers from 1-9 summing to n
// LeetCode 216: Combination Sum III
func CombinationSum3(k int, n int) [][]int {
    result := [][]int{}

    var backtrack func(start, remaining int, path []int)
    backtrack = func(start, remaining int, path []int) {
        if len(path) == k {
            if remaining == 0 {
                comb := make([]int, k)
                copy(comb, path)
                result = append(result, comb)
            }
            return
        }

        for i := start; i <= 9; i++ {
            if i > remaining {
                break
            }

            path = append(path, i)
            backtrack(i+1, remaining-i, path)
            path = path[:len(path)-1]
        }
    }

    backtrack(1, n, []int{})
    return result
}
```

### Junior → FAANG: Combination Variants and Their Key Differences

The three combination variants in this file (Combine, CombinationSum, CombinationSum2) differ along two dimensions: fixed-size versus variable-size output, and single-use versus multi-use candidates.

Combine: fixed size k, single use each. The `start` index ensures no element is reused, and the `need` variable enables early pruning: if fewer than `k - len(path)` elements remain in the array, the current branch cannot produce a valid combination and can be pruned immediately. This pruning is the difference between a working solution and an efficient one.

CombinationSum: variable size (stop when remaining=0), multi-use each. Passing `i` (not `i+1`) as the next start enables reuse. Note that `CombinationSum` as written does **not** sort, and therefore correctly uses `continue` rather than `break` when a candidate exceeds the remaining amount: an oversized candidate says nothing about the ones after it when the order is arbitrary. Sorting first would license the stronger `break`, and that upgrade is exactly what `CombinationSum2` below does. The two must travel together. Take `candidates = [7, 2]` with `target = 4`: `continue` finds `[2,2]`, while `break` on an unsorted slice bails at the 7 and returns nothing at all. If you want the `break`, sort first, every time.

CombinationSum2: variable size, single-use each. Combines the sorted-and-skip duplicate guard from Subsets II with the early-break optimization from CombinationSum. Knowing which combination of guards to apply to each variant is the sign of a candidate who has internalized the pattern rather than memorized specific solutions.

### Senior @ FAANG: Combination Sum in Pricing and Allocation

CombinationSum is the exact algorithm used in pricing systems for "ways to make change" and in resource allocation for "ways to allocate a budget across discrete unit sizes." The multi-use property corresponds to items that can be purchased in multiple quantities (e.g., ad impressions sold in blocks of 1000).

The `break` optimization (when candidates are sorted and the current candidate exceeds the remaining) is a critical production optimization. Without it, the algorithm explores all candidates at every level even when the remaining budget is 0 or small, wasting time proportional to the number of oversized candidates. In pricing systems where the candidate set (available product sizes) is large, this optimization can reduce the search time by an order of magnitude for small remaining amounts.

A production system that uses CombinationSum for budget allocation must also handle the case where no valid allocation exists (remaining > 0 after all candidates are exhausted). The algorithm returns an empty result in this case, which should be surfaced as a distinct "no valid allocation" response rather than treated as equivalent to a zero-element allocation. Documenting this distinction in the API contract prevents silent failures in downstream systems that check for empty results without distinguishing the two semantics.

### Junior → FAANG: The `continue` vs `break` Distinction in Pruning

The difference between `continue` (skip this candidate, try the next one) and `break` (stop trying candidates at this level) is the most important pruning distinction in combination problems. You can only use `break` when the candidates are sorted and the current candidate exceeds the constraint, because then all subsequent candidates are also too large and can be skipped in bulk. Using `continue` in this situation wastes time checking each remaining candidate individually.

In CombinationSum2 (each number used once, no duplicates), the `break` on `candidates[i] > remaining` is valid because the candidates are sorted. The `continue` on the duplicate guard `i > start && candidates[i] == candidates[i-1]` is also correct because it skips only the duplicate, not all subsequent candidates. Mixing up `break` and `continue` for these two cases is a common optimization bug: using `continue` instead of `break` is always correct (just slower), but using `break` instead of `continue` for the duplicate guard incorrectly skips non-duplicate elements and produces missing results.

For CombinationSum3 (k numbers from 1-9 summing to n), the constraint set (exactly k numbers, each 1-9, sum to n) is tight enough that most branches are pruned early. The early termination `if i > remaining { break }` exits the inner loop when the smallest remaining candidate already exceeds what is needed. This prune is effective because the candidates are in increasing order (1 through 9), so if `i > remaining`, all subsequent candidates are also larger.

### Senior @ FAANG: Combination Sum in Multi-Dimensional Resource Allocation

The production extension of CombinationSum to multi-dimensional constraints (combine items where both CPU and memory must stay within limits) is an NP-hard problem in general (multi-dimensional knapsack). But for production schedulers with small candidate sets (typically under 30 resource allocation options), the backtracking approach with multi-dimensional pruning is practical. The key is early termination on any violated dimension: if CPU exceeds budget, immediately prune the branch, regardless of memory.

For pricing systems that use CombinationSum to generate bundle recommendations (which product combinations sum to exactly a target price), the candidate set is the product catalog, which can be thousands of products. Direct backtracking over thousands of products is impractical. The production approach pre-filters the catalog to products within the target price range, groups them by price tier (rounded to the nearest dollar), and runs backtracking on the tier representatives. This two-phase shape, pre-filter then enumerate, is what makes the search feasible: the filter is linear and the enumeration is exponential, so every product removed before the second phase is worth far more than any constant-factor tuning inside it.

Staff engineers document this two-phase architecture explicitly, including the pre-filter precision (what fraction of exact-match bundles are missed by the tier rounding) and the maximum candidate set size after pre-filtering. These parameters become tunable configuration values rather than hardcoded thresholds.
