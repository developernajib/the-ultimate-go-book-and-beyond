## 66.3 Prefix Sum

The prefix sum technique trades O(n) preprocessing space for O(1) range queries by storing cumulative totals so that any subarray sum reduces to a single subtraction: `sum(left, right) = prefix[right+1] - prefix[left]`. This is a critical optimization when the same array is queried repeatedly. Without it, each range query costs O(n), making m queries O(m·n). With a prefix array, the same m queries run in O(n + m). The 2D variant extends this to matrix rectangles using the inclusion-exclusion principle to cancel overlapping regions.

```go
// Range Sum Query - Immutable (LeetCode 303)
type NumArray struct {
    prefix []int
}

func Constructor(nums []int) NumArray {
    prefix := make([]int, len(nums)+1)
    for i, num := range nums {
        prefix[i+1] = prefix[i] + num
    }
    return NumArray{prefix: prefix}
}

func (na *NumArray) SumRange(left int, right int) int {
    return na.prefix[right+1] - na.prefix[left]
}

// Product of Array Except Self (LeetCode 238)
// Time: O(n), Space: O(1) excluding output
func productExceptSelf(nums []int) []int {
    n := len(nums)
    result := make([]int, n)

    // Left prefix products
    result[0] = 1
    for i := 1; i < n; i++ {
        result[i] = result[i-1] * nums[i-1]
    }

    // Multiply by right prefix products
    rightProduct := 1
    for i := n - 1; i >= 0; i-- {
        result[i] *= rightProduct
        rightProduct *= nums[i]
    }

    return result
}

// 2D Prefix Sum - Range Sum Query 2D (LeetCode 304)
type NumMatrix struct {
    prefix [][]int
}

func ConstructorMatrix(matrix [][]int) NumMatrix {
    if len(matrix) == 0 || len(matrix[0]) == 0 {
        return NumMatrix{}
    }

    m, n := len(matrix), len(matrix[0])
    prefix := make([][]int, m+1)
    for i := range prefix {
        prefix[i] = make([]int, n+1)
    }

    for i := 1; i <= m; i++ {
        for j := 1; j <= n; j++ {
            prefix[i][j] = matrix[i-1][j-1] +
                prefix[i-1][j] + prefix[i][j-1] - prefix[i-1][j-1]
        }
    }

    return NumMatrix{prefix: prefix}
}

func (nm *NumMatrix) SumRegion(row1 int, col1 int, row2 int, col2 int) int {
    return nm.prefix[row2+1][col2+1] -
        nm.prefix[row1][col2+1] -
        nm.prefix[row2+1][col1] +
        nm.prefix[row1][col1]
}
```

### Junior → FAANG: Recognizing the Prefix Sum Pattern

The prefix sum pattern applies whenever you see: "given an array, answer multiple queries of the form 'what is the sum between index i and index j?'" Without preprocessing, each query is O(n). With a prefix array built in O(n), each query is O(1). The interview signal is recognizing when the problem involves repeated range queries and applying the preprocessing trade-off proactively.

For the 2D case, practice the four-cell formula until it is reflexive: `prefix[r2+1][c2+1] - prefix[r1][c2+1] - prefix[r2+1][c1] + prefix[r1][c1]`. The four terms correspond to: the full rectangle from origin to bottom-right, minus the rectangle above the query region, minus the rectangle to the left, plus the doubly-subtracted top-left corner. Drawing this diagram on paper before the interview makes the formula easier to recall under pressure.

The Product of Array Except Self problem uses a variant of this idea where the "prefix product" from the left and the "suffix product" from the right are computed separately and combined. This is a common FAANG interview problem specifically because it tests whether you can generalize the prefix sum concept to non-sum operations.

### Senior @ FAANG: Prefix Structures in Database and Query Engines

Prefix sum arrays are a fundamental building block in columnar databases and query engines. Apache Parquet uses run-length encoding with cumulative offsets to enable O(log n) row lookup by sequential offset, which is the prefix sum idea applied to variable-length record storage. ClickHouse uses prefix sums in its MergeTree storage format to enable O(log n) range queries on sorted primary key columns without reading the full column data.

The 2D prefix sum generalizes to higher dimensions (tensor prefix sums) and appears in image processing (summed area tables for fast rectangular integral computation) and machine learning (fast feature computation over spatial regions). The same formula with the inclusion-exclusion principle scales to k dimensions with 2^k terms, which is manageable for low-dimensional data but impractical for high-dimensional tensors.

For sparse data, the standard prefix sum requires O(n) space even when most values are zero. Production systems that handle sparse matrices use compressed sparse row format with cumulative non-zero counts as the prefix structure, enabling O(log n) range queries at O(nnz) space where nnz is the number of non-zero values. Understanding when to switch from dense to sparse representations, and what the complexity trade-offs are, is a staff-level data engineering competency.

---
