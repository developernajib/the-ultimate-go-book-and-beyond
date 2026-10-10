## 74.3 Permutations

### Permutations I

Permutation generation differs from subset generation in that order matters and every element must appear exactly once. A `used` boolean array tracks which elements are already on the current path, and elements are tried in every position at each recursion level, producing n! total permutations, each of length n.

```go
// Permute returns all permutations
// LeetCode 46: Permutations
// Time: O(n * n!), Space: O(n)
func Permute(nums []int) [][]int {
    result := [][]int{}
    used := make([]bool, len(nums))

    var backtrack func(path []int)
    backtrack = func(path []int) {
        if len(path) == len(nums) {
            perm := make([]int, len(path))
            copy(perm, path)
            result = append(result, perm)
            return
        }

        for i := 0; i < len(nums); i++ {
            if used[i] {
                continue
            }

            used[i] = true
            path = append(path, nums[i])

            backtrack(path)

            path = path[:len(path)-1]
            used[i] = false
        }
    }

    backtrack([]int{})
    return result
}

// PermuteSwap uses in-place swapping (more efficient)
func PermuteSwap(nums []int) [][]int {
    result := [][]int{}

    var backtrack func(first int)
    backtrack = func(first int) {
        if first == len(nums) {
            perm := make([]int, len(nums))
            copy(perm, nums)
            result = append(result, perm)
            return
        }

        for i := first; i < len(nums); i++ {
            nums[first], nums[i] = nums[i], nums[first]
            backtrack(first + 1)
            nums[first], nums[i] = nums[i], nums[first] // backtrack
        }
    }

    backtrack(0)
    return result
}
```

### Permutations II (with duplicates)

When the input contains duplicate values, the standard approach generates identical permutations at different recursion branches, causing redundant output. Sorting the array first groups equal elements together, then the guard `nums[i] == nums[i-1] && !used[i-1]` prunes any branch that would place a duplicate value in the same position as an identical sibling that was already explored and removed, eliminating duplicate permutations without a hash-set de-duplication pass.

```go
import "slices"

// PermuteUnique returns unique permutations
// LeetCode 47: Permutations II
// Time: O(n * n!) worst case, Space: O(n)
// Note: sorts nums in place, reordering the caller's slice.
func PermuteUnique(nums []int) [][]int {
    slices.Sort(nums) // required: the guard below needs equal values adjacent
    result := [][]int{}
    used := make([]bool, len(nums))

    var backtrack func(path []int)
    backtrack = func(path []int) {
        if len(path) == len(nums) {
            perm := make([]int, len(path))
            copy(perm, path)
            result = append(result, perm)
            return
        }

        for i := 0; i < len(nums); i++ {
            if used[i] {
                continue
            }

            // Skip duplicates: if same as previous and previous not used
            if i > 0 && nums[i] == nums[i-1] && !used[i-1] {
                continue
            }

            used[i] = true
            path = append(path, nums[i])

            backtrack(path)

            path = path[:len(path)-1]
            used[i] = false
        }
    }

    backtrack([]int{})
    return result
}
```

### Next Permutation

Rather than generating all permutations and finding the successor, the next-permutation algorithm operates directly on the array in O(n) time using three passes. It scans right-to-left to find the first "descent" (the index `i` where the sequence stops increasing), then finds the smallest element to the right of `i` that is still larger than `nums[i]`, swaps them, and reverses the suffix after `i` to put it in ascending (lexicographically smallest) order. If no descent exists the array is already the last permutation and reversing the entire array wraps around to the first.

```go
// NextPermutation finds lexicographically next permutation
// LeetCode 31: Next Permutation
// Time: O(n), Space: O(1)
func NextPermutation(nums []int) {
    n := len(nums)

    // Step 1: Find largest i such that nums[i] < nums[i+1]
    i := n - 2
    for i >= 0 && nums[i] >= nums[i+1] {
        i--
    }

    if i >= 0 {
        // Step 2: Find largest j such that nums[j] > nums[i]
        j := n - 1
        for nums[j] <= nums[i] {
            j--
        }
        // Step 3: Swap nums[i] and nums[j]
        nums[i], nums[j] = nums[j], nums[i]
    }

    // Step 4: Reverse from i+1 to end
    reverse(nums, i+1, n-1)
}

func reverse(nums []int, left, right int) {
    for left < right {
        nums[left], nums[right] = nums[right], nums[left]
        left++
        right--
    }
}
```

### Junior → FAANG: Permutations and the Used-Array Pattern

The fundamental distinction between permutation problems and combination problems is this: in permutations, every element can appear in every position (order matters), so the loop always starts from 0 with a `used[]` array tracking what is already in the path. In combinations, elements are selected in forward order, so the loop starts from a `start` index to avoid revisiting elements.

Confusing these two patterns is the most common mistake in permutation/combination interview problems. The diagnostic test: "does [1,2] and [2,1] count as different answers?" If yes (order matters), it is a permutation problem and you need `used[]`. If no, it is a combination problem and you need a `start` index.

The swap-based variant (`PermuteSwap`) is space-efficient (no `used[]` array) and permutes in place. Be precise about its mutation, because the loose version of this claim is wrong: `PermuteSwap` swaps the input around *during* the search but undoes every swap on the way back up, so the array it hands back is in its original order. The post-condition is clean. What is not clean is the middle: the caller's array is scrambled for the duration of the call, so passing in a slice that another goroutine reads concurrently is a data race, and a panic partway through leaves it shuffled. Know both variants and state the trade-off: swap-based avoids the O(n) `used[]` array and disturbs the caller's memory in flight, `used[]`-based costs O(n) and never touches the input at all.

For permutations with duplicates, the guard `i > 0 && nums[i] == nums[i-1] && !used[i-1]` requires sorting first. Without sorting, identical values are not adjacent and the guard cannot detect same-level duplicates. The `!used[i-1]` condition means: if the previous identical element is not currently in the path (i.e., we are at the same recursion level, not a deeper one), skip this one to avoid generating the same permutation twice.

### Senior @ FAANG: Permutation Generation in Scheduling and Assignment Systems

Permutation generation is the theoretical basis for a large class of assignment and scheduling problems. Job scheduling (in what order should these tasks be executed to minimize total completion time?), seating arrangement optimization, and test case generation (which orderings of operations reveal race conditions?) all reduce to permutation enumeration with domain-specific pruning.

The `NextPermutation` algorithm (O(n) time, O(1) space) is the production-ready algorithm for any system that needs to iterate through orderings lazily, without materializing all n! permutations. It is used in constraint solver iterators, optimization benchmarks that require testing all orderings up to a bound, and in music theory algorithms that enumerate chord voicings.

The duplicate-permutation problem (PermuteUnique) scales poorly when the input has many repeated elements: if all n elements are identical, there is only one unique permutation but the naive algorithm explores n! paths before deduplication. The sorted-and-skip approach addresses this at the algorithm level, but production systems with highly repetitive inputs should additionally validate that the number of unique permutations is bounded before starting the enumeration. The formula for the number of unique permutations of a multiset is `n! / (k1! * k2! * ... * km!)` where k1, ..., km are the frequencies of each unique element. Computing this before starting the backtracking gives an early bound check.

### Junior → FAANG: Permutations vs Combinations as a Mental Switch

The single most reliable way to decide between permutations (used array) and combinations (start index) is to answer one question: do [1,2] and [2,1] count as different answers for this problem? If the answer is yes (order matters), you need a used array and always iterate from index 0. If the answer is no (order does not matter), you need a start index and always iterate forward from it.

For the `PermuteUnique` duplicate guard, practice explaining `i > 0 && nums[i] == nums[i-1] && !used[i-1]` in plain English: "if the current element equals the previous element, and the previous element is not currently in the path (meaning we are at the same recursion level, not a deeper one), skip this element to avoid generating the same permutation twice." The `!used[i-1]` condition is the part that trips up candidates. Trace through [1,1,2] with and without this condition to see that it is correct.

Watch which function actually leaves a mark on the caller's slice, because it is not the one candidates usually name. `PermuteSwap` restores every swap and returns the array as it found it. `PermuteUnique` is the one that mutates permanently: `slices.Sort(nums)` reorders the caller's data and nothing puts it back. If the caller cared about the original order, it is gone, and the function never said so. The same is true of `SubsetsWithDup` in the previous section, and of every sort-and-skip solution in this chapter.

In production, sort a copy (`nums = append([]int(nil), nums...)`) or document the reordering in the doc comment. In an interview, just say it out loud: "note this sorts the input in place, so I'd copy first if the caller depends on the original order." It takes five seconds and it is exactly the kind of thing a reviewer is checking for.

### Senior @ FAANG: Permutation Enumeration in A/B Test Analysis

Permutation generation appears in A/B test analysis when you need to evaluate all orderings of experiment segments to detect order effects (whether the order in which users see variants affects their behavior). For n=6 segments, 6! = 720 orderings is manageable. For n=10, 3.6 million orderings requires batch processing. For n=12, the full enumeration is infeasible and statistical sampling is required.

The `NextPermutation` algorithm is the foundation for lazy permutation iteration in production systems: instead of materializing all n! permutations up front, iterate through them one at a time using `NextPermutation` and process each one as it is generated. This pattern is used in constraint solver enumeration (iterate through assignments one at a time, check each against constraints, stop when one satisfies all constraints) and in test case generation (iterate through orderings of operations, run each as a test case, stop on the first failure).

For permutation enumeration in production, the practical limit is approximately n=10 (3.6 million permutations) for real-time contexts and n=12 to n=13 (500 million to 6 billion permutations) for offline batch jobs with parallel processing. Document these limits in the function's documentation and reject inputs above them with a clear error message.
