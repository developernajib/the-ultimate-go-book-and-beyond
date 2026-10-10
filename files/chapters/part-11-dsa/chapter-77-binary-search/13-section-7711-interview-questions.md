## 77.11 Interview Questions

### Question 1: Search in Rotated Sorted Array

A rotated sorted array always has at least one sorted half, which binary search can exploit by first identifying which half is ordered before deciding where to redirect the search. When duplicates are present, equal values at `nums[left]`, `nums[mid]`, and `nums[right]` prevent determining the sorted side, so both pointers must be nudged inward one step to break the ambiguity.

```go
// Search in a rotated sorted array (no duplicates)
func search(nums []int, target int) int {
    if len(nums) == 0 {
        return -1
    }

    left, right := 0, len(nums)-1

    for left <= right {
        mid := left + (right-left)/2

        if nums[mid] == target {
            return mid
        }

        // Determine which half is sorted
        if nums[left] <= nums[mid] {
            // Left half is sorted
            if target >= nums[left] && target < nums[mid] {
                right = mid - 1
            } else {
                left = mid + 1
            }
        } else {
            // Right half is sorted
            if target > nums[mid] && target <= nums[right] {
                left = mid + 1
            } else {
                right = mid - 1
            }
        }
    }

    return -1
}

// With duplicates
func searchWithDuplicates(nums []int, target int) bool {
    left, right := 0, len(nums)-1

    for left <= right {
        mid := left + (right-left)/2

        if nums[mid] == target {
            return true
        }

        // Handle duplicates: shrink search space
        if nums[left] == nums[mid] && nums[mid] == nums[right] {
            left++
            right--
        } else if nums[left] <= nums[mid] {
            if target >= nums[left] && target < nums[mid] {
                right = mid - 1
            } else {
                left = mid + 1
            }
        } else {
            if target > nums[mid] && target <= nums[right] {
                left = mid + 1
            } else {
                right = mid - 1
            }
        }
    }

    return false
}
```

### Question 2: Find Minimum in Rotated Sorted Array

The minimum element sits at the rotation pivot, which is identified by comparing the midpoint value against the rightmost element. If `nums[mid] > nums[right]`, the pivot must lie to the right of `mid`. Handling duplicates requires an additional branch: when `nums[mid] == nums[right]` it is impossible to determine which side holds the pivot, so the right boundary is decremented by one to safely reduce the search space.

```go
// Find minimum in rotated sorted array
func findMin(nums []int) int {
    left, right := 0, len(nums)-1

    // If not rotated, first element is minimum
    if nums[left] < nums[right] {
        return nums[left]
    }

    for left < right {
        mid := left + (right-left)/2

        // If mid element is greater than right, minimum is in right half
        if nums[mid] > nums[right] {
            left = mid + 1
        } else {
            right = mid
        }
    }

    return nums[left]
}

// With duplicates
func findMinWithDuplicates(nums []int) int {
    left, right := 0, len(nums)-1

    for left < right {
        mid := left + (right-left)/2

        if nums[mid] > nums[right] {
            left = mid + 1
        } else if nums[mid] < nums[right] {
            right = mid
        } else {
            // nums[mid] == nums[right], can't determine, shrink right
            right--
        }
    }

    return nums[left]
}
```

### Question 3: Find Peak Element

Binary search applies here even though the array is not fully sorted, because comparing `nums[mid]` with `nums[mid+1]` reveals the local slope: if the sequence is ascending, a peak must exist to the right, and if descending, it exists at or to the left of `mid`. This guarantees convergence to a valid peak in O(log n) steps regardless of how many peaks the array contains.

```go
// Find a peak element (element greater than neighbors)
func findPeakElement(nums []int) int {
    left, right := 0, len(nums)-1

    for left < right {
        mid := left + (right-left)/2

        if nums[mid] > nums[mid+1] {
            // Descending, peak is at mid or left
            right = mid
        } else {
            // Ascending, peak is in right half
            left = mid + 1
        }
    }

    return left
}

// Find all peaks
func findAllPeaks(nums []int) []int {
    var peaks []int
    n := len(nums)

    for i := 0; i < n; i++ {
        isPeak := true
        if i > 0 && nums[i] <= nums[i-1] {
            isPeak = false
        }
        if i < n-1 && nums[i] <= nums[i+1] {
            isPeak = false
        }
        if isPeak {
            peaks = append(peaks, i)
        }
    }

    return peaks
}
```

### Question 4: Koko Eating Bananas (Binary Search on Answer)

Rather than searching a sorted data structure, this problem applies binary search directly over the answer domain (the possible eating speeds from 1 to the size of the largest pile). For each candidate speed `k`, the helper function verifies feasibility in O(n) time, and the outer binary search narrows to the minimum viable speed in O(log maxPile) iterations.

```go
// Koko wants to eat all bananas within h hours
// Find minimum eating speed k
func minEatingSpeed(piles []int, h int) int {
    // Binary search on answer (speed k)
    left, right := 1, maxPile(piles)

    for left < right {
        mid := left + (right-left)/2

        if canFinish(piles, mid, h) {
            right = mid // Try smaller speed
        } else {
            left = mid + 1 // Need faster speed
        }
    }

    return left
}

func canFinish(piles []int, k, h int) bool {
    hours := 0
    for _, pile := range piles {
        hours += (pile + k - 1) / k // Ceiling division
    }
    return hours <= h
}

func maxPile(piles []int) int {
    max := piles[0]
    for _, p := range piles {
        if p > max {
            max = p
        }
    }
    return max
}
```

### Question 5: Median of Two Sorted Arrays

The key insight is to binary-search for a partition point `i` in the smaller array such that all elements left of the combined partition are less than or equal to all elements on the right, which implicitly defines the partition in the larger array via `j = halfLen - i`. Once the correct partition is found, the median is computed from the boundary values without merging the arrays, achieving O(log(min(m, n))) time complexity.

```go
// Find median of two sorted arrays in O(log(min(m,n)))
func findMedianSortedArrays(nums1 []int, nums2 []int) float64 {
    // Ensure nums1 is smaller
    if len(nums1) > len(nums2) {
        nums1, nums2 = nums2, nums1
    }

    m, n := len(nums1), len(nums2)
    left, right := 0, m
    halfLen := (m + n + 1) / 2

    for left <= right {
        i := left + (right-left)/2
        j := halfLen - i

        if i < m && nums2[j-1] > nums1[i] {
            // i is too small
            left = i + 1
        } else if i > 0 && nums1[i-1] > nums2[j] {
            // i is too big
            right = i - 1
        } else {
            // i is perfect
            var maxLeft int
            if i == 0 {
                maxLeft = nums2[j-1]
            } else if j == 0 {
                maxLeft = nums1[i-1]
            } else {
                maxLeft = max(nums1[i-1], nums2[j-1])
            }

            if (m+n)%2 == 1 {
                return float64(maxLeft)
            }

            var minRight int
            if i == m {
                minRight = nums2[j]
            } else if j == n {
                minRight = nums1[i]
            } else {
                minRight = min(nums1[i], nums2[j])
            }

            return float64(maxLeft+minRight) / 2.0
        }
    }

    return 0.0
}
```

### Junior -> FAANG: Structured Communication in Binary Search Interviews

For all five question types in this section, the interviewer is evaluating both correctness and communication. The ideal response structure: state the key insight ("at least one half is always sorted in a rotated array"), state the invariant ("the target, if present, is in [left, right]"), write the code, then trace through the hard case.

The hard case for each question: rotated array with target at position 0 (Question 1), array with all equal elements (Question 2), a strictly two-element input like `[1, 2]` for peak (Question 3), `h` equal to the number of piles (Koko, Question 4), and m=1 or m=n for median (Question 5). Tracing the hard case live demonstrates that you understand the algorithm rather than having memorized it.

One caution on Question 3, because it is a trap in both directions. Do not offer an all-equal array like `[2, 2, 2]` as your peak test case. LeetCode 162 guarantees `nums[i] != nums[i+1]`, and `findPeakElement` genuinely returns a non-peak on all-equal input: for `[2, 2, 2]` it returns index 2, which is not greater than its neighbor. That is not a bug in the code, it is input outside the contract, and the whole descend-toward-a-peak argument collapses without the no-equal-neighbors guarantee, since a flat run gives the comparison no slope to follow. The right move is to name the precondition and say what would break without it. Volunteering all-equal as a case your code "handles" is worse than not mentioning it.

For Koko (Question 4), explicitly state why the answer range is `[1, max(piles)]` rather than `[1, sum(piles)]`: at speed equal to the size of the largest pile, every pile takes exactly one hour, so the maximum useful speed is bounded. A speed larger than the largest pile is equivalent to that speed for all computations.

### Senior @ FAANG: Bar-Raiser Follow-Ups for Each Question

For Question 1 (Search in Rotated Array): "How does your algorithm change if the array is circularly sorted with an unknown rotation amount and you have only an O(1) random access API?" The answer is the same algorithm, since it only uses random access. The interesting follow-up is "how does it change if you only have sequential access?" The honest answer is that binary search dies with random access. Every template in this chapter depends on jumping to `mid` in O(1), and if reaching index `mid` costs `mid` steps, the halving buys nothing and a linear scan at O(n) is optimal. The related but distinct case worth raising is a sorted sequence of unknown length with random access, where exponential search doubles an index until it overshoots the target and then binary searches the bracketed range, for O(log n) total. Keep the two apart: unknown length is a bounding problem, sequential access is a lower-bound problem.

For Question 2 (Find Minimum in Rotated Array with duplicates): "In a production system where this array is updated continuously by multiple writers, how would you maintain the O(log n) guarantee?" The answer requires eliminating duplicates at write time (by including a tiebreaker key) or accepting the O(n) worst case as an acceptable degradation for the rare all-equal case. A senior candidate articulates the tradeoff explicitly.

For Question 5 (Median of Two Sorted Arrays): "What if the arrays are on different machines with no shared memory?" This is the distributed median problem, requiring quantile sketch merging rather than partition-based binary search. A staff-level candidate knows the sketch approach and can describe the accuracy-efficiency tradeoff.
