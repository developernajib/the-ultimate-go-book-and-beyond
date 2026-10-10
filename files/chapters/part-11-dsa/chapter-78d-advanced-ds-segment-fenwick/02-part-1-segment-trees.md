## 78D.1 Segment Trees

### What Is a Segment Tree?

A segment tree is a binary tree where each node stores aggregate information (sum, min, max, GCD, etc.) about a range of the original array. The root covers the entire array, and each leaf covers a single element.

```
Array: [2, 1, 5, 3, 4]

              [15]          <- sum of [0..4]
            /      \
         [8]        [7]     <- sum of [0..2], [3..4]
        /    \     /    \
      [3]   [5]  [3]   [4]  <- sum of [0..1], [2..2], [3..3], [4..4]
     /   \
   [2]   [1]                <- sum of [0..0], [1..1]
```

**Why use it?**
- Point update + range query: O(log n) each
- Range update + range query (with lazy propagation): O(log n) each
- Brute-force alternative: O(n) per query or O(n) per update

### Segment Tree Implementation in Go

The segment tree array is allocated with `4*n` slots to safely accommodate the implicit binary tree structure regardless of whether n is a power of two. The `build` function fills nodes bottom-up from the leaves, and subsequent `update` and `query` operations traverse from root to leaves in O(log n) by halving the range at each step.

```go
package segtree

// SegmentTree supports range sum queries and point updates.
type SegmentTree struct {
	n    int
	tree []int
}

// New builds a segment tree from the given array.
func New(nums []int) *SegmentTree {
	n := len(nums)
	st := &SegmentTree{
		n:    n,
		tree: make([]int, 4*n),
	}
	if n > 0 {
		st.build(nums, 1, 0, n-1)
	}
	return st
}

func (st *SegmentTree) build(nums []int, node, start, end int) {
	if start == end {
		st.tree[node] = nums[start]
		return
	}
	mid := (start + end) / 2
	st.build(nums, 2*node, start, mid)
	st.build(nums, 2*node+1, mid+1, end)
	st.tree[node] = st.tree[2*node] + st.tree[2*node+1]
}

// Update sets nums[idx] = val.
func (st *SegmentTree) Update(idx, val int) {
	st.update(1, 0, st.n-1, idx, val)
}

func (st *SegmentTree) update(node, start, end, idx, val int) {
	if start == end {
		st.tree[node] = val
		return
	}
	mid := (start + end) / 2
	if idx <= mid {
		st.update(2*node, start, mid, idx, val)
	} else {
		st.update(2*node+1, mid+1, end, idx, val)
	}
	st.tree[node] = st.tree[2*node] + st.tree[2*node+1]
}

// Query returns the sum of nums[l..r].
func (st *SegmentTree) Query(l, r int) int {
	return st.query(1, 0, st.n-1, l, r)
}

func (st *SegmentTree) query(node, start, end, l, r int) int {
	if r < start || end < l {
		return 0 // identity for sum
	}
	if l <= start && end <= r {
		return st.tree[node]
	}
	mid := (start + end) / 2
	leftSum := st.query(2*node, start, mid, l, r)
	rightSum := st.query(2*node+1, mid+1, end, l, r)
	return leftSum + rightSum
}
```

### How Build Works

1. Recursively split the array in half
2. When we reach a single element (leaf), store it
3. On the way back up, merge children: `tree[node] = tree[left] + tree[right]`

**Time:** O(n) to build, O(log n) per query/update
**Space:** O(4n) ≈ O(n)

### How Query Works

For `Query(l, r)`:
- If the current node's range is completely outside `[l, r]` → return identity (0 for sum)
- If the current node's range is completely inside `[l, r]` → return `tree[node]`
- Otherwise → split and recurse on both children

### How Update Works

For `Update(idx, val)`:
- Walk down from root to the leaf at `idx`
- Set the leaf to `val`
- On the way back up, recalculate each ancestor

### Segment Tree for Range Minimum Query

Switching from sum to minimum requires only two changes: the merge becomes `min(left, right)` instead of addition, and the identity returned for out-of-range nodes becomes `math.MaxInt` instead of zero, so that a node entirely outside the query window can never win the comparison and contaminate the result. Returning 0 here would be a textbook silent-wrongness bug: every query would report at most 0, and on an all-positive array every answer would be 0.

Use `math.MaxInt`, not `math.MaxInt64`. The tree is `[]int`, and `math.MaxInt64` does not fit in an `int` on a 32-bit platform, so it is a compile error rather than a subtle one.

Everything else (tree size, indexing, the split-at-midpoint recursion) is identical to the sum variant. That is the real lesson: a segment tree is a generic structure parameterized by an associative merge and its identity element. Sum with 0, min with +∞, max with -∞, GCD with 0. The requirement is associativity, since the tree fixes the grouping of the operations for you and you do not get to choose which pairs merge first.

```go
package segtree

import "math"

// MinSegTree supports range minimum queries.
type MinSegTree struct {
	n    int
	tree []int
}

func NewMin(nums []int) *MinSegTree {
	n := len(nums)
	st := &MinSegTree{
		n:    n,
		tree: make([]int, 4*n),
	}
	for i := range st.tree {
		st.tree[i] = math.MaxInt // int-sized: MaxInt64 will not fit in an int on 32-bit
	}
	if n > 0 {
		st.build(nums, 1, 0, n-1)
	}
	return st
}

func (st *MinSegTree) build(nums []int, node, start, end int) {
	if start == end {
		st.tree[node] = nums[start]
		return
	}
	mid := (start + end) / 2
	st.build(nums, 2*node, start, mid)
	st.build(nums, 2*node+1, mid+1, end)
	st.tree[node] = min(st.tree[2*node], st.tree[2*node+1])
}

func (st *MinSegTree) Update(idx, val int) {
	st.update(1, 0, st.n-1, idx, val)
}

func (st *MinSegTree) update(node, start, end, idx, val int) {
	if start == end {
		st.tree[node] = val
		return
	}
	mid := (start + end) / 2
	if idx <= mid {
		st.update(2*node, start, mid, idx, val)
	} else {
		st.update(2*node+1, mid+1, end, idx, val)
	}
	st.tree[node] = min(st.tree[2*node], st.tree[2*node+1])
}

func (st *MinSegTree) Query(l, r int) int {
	return st.query(1, 0, st.n-1, l, r)
}

func (st *MinSegTree) query(node, start, end, l, r int) int {
	if r < start || end < l {
		return math.MaxInt // identity for min
	}
	if l <= start && end <= r {
		return st.tree[node]
	}
	mid := (start + end) / 2
	return min(st.query(2*node, start, mid, l, r),
		st.query(2*node+1, mid+1, end, l, r))
}

// min is the builtin, available since Go 1.21. No helper needed.
```

### Lazy Propagation

When you need **range updates** (e.g., add 5 to every element in `[l, r]`), naive segment trees require O(n) updates. Lazy propagation defers updates to children until they are actually needed.

**Key idea:** Each node stores a "pending" value. When we visit a node, we push pending updates to its children before proceeding.

```go
package segtree

// LazySegTree supports range updates and range sum queries.
type LazySegTree struct {
	n    int
	tree []int
	lazy []int
}

func NewLazy(nums []int) *LazySegTree {
	n := len(nums)
	st := &LazySegTree{
		n:    n,
		tree: make([]int, 4*n),
		lazy: make([]int, 4*n),
	}
	if n > 0 {
		st.build(nums, 1, 0, n-1)
	}
	return st
}

func (st *LazySegTree) build(nums []int, node, start, end int) {
	if start == end {
		st.tree[node] = nums[start]
		return
	}
	mid := (start + end) / 2
	st.build(nums, 2*node, start, mid)
	st.build(nums, 2*node+1, mid+1, end)
	st.tree[node] = st.tree[2*node] + st.tree[2*node+1]
}

// pushDown propagates the lazy value to children.
func (st *LazySegTree) pushDown(node, start, end int) {
	if st.lazy[node] != 0 {
		mid := (start + end) / 2
		leftCount := mid - start + 1
		rightCount := end - mid

		st.tree[2*node] += st.lazy[node] * leftCount
		st.lazy[2*node] += st.lazy[node]

		st.tree[2*node+1] += st.lazy[node] * rightCount
		st.lazy[2*node+1] += st.lazy[node]

		st.lazy[node] = 0
	}
}

// RangeUpdate adds val to every element in [l, r].
func (st *LazySegTree) RangeUpdate(l, r, val int) {
	st.rangeUpdate(1, 0, st.n-1, l, r, val)
}

func (st *LazySegTree) rangeUpdate(node, start, end, l, r, val int) {
	if r < start || end < l {
		return
	}
	if l <= start && end <= r {
		count := end - start + 1
		st.tree[node] += val * count
		st.lazy[node] += val
		return
	}
	st.pushDown(node, start, end)
	mid := (start + end) / 2
	st.rangeUpdate(2*node, start, mid, l, r, val)
	st.rangeUpdate(2*node+1, mid+1, end, l, r, val)
	st.tree[node] = st.tree[2*node] + st.tree[2*node+1]
}

// Query returns the sum of elements in [l, r].
func (st *LazySegTree) Query(l, r int) int {
	return st.query(1, 0, st.n-1, l, r)
}

func (st *LazySegTree) query(node, start, end, l, r int) int {
	if r < start || end < l {
		return 0
	}
	if l <= start && end <= r {
		return st.tree[node]
	}
	st.pushDown(node, start, end)
	mid := (start + end) / 2
	return st.query(2*node, start, mid, l, r) +
		st.query(2*node+1, mid+1, end, l, r)
}
```

**Complexity with lazy propagation:**
- Range update: O(log n)
- Range query: O(log n)
- Space: O(n)

**Reading the invariant.** Lazy propagation is where these trees go quietly wrong, so state the invariant precisely: `tree[node]` is always correct and already includes `lazy[node]`, while `lazy[node]` records an update that has been applied to this node but **not yet** to its children. Both halves matter. Because `tree[node]` is already correct, a query that stops at a fully covered node can return it immediately with no push-down. Because children are stale, any traversal that goes *past* this node must push down first.

That is why `pushDown` appears in exactly two places, and why both are necessary. In `rangeUpdate` it runs only on the partial-overlap path, after the fully-covered case has already returned. In `query` it runs in the same position. Delete either call and nothing crashes: the tree keeps returning answers, and they are simply stale. That is the failure mode to fear.

Three details in `pushDown` earn their place. It multiplies by `leftCount` and `rightCount` because the stored value is a *sum*, so adding `val` to each of k elements adds `val * k` to their total. It uses `+=` on the child's lazy rather than `=`, so that a second pending update accumulates onto a first instead of destroying it. And it clears `lazy[node]` at the end, since re-pushing the same update would double-count it. Each of those three is a real bug that a hand-picked test can miss and a randomized comparison against a brute-force reference catches immediately.

### When to Use Segment Trees

| Problem Type | Use Segment Tree? |
|---|---|
| Range sum + point update | Yes (or Fenwick tree) |
| Range min/max + point update | Yes |
| Range sum + range update | Yes (with lazy propagation) |
| Static range queries only | No, use prefix sums |
| Count of elements in range | Yes (merge sort tree variant) |

---

### Junior → FAANG: Common Segment Tree Mistakes in Interviews

Three bugs appear repeatedly in segment tree implementations under interview pressure. First, allocating `2*n` instead of `4*n` nodes causes out-of-bounds writes for non-power-of-two input sizes. Second, mixing 0-indexed and 1-indexed child formulas within the same function corrupts the tree silently. Third, forgetting to call `pushDown` before recursing in a lazy implementation returns stale answers.

Write a test the moment the code compiles. Build from `[1, 2, 3, 4]`, call `Update(2, 10)`, and query `[0, 3]`. The array is now `[1, 2, 10, 4]`, so the answer is **17**.

Compute that expected value from the array yourself rather than trusting the number here, and note the trap sitting in this very example: `Update(2, 10)` uses a 0-indexed API, so it overwrites the `3`, not the `2`. Read it as 1-indexed and you expect 18, then "fix" a correct tree until it returns the wrong answer. This is the entire failure mode of these structures in miniature. The expected value must come from a reference you trust, not from intuition about which element index 2 names.

Which is why the honest version of this advice is not "write one test." It is: write a naive O(n) reference and compare against it on random operation sequences. Every structure in this chapter was verified that way. A segment tree that is wrong on one node-range alignment passes a hand-picked example roughly as often as it fails one.

### Senior @ FAANG: Segment Trees in Database Internals and Real-Time Analytics

The segment tree shares an idea with database index internals without being one of them. Both decompose a range so a query touches a logarithmic number of nodes. The differences matter more than the similarity: a B-tree is optimized for block-oriented storage with high fan-out to minimize disk reads, and it indexes keys to locate records. A segment tree is a binary, in-memory structure whose nodes store *aggregates* rather than pointers to data. Calling a segment tree a specialized B-tree gets the relationship wrong. They are cousins that share a divide-and-conquer skeleton, and the design pressures that shaped them are unrelated.

The genuinely useful connection is the one to precomputed aggregates. Storing per-block min/max/count so a scan can skip whole blocks is the same bargain a segment tree makes, just with one level instead of log n and no support for updates. When you meet a range-aggregation fast path in a storage engine, the question to ask is how many levels of summary it keeps and whether they can be updated in place or only rebuilt.

The merge sort tree variant, which stores a sorted copy of each node's range, answers count-of-elements-in-range in O(log² n) and costs O(n log n) space. That is the basis of offline range rank queries.

The concern when introducing a segment tree into production is the update-to-query ratio. O(log n) per update is only worth paying if queries are frequent enough to amortize it. A write-heavy workload with rare queries is often better served by a plain array plus periodic bulk rebuilds, and a read-only workload should use prefix sums and skip the tree entirely. Measure before you build one.
