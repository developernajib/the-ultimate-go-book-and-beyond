## 78B.3 The Binary Search Pattern

```
┌─────────────────────────────────────────────────────────────────┐
│                  BINARY SEARCH PATTERN                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Standard:   Find target in sorted array                        │
│  Bisect Left:  Find first position >= target                    │
│  Bisect Right: Find first position > target                     │
│  On Answer:  Binary search on the answer space                  │
│                                                                 │
│  ┌───┬───┬───┬───┬───┬───┬───┬───┐                              │
│  │ 1 │ 3 │ 5 │ 7 │ 9 │11 │13 │15 │                              │
│  └───┴───┴───┴───┴───┴───┴───┴───┘                              │
│              mid=7                                              │
│  target=11 → search right half                                  │
│                                                                 │
│  Key insight: Any time you can define a monotonic               │
│  predicate (false...false, true...true), you can                │
│  binary search on it.                                           │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

Binary search is more versatile than "find an element in a sorted array." The core idea: whenever you have a monotonic predicate over a search space, you can binary search for the boundary. This applies to answer spaces, rotated arrays, matrix search, and optimization problems. Sorted order is just the most common way a monotone predicate shows up, not the requirement itself.

**When to use Binary Search:**
- Sorted array lookups
- Finding boundaries (first/last occurrence)
- Search space can be halved based on a condition
- Optimization: minimize/maximize a value where feasibility is monotonic
- Rotated sorted arrays

### Template: Standard Binary Search

Standard binary search reduces the search space by half each iteration, achieving O(log n) time by maintaining a closed interval `[left, right]` and terminating when `left > right`. The overflow-safe midpoint calculation `left + (right-left)/2` should be used universally in place of `(left+right)/2`.

```go
func binarySearch(nums []int, target int) int {
    left, right := 0, len(nums)-1

    for left <= right {
        mid := left + (right-left)/2 // avoid overflow
        if nums[mid] == target {
            return mid
        } else if nums[mid] < target {
            left = mid + 1
        } else {
            right = mid - 1
        }
    }

    return -1 // not found
}
```

### Template: Binary Search on Answer

Binary search on the answer applies when the feasibility function is monotone: finding the minimum feasible answer requires searching for the leftmost `true` in a boolean sequence `[false, ..., false, true, ..., true]`. The template below generalizes this pattern with an arbitrary `feasible` predicate, enabling O(log(hi-lo)) solutions for optimization problems.

```go
func binarySearchOnAnswer(lo, hi int, feasible func(int) bool) int {
    for lo < hi {
        mid := lo + (hi-lo)/2
        if feasible(mid) {
            hi = mid // mid might be the answer, search lower
        } else {
            lo = mid + 1 // mid is too small
        }
    }
    return lo
}
```

---

### Problem 1: Binary Search (LC 704)

**Problem:** Given a sorted array `nums` and `target`, return the index of `target` or -1.

**Approach:** Standard binary search.

```go
func search(nums []int, target int) int {
    left, right := 0, len(nums)-1

    for left <= right {
        mid := left + (right-left)/2
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
```

**Time Complexity:** O(log n).
**Space Complexity:** O(1).

**Edge cases:**
- Single element array
- Target smaller than all elements
- Target larger than all elements
- Duplicate elements (returns any matching index)

---

### Problem 2: Search in Rotated Sorted Array (LC 33)

**Problem:** An ascending sorted array is rotated at some pivot. Given `target`, return its index or -1. All values are unique.

**Approach:** Modified binary search. At each step, one half is definitely sorted. Determine which half is sorted, then check if the target lies in that sorted half.

```go
func searchRotated(nums []int, target int) int {
    left, right := 0, len(nums)-1

    for left <= right {
        mid := left + (right-left)/2

        if nums[mid] == target {
            return mid
        }

        // Left half is sorted
        if nums[left] <= nums[mid] {
            if target >= nums[left] && target < nums[mid] {
                right = mid - 1 // target in sorted left half
            } else {
                left = mid + 1 // target in right half
            }
        } else {
            // Right half is sorted
            if target > nums[mid] && target <= nums[right] {
                left = mid + 1 // target in sorted right half
            } else {
                right = mid - 1 // target in left half
            }
        }
    }

    return -1
}
```

**Time Complexity:** O(log n).
**Space Complexity:** O(1).

**Edge cases:**
- Array not rotated (pivot at index 0)
- Array of length 1 or 2
- Target at the pivot point
- Target not in the array

---

### Problem 3: Find Minimum in Rotated Sorted Array (LC 153)

**Problem:** Find the minimum element in a rotated sorted array with unique elements.

**Approach:** Binary search. If `nums[mid] > nums[right]`, the minimum is in the right half. Otherwise, it is in the left half (including mid).

```go
func findMin(nums []int) int {
    left, right := 0, len(nums)-1

    for left < right {
        mid := left + (right-left)/2

        if nums[mid] > nums[right] {
            // Minimum is in the right half (not including mid)
            left = mid + 1
        } else {
            // Minimum is in the left half (including mid)
            right = mid
        }
    }

    return nums[left]
}
```

**Time Complexity:** O(log n).
**Space Complexity:** O(1).

**Edge cases:**
- Not rotated → returns first element
- Rotated by 1 position
- Two elements

---

### Problem 4: Koko Eating Bananas (LC 875)

**Problem:** Koko has piles of bananas. She can eat `k` bananas/hour. Each hour she picks a pile and eats `k` bananas from it (if the pile has less than `k`, she eats the whole pile and doesn't eat more that hour). Return the minimum `k` such that she finishes all piles in `h` hours.

**Approach:** Binary search on the answer space. The answer `k` ranges from 1 to `max(piles)`. For each `k`, check if it is feasible (total hours <= h). The feasibility function is monotonic: if `k` works, any larger value also works.

```go
func minEatingSpeed(piles []int, h int) int {
    // Search space: [1, max(piles)]
    lo, hi := 1, 0
    for _, p := range piles {
        if p > hi {
            hi = p
        }
    }

    for lo < hi {
        mid := lo + (hi-lo)/2
        if canFinish(piles, mid, h) {
            hi = mid // mid might be the answer
        } else {
            lo = mid + 1
        }
    }

    return lo
}

func canFinish(piles []int, k, h int) bool {
    hours := 0
    for _, p := range piles {
        hours += (p + k - 1) / k // ceiling division
    }
    return hours <= h
}
```

**Time Complexity:** O(n log(max(piles))). The binary search over the answer costs log(max(piles)) steps, each running an O(n) feasibility check.
**Space Complexity:** O(1).

**Edge cases:**
- `h == len(piles)` → must eat the biggest pile in one hour, answer is max(piles)
- `h` is very large → answer is 1
- Single pile → ceiling(pile / h)

---

### Problem 5: Median of Two Sorted Arrays (LC 4)

**Problem:** Given two sorted arrays `nums1` and `nums2`, return the median of the merged array in O(log(m+n)) time.

**Approach:** Binary search on the partition of the smaller array. We need to find a cut in nums1 at position i and a corresponding cut in nums2 at position j = (m+n+1)/2 - i such that all elements on the left side are <= all elements on the right side.

```go
import "math"

func findMedianSortedArrays(nums1 []int, nums2 []int) float64 {
    // Ensure nums1 is the shorter array
    if len(nums1) > len(nums2) {
        return findMedianSortedArrays(nums2, nums1)
    }

    m, n := len(nums1), len(nums2)
    lo, hi := 0, m
    halfLen := (m + n + 1) / 2

    for lo <= hi {
        i := lo + (hi-lo)/2  // partition in nums1
        j := halfLen - i       // partition in nums2

        // Sentinels for the out-of-range edges of each partition.
        // These are int, so use math.MinInt/MaxInt, not the Int64 constants.
        var leftMax1, leftMax2, rightMin1, rightMin2 int

        if i == 0 {
            leftMax1 = math.MinInt
        } else {
            leftMax1 = nums1[i-1]
        }
        if j == 0 {
            leftMax2 = math.MinInt
        } else {
            leftMax2 = nums2[j-1]
        }
        if i == m {
            rightMin1 = math.MaxInt
        } else {
            rightMin1 = nums1[i]
        }
        if j == n {
            rightMin2 = math.MaxInt
        } else {
            rightMin2 = nums2[j]
        }

        if leftMax1 <= rightMin2 && leftMax2 <= rightMin1 {
            // Found the correct partition
            if (m+n)%2 == 1 {
                return float64(max(leftMax1, leftMax2))
            }
            return float64(max(leftMax1, leftMax2)+min(rightMin1, rightMin2)) / 2.0
        } else if leftMax1 > rightMin2 {
            hi = i - 1 // too far right in nums1
        } else {
            lo = i + 1 // too far left in nums1
        }
    }

    return 0.0 // should never reach here with valid input
}

// Note: Uses builtin max() available since Go 1.21
```

**Time Complexity:** O(log(min(m, n))).
**Space Complexity:** O(1).

**Edge cases:**
- One array is empty
- Arrays of very different lengths
- All elements of one array smaller than the other
- Single element arrays
- Even vs odd total length

---

### Junior → FAANG: Binary Search Beyond Sorted Arrays

Most junior engineers know binary search for "find element in sorted array." The FAANG-relevant extension is binary search on answer spaces: the predicate is not "is element at mid equal to target?" but "is mid a valid answer to the optimization question?" This shift requires recognizing two things: the answer space is implicitly sorted (feasibility is monotone), and the predicate is computable in O(n) or better.

A practical exercise: for "Koko Eating Bananas," before touching code, explicitly state the answer space (1 to max(piles)) and the feasibility predicate ("can Koko eat all piles in H hours at rate mid?"). Then confirm monotonicity: if rate mid is feasible, any rate higher than mid is also feasible. That monotonicity is the prerequisite for binary search. This three-step framing (answer space, predicate, monotonicity) applies identically to ship capacity, split array largest sum, and magnetic force between balls.

First-job habit: always prefer `left + (right - left) / 2` over `(left + right) / 2` to avoid integer overflow. In Go, `int` is 64-bit on most platforms and overflow is rare in practice, but the habit is correct and interviewers notice it.

The median-of-two-sorted-arrays problem (LC 4) is a frequent source of interview failure because candidates apply element binary search when the correct approach is partitioning binary search. The key realization: you are not searching for a value but for a partition position such that the left halves of both arrays contain exactly (m+n)/2 elements smaller than the right halves.

### Senior @ FAANG: Binary Search as a Universal Optimization Primitive

At L5+, binary search on answer space is a first-class tool in system design. Determining the optimal number of shards for a distributed system given throughput targets and latency constraints is a binary search on the integer space of shard counts with a simulation-based feasibility predicate. Optimal cache size selection, optimal batch size for a queue consumer, and optimal replica factor for a storage system are all instances of the same structure.

In compiler and build system optimization, binary search is used to find the first "bad" commit in a bisection search (git bisect is exactly this pattern). Understanding the pattern at the invariant level lets you reason about its correctness even when the predicate is a multi-minute CI run rather than an O(1) comparison.

ADR consideration: binary search requires that the predicate evaluation be significantly cheaper than the answer space size. If the feasibility predicate is O(n) and the answer space has O(M) candidates, the total cost is O(n log M). Document this explicitly when choosing binary search over linear scan: the choice is only beneficial when log M is much smaller than M, which is true for large integer answer spaces but may not hold when M is small. For answer spaces smaller than 64, linear scan is simpler and the performance difference is immaterial.

Bar-raiser signal: the candidate recognizes that Median of Two Sorted Arrays is a partition problem rather than a search problem, and can articulate why the binary search runs on the shorter array. The reason is concrete: `j = halfLen - i` must stay within `[0, n]`, and searching the shorter array is what guarantees it does. A candidate who can also compare this against the k-th-element-across-n-sorted-arrays generalization, and say when a heap beats the partition search, is reasoning about the pattern rather than reciting it.
