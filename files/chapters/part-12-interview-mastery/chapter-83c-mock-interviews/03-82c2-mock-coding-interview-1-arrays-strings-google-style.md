## 83C.2 Mock Coding Interview 1: Arrays & Strings (Google-style)

### Interviewer Briefing

**Company style:** Google. Emphasis on algorithmic thinking, correctness, edge cases, and code quality. The interviewer expects candidates to discuss multiple approaches before coding. Follow-up questions test depth of understanding.

**Level:** L4 (Senior Software Engineer) or L5 (Staff Software Engineer)

**Interview duration:** 45 minutes

### Problem Statement

*Read this to the candidate (or read it yourself and start the timer):*

> You are given an array of integers `nums` and an integer `target`. Find all unique quadruplets `[nums[a], nums[b], nums[c], nums[d]]` such that:
>
> - `0 <= a < b < c < d < len(nums)`
> - `nums[a] + nums[b] + nums[c] + nums[d] == target`
>
> Return all unique quadruplets. The solution set must not contain duplicate quadruplets.
>
> **Example 1:**
> Input: `nums = [1, 0, -1, 0, -2, 2]`, `target = 0`
> Output: `[[-2, -1, 1, 2], [-2, 0, 0, 2], [-1, 0, 0, 1]]`
>
> **Example 2:**
> Input: `nums = [2, 2, 2, 2, 2]`, `target = 8`
> Output: `[[2, 2, 2, 2]]`
>
> **Constraints:**
> - `1 <= len(nums) <= 200`
> - `-10^9 <= nums[i] <= 10^9`
> - `-10^9 <= target <= 10^9`

### 45-Minute Timeline

| Time | Phase | What should happen |
|------|-------|--------------------|
| 0:00-2:00 | Read & Clarify | Candidate reads problem, asks about duplicates handling, confirms integer range |
| 2:00-4:00 | Clarifying Questions | "Can nums contain duplicates?" (Yes) "Should output be sorted?" (Each quadruplet sorted, output order doesn't matter) "Can I modify the input array?" (Yes) |
| 4:00-10:00 | Approach Discussion | Candidate should mention brute force O(n^4), then O(n^3) with two pointers after sorting. Should discuss how sorting enables duplicate skipping. |
| 10:00-12:00 | Complexity Analysis | O(n^3) time, O(1) extra space (excluding output). Candidate should note that sorting is O(n log n) which is dominated by O(n^3). |
| 12:00-32:00 | Implementation | Clean Go code with proper duplicate handling at each level |
| 32:00-40:00 | Testing | Walk through Example 1 step by step. Test edge cases: all same numbers, array of length 4, negative target |
| 40:00-45:00 | Follow-ups | See follow-up questions below |

### Expected Solution Walkthrough

**Step 1: Recognize the pattern.** This is a generalization of 2Sum and 3Sum. The key insight is that sorting the array enables both the two-pointer technique and efficient duplicate skipping.

**Step 2: Reduce to 2Sum.** Fix two numbers with nested loops (i, j), then use two pointers (left, right) to find pairs that complete the target sum. This reduces from O(n^4) brute force to O(n^3).

**Step 3: Handle duplicates.** After sorting, skip consecutive equal elements at each level of the loop to avoid duplicate quadruplets. This is the most common source of bugs.

**Step 4: Handle overflow.** Since nums[i] can be up to 10^9, the sum of four numbers can overflow int32. Use int64 or Go's default int (which is 64-bit on modern systems).

### Interviewer Notes: What to Look For

**Strong signals:**
- Immediately recognizes this as an extension of 2Sum/3Sum
- Discusses brute force first, then optimizes - shows systematic thinking
- Correctly identifies that sorting enables duplicate skipping
- Handles overflow proactively (mentions 10^9 * 4 could overflow int32)
- Writes clean code with meaningful variable names
- Tests with both examples and edge cases

**Weak signals:**
- Jumps straight to coding without discussing approach
- Uses a hash set for deduplication instead of sorting-based skipping (works but less efficient and harder to implement correctly)
- Misses the overflow concern
- Cannot explain why sorting helps with duplicates
- Code has off-by-one errors in loop bounds

**Red flags:**
- Cannot solve 2Sum as a subroutine
- Produces O(n^4) solution and cannot optimize when prompted
- Code does not compile or has fundamental logic errors after 30 minutes

### Complete Go Solution

The reference implementation below is written to the standard an interviewer expects: correct complexity and idiomatic use of the standard library.

```go
package interview

import "slices"

// fourSum finds all unique quadruplets that sum to target.
// Time: O(n^3) where n = len(nums)
// Space: O(1) extra space (excluding output and sort stack)
func fourSum(nums []int, target int) [][]int {
    slices.Sort(nums)
    n := len(nums)
    var result [][]int

    for i := 0; i < n-3; i++ {
        // Skip duplicate values for the first position
        if i > 0 && nums[i] == nums[i-1] {
            continue
        }

        // Early termination: if the smallest possible sum
        // from this point exceeds target, we're done
        if nums[i]+nums[i+1]+nums[i+2]+nums[i+3] > target {
            break
        }

        // Skip if the largest possible sum with nums[i] is
        // still less than target
        if nums[i]+nums[n-3]+nums[n-2]+nums[n-1] < target {
            continue
        }

        for j := i + 1; j < n-2; j++ {
            // Skip duplicate values for the second position
            if j > i+1 && nums[j] == nums[j-1] {
                continue
            }

            // Early termination for inner loop
            if nums[i]+nums[j]+nums[j+1]+nums[j+2] > target {
                break
            }

            if nums[i]+nums[j]+nums[n-2]+nums[n-1] < target {
                continue
            }

            // Two-pointer approach for the remaining two numbers
            left, right := j+1, n-1
            for left < right {
                sum := nums[i] + nums[j] + nums[left] + nums[right]

                if sum == target {
                    result = append(result, []int{
                        nums[i], nums[j], nums[left], nums[right],
                    })

                    // Skip duplicates for third position
                    for left < right && nums[left] == nums[left+1] {
                        left++
                    }
                    // Skip duplicates for fourth position
                    for left < right && nums[right] == nums[right-1] {
                        right--
                    }
                    left++
                    right--
                } else if sum < target {
                    left++
                } else {
                    right--
                }
            }
        }
    }

    return result
}
```

### Follow-up Questions

**Follow-up 1: "Can you generalize this to kSum?"**

*What a strong candidate says:*

"Yes. The pattern generalizes recursively. For kSum, if k > 2, fix one element and recursively call (k-1)Sum on the remaining subarray. The base case is 2Sum using two pointers. The time complexity would be O(n^(k-1)). Let me sketch it:"

```go
package interview

import "slices"

// kSum generalizes the approach to find k numbers summing to target.
func kSum(nums []int, target int, k int) [][]int {
    slices.Sort(nums)
    return kSumHelper(nums, target, k, 0)
}

func kSumHelper(nums []int, target int, k int, start int) [][]int {
    var result [][]int
    n := len(nums)

    if n-start < k || k < 2 {
        return result
    }

    // Base case: 2Sum with two pointers
    if k == 2 {
        left, right := start, n-1
        for left < right {
            sum := nums[left] + nums[right]
            if sum == target {
                result = append(result, []int{nums[left], nums[right]})
                for left < right && nums[left] == nums[left+1] {
                    left++
                }
                for left < right && nums[right] == nums[right-1] {
                    right--
                }
                left++
                right--
            } else if sum < target {
                left++
            } else {
                right--
            }
        }
        return result
    }

    // Recursive case: fix one element, solve (k-1)Sum
    for i := start; i < n-k+1; i++ {
        if i > start && nums[i] == nums[i-1] {
            continue
        }

        // Early termination
        minSum := 0
        for j := 0; j < k; j++ {
            minSum += nums[i+j]
        }
        if minSum > target {
            break
        }

        maxSum := nums[i]
        for j := 1; j < k; j++ {
            maxSum += nums[n-j]
        }
        if maxSum < target {
            continue
        }

        subResults := kSumHelper(nums, target-nums[i], k-1, i+1)
        for _, sub := range subResults {
            result = append(result, append([]int{nums[i]}, sub...))
        }
    }

    return result
}
```

**Follow-up 2: "What if the array is extremely large (10^6 elements) and target combinations are sparse?"**

*What a strong candidate says:*

"At 10^6 elements, O(n^3) is 10^18 operations - infeasible. I'd consider a meet-in-the-middle approach: compute all pairwise sums and store them in a hash map. Then for each pair sum, look up (target - pair sum) in the map. This is O(n^2) time and O(n^2) space. The trade-off is memory: 10^12 pair sums won't fit in memory either. So for truly massive arrays, I'd filter aggressively - sort and use bounds to prune impossible pairs before the hash map phase."

**Follow-up 3: "How would you test this in production?"**

*What a strong candidate says:*

"I'd write table-driven tests covering: empty array, array shorter than 4, all identical elements, no valid quadruplets, negative numbers and target, overflow edge cases near int64 boundaries, and a fuzz test with random inputs verified against a brute-force O(n^4) reference implementation."

### Scoring Rubric

| Rating | Criteria |
|--------|----------|
| **Strong Hire** | Identifies O(n^3) approach quickly. Clean, bug-free code with proper duplicate handling and early termination optimizations. Discusses overflow. Tests thoroughly. Handles kSum follow-up with working recursive code. Communicates clearly throughout. |
| **Hire** | Gets to O(n^3) approach (possibly with hints). Code works correctly for both examples. Handles duplicates. May miss early termination optimizations. Answers at least one follow-up well. Good communication. |
| **Lean Hire** | Eventually gets O(n^3) with significant hints. Code mostly works but may have a bug in duplicate handling. Limited testing. Struggles with follow-ups. Communication is acceptable but not strong. |
| **No Hire** | Cannot arrive at O(n^3) approach. Code has fundamental errors. Does not handle duplicates. Poor communication. Cannot answer follow-ups. |


### Junior → FAANG: Arrays and Strings Mock Interview Fundamentals

Arrays and strings problems test your ability to reason about linear data structures under time and space constraints. Common patterns: sliding window (for substring/subarray problems with a size or condition constraint), two pointers (for sorted array problems or palindrome detection), prefix sums (for range sum queries), and hash maps (for frequency counting and complement lookup). For Google-style interviews, the interviewer expects you to arrive at an optimal solution, so practice recognizing which pattern applies based on the problem structure rather than brute-forcing and optimizing.

### Senior @ FAANG: Arrays/Strings at the L5/L6 Bar: Optimization Discussion and Code Quality

At the L5/L6 level, the coding interview evaluation includes code quality, not just correctness and asymptotic complexity. Specifically: meaningful variable names, proper error handling (edge cases and nil/empty inputs), and clean separation of logic into helper functions where appropriate. The optimization discussion at this level also includes practical performance considerations beyond O(n): cache locality (traversing an array sequentially is cache-friendly, pointer chasing is not), memory allocation patterns (pre-allocating slices in Go avoids repeated GC pressure), and the trade-off between code clarity and micro-optimization. Bar-raisers at the L6 level expect you to know when not to optimize: if the bottleneck is I/O and the algorithm is O(n log n) versus O(n), the difference is irrelevant. Demonstrating this judgment is a stronger signal than always arriving at the theoretically optimal solution.

---
