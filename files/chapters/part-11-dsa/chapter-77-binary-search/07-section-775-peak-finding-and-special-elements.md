## 77.5 Peak Finding and Special Elements

Peak finding uses binary search even though the array is not sorted: if `nums[mid] < nums[mid+1]`, the right side must contain a peak (since the array eventually ends or decreases), so searching right guarantees convergence. This asymmetric reasoning eliminates one half per iteration while guaranteeing a peak will be found in O(log n).

```go
// FindPeakElement finds any peak (greater than neighbors)
// LeetCode 162: Find Peak Element
// Time: O(log n), Space: O(1)
func FindPeakElement(nums []int) int {
    left, right := 0, len(nums)-1

    for left < right {
        mid := left + (right-left)/2

        if nums[mid] > nums[mid+1] {
            right = mid
        } else {
            left = mid + 1
        }
    }

    return left
}

// PeakIndexInMountainArray finds peak in bitonic array
// LeetCode 852: Peak Index in a Mountain Array
func PeakIndexInMountainArray(arr []int) int {
    left, right := 0, len(arr)-1

    for left < right {
        mid := left + (right-left)/2

        if arr[mid] < arr[mid+1] {
            left = mid + 1
        } else {
            right = mid
        }
    }

    return left
}

// FindInMountainArray searches in bitonic/mountain array
// LeetCode 1095: Find in Mountain Array
func FindInMountainArray(target int, mountainArr []int) int {
    n := len(mountainArr)

    // Find peak
    left, right := 0, n-1
    for left < right {
        mid := left + (right-left)/2
        if mountainArr[mid] < mountainArr[mid+1] {
            left = mid + 1
        } else {
            right = mid
        }
    }
    peak := left

    // Search in ascending part
    result := binarySearchAsc(mountainArr, target, 0, peak)
    if result != -1 {
        return result
    }

    // Search in descending part
    return binarySearchDesc(mountainArr, target, peak+1, n-1)
}

func binarySearchAsc(arr []int, target, left, right int) int {
    for left <= right {
        mid := left + (right-left)/2
        if arr[mid] == target {
            return mid
        } else if arr[mid] < target {
            left = mid + 1
        } else {
            right = mid - 1
        }
    }
    return -1
}

func binarySearchDesc(arr []int, target, left, right int) int {
    for left <= right {
        mid := left + (right-left)/2
        if arr[mid] == target {
            return mid
        } else if arr[mid] < target {
            right = mid - 1
        } else {
            left = mid + 1
        }
    }
    return -1
}
```

The two helpers differ in exactly one place: `binarySearchDesc` swaps the branch bodies, because in a descending run a value smaller than the target lies to the left rather than the right. Everything else, including the loop condition and the closed range, is identical to Template 1.

### Junior -> FAANG: Peak Finding as a Non-Obvious Binary Search

Peak finding is surprising to candidates because the array is not sorted. The insight that makes binary search applicable is that comparing `nums[mid]` with `nums[mid+1]` reveals a local slope, and in any array that eventually terminates (or is treated as bounded), a rising slope must eventually lead to a peak. Practice the invariant: "there is always at least one peak in [left, right]." Before the loop, this is true by assumption. After setting `right = mid` when `nums[mid] > nums[mid+1]`, the peak either is at `mid` or is to the left, so the invariant holds. After setting `left = mid + 1` when ascending, the peak must be strictly to the right (since `nums[mid] < nums[mid+1]`), so the invariant holds.

For `FindInMountainArray`, practice the three-phase structure: find the peak (one binary search), search the ascending half (standard binary search), search the descending half (reverse comparison binary search). The key is to search the ascending half first because the problem requests the smallest valid index.

### Senior @ FAANG: Peak Finding in Distributed Monitoring

Peak finding appears in distributed monitoring systems when you want to find the time of maximum load in a time series without scanning the entire series. If the load function is unimodal (rises to a peak and then falls), peak finding binary search locates the peak in O(log n) lookups rather than O(n). This matters when each lookup requires a database query or a network round trip.

The assumption of unimodality is the critical precondition, and it is the part that usually fails. Real load curves are noisy, so a single dip between two samples is enough to send the search down the wrong half and return a local bump rather than the global maximum. Note what the algorithm actually promises: it finds *a* peak, not *the* peak, and on non-unimodal data those are different answers. Systems that need the true maximum either smooth the series first, or use the binary search as a cheap hint and validate with a scan. Document the precondition where the caller can see it, and treat a unimodality violation as a signal in its own right, since a load curve that suddenly grows a second peak often means something upstream changed.
