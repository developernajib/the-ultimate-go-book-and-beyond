## 77.2 Rotated Sorted Array

A rotated sorted array is two sorted halves concatenated, and the key insight is that at least one half of any binary search window is always sorted. By checking which half is sorted, we can determine with certainty whether the target lies within that half or in the other, enabling the standard O(log n) elimination.

```go
// Search in rotated sorted array
// LeetCode 33: Search in Rotated Sorted Array
// Time: O(log n), Space: O(1)
func SearchRotated(nums []int, target int) int {
    left, right := 0, len(nums)-1

    for left <= right {
        mid := left + (right-left)/2

        if nums[mid] == target {
            return mid
        }

        // Determine which half is sorted
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

// SearchRotatedWithDuplicates allows duplicates
// LeetCode 81: Search in Rotated Sorted Array II
// Time: O(log n) average, O(n) worst case
func SearchRotatedWithDuplicates(nums []int, target int) bool {
    left, right := 0, len(nums)-1

    for left <= right {
        mid := left + (right-left)/2

        if nums[mid] == target {
            return true
        }

        // Handle duplicates at boundaries
        if nums[left] == nums[mid] && nums[mid] == nums[right] {
            left++
            right--
        } else if nums[left] <= nums[mid] {
            if nums[left] <= target && target < nums[mid] {
                right = mid - 1
            } else {
                left = mid + 1
            }
        } else {
            if nums[mid] < target && target <= nums[right] {
                left = mid + 1
            } else {
                right = mid - 1
            }
        }
    }

    return false
}

// FindMin finds minimum in rotated sorted array
// LeetCode 153: Find Minimum in Rotated Sorted Array
func FindMin(nums []int) int {
    left, right := 0, len(nums)-1

    for left < right {
        mid := left + (right-left)/2

        if nums[mid] > nums[right] {
            // Minimum is in right half
            left = mid + 1
        } else {
            // Minimum is in left half (including mid)
            right = mid
        }
    }

    return nums[left]
}

// FindMinWithDuplicates handles duplicates
// LeetCode 154: Find Minimum in Rotated Sorted Array II
func FindMinWithDuplicates(nums []int) int {
    left, right := 0, len(nums)-1

    for left < right {
        mid := left + (right-left)/2

        if nums[mid] > nums[right] {
            left = mid + 1
        } else if nums[mid] < nums[right] {
            right = mid
        } else {
            // nums[mid] == nums[right]
            right--
        }
    }

    return nums[left]
}

// FindPivot returns index of pivot (smallest element)
func FindPivot(nums []int) int {
    left, right := 0, len(nums)-1

    // Array not rotated
    if nums[left] < nums[right] {
        return 0
    }

    for left < right {
        mid := left + (right-left)/2

        if nums[mid] > nums[right] {
            left = mid + 1
        } else {
            right = mid
        }
    }

    return left
}
```

All four functions above index `nums[0]` before checking the length, so they assume a non-empty slice. That assumption is fine for a LeetCode harness, which never passes an empty array, but a production caller must guard it.

### Junior -> FAANG: Mastering Rotated Array Reasoning

The rotated array is the most common binary search variant in FAANG interviews and the most likely source of failure. The mistake candidates make is trying to find the rotation point first and then searching in the correct half. This adds complexity and bugs. The cleaner approach, shown above, determines which half is sorted at each step and decides where the target lies.

The critical test case is when `nums[left] == nums[mid]`. With no duplicates this can only mean `mid == left`, which happens when the window has shrunk to one or two elements. The code stays correct there: the window `[left..mid]` is a single element, trivially sorted, and the range check `nums[left] <= target && target < nums[mid]` is false for it, so the search moves right, which is the only place left to look. With duplicates, `nums[left] == nums[mid] == nums[right]` is genuinely ambiguous. Neither half can be ruled out, since the values give no information about where the rotation point sits. That is why both boundaries shrink by one, and it is exactly the step that costs the guaranteed log-time bound.

Practice the key invariant: "if `nums[left] <= nums[mid]`, the window `[left..mid]` is sorted." Check it on both rotations. In `[4, 5, 6, 7, 0, 1, 2]` with `left=0, mid=3`, we have `4 <= 7`, so the left side is sorted and the rotation point lies to the right of mid. In `[6, 7, 0, 1, 2, 3, 4]` with `left=0, mid=3`, we have `6 > 1`, so the left side is not sorted, the rotation point is inside it, and therefore the right side `[1, 2, 3, 4]` must be sorted. Exactly one of the two cases fires every iteration, which is what makes the elimination sound.

### Senior @ FAANG: Rotated Array in Production Systems

Rotated sorted arrays appear in production as circular buffers and log files where the oldest entry is at a known offset from the start. The `FindPivot` function above is the production-useful piece: given a log file represented as a sorted-by-timestamp array that wraps around, `FindPivot` finds the oldest entry in O(log n) rather than O(n).

A senior engineer designing a log reader asks: "does the log ever contain duplicate timestamps?" If yes, the O(n) worst case for the duplicates variant may be acceptable for small windows (a disk page at a time) but not for large files. The production fix is to add a sequence number to each log entry and search by (timestamp, sequence_number) pairs, eliminating duplicates and restoring O(log n) guaranteed complexity.

`FindMinWithDuplicates` degrading to O(n) is a legitimate concern for a system that advertises log-time search. Document the limitation where the caller will see it: "This function is O(n) in the worst case, reached when the elements are all equal. A caller that needs a guaranteed O(log n) bound must supply input without duplicates, or with a tiebreaker key."
