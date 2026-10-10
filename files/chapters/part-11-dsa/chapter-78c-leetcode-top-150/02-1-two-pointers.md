## 78C.1 Two Pointers

The two-pointer technique uses two indices that move through the data structure (usually a sorted array or string) to find pairs, triplets, or subarrays satisfying a condition. The key is deciding **when** and **how** to move each pointer.

---
### LC 1 - Two Sum 🟢

**Key Insight**: Use a hash map for O(1) lookups instead of nested loops. Store `target - num` as you iterate.

```go
func twoSum(nums []int, target int) []int {
    seen := make(map[int]int) // value -> index
    for i, num := range nums {
        complement := target - num
        if j, ok := seen[complement]; ok {
            return []int{j, i}
        }
        seen[num] = i
    }
    return nil
}
```
**Time**: O(n) - single pass with hash map lookups.
**Space**: O(n) - hash map stores up to n entries.

---
### LC 15 - 3Sum 🟡

**Key Insight**: Sort first, fix one element, then use two pointers on the remainder, skipping duplicates at every level.

```go
func threeSum(nums []int) [][]int {
    sort.Ints(nums)
    var result [][]int
    n := len(nums)

    for i := 0; i < n-2; i++ {
        if i > 0 && nums[i] == nums[i-1] {
            continue // skip duplicate first element
        }
        left, right := i+1, n-1
        for left < right {
            sum := nums[i] + nums[left] + nums[right]
            switch {
            case sum < 0:
                left++
            case sum > 0:
                right--
            default:
                result = append(result, []int{nums[i], nums[left], nums[right]})
                for left < right && nums[left] == nums[left+1] {
                    left++
                }
                for left < right && nums[right] == nums[right-1] {
                    right--
                }
                left++
                right--
            }
        }
    }
    return result
}
```
**Time**: O(n²) - outer loop × two-pointer sweep.
**Space**: O(1) - ignoring output storage (sort is in-place).

---
### LC 11 - Container With Most Water 🟡

**Key Insight**: Start with the widest container. Move the shorter side inward because moving the taller side can only decrease area.

```go
func maxArea(height []int) int {
    left, right := 0, len(height)-1
    best := 0

    for left < right {
        h := min(height[left], height[right])
        area := h * (right - left)
        if area > best {
            best = area
        }
        if height[left] < height[right] {
            left++
        } else {
            right--
        }
    }
    return best
}
```

`min` is a builtin since Go 1.21, so no helper is needed.

**Time**: O(n), each pointer moves at most n times.
**Space**: O(1).

---
### LC 42 - Trapping Rain Water 🔴

**Key Insight**: Water at any position equals `min(maxLeft, maxRight) - height[i]`. Use two pointers tracking left/right maxes to compute this in one pass.

```go
func trap(height []int) int {
    if len(height) == 0 {
        return 0
    }
    left, right := 0, len(height)-1
    leftMax, rightMax := 0, 0
    water := 0

    for left < right {
        if height[left] < height[right] {
            if height[left] >= leftMax {
                leftMax = height[left]
            } else {
                water += leftMax - height[left]
            }
            left++
        } else {
            if height[right] >= rightMax {
                rightMax = height[right]
            } else {
                water += rightMax - height[right]
            }
            right--
        }
    }
    return water
}
```
**Time**: O(n) - single pass with two pointers.
**Space**: O(1).

---
### LC 125 - Valid Palindrome 🟢

**Key Insight**: Use two pointers from both ends, skipping non-alphanumeric characters and comparing case-insensitively.

```go
func isPalindrome(s string) bool {
    left, right := 0, len(s)-1

    for left < right {
        for left < right && !isAlphaNum(s[left]) {
            left++
        }
        for left < right && !isAlphaNum(s[right]) {
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

func isAlphaNum(c byte) bool {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
}

func toLower(c byte) byte {
    if c >= 'A' && c <= 'Z' {
        return c + 32
    }
    return c
}
```
**Time**: O(n) - each character visited at most once.
**Space**: O(1).

---
### LC 167 - Two Sum II (Input Array Is Sorted) 🟡

**Key Insight**: Since the array is sorted, use two pointers. If the sum is too small move the left pointer right, if too large move the right pointer left.

```go
func twoSum(numbers []int, target int) []int {
    left, right := 0, len(numbers)-1

    for left < right {
        sum := numbers[left] + numbers[right]
        switch {
        case sum < target:
            left++
        case sum > target:
            right--
        default:
            return []int{left + 1, right + 1} // 1-indexed
        }
    }
    return nil
}
```
**Time**: O(n).
**Space**: O(1).

---
### LC 283 - Move Zeroes 🟢

**Key Insight**: Use a slow pointer to track the insertion position for non-zero elements. Swap to maintain relative order.

```go
func moveZeroes(nums []int) {
    slow := 0
    for fast := 0; fast < len(nums); fast++ {
        if nums[fast] != 0 {
            nums[slow], nums[fast] = nums[fast], nums[slow]
            slow++
        }
    }
}
```
**Time**: O(n).
**Space**: O(1).

---
### LC 977 - Squares of a Sorted Array 🟢

**Key Insight**: The largest squares come from the extremes of a sorted array (most negative or most positive). Merge from both ends into result array.

```go
func sortedSquares(nums []int) []int {
    n := len(nums)
    result := make([]int, n)
    left, right := 0, n-1

    for i := n - 1; i >= 0; i-- {
        lsq := nums[left] * nums[left]
        rsq := nums[right] * nums[right]
        if lsq > rsq {
            result[i] = lsq
            left++
        } else {
            result[i] = rsq
            right--
        }
    }
    return result
}
```
**Time**: O(n).
**Space**: O(n) - output array.

---
### LC 75 - Sort Colors 🟡

**Key Insight**: Dutch National Flag. Three pointers partition the array into regions for 0s, 1s, and 2s in a single pass.

```go
func sortColors(nums []int) {
    low, mid, high := 0, 0, len(nums)-1

    for mid <= high {
        switch nums[mid] {
        case 0:
            nums[low], nums[mid] = nums[mid], nums[low]
            low++
            mid++
        case 1:
            mid++
        case 2:
            nums[mid], nums[high] = nums[high], nums[mid]
            high--
        }
    }
}
```
**Time**: O(n).
**Space**: O(1).

---
### LC 392 - Is Subsequence 🟢

**Key Insight**: Use two pointers, one on each string. Advance the subsequence pointer only when characters match.

```go
func isSubsequence(s string, t string) bool {
    si, ti := 0, 0
    for si < len(s) && ti < len(t) {
        if s[si] == t[ti] {
            si++
        }
        ti++
    }
    return si == len(s)
}
```
**Time**: O(n) where n = len(t).
**Space**: O(1).

---
### LC 88 - Merge Sorted Array 🟢

**Key Insight**: Merge backwards. Writing from the tail of `nums1` fills the reserved zero slots first, so no element is ever overwritten before it has been copied.

```go
func merge(nums1 []int, m int, nums2 []int, n int) {
    i, j, k := m-1, n-1, m+n-1

    for j >= 0 {
        if i >= 0 && nums1[i] > nums2[j] {
            nums1[k] = nums1[i]
            i--
        } else {
            nums1[k] = nums2[j]
            j--
        }
        k--
    }
}
```

The loop stops when `j` runs out rather than when both do. Any elements still left in `nums1` are already in their final positions, so copying them would be wasted work.

**Time**: O(m + n) - every element is written exactly once.
**Space**: O(1) - the merge happens in place.

---

### Junior → FAANG: Subsequence vs. Substring and Pointer Rules

Two common junior confusions in this section: confusing subsequence (elements not required to be contiguous) with substring/subarray (contiguous), and forgetting that opposite-direction two pointers require sorted data while fast/slow pointers do not.

For Is Subsequence, the fast pointer scans `t` unconditionally and the slow pointer advances only on a character match in `s`. The slow pointer finishing past the end of `s` is the success condition. Practice stating this invariant before coding: "slow points to the next character in s that still needs to be matched." If you can state the invariant, the code writes itself.

Trapping Rain Water is the hardest two-pointer problem in this section and frequently trips candidates who try to use a stack instead. The two-pointer approach maintains a left-max and right-max as it converges from both ends, processing the side with the smaller max because that side's water level is fully determined. Practicing the "which side is determined?" reasoning before the interview is the key preparation step.

### Senior @ FAANG: Two-Pointer Correctness Arguments in Production Code

In production data pipelines, two-pointer merge logic (merging two sorted streams) is a building block that appears in merge joins in database engines, external sort implementations, and LSM-tree compaction. The correctness argument is always the same: the pointer pointing to the smaller current element is advanced because we have determined its contribution to the merged output. Any bug in this logic produces silently incorrect merge results that may not surface until downstream aggregations produce wrong totals. When reviewing code that implements this pattern, demand a stated invariant in the comment, not just correct-looking code.
