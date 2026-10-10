## 78D.2 Fenwick Tree (Binary Indexed Tree)

### What Is a Fenwick Tree?

A Fenwick tree (also called Binary Indexed Tree or BIT) is a simpler, more space-efficient alternative to segment trees for **prefix sum** queries and **point updates**. It uses a clever bit-manipulation trick to determine which ranges each index is responsible for.

**Key insight:** Each index `i` in the Fenwick tree stores the sum of a range whose length equals the lowest set bit of `i`.

```
Index (1-based):  1   2   3   4   5   6   7   8
Lowest bit:       1   2   1   4   1   2   1   8
Range covered:   [1] [1,2] [3] [1,4] [5] [5,6] [7] [1,8]
```

### Fenwick Tree Implementation in Go

```go
package fenwick

// FenwickTree supports prefix sum queries and point updates.
// Uses 1-based indexing internally.
type FenwickTree struct {
	n    int
	tree []int
}

// New creates a Fenwick tree of size n (0-indexed input).
func New(n int) *FenwickTree {
	return &FenwickTree{
		n:    n,
		tree: make([]int, n+1), // 1-indexed
	}
}

// FromArray builds a Fenwick tree from the given array in O(n).
func FromArray(nums []int) *FenwickTree {
	n := len(nums)
	ft := &FenwickTree{
		n:    n,
		tree: make([]int, n+1),
	}
	// Copy nums into tree (1-indexed)
	for i := 0; i < n; i++ {
		ft.tree[i+1] = nums[i]
	}
	// Build in O(n) by propagating to parents
	for i := 1; i <= n; i++ {
		parent := i + (i & (-i))
		if parent <= n {
			ft.tree[parent] += ft.tree[i]
		}
	}
	return ft
}

// Update adds delta to index i (0-indexed).
func (ft *FenwickTree) Update(i, delta int) {
	i++ // convert to 1-indexed
	for i <= ft.n {
		ft.tree[i] += delta
		i += i & (-i) // move to parent
	}
}

// PrefixSum returns the sum of elements [0, i] (0-indexed).
func (ft *FenwickTree) PrefixSum(i int) int {
	i++ // convert to 1-indexed
	sum := 0
	for i > 0 {
		sum += ft.tree[i]
		i -= i & (-i) // move to previous range
	}
	return sum
}

// RangeSum returns the sum of elements [l, r] (0-indexed).
func (ft *FenwickTree) RangeSum(l, r int) int {
	if l == 0 {
		return ft.PrefixSum(r)
	}
	return ft.PrefixSum(r) - ft.PrefixSum(l-1)
}
```

The `l == 0` guard is defensive rather than load-bearing: `PrefixSum(-1)` increments to 0, fails the `i > 0` test immediately, and returns 0, so `PrefixSum(r) - PrefixSum(-1)` already gives the right answer. Keep the guard for readability if you like, but know that it is documenting intent, not preventing a bug.

`FromArray` is worth a second look, because it builds in O(n) rather than the O(n log n) you get from n separate `Update` calls. It seeds each `tree[i+1]` with a raw element, then makes a single left-to-right pass pushing each slot's accumulated total into its parent at `i + (i & -i)`. By the time index `i` is read, every index that feeds it has already been folded in, so one pass suffices. The `parent <= n` check drops the pushes that fall outside the tree.

### How `i & (-i)` Works

This expression extracts the **lowest set bit** of `i`. In two's complement, `-i` is `^i + 1`, which flips every bit above the lowest set bit and leaves the lowest set bit itself as the only position where `i` and `-i` agree on a 1.

```
i      = 12 = 0000...00001100
-i     = -12 = 1111...11110100   (two's complement: ^i + 1)
i & -i =                0100  = 4
```

- **Update:** add the lowest bit to move to the next index responsible for this one: `i += i & (-i)`
- **Query:** subtract the lowest bit to jump to the previous disjoint range: `i -= i & (-i)`

### Why the 1-indexing Is Mandatory, Not a Convention

This is the single most important paragraph in this section. A Fenwick tree **cannot** be 0-indexed, and the reason is mechanical: `0 & -0 == 0`.

Feed index 0 into these loops and watch what happens. `Update`'s step becomes `i += 0`, which never advances: an infinite loop. `PrefixSum`'s guard `for i > 0` is false immediately, so it returns 0 without summing anything, and it does so **silently**. There is no panic and no error. Element 0 simply does not exist, and every prefix sum that should include it is short by exactly its value.

Concretely, a 0-indexed Fenwick tree built over `[10, 20, 30, 40]` reports the prefix sum through the last index as 90 rather than 100. Nothing signals a problem. The number is merely wrong, and it is close enough to right that it survives a glance.

This is why `Update` and `PrefixSum` open with `i++` and why `tree` is allocated with `n+1` slots. Index 0 of the array is deliberately unused. It is not waste, it is the sentinel that makes the bit arithmetic terminate. Whenever you write or review a Fenwick tree, find the conversion to 1-indexing first. If it is absent, the structure is wrong regardless of how the tests look.

### Fenwick Tree vs Segment Tree

| Feature | Fenwick Tree | Segment Tree |
|---|---|---|
| Space | O(n) | O(4n) |
| Code complexity | ~20 lines | ~60 lines |
| Point update | O(log n) | O(log n) |
| Prefix sum query | O(log n) | O(log n) |
| Range min/max | Not supported | Supported |
| Range update + range query | Complex (2 BITs) | Supported (lazy) |
| Constant factor | Smaller | Larger |

**Rule of thumb:** Use Fenwick tree when you only need prefix sums. Use segment tree when you need min/max or more complex operations.

### 2D Fenwick Tree

For 2D prefix sum queries (common in matrix problems):

```go
package fenwick

// FenwickTree2D supports 2D prefix sum queries and point updates.
type FenwickTree2D struct {
	rows, cols int
	tree       [][]int
}

func New2D(rows, cols int) *FenwickTree2D {
	tree := make([][]int, rows+1)
	for i := range tree {
		tree[i] = make([]int, cols+1)
	}
	return &FenwickTree2D{rows: rows, cols: cols, tree: tree}
}

func (ft *FenwickTree2D) Update(r, c, delta int) {
	r++
	c++
	for i := r; i <= ft.rows; i += i & (-i) {
		for j := c; j <= ft.cols; j += j & (-j) {
			ft.tree[i][j] += delta
		}
	}
}

func (ft *FenwickTree2D) PrefixSum(r, c int) int {
	r++
	c++
	sum := 0
	for i := r; i > 0; i -= i & (-i) {
		for j := c; j > 0; j -= j & (-j) {
			sum += ft.tree[i][j]
		}
	}
	return sum
}

// RangeSum returns sum of submatrix [r1,c1] to [r2,c2] (0-indexed).
func (ft *FenwickTree2D) RangeSum(r1, c1, r2, c2 int) int {
	sum := ft.PrefixSum(r2, c2)
	if r1 > 0 {
		sum -= ft.PrefixSum(r1-1, c2)
	}
	if c1 > 0 {
		sum -= ft.PrefixSum(r2, c1-1)
	}
	if r1 > 0 && c1 > 0 {
		sum += ft.PrefixSum(r1-1, c1-1)
	}
	return sum
}
```

### LeetCode 307: Range Sum Query - Mutable

**Problem:** Given an integer array `nums`, handle multiple queries of two types: update the value at an index, and find the sum of elements between indices `left` and `right`.

```go
type NumArray struct {
	ft   []int
	nums []int
	n    int
}

func Constructor(nums []int) NumArray {
	n := len(nums)
	na := NumArray{
		ft:   make([]int, n+1),
		nums: make([]int, n),
		n:    n,
	}
	copy(na.nums, nums)
	for i := 0; i < n; i++ {
		na.add(i+1, nums[i])
	}
	return na
}

func (na *NumArray) add(i, delta int) {
	for i <= na.n {
		na.ft[i] += delta
		i += i & (-i)
	}
}

func (na *NumArray) prefixSum(i int) int {
	sum := 0
	for i > 0 {
		sum += na.ft[i]
		i -= i & (-i)
	}
	return sum
}

func (na *NumArray) Update(index int, val int) {
	delta := val - na.nums[index]
	na.nums[index] = val
	na.add(index+1, delta)
}

func (na *NumArray) SumRange(left int, right int) int {
	return na.prefixSum(right+1) - na.prefixSum(left)
}
```

**Complexity:** O(log n) per update and query. O(n log n) to build.

### LeetCode 315: Count of Smaller Numbers After Self

**Problem:** Given an integer array `nums`, return an array `counts` where `counts[i]` is the number of elements to the right of `nums[i]` that are smaller than `nums[i]`.

**Key insight:** Process from right to left. Use a Fenwick tree indexed by value to count how many smaller values we have seen so far.

```go
import "sort"

func countSmaller(nums []int) []int {
	// Coordinate compression
	sorted := make([]int, len(nums))
	copy(sorted, nums)
	sort.Ints(sorted)
	sorted = removeDuplicates(sorted)
	rank := make(map[int]int)
	for i, v := range sorted {
		rank[v] = i + 1 // 1-indexed
	}

	n := len(sorted)
	ft := make([]int, n+1)

	add := func(i int) {
		for i <= n {
			ft[i]++
			i += i & (-i)
		}
	}

	prefixSum := func(i int) int {
		s := 0
		for i > 0 {
			s += ft[i]
			i -= i & (-i)
		}
		return s
	}

	result := make([]int, len(nums))
	for i := len(nums) - 1; i >= 0; i-- {
		r := rank[nums[i]]
		result[i] = prefixSum(r - 1) // count elements with rank < r
		add(r)
	}
	return result
}

func removeDuplicates(sorted []int) []int {
	if len(sorted) == 0 {
		return sorted
	}
	result := []int{sorted[0]}
	for i := 1; i < len(sorted); i++ {
		if sorted[i] != sorted[i-1] {
			result = append(result, sorted[i])
		}
	}
	return result
}
```

**Complexity:** O(n log n) time, O(n) space.

Notice the inversion in what the tree indexes. Everywhere else in this chapter the Fenwick tree is indexed by *position* and stores values. Here it is indexed by *value rank* and stores counts. `prefixSum(r-1)` asks "how many values with rank strictly below this one have I already inserted," and since the scan runs right to left, "already inserted" means "lies to the right in the original array." That reframing, from positions to values, is the trick that makes counting problems tractable, and it is worth recognizing as a technique rather than memorizing as a solution.

Coordinate compression is what makes it affordable: values may span the full integer range, but only n of them occur, so mapping them to ranks 1..n bounds the tree at n+1 slots. The ranks are assigned `i + 1` for exactly the reason in the previous section.

---

### Junior → FAANG: Fenwick Tree as the Interview-Friendly Range Query Tool

The Fenwick tree is usually the better interview choice for prefix sums, but be precise about why: it is *less code*, not less subtle. There is no child index formula and no tree sizing, just `i += i & (-i)` to update and `i -= i & (-i)` to query. That brevity is real and it is worth having memorized.

What it buys in typing speed it charges back in opacity. The segment tree wears its structure on its face, and you can print a node's range and see whether it looks right. The Fenwick tree's structure is implicit in the bit arithmetic, so when it returns a wrong answer there is nothing intermediate to inspect. Every mistake, especially anything involving index 0, is silent. So: fewer lines, fewer places to slip, and less help when you do.

Three things to internalize: it is 1-indexed and this is mandatory rather than stylistic, `i & (-i)` isolates the lowest set bit, and any range query is the difference of two prefix queries, which is exactly why the structure only supports operations with an inverse. Practice until `Update` and `PrefixSum` come out from memory in under two minutes, then, every time, test against a naive prefix-sum reference including index 0 specifically.

### Senior @ FAANG: Fenwick Trees in Streaming Aggregation and Inversion Count Systems

Fenwick trees appear in several non-obvious production contexts. Counting inversions (the number of pairs `(i, j)` where `i < j` but `arr[i] > arr[j]`) is solved with Fenwick plus coordinate compression in O(n log n), and this problem underlies recommendation system ranking quality metrics (Kendall tau correlation between predicted and actual rankings). In streaming analytics, a Fenwick tree over a sliding time window (with coordinate compression over discrete timestamps) enables O(log n) per-event updates and O(log n) range sum queries for time-bucketed aggregations. The 2D Fenwick tree (LC 308) extends to columnar data with two range dimensions, used in spatial analytics for aggregate queries over geographic bounding boxes. The staff-level design question is: "When does the complexity of a Fenwick tree implementation become a maintenance liability, and at what point should it be replaced by a database aggregate index?" The answer depends on update frequency, query latency requirements, and team familiarity. A Fenwick tree requires correctness ownership. A database index does not, but at the cost of higher latency and infrastructure dependency.
