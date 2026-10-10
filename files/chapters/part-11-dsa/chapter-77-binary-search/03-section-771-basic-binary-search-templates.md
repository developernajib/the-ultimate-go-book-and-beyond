## 77.1 Basic Binary Search Templates

### Template 1: Find Exact Match

Binary search maintains two pointers defining the current search window and halves the window each iteration by comparing the target against the midpoint. The mid-calculation `left + (right-left)/2` is the overflow-safe form: it never computes a value larger than `right`, whereas `(left+right)/2` can overflow once `left+right` exceeds the range of the index type.

A note on how much that matters in Go. This bug is famous from Java and C, where indices are 32-bit and an array of a few billion elements is enough to wrap. Go's `int` is 64-bit on every 64-bit platform, so `left+right` cannot overflow for any slice that fits in memory. Write `left + (right-left)/2` anyway. It costs nothing, it is what reviewers expect to see, and it stays correct if the code is ever ported to a 32-bit target or the indices are ever narrowed to `int32`. Just do not claim in an interview that `(left+right)/2` is a live overflow bug in 64-bit Go, because it is not, and an interviewer who knows the difference will notice you repeating a rule you have not thought through.

```go
package binarysearch

// BinarySearch finds exact target in sorted array
// Returns index if found, -1 otherwise
// Time: O(log n), Space: O(1)
func BinarySearch(nums []int, target int) int {
    left, right := 0, len(nums)-1

    for left <= right {
        mid := left + (right-left)/2 // Avoid overflow

        if nums[mid] == target {
            return mid
        } else if nums[mid] < target {
            left = mid + 1
        } else {
            right = mid - 1
        }
    }

    return -1
}

// BinarySearchRecursive using recursion
func BinarySearchRecursive(nums []int, target int) int {
    return bsRecursive(nums, target, 0, len(nums)-1)
}

func bsRecursive(nums []int, target, left, right int) int {
    if left > right {
        return -1
    }

    mid := left + (right-left)/2

    if nums[mid] == target {
        return mid
    } else if nums[mid] < target {
        return bsRecursive(nums, target, mid+1, right)
    }
    return bsRecursive(nums, target, left, mid-1)
}
```

### Template 2: Find First/Last Occurrence

When a sorted array contains duplicate values, the standard exact-match template stops at an arbitrary occurrence. To pin down the leftmost index, record the match in `result` and then continue searching left by setting `right = mid - 1`. The symmetric right-biased variant continues searching right with `left = mid + 1`. Both passes run in O(log n), so finding the full range `[first, last]` requires exactly two binary search passes.

```go
// SearchFirst finds first occurrence of target
// LeetCode 34: Find First and Last Position
func SearchFirst(nums []int, target int) int {
    left, right := 0, len(nums)-1
    result := -1

    for left <= right {
        mid := left + (right-left)/2

        if nums[mid] == target {
            result = mid
            right = mid - 1 // Keep searching left
        } else if nums[mid] < target {
            left = mid + 1
        } else {
            right = mid - 1
        }
    }

    return result
}

// SearchLast finds last occurrence of target
func SearchLast(nums []int, target int) int {
    left, right := 0, len(nums)-1
    result := -1

    for left <= right {
        mid := left + (right-left)/2

        if nums[mid] == target {
            result = mid
            left = mid + 1 // Keep searching right
        } else if nums[mid] < target {
            left = mid + 1
        } else {
            right = mid - 1
        }
    }

    return result
}

// SearchRange returns [first, last] positions
// LeetCode 34: Find First and Last Position
func SearchRange(nums []int, target int) []int {
    return []int{SearchFirst(nums, target), SearchLast(nums, target)}
}
```

### Template 3: Find Insertion Point (Lower/Upper Bound)

Lower bound and upper bound answer a different question from exact search: "where does this value belong?" rather than "does this value exist?" The half-open search space `[0, len(nums)]` (note `right = len(nums)`, not `len(nums)-1`) is critical because the correct insertion point may lie one past the last element. Go's `sort.Search` implements this same contract, accepting a monotone predicate and returning the smallest index for which it holds true.

```go
// LowerBound finds smallest index where nums[index] >= target
// Returns len(nums) if all elements < target
func LowerBound(nums []int, target int) int {
    left, right := 0, len(nums)

    for left < right {
        mid := left + (right-left)/2

        if nums[mid] < target {
            left = mid + 1
        } else {
            right = mid
        }
    }

    return left
}

// UpperBound finds smallest index where nums[index] > target
// Returns len(nums) if all elements <= target
func UpperBound(nums []int, target int) int {
    left, right := 0, len(nums)

    for left < right {
        mid := left + (right-left)/2

        if nums[mid] <= target {
            left = mid + 1
        } else {
            right = mid
        }
    }

    return left
}

// SearchInsert finds insertion position
// LeetCode 35: Search Insert Position
func SearchInsert(nums []int, target int) int {
    return LowerBound(nums, target)
}

```

The same two bounds using Go's standard library. `sort.Search` returns the smallest index in `[0, n)` for which the predicate is true, or `n` if it is never true, which is exactly the lower-bound contract.

```go
import "sort"

func LowerBoundBuiltin(nums []int, target int) int {
    return sort.Search(len(nums), func(i int) bool {
        return nums[i] >= target
    })
}

func UpperBoundBuiltin(nums []int, target int) int {
    return sort.Search(len(nums), func(i int) bool {
        return nums[i] > target
    })
}
```

### Junior -> FAANG: Template Muscle Memory

The three templates above cover every standard binary search interview problem. Build muscle memory by implementing each one from scratch (no reference) five times in a row. The most common confusion is between `right = len(nums)` (half-open range for LowerBound) and `right = len(nums)-1` (closed range for Template 1). Commit this distinction: half-open range is required when the answer might be "one past the last element," which is the case for insertion point and lower/upper bound.

For `SearchFirst` and `SearchLast`, trace through the case where the entire array is the target value (e.g., `nums = [5, 5, 5, 5]`, `target = 5`). For `SearchFirst`, the loop should land at index 0. For `SearchLast`, at index 3. If your implementation returns any other index, the update rule is wrong.

The `sort.Search` built-in is idiomatic Go and should be your first choice for any lower/upper bound in production code. Practice translating problems into the `sort.Search` predicate form: "find the smallest index i such that nums[i] >= target" becomes `sort.Search(n, func(i int) bool { return nums[i] >= target })`. This translation should take under 30 seconds.

### Senior @ FAANG: Template Selection as an Architectural Signal

In a code review, the choice between templates signals whether the author understands the semantics of their search. A `left <= right` loop that never returns inside the loop and instead returns `left` after the loop is a degenerate lower-bound implementation written in the wrong template. It happens to work in some cases but obscures intent. Require that the template choice matches the problem: exact-match semantics use Template 1 with an explicit return inside the loop, and boundary semantics use Template 2 or `sort.Search`.

The `SearchRange` implementation above calls `SearchFirst` and `SearchLast` separately, making two full passes through the binary search. Both passes are O(log n), so the range query is O(log n) with a constant factor of two. The available refinement is to run `SearchFirst` first and start `SearchLast` from `left = first` rather than `0`, which narrows the second pass to the suffix after the first occurrence. This does not change the complexity class and only pays off when the first occurrence sits deep in the array. Treat it as a note for later, and reach for it only if a profile puts this search in a hot path.
