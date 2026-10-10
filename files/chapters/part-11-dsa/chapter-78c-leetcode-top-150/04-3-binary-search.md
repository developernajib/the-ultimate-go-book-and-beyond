## 78C.3 Binary Search

Binary search is not just for sorted arrays. It applies whenever you can define a monotonic predicate that partitions the search space into two halves.

---
### LC 704 - Binary Search 🟢

**Key Insight**: The most basic binary search. Compare the middle element and eliminate half the search space.

```go
func search(nums []int, target int) int {
    left, right := 0, len(nums)-1

    for left <= right {
        mid := left + (right-left)/2
        switch {
        case nums[mid] < target:
            left = mid + 1
        case nums[mid] > target:
            right = mid - 1
        default:
            return mid
        }
    }
    return -1
}
```
**Time**: O(log n).
**Space**: O(1).

---
### LC 278 - First Bad Version 🟢

**Key Insight**: Binary search for the leftmost true in a boolean predicate, the classic bisect-left pattern.

```go
func firstBadVersion(n int) int {
    left, right := 1, n
    for left < right {
        mid := left + (right-left)/2
        if isBadVersion(mid) {
            right = mid
        } else {
            left = mid + 1
        }
    }
    return left
}
```
**Time**: O(log n).
**Space**: O(1).

---
### LC 33 - Search in Rotated Sorted Array 🟡

**Key Insight**: One half is always sorted after rotation. Determine which half, then check whether the target falls in the sorted range.

```go
func search(nums []int, target int) int {
    left, right := 0, len(nums)-1

    for left <= right {
        mid := left + (right-left)/2
        if nums[mid] == target {
            return mid
        }

        if nums[left] <= nums[mid] {
            // Left half is sorted
            if nums[left] <= target && target < nums[mid] {
                right = mid - 1
            } else {
                left = mid + 1
            }
        } else {
            // Right half is sorted
            if nums[mid] < target && target <= nums[right] {
                left = mid + 1
            } else {
                right = mid - 1
            }
        }
    }
    return -1
}
```
**Time**: O(log n).
**Space**: O(1).

---
### LC 34 - Find First and Last Position of Element in Sorted Array 🟡

**Key Insight**: Run two binary searches, one for the leftmost occurrence (bisect-left) and one for the rightmost (bisect-right).

```go
func searchRange(nums []int, target int) []int {
    return []int{findFirst(nums, target), findLast(nums, target)}
}

func findFirst(nums []int, target int) int {
    left, right := 0, len(nums)-1
    result := -1
    for left <= right {
        mid := left + (right-left)/2
        if nums[mid] == target {
            result = mid
            right = mid - 1
        } else if nums[mid] < target {
            left = mid + 1
        } else {
            right = mid - 1
        }
    }
    return result
}

func findLast(nums []int, target int) int {
    left, right := 0, len(nums)-1
    result := -1
    for left <= right {
        mid := left + (right-left)/2
        if nums[mid] == target {
            result = mid
            left = mid + 1
        } else if nums[mid] < target {
            left = mid + 1
        } else {
            right = mid - 1
        }
    }
    return result
}
```
**Time**: O(log n).
**Space**: O(1).

---
### LC 74 - Search a 2D Matrix 🟡

**Key Insight**: Treat the 2D matrix as a flat sorted array. Convert the 1D index to row and column with division and modulo.

```go
func searchMatrix(matrix [][]int, target int) bool {
    if len(matrix) == 0 || len(matrix[0]) == 0 {
        return false
    }
    rows, cols := len(matrix), len(matrix[0])
    left, right := 0, rows*cols-1

    for left <= right {
        mid := left + (right-left)/2
        val := matrix[mid/cols][mid%cols]
        switch {
        case val < target:
            left = mid + 1
        case val > target:
            right = mid - 1
        default:
            return true
        }
    }
    return false
}
```
**Time**: O(log(m×n)).
**Space**: O(1).

---
### LC 153 - Find Minimum in Rotated Sorted Array 🟡

**Key Insight**: Compare mid with right. If mid > right, the minimum is in the right half. Otherwise it is in the left half (including mid).

```go
func findMin(nums []int) int {
    left, right := 0, len(nums)-1
    for left < right {
        mid := left + (right-left)/2
        if nums[mid] > nums[right] {
            left = mid + 1
        } else {
            right = mid
        }
    }
    return nums[left]
}
```
**Time**: O(log n).
**Space**: O(1).

---
### LC 162 - Find Peak Element 🟡

**Key Insight**: If `nums[mid] < nums[mid+1]`, a peak must exist to the right. Otherwise to the left (including mid).

```go
func findPeakElement(nums []int) int {
    left, right := 0, len(nums)-1
    for left < right {
        mid := left + (right-left)/2
        if nums[mid] < nums[mid+1] {
            left = mid + 1
        } else {
            right = mid
        }
    }
    return left
}
```
**Time**: O(log n).
**Space**: O(1).

---
### LC 875 - Koko Eating Bananas 🟡

**Key Insight**: Binary search on the answer, the eating speed k. Check whether Koko can finish within h hours at speed mid.

```go
func minEatingSpeed(piles []int, h int) int {
    left, right := 1, 0
    for _, p := range piles {
        if p > right {
            right = p
        }
    }

    for left < right {
        mid := left + (right-left)/2
        if canFinish(piles, mid, h) {
            right = mid
        } else {
            left = mid + 1
        }
    }
    return left
}

func canFinish(piles []int, speed, h int) bool {
    hours := 0
    for _, p := range piles {
        hours += (p + speed - 1) / speed // ceiling division
    }
    return hours <= h
}
```
**Time**: O(n × log(max(piles))).
**Space**: O(1).

---
### LC 981 - Time Based Key-Value Store 🟡

**Key Insight**: Store values with timestamps in a map of sorted lists. Binary search for the largest timestamp <= the given timestamp.

```go
type TimeMap struct {
    store map[string][]entry
}

type entry struct {
    timestamp int
    value     string
}

func Constructor() TimeMap {
    return TimeMap{store: make(map[string][]entry)}
}

func (t *TimeMap) Set(key string, value string, timestamp int) {
    t.store[key] = append(t.store[key], entry{timestamp, value})
}

func (t *TimeMap) Get(key string, timestamp int) string {
    entries := t.store[key]
    if len(entries) == 0 {
        return ""
    }

    left, right := 0, len(entries)-1
    result := ""
    for left <= right {
        mid := left + (right-left)/2
        if entries[mid].timestamp <= timestamp {
            result = entries[mid].value
            left = mid + 1
        } else {
            right = mid - 1
        }
    }
    return result
}
```
The problem guarantees that `Set` is called with strictly increasing timestamps per key, so appending keeps each list sorted. Without that guarantee `Set` would need an insertion at the correct position and `Get` would break.

**Time**: Set O(1), Get O(log n).
**Space**: O(n) total entries.

---
### LC 410 - Split Array Largest Sum 🔴

**Key Insight**: Binary search on the answer (the largest subarray sum). Greedily check if you can split into <= k subarrays with that max sum.

```go
func splitArray(nums []int, k int) int {
    left, right := 0, 0
    for _, n := range nums {
        if n > left {
            left = n
        }
        right += n
    }

    for left < right {
        mid := left + (right-left)/2
        if canSplit(nums, k, mid) {
            right = mid
        } else {
            left = mid + 1
        }
    }
    return left
}

func canSplit(nums []int, k, maxSum int) bool {
    count := 1
    current := 0
    for _, n := range nums {
        if current+n > maxSum {
            count++
            current = n
            if count > k {
                return false
            }
        } else {
            current += n
        }
    }
    return true
}
```
**Time**: O(n × log(sum - max)).
**Space**: O(1).

---
### LC 4 - Median of Two Sorted Arrays 🔴

**Key Insight**: Do not search for the median value, search for the **partition**. Cut both arrays so that the left halves together hold exactly half the elements and every element on the left is <= every element on the right. Binary search the cut position in the shorter array only, which gives O(log(min(m, n))).

```go
import "math"

func findMedianSortedArrays(nums1 []int, nums2 []int) float64 {
    if len(nums1) > len(nums2) {
        nums1, nums2 = nums2, nums1 // always binary search the shorter array
    }
    m, n := len(nums1), len(nums2)
    half := (m + n + 1) / 2 // size of the combined left half
    lo, hi := 0, m

    for lo <= hi {
        i := (lo + hi) / 2 // take i elements from nums1
        j := half - i      // take j elements from nums2

        leftA, rightA := negInf(nums1, i-1), posInf(nums1, i)
        leftB, rightB := negInf(nums2, j-1), posInf(nums2, j)

        switch {
        case leftA > rightB:
            hi = i - 1 // took too many from nums1
        case leftB > rightA:
            lo = i + 1 // took too few from nums1
        default:
            maxLeft := max(leftA, leftB)
            if (m+n)%2 == 1 {
                return float64(maxLeft)
            }
            minRight := min(rightA, rightB)
            return float64(maxLeft+minRight) / 2.0
        }
    }
    return 0 // unreachable for sorted inputs
}

// negInf returns a[i], or -infinity when i falls off the left edge.
func negInf(a []int, i int) int {
    if i < 0 {
        return math.MinInt
    }
    return a[i]
}

// posInf returns a[i], or +infinity when i falls off the right edge.
func posInf(a []int, i int) int {
    if i >= len(a) {
        return math.MaxInt
    }
    return a[i]
}
```

The infinity sentinels are what make this readable. Without them the partition check drowns in boundary conditions for the four cases where a cut lands at the very start or very end of an array. With them, an empty side simply never violates the ordering test. Rounding `half` up with `(m+n+1)/2` means the odd case needs no separate index arithmetic: the median is just the largest element on the left.

**Time**: O(log(min(m, n))) - binary search over cut positions in the shorter array.
**Space**: O(1).

---

### Junior → FAANG: The Three Binary Search Templates and When Each Applies

Binary search has three common loop termination variants that junior engineers confuse: `left < right`, `left <= right`, and `left + 1 < right`. The choice depends on what you want `left` and `right` to represent when the loop exits. For "find exact target," use `left <= right` and check `mid` directly. For "find leftmost position satisfying a predicate," use `left < right` and narrow by setting `right = mid` (not `mid-1`) when the predicate is true. For "find the boundary between two regions without overshoot," use `left + 1 < right` and check `nums[left]` and `nums[right]` after the loop.

The answer-space binary search problems (Koko Eating Bananas, Split Array Largest Sum) are where binary search at FAANG level diverges from the textbook. The predicate function is O(n) and must be implemented correctly before the binary search outer loop is even written. Practice implementing the predicate separately, testing it on examples, and then wrapping it in the binary search.

Entry-level signal: knowing which variant to use without trial and error. Write the three templates on paper, practice choosing the correct one for three problems each, and the selection becomes automatic.

### Senior @ FAANG: Binary Search on Answer Space in Capacity Planning

Binary search on answer space is a tool for systems-level capacity planning that most engineers do not recognize as such. Determining the minimum number of servers to handle a predicted peak load, given a per-server throughput model, is a binary search on the integer space of server counts with a feasibility predicate computed from the load model. The same structure applies to selecting optimal thread pool size, connection pool size, and cache capacity.

When you frame capacity planning as binary search, you gain two benefits: a principled method for finding the optimal parameter value, and a monotonicity verification step that forces you to explicitly confirm that your feasibility model is well-behaved (adding more capacity is always at least as good as less). Feasibility models that are not monotone (e.g., adding servers sometimes increases contention enough to decrease throughput) break the binary search correctness assumption and signal a more complex system interaction that needs investigation.
