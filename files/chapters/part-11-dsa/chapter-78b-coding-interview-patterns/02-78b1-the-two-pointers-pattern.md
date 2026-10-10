## 78B.1 The Two Pointers Pattern

```
┌─────────────────────────────────────────────────────────────────┐
│                    TWO POINTERS PATTERN                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Variant 1: Opposite Direction                                  │
│  ┌───┬───┬───┬───┬───┬───┬───┬───┐                              │
│  │ 1 │ 3 │ 5 │ 7 │ 9 │11 │13 │15 │                              │
│  └───┴───┴───┴───┴───┴───┴───┴───┘                              │
│    L→                          ←R                               │
│  Use: Pair sum, palindrome, container with most water           │
│                                                                 │
│  Variant 2: Same Direction (Fast/Slow)                          │
│  ┌───┬───┬───┬───┬───┬───┬───┬───┐                              │
│  │ 0 │ 1 │ 0 │ 3 │ 0 │ 5 │ 0 │ 7 │                              │
│  └───┴───┴───┴───┴───┴───┴───┴───┘                              │
│    S→  F→                                                       │
│  Use: Remove duplicates, move zeros, linked list cycle          │
│                                                                 │
│  Key insight: Reduce O(n²) brute force to O(n) by               │
│  maintaining invariants with two indices                        │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

The Two Pointers pattern uses two indices that traverse the data structure in a coordinated manner, typically reducing a brute-force O(n²) solution to O(n). There are two primary variants:

1. **Opposite direction pointers.** Start at both ends and move inward. Used when the array is sorted and you need to find pairs, or when you need to compare elements from both ends (palindromes, container problems).

2. **Same direction pointers (fast/slow).** Both start at the beginning but move at different speeds. Used for removing elements in-place, detecting cycles, and partitioning.

**When to use Two Pointers:**
- The input is a sorted array or linked list
- You need to find pairs that satisfy a condition
- You need to compare or process elements from both ends
- You need to remove or rearrange elements in-place with O(1) space
- You need to detect cycles in a linked list

### Template: Opposite Direction Two Pointers

The opposite-direction template places one pointer at the start and one at the end of a sorted array, advancing the left pointer when the current sum is too small and retreating the right pointer when it is too large. This guarantees that the pair, if it exists, is found in a single O(n) pass.

```go
func twoPointerOpposite(nums []int, target int) []int {
    left, right := 0, len(nums)-1
    for left < right {
        sum := nums[left] + nums[right]
        if sum == target {
            return []int{left, right}
        } else if sum < target {
            left++
        } else {
            right--
        }
    }
    return []int{} // no pair found
}
```

### Template: Same Direction (Fast/Slow) Two Pointers

The same-direction template uses a slow pointer to mark the write position and a fast pointer to scan ahead. Elements that satisfy the condition are compacted to the front of the array in place, with `slow` tracking the boundary between kept and unprocessed elements.

```go
func twoPointerSameDirection(nums []int) int {
    slow := 0
    for fast := 0; fast < len(nums); fast++ {
        if meetCondition(nums[fast]) {
            nums[slow] = nums[fast]
            slow++
        }
    }
    return slow // new length
}
```

---

### Problem 1: Two Sum II - Input Array Is Sorted (LC 167)

**Problem:** Given a 1-indexed sorted array `numbers`, find two numbers that add up to `target`. Return their 1-indexed positions.

**Approach:** Classic opposite-direction two pointers on a sorted array. If the sum is too small, increment left to increase it. If too large, decrement right to decrease it. The sorted property guarantees we won't miss any valid pair.

```go
func twoSum(numbers []int, target int) []int {
    left, right := 0, len(numbers)-1

    for left < right {
        sum := numbers[left] + numbers[right]
        switch {
        case sum == target:
            return []int{left + 1, right + 1} // 1-indexed
        case sum < target:
            left++
        default:
            right--
        }
    }

    return []int{} // guaranteed to have a solution per problem constraints
}
```

**Time Complexity:** O(n). Each pointer moves at most n times.
**Space Complexity:** O(1). Only two variables.

**Edge cases:**
- Two elements only: works since left=0, right=1
- Duplicate values: the algorithm handles them naturally
- Negative numbers: sorted order still holds, algorithm is unchanged

---

### Problem 2: 3Sum (LC 15)

**Problem:** Given an integer array `nums`, return all unique triplets `[nums[i], nums[j], nums[k]]` such that `i != j != k` and `nums[i] + nums[j] + nums[k] == 0`.

**Approach:** Sort the array, then fix one element and use two pointers for the remaining two. Skip duplicates at each level to ensure uniqueness.

```go
func threeSum(nums []int) [][]int {
    slices.Sort(nums)
    result := [][]int{}
    n := len(nums)

    for i := 0; i < n-2; i++ {
        // Skip duplicate values for the first element
        if i > 0 && nums[i] == nums[i-1] {
            continue
        }

        // Early termination: if smallest possible sum > 0, no more solutions
        if nums[i] > 0 {
            break
        }

        left, right := i+1, n-1
        for left < right {
            sum := nums[i] + nums[left] + nums[right]
            switch {
            case sum == 0:
                result = append(result, []int{nums[i], nums[left], nums[right]})
                // Skip duplicates for second element
                for left < right && nums[left] == nums[left+1] {
                    left++
                }
                // Skip duplicates for third element
                for left < right && nums[right] == nums[right-1] {
                    right--
                }
                left++
                right--
            case sum < 0:
                left++
            default:
                right--
            }
        }
    }

    return result
}
```

**Time Complexity:** O(n²). Sorting is O(n log n), then O(n) for the outer loop times O(n) for the two pointers.
**Space Complexity:** O(1) extra (excluding the output array and sort space).

**Edge cases:**
- All zeros: `[0, 0, 0]` → `[[0, 0, 0]]`
- Array with fewer than 3 elements → return empty
- All positive or all negative → return empty (early termination catches this)
- Many duplicates: the skip logic must handle them correctly

---

### Problem 3: Container With Most Water (LC 11)

**Problem:** Given `n` non-negative integers `height[0..n-1]` where each represents a vertical line at position `i`, find two lines that together with the x-axis form a container that holds the most water.

**Approach:** Start with the widest container (left=0, right=n-1). The area is `min(height[left], height[right]) * (right - left)`. Move the pointer pointing to the shorter line inward, because moving the taller one can never increase the area (width decreases and height is still limited by the shorter line).

```go
func maxArea(height []int) int {
    left, right := 0, len(height)-1
    maxWater := 0

    for left < right {
        // Calculate current area
        h := min(height[left], height[right])
        width := right - left
        area := h * width

        if area > maxWater {
            maxWater = area
        }

        // Move the pointer with the shorter height
        if height[left] < height[right] {
            left++
        } else {
            right--
        }
    }

    return maxWater
}

// Note: Uses builtin min() available since Go 1.21
```

**Time Complexity:** O(n). Single pass with two pointers.
**Space Complexity:** O(1).

**Edge cases:**
- Two elements: just one container, return `min(h[0], h[1]) * 1`
- All same height: the first iteration gives the answer (widest possible)
- Strictly increasing: the optimal container is not necessarily at the ends. For `[1,2,3,4]` the best pair is `(2,4)` with area 4, not the outermost pair with area 3

---

### Problem 4: Valid Palindrome (LC 125)

**Problem:** Given a string `s`, determine if it is a palindrome considering only alphanumeric characters and ignoring case.

**Approach:** Opposite-direction two pointers, skipping non-alphanumeric characters and comparing in lowercase.

```go
func isPalindrome(s string) bool {
    left, right := 0, len(s)-1

    for left < right {
        // Skip non-alphanumeric from left
        for left < right && !isAlphaNumeric(s[left]) {
            left++
        }
        // Skip non-alphanumeric from right
        for left < right && !isAlphaNumeric(s[right]) {
            right--
        }

        if toLower(s[left]) != toLower(s[right]) {
            return false
        }
        left++
        right--
    }

    return true
}

func isAlphaNumeric(c byte) bool {
    return (c >= 'a' && c <= 'z') ||
        (c >= 'A' && c <= 'Z') ||
        (c >= '0' && c <= '9')
}

func toLower(c byte) byte {
    if c >= 'A' && c <= 'Z' {
        return c + 32
    }
    return c
}
```

**Time Complexity:** O(n). Each character is visited at most once.
**Space Complexity:** O(1).

**Edge cases:**
- Empty string → true (vacuously a palindrome)
- String with only non-alphanumeric characters → true
- Single character → true
- "0P" → false (digit and letter comparison)

This version indexes bytes, which is safe here because the problem restricts the input to ASCII. If an interviewer widens the input to arbitrary Unicode, say so and switch to `[]rune(s)` with `unicode.IsLetter`, `unicode.IsDigit`, and `unicode.ToLower`. Byte indexing a multi-byte rune compares fragments of a character and gives wrong answers. Naming that constraint before you are asked is a strong signal.

---

### Problem 5: Move Zeroes (LC 283)

**Problem:** Given an integer array `nums`, move all 0's to the end while maintaining the relative order of non-zero elements. Must be done in-place.

**Approach:** Same-direction two pointers. The slow pointer marks where the next non-zero should go. The fast pointer scans for non-zero elements.

```go
func moveZeroes(nums []int) {
    slow := 0

    // Move all non-zero elements to the front
    for fast := 0; fast < len(nums); fast++ {
        if nums[fast] != 0 {
            nums[slow], nums[fast] = nums[fast], nums[slow]
            slow++
        }
    }
    // All positions from slow onward are already zero due to swapping
}
```

**Time Complexity:** O(n). Single pass.
**Space Complexity:** O(1).

**Edge cases:**
- No zeroes: each element swaps with itself (a no-op)
- All zeroes: slow never moves, array unchanged
- Single element: works correctly
- Zeroes only at the end: slow and fast move together

---

### Junior → FAANG: Internalizing the Two Pointers Invariant

The most common junior mistake with two pointers is applying the pattern to unsorted input and getting wrong answers that are hard to debug. The key prerequisite: opposite-direction two pointers require a monotone property, typically sorted order, so that moving a pointer in one direction always changes the sum (or comparison value) in a predictable direction. Without that monotone property the pointer movement logic has no correctness guarantee.

Worked internalization exercise: before writing any code, state the invariant explicitly. For Two Sum II the invariant is "at any point, if a valid pair exists, at least one of left or right is currently pointing at it." Proving that invariant is maintained by each branch of the loop is more valuable than memorizing the template, because it extends to new problems like 4Sum or Container With Most Water without re-derivation.

First-job interview habit: when the interviewer changes a constraint mid-problem (e.g., "now assume the array is not sorted"), your answer should immediately identify which invariant breaks and what the complexity cost of fixing it is. For two pointers, losing sorted order typically forces you to sort first (adding O(n log n)) or switch to a hash map approach.

Entry-level signal: correctly handling the duplicate-skip loops in 3Sum without prompting. Interviewers watch specifically for whether you enumerate the duplicate cases before running your solution.

### Senior @ FAANG: Two Pointers in Production Systems and Code Review

At L5+, two-pointer logic appears in production codebases in forms that do not look like LeetCode problems. Merge logic in LSM-tree storage engines (used in RocksDB, Cassandra, and LevelDB) is a generalized two-pointer merge: two sorted iterators advanced based on key comparison. The correctness argument is identical to the merge step in merge sort. When reviewing a storage engine patch, recognizing this pattern lets you reason about correctness at the invariant level rather than tracing code paths.

In data pipeline code, the same-direction fast/slow pointer appears as the read cursor versus write cursor pattern in ring buffers and backpressure-aware streaming. The producer advances the write cursor and the consumer advances the read cursor, and the buffer-full condition is the write cursor catching up to the read cursor in a cyclic version of the same-direction template. The shared idea is that one index trails the other and the gap between them carries the meaning.

ADR consideration: when choosing between a two-pointer approach and a hash-map approach for a pair-sum problem, the decision depends on whether the data is already sorted, whether sort stability matters, and whether extra O(n) space is acceptable given memory constraints. In embedded or latency-critical environments where heap allocations are expensive, the O(1) space two-pointer approach is often preferred even when it requires a sort step, because the sort can be done in-place. Document this tradeoff explicitly when the choice is non-obvious.

Bar-raiser signal: the candidate recognizes that the 3Sum duplicate-skip logic is not an ad hoc patch but a direct consequence of the problem's definition of "unique triplets," and can generalize the pattern to kSum without re-deriving the deduplication strategy from scratch.
