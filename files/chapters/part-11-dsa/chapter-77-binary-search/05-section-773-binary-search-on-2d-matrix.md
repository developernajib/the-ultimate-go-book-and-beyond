## 77.3 Binary Search on 2D Matrix

A matrix where each row is sorted and the first element of each row is greater than the last element of the previous row can be treated as a flattened sorted array. Mapping a 1D mid index to 2D coordinates via `row = mid / cols` and `col = mid % cols` allows standard binary search to run in O(log(m*n)) without materializing the 1D array.

```go
// SearchMatrix searches a matrix whose rows are sorted and where
// matrix[i][0] > matrix[i-1][n-1], so the whole matrix reads as one
// sorted sequence. Row-and-column sorting alone is not enough here.
// LeetCode 74: Search a 2D Matrix
// Time: O(log(m*n)), Space: O(1)
func SearchMatrix(matrix [][]int, target int) bool {
    if len(matrix) == 0 || len(matrix[0]) == 0 {
        return false
    }

    m, n := len(matrix), len(matrix[0])
    left, right := 0, m*n-1

    for left <= right {
        mid := left + (right-left)/2
        row := mid / n
        col := mid % n

        if matrix[row][col] == target {
            return true
        } else if matrix[row][col] < target {
            left = mid + 1
        } else {
            right = mid - 1
        }
    }

    return false
}

// SearchMatrixII for matrix where each row and column is sorted
// LeetCode 240: Search a 2D Matrix II
// Time: O(m + n), Space: O(1)
func SearchMatrixII(matrix [][]int, target int) bool {
    if len(matrix) == 0 || len(matrix[0]) == 0 {
        return false
    }

    m, n := len(matrix), len(matrix[0])
    row, col := 0, n-1 // Start from top-right

    for row < m && col >= 0 {
        if matrix[row][col] == target {
            return true
        } else if matrix[row][col] < target {
            row++
        } else {
            col--
        }
    }

    return false
}

// KthSmallest finds the k-th smallest element of an n x n matrix whose
// rows and columns are each sorted ascending. Square input is assumed.
// LeetCode 378: Kth Smallest Element in a Sorted Matrix
// Time: O(n * log(max-min)), Space: O(1)
func KthSmallest(matrix [][]int, k int) int {
    n := len(matrix)
    low, high := matrix[0][0], matrix[n-1][n-1]

    for low < high {
        mid := low + (high-low)/2

        // Count elements <= mid
        count := countLessOrEqual(matrix, mid)

        if count < k {
            low = mid + 1
        } else {
            high = mid
        }
    }

    return low
}

func countLessOrEqual(matrix [][]int, target int) int {
    n := len(matrix)
    count := 0
    row, col := n-1, 0

    for row >= 0 && col < n {
        if matrix[row][col] <= target {
            count += row + 1
            col++
        } else {
            row--
        }
    }

    return count
}
```

### Junior -> FAANG: 1D-to-2D Index Mapping as a Core Skill

The index mapping `row = mid / cols`, `col = mid % cols` is one of the most frequently tested 2D algorithm techniques. Memorize it and practice translating in both directions: given a (row, col) pair, compute the 1D index as `row * cols + col`. Given a 1D index `mid`, compute (row, col) as above. Draw a small 3x4 matrix on paper and verify the mapping for mid = 0, 5, 11 before trusting your memory.

The `SearchMatrixII` approach (starting from top-right and moving left or down) is not binary search in the traditional sense. It is a two-pointer elimination that works because the matrix is sorted both row-wise and column-wise. Know both approaches (1D binary search for SearchMatrix I, staircase traversal for SearchMatrix II) because they solve different problem variants.

For `KthSmallest`, the binary search is on the value range rather than on an array index. The `countLessOrEqual` function uses the same staircase traversal from SearchMatrix II. Practice deriving this: start from the bottom-left corner, move right if the current value is within the target, move up otherwise, accumulating the count of elements in the columns you pass through.

### Senior @ FAANG: 2D Search in Production Data Systems

2D binary search over sorted matrices appears in database column store implementations, where a block of sorted values is stored in a matrix format for cache efficiency. The `SearchMatrix` approach (treating the matrix as a flattened 1D array) is correct only when the strong monotonicity property holds (first element of row i+1 greater than last element of row i). If only row-wise and column-wise sorting is guaranteed, only the `SearchMatrixII` staircase approach is correct.

In a code review, require that the problem variant (strong monotonicity vs weak row/column monotonicity) is documented explicitly as a precondition comment. Teams that conflate the two variants introduce correctness bugs that only manifest for specific data distributions.

The `KthSmallest` binary search deserves a closer look, because the obvious worry about it turns out to be unfounded and the reason why is the interesting part. The search runs over the value range, not over indices, so `low` converges to the smallest value `v` for which `countLessOrEqual(v) >= k`. The natural objection is that `v` need not be an element of the matrix at all, since nothing constrained it to one. It always is, though. Suppose `v` were absent. Then no element lies in `(v-1, v]`, so `countLessOrEqual(v-1) == countLessOrEqual(v) >= k`, which makes `v-1` a smaller value satisfying the predicate and contradicts the minimality of `v`. So the converged `low` is a real matrix element, and it is the k-th smallest.

That argument is worth being able to reproduce on a whiteboard. It is the standard follow-up to this problem, and it generalizes: any binary search on an integer answer space whose predicate is a counting function returns a value that is actually attained, for exactly this reason. Note also that the loop needs the `high = mid` update rather than `high = mid - 1`. The candidate `mid` may itself be the answer, and `mid - 1` would step over it.
