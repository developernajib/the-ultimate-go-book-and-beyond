## 77.6 Median and Nth Element

Finding the median of two sorted arrays in O(log(min(m, n))) time is a classic hard binary search problem. The key insight is to binary search on the partition index of the smaller array: for every candidate cut point `i` in `nums1`, the corresponding cut point `j` in `nums2` is determined algebraically so that exactly half the total elements sit on the left side. Rather than merging the arrays (O(m + n)), the algorithm eliminates half the smaller array on each iteration by checking whether the left-side maximum exceeds the right-side minimum, converging on the correct partition in logarithmic time.

```go
// FindMedianSortedArrays finds the median of two sorted arrays.
// Precondition: the arrays are not both empty. A median of nothing is
// undefined, and this code would index out of range rather than say so.
// min and max are builtins as of Go 1.21, so no import is needed.
// LeetCode 4: Median of Two Sorted Arrays
// Time: O(log(min(m, n))), Space: O(1)
func FindMedianSortedArrays(nums1 []int, nums2 []int) float64 {
    // Ensure nums1 is smaller for efficiency
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
            left = i + 1
        } else if i > 0 && nums1[i-1] > nums2[j] {
            right = i - 1
        } else {
            // Found correct partition
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

### Junior -> FAANG: Median of Two Sorted Arrays as a Confidence Benchmark

LeetCode 4 is listed as "Hard" and is a reliable confidence benchmark. If you can implement it correctly from scratch in under 20 minutes, you are ready for hard binary search questions at any FAANG company. The algorithm has three phases: ensure nums1 is the smaller array (so binary search runs on the smaller input), binary search for the partition index i in nums1 such that all left-side elements are at most all right-side elements, then compute the median from the four boundary values.

The boundary conditions (i=0, j=0, i=m, j=n) are the cases where the partition falls at the very start or very end of one array, so one of the four boundary values does not exist. There are two standard ways to handle this. The implementation above branches explicitly on each case, which is verbose but keeps the arithmetic in `int`. The alternative is to substitute sentinels, treating a missing left boundary as negative infinity and a missing right boundary as positive infinity, which collapses the branches into plain `max` and `min` calls. If you take the sentinel route in Go, reach for `math.MinInt` and `math.MaxInt` rather than the `Int64` variants, so the constants match the width of `int` on whatever platform you build for.

Trace the algorithm on `nums1 = [2]`, `nums2 = [1, 3]`. Here m=1, n=2, so left=0, right=1, halfLen=2. First iteration: i=0, j=2. The check `nums2[j-1] = 3 > nums1[i] = 2` holds, meaning the cut left too small a value from nums1 on the left side, so left=1. Second iteration: i=1, j=1. Neither violation fires. maxLeft = max(nums1[0], nums2[0]) = max(2, 1) = 2. Total length 3 is odd, so return 2.0, which is the median of [1, 2, 3].

### Senior @ FAANG: Median in Streaming and Distributed Contexts

The O(log(min(m, n))) two-sorted-arrays algorithm is the exact-computation answer for a static input. Production systems rarely have this luxury. Streaming median computation uses two heaps (a max-heap for the lower half and a min-heap for the upper half) and maintains the invariant that they differ in size by at most one. Distributed median computation generally gives up exactness and uses a quantile sketch such as t-digest or an HDR histogram. The trade is approximation error for a summary whose size depends on a configured accuracy parameter rather than on the number of elements observed, and which can be merged across nodes. Merging is cheap relative to shipping the raw data, but it is not free: the cost scales with the size of the sketches being combined, not with a constant.

A senior engineer asked "how would you compute the median of a 100 TB dataset?" should immediately escalate to the distributed context and propose a quantile sketch approach, not a two-pointer merge. The algorithmic interview answer is necessary for understanding correctness, but the engineering answer is about choosing the right tool for the scale.
