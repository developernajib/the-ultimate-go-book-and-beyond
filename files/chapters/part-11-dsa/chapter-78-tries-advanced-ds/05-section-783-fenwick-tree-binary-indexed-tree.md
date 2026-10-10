## 78.3 Fenwick Tree (Binary Indexed Tree)

A Fenwick Tree, also called a Binary Indexed Tree (BIT), is a space-efficient data structure that answers prefix sum queries and applies point updates in O(log n) time, far better than the O(n) cost of a naive array scan. Its core insight is that each index `i` in the internal array stores the cumulative sum of a range whose length is determined by the lowest set bit of `i`, encoded as `i & (-i)`. The diagram below illustrates how a 10-element input array maps to its BIT representation, where each cell aggregates a specific power-of-two-aligned range.

```
┌─────────────────────────────────────────────────────────────────┐
│                    FENWICK TREE (BIT)                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Array: [3, 2, -1, 6, 5, 4, -3, 3, 7, 2]                        │
│  Index:  1  2   3  4  5  6   7  8  9 10 (1-indexed)             │
│                                                                 │
│  BIT[i] stores sum of specific range based on lowest set bit    │
│                                                                 │
│  BIT[1] = A[1]           = 3                                    │
│  BIT[2] = A[1] + A[2]    = 5                                    │
│  BIT[3] = A[3]           = -1                                   │
│  BIT[4] = A[1..4]        = 10                                   │
│  BIT[5] = A[5]           = 5                                    │
│  BIT[6] = A[5] + A[6]    = 9                                    │
│  BIT[7] = A[7]           = -3                                   │
│  BIT[8] = A[1..8]        = 19                                   │
│                                                                 │
│  Key Operations:                                                │
│  • lowbit(i) = i & (-i)  - lowest set bit                       │
│  • Query: traverse up by removing lowbit                        │
│  • Update: traverse up by adding lowbit                         │
│                                                                 │
│  Time: O(log n) for both query and update                       │
│  Space: O(n)                                                    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Fenwick Tree Implementation

A Fenwick tree (Binary Indexed Tree) supports prefix sum queries and point updates in O(log n) using a compact array. Each index `i` stores the sum of a range determined by the lowest set bit of `i`, and both update and query operations navigate this structure by adding or subtracting the lowest set bit using `i += i & (-i)` and `i -= i & (-i)` respectively.

```go
package fenwick

// FenwickTree implements a Binary Indexed Tree
type FenwickTree struct {
    tree []int
    n    int
}

// NewFenwickTree creates a Fenwick tree from an array
func NewFenwickTree(nums []int) *FenwickTree {
    n := len(nums)
    ft := &FenwickTree{
        tree: make([]int, n+1),
        n:    n,
    }

    for i, num := range nums {
        ft.Update(i, num)
    }

    return ft
}

// lowbit returns the lowest set bit
func lowbit(x int) int {
    return x & (-x)
}

// Update adds delta to index i (0-indexed)
// Time: O(log n)
func (ft *FenwickTree) Update(i, delta int) {
    i++ // Convert to 1-indexed
    for i <= ft.n {
        ft.tree[i] += delta
        i += lowbit(i)
    }
}

// PrefixSum returns sum of elements [0, i] (0-indexed)
// Time: O(log n)
func (ft *FenwickTree) PrefixSum(i int) int {
    i++ // Convert to 1-indexed
    sum := 0
    for i > 0 {
        sum += ft.tree[i]
        i -= lowbit(i)
    }
    return sum
}

// RangeSum returns sum of elements [left, right] (0-indexed)
// Time: O(log n)
func (ft *FenwickTree) RangeSum(left, right int) int {
    if left == 0 {
        return ft.PrefixSum(right)
    }
    return ft.PrefixSum(right) - ft.PrefixSum(left-1)
}

// Set changes value at index i to val
func (ft *FenwickTree) Set(i, val int, nums []int) {
    delta := val - nums[i]
    nums[i] = val
    ft.Update(i, delta)
}
```

### Range Sum Query - Mutable

LeetCode 307 asks for a data structure handling both point updates and range sum queries on a mutable array, exactly the problem a Fenwick tree solves. The `NumArray` wrapper stores a parallel `nums` slice alongside the BIT, because the tree stores sums rather than the values themselves. A BIT cannot tell you what is currently at index `i`, and `Update` needs that to compute the delta between the old and new value. The two structures must stay in step: every write goes through `Update`, which mutates `nums` and the tree together.

That coupling is why the constructor copies its input rather than keeping the caller's slice. Two things go wrong otherwise. Writes through `na.nums` would reach into the caller's array, which they did not ask for. Worse, the caller retains a live reference and can write to it directly, and any such write leaves `nums` disagreeing with the sums in the BIT, after which every query returns a confidently wrong answer with nothing to indicate it. Owning the data is what makes the invariant enforceable.

```go
// NumArray implements mutable range sum query
// LeetCode 307: Range Sum Query - Mutable
type NumArray struct {
    nums []int
    ft   *FenwickTree
}

func NumArrayConstructor(nums []int) NumArray {
    // Copy the input. Storing the caller's slice would alias it, and
    // Update writes through na.nums, silently mutating their array.
    // It would also let a caller's later writes desync nums from the BIT.
    own := make([]int, len(nums))
    copy(own, nums)
    return NumArray{
        nums: own,
        ft:   NewFenwickTree(own),
    }
}

func (na *NumArray) Update(index int, val int) {
    delta := val - na.nums[index]
    na.nums[index] = val
    na.ft.Update(index, delta)
}

func (na *NumArray) SumRange(left int, right int) int {
    return na.ft.RangeSum(left, right)
}
```

### Count of Smaller Numbers After Self

LeetCode 315 requires counting, for each element, how many values to its right are strictly smaller. A classic offline inversion-counting problem. The solution compresses the value space into dense ranks using coordinate compression, then sweeps from right to left, querying the BIT for the prefix count of all ranks smaller than the current element before inserting the current rank with a unit update.

```go
import "slices"

// CountSmaller counts smaller elements to the right
// LeetCode 315: Count of Smaller Numbers After Self
func CountSmaller(nums []int) []int {
    n := len(nums)
    result := make([]int, n)

    // Coordinate compression
    sorted := make([]int, n)
    copy(sorted, nums)
    slices.Sort(sorted)

    // Remove duplicates and create rank map
    rank := make(map[int]int)
    r := 0
    for i, num := range sorted {
        if i == 0 || num != sorted[i-1] {
            rank[num] = r
            r++
        }
    }

    // Fenwick tree for counting
    ft := &FenwickTree{
        tree: make([]int, r+1),
        n:    r,
    }

    // Process from right to left
    for i := n - 1; i >= 0; i-- {
        idx := rank[nums[i]]
        result[i] = ft.PrefixSum(idx - 1)
        ft.Update(idx, 1)
    }

    return result
}
```

### Junior → FAANG: The Three Operations You Must Know Cold

A Fenwick tree exposes three operations in interview settings: `Update(i, delta)` adds a value at a position, `PrefixSum(i)` returns the sum from position 0 to i, and `RangeSum(l, r)` subtracts two prefix sums. The bit trick `i & (-i)` is the only non-obvious line: it isolates the lowest set bit of `i`, which determines the range length stored at that index. The update traversal adds the lowest set bit at each step to climb toward the root. The query traversal removes it to collect partial sums. Practice writing both traversals from memory until the `+=` and `-=` direction is automatic, because swapping them produces a working-looking but incorrect implementation.

### Senior @ FAANG: Fenwick Trees in Competitive Ranking and Inversion Counting Pipelines

The coordinate-compressed Fenwick tree shown in the "Count of Smaller Numbers After Self" example is the foundation of ranking-evaluation pipelines. Any system that compares a predicted ordering against an observed one, such as a recommender scored against what users actually played or bought, can measure the disagreement with Kendall tau, and Kendall tau is inversion counting wearing a different name. A Fenwick tree with coordinate compression computes it in O(n log n) against O(n^2) for the brute-force pair scan, which is the whole reason this structure earns its place in an offline metrics job.

Be careful not to over-claim the technique's reach, because this is where the reasoning usually goes wrong. Kendall tau reduces to inversion counting. NDCG, the other metric people reach for here, does not: it is a sum of per-position discounted gains, computed by sorting and then walking the ranked list once, with no pair counting anywhere in it. Both are O(n log n) and both evaluate rankings, which is exactly what makes the conflation tempting. Only one of them is an inversion count, and claiming a Fenwick tree is the natural tool for NDCG will not survive a follow-up question. The staff-level concern when deploying such a pipeline is numerical stability: floating-point scores require tie-breaking rules that affect the rank mapping, and the coordinate compression must handle duplicates consistently. A property-based test generating arbitrary score lists and comparing the Fenwick-based ranking against a brute-force ranking is the correctness standard. At scale (billions of items), the algorithm must be distributed: partition items by score range across nodes, compute local inversions with Fenwick, and merge-sort across partitions to count cross-partition inversions.
