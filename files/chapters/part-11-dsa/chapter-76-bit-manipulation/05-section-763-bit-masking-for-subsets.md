## 76.3 Bit Masking for Subsets

A bitmask of n bits can represent any subset of n elements: bit `i` being set means element `i` is included. Iterating over all integers from 0 to `2^n - 1` enumerates all possible subsets in lexicographic bit order, making this a compact and efficient alternative to the recursive backtracking approach when n is small (typically ≤ 20).

```go
// GenerateSubsets generates all subsets using bit masking
// Time: O(n * 2^n)
func GenerateSubsets(nums []int) [][]int {
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

// IterateSubsets iterates through all subsets of a given mask
// Useful for subset DP
func IterateSubsets(mask int) []int {
    subsets := []int{}
    for sub := mask; sub > 0; sub = (sub - 1) & mask {
        subsets = append(subsets, sub)
    }
    subsets = append(subsets, 0) // Empty subset
    return subsets
}

// SubsetSum checks if subset with given sum exists
func SubsetSum(nums []int, target int) bool {
    n := len(nums)

    for mask := 0; mask < (1 << n); mask++ {
        sum := 0
        for i := 0; i < n; i++ {
            if mask&(1<<i) != 0 {
                sum += nums[i]
            }
        }
        if sum == target {
            return true
        }
    }

    return false
}
```

### Bitmask DP

Bitmask DP replaces exponential recursive search with bottom-up tabulation over subset states. Each integer from `0` to `2^n - 1` represents a visited set, so the DP table has `2^n` entries and transitions between them run in O(n) per state. This technique is the standard approach for NP-hard problems on small graphs (such as the Travelling Salesman Problem and the k-equal-partition problem) where `n ≤ 20` makes the `O(n² · 2^n)` runtime tractable.

```go
import (
    "cmp"
    "slices"
)

// CanPartitionKSubsetsBitmask solves LeetCode 698 with bitmask DP.
// Time: O(n * 2^n), Space: O(2^n)
//
// dp[mask] holds the sum of the group currently being filled, modulo target,
// after consuming exactly the elements in mask. That value is a function of
// mask alone (it is the sum of mask's elements mod target), which is what makes
// the "already computed, skip it" test sound.
func CanPartitionKSubsetsBitmask(nums []int, k int) bool {
    n := len(nums)
    if k <= 0 || k > n {
        return false
    }

    sum := 0
    for _, num := range nums {
        sum += num
    }

    if sum%k != 0 {
        return false
    }

    target := sum / k

    // Required: target == 0 (an all-zero input) would make the % target below
    // panic with a divide by zero. If every element is 0, any k <= n splits it.
    if target == 0 {
        return true
    }

    // Sort descending for pruning: oversized elements fail immediately.
    slices.SortFunc(nums, func(a, b int) int {
        return cmp.Compare(b, a)
    })

    if nums[0] > target {
        return false
    }

    // dp[mask] = true if we can partition elements in mask into complete groups
    total := 1 << n
    dp := make([]int, total)
    for i := range dp {
        dp[i] = -1 // -1 = unvisited
    }
    dp[0] = 0 // Empty set has sum 0 in current group

    for mask := 0; mask < total; mask++ {
        if dp[mask] == -1 {
            continue
        }

        for i := 0; i < n; i++ {
            if mask&(1<<i) != 0 {
                continue // Already used
            }

            newMask := mask | (1 << i)
            if dp[newMask] != -1 {
                continue // Already computed
            }

            newSum := (dp[mask] + nums[i]) % target
            if dp[mask]+nums[i] <= target {
                dp[newMask] = newSum
            }
        }
    }

    return dp[total-1] == 0
}

// TSP solves the Travelling Salesman Problem with Held-Karp bitmask DP.
// Time: O(n^2 * 2^n), Space: O(n * 2^n)
//
// Returns the cost of the cheapest cycle starting and ending at city 0.
func TSP(dist [][]int) int {
    n := len(dist)

    // Required: with 0 or 1 cities there is no tour to cost out, and the
    // final loop below (which starts at i = 1) would never execute, leaving
    // result at INF. Return 0 rather than a sentinel masquerading as a cost.
    if n <= 1 {
        return 0
    }

    const INF = 1 << 30
    total := 1 << n

    // dp[mask][i] = min cost to visit all cities in mask ending at city i
    dp := make([][]int, total)
    for i := range dp {
        dp[i] = make([]int, n)
        for j := range dp[i] {
            dp[i][j] = INF
        }
    }

    // Start from city 0
    dp[1][0] = 0

    for mask := 1; mask < total; mask++ {
        for last := 0; last < n; last++ {
            if mask&(1<<last) == 0 || dp[mask][last] == INF {
                continue
            }

            for next := 0; next < n; next++ {
                if mask&(1<<next) != 0 {
                    continue
                }

                newMask := mask | (1 << next)
                newCost := dp[mask][last] + dist[last][next]
                if newCost < dp[newMask][next] {
                    dp[newMask][next] = newCost
                }
            }
        }
    }

    // Find minimum cost to return to city 0
    result := INF
    fullMask := total - 1
    for i := 1; i < n; i++ {
        if dp[fullMask][i]+dist[i][0] < result {
            result = dp[fullMask][i] + dist[i][0]
        }
    }

    return result
}
```

### Junior -> FAANG: Knowing When the Subset Enumeration Approach Is Correct

Bitmask subset enumeration works when n is small (practically, n <= 20 for 2^n subsets and n <= 15 for TSP-class bitmask DP). A common junior mistake is applying this approach to n = 30 or n = 40 without checking the cost: 2^30 is over one billion. Before writing any bitmask solution, write `O(2^n)` and verify that n fits within the time limit. For competitive programming, assume 10^8 operations per second and a 1-second limit, so n must be at most 26.

For `IterateSubsets`, the trick `sub = (sub - 1) & mask` is elegant but non-obvious. Trace through it for `mask = 0b1010`: sub starts at 1010, then becomes `(1010 - 1) & 1010 = 1001 & 1010 = 1000`, then `(1000 - 1) & 1010 = 0111 & 1010 = 0010`, then `(0010 - 1) & 1010 = 0001 & 1010 = 0000`. The empty subset is appended separately. This iteration visits every subset of mask exactly once in O(2^popcount(mask)) total, which is why it is the standard inner loop for subset DP.

### Senior @ FAANG: Bitmask DP in Production Scheduling

Bitmask DP for assignment problems appears in real production contexts at FAANG: worker-to-task assignment (where each task requires a specific skill combination), circuit board test coverage (where each test covers a subset of faults), and container scheduling (where each workload requires a subset of node capabilities). The TSP implementation above is the algorithmic skeleton, but production use requires several additions.

First, the state space requires explicit memory budgeting. For n=20 with 64-bit ints, the dp table is `20 * 2^20 * 8` bytes, about 160 MiB. Be clear about what that means for the memory hierarchy, because the intuition people reach for is wrong: 160 MiB does not fit in L3. Contemporary server L3 is on the order of tens of MiB, so this table lives in DRAM and the working set exceeds cache by more than an order of magnitude. The consequence is that Held-Karp at n=20 is memory-bound, not compute-bound, and the 400 million operations are not what makes it slow. Cache misses are.

That reframing is what should drive the layout decision. The row-major `dp[mask][last]` layout keeps the `last` values for a fixed `mask` contiguous, so the inner loop reads sequentially and the prefetcher can help, while writes to `dp[newMask][next]` scatter across the table and will miss. Choosing `int32` instead of `int` for the costs halves the table to 80 MiB and is usually a bigger win than any arithmetic tuning, because the bottleneck is bytes moved. Measure before assuming either way, and document the layout choice in the code.

Second, parallelizing bitmask DP is non-trivial because the transition from `mask` to `newMask` creates a data dependency. The standard approach is to process all masks with the same popcount in parallel (since popcount(newMask) = popcount(mask) + 1, there are no dependencies within a popcount level). At FAANG, staff engineers own the decision about whether to implement this parallelization or to simply precompute the result offline and serve it from a cache. The latter is almost always the correct answer for production scheduling, where the graph changes infrequently.
