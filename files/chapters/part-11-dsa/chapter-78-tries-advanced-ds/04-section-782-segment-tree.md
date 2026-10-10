## 78.2 Segment Tree

A segment tree solves the range query problem: given a mutable array, answer arbitrary range aggregate queries (sum, min, max) and point updates both in O(log n) rather than the O(n) a naive scan would cost. It works by recursively halving the array during an O(n) build, storing each node's aggregate over the sub-range it covers, so that any query range decomposes into at most O(log n) of those precomputed nodes.

The split is at the midpoint of each node's range, not on power-of-two boundaries. For an array of six elements the root covers `[0, 5]` and its children cover `[0, 2]` and `[3, 5]`, neither of which is a power-of-two-aligned block. This distinguishes a segment tree from structures that do rely on power-of-two alignment, such as sparse tables and Fenwick trees, and it is why the segment tree handles any `n` without padding the input up to the next power of two.

```
┌─────────────────────────────────────────────────────────────────┐
│                    SEGMENT TREE                                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Array: [1, 3, 5, 7, 9, 11]                                     │
│                                                                 │
│  Segment Tree (sum):                                            │
│                                                                 │
│                        [36]                                     │
│                     [0-5]                                       │
│                    /      \                                     │
│                 [9]        [27]                                 │
│               [0-2]       [3-5]                                 │
│              /    \      /     \                                │
│            [4]   [5]   [16]   [11]                              │
│           [0-1] [2]   [3-4]   [5]                               │
│          /    \      /    \                                     │
│        [1]   [3]   [7]   [9]                                    │
│        [0]   [1]   [3]   [4]                                    │
│                                                                 │
│  Operations:                                                    │
│  • Build: O(n)                                                  │
│  • Range Query: O(log n)                                        │
│  • Point Update: O(log n)                                       │
│  • Range Update (with lazy): O(log n)                           │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Basic Segment Tree

A segment tree stores aggregate values (sum, min, max) for ranges in an array, enabling both point updates and range queries in O(log n). The tree is represented as an array where node `i`'s children are at indices `2i` and `2i+1`, and the root at index 1 covers the full input range.

```go
package segtree

// SegmentTree implements a segment tree for range sum queries
type SegmentTree struct {
    tree []int
    n    int
}

// NewSegmentTree creates a segment tree from an array.
// The 4*n sizing is the standard safe bound: the recursion can reach
// depth ceil(log2(n))+1, and 4*n covers the worst case for any n
// without needing to round the input up to a power of two.
func NewSegmentTree(nums []int) *SegmentTree {
    n := len(nums)
    if n == 0 {
        // build would index nums[0] on an empty slice and panic.
        // An empty tree answers every query with the sum identity, 0.
        return &SegmentTree{tree: nil, n: 0}
    }
    st := &SegmentTree{
        tree: make([]int, 4*n),
        n:    n,
    }
    st.build(nums, 0, 0, n-1)
    return st
}

// build constructs the segment tree recursively
func (st *SegmentTree) build(nums []int, node, start, end int) {
    if start == end {
        st.tree[node] = nums[start]
        return
    }

    mid := start + (end-start)/2
    leftChild := 2*node + 1
    rightChild := 2*node + 2

    st.build(nums, leftChild, start, mid)
    st.build(nums, rightChild, mid+1, end)

    st.tree[node] = st.tree[leftChild] + st.tree[rightChild]
}

// Update changes value at index
// Time: O(log n)
func (st *SegmentTree) Update(index, val int) {
    if index < 0 || index >= st.n {
        return // out of range: nothing to update
    }
    st.updateHelper(0, 0, st.n-1, index, val)
}

func (st *SegmentTree) updateHelper(node, start, end, index, val int) {
    if start == end {
        st.tree[node] = val
        return
    }

    mid := start + (end-start)/2
    leftChild := 2*node + 1
    rightChild := 2*node + 2

    if index <= mid {
        st.updateHelper(leftChild, start, mid, index, val)
    } else {
        st.updateHelper(rightChild, mid+1, end, index, val)
    }

    st.tree[node] = st.tree[leftChild] + st.tree[rightChild]
}

// Query returns sum of range [left, right]
// Time: O(log n)
func (st *SegmentTree) Query(left, right int) int {
    if st.n == 0 {
        return 0
    }
    return st.queryHelper(0, 0, st.n-1, left, right)
}

func (st *SegmentTree) queryHelper(node, start, end, left, right int) int {
    // No overlap
    if right < start || left > end {
        return 0
    }

    // Complete overlap
    if left <= start && end <= right {
        return st.tree[node]
    }

    // Partial overlap
    mid := start + (end-start)/2
    leftSum := st.queryHelper(2*node+1, start, mid, left, right)
    rightSum := st.queryHelper(2*node+2, mid+1, end, left, right)

    return leftSum + rightSum
}
```

### Lazy Propagation Segment Tree

Without lazy propagation, applying a range update (e.g., "add 5 to every element from index 2 to 9") requires visiting every affected leaf individually, degrading range updates to O(n). Lazy propagation defers the work by storing a pending delta on each internal node and pushing it down to children only when those children actually need to be accessed, keeping both range updates and subsequent range queries at O(log n). The `lazy` array carries these deferred increments, and `pushDown` flushes them to children before any traversal descends further.

```go
// LazySegmentTree supports range updates
type LazySegmentTree struct {
    tree []int
    lazy []int
    n    int
}

// NewLazySegmentTree creates a segment tree with lazy propagation
func NewLazySegmentTree(nums []int) *LazySegmentTree {
    n := len(nums)
    if n == 0 {
        return &LazySegmentTree{n: 0}
    }
    st := &LazySegmentTree{
        tree: make([]int, 4*n),
        lazy: make([]int, 4*n),
        n:    n,
    }
    st.build(nums, 0, 0, n-1)
    return st
}

func (st *LazySegmentTree) build(nums []int, node, start, end int) {
    if start == end {
        st.tree[node] = nums[start]
        return
    }

    mid := start + (end-start)/2
    st.build(nums, 2*node+1, start, mid)
    st.build(nums, 2*node+2, mid+1, end)
    st.tree[node] = st.tree[2*node+1] + st.tree[2*node+2]
}

// pushDown propagates lazy values to children
func (st *LazySegmentTree) pushDown(node, start, end int) {
    if st.lazy[node] != 0 {
        mid := start + (end-start)/2
        leftChild := 2*node + 1
        rightChild := 2*node + 2

        // Update children
        st.tree[leftChild] += st.lazy[node] * (mid - start + 1)
        st.tree[rightChild] += st.lazy[node] * (end - mid)

        // Propagate lazy
        st.lazy[leftChild] += st.lazy[node]
        st.lazy[rightChild] += st.lazy[node]

        st.lazy[node] = 0
    }
}

// RangeUpdate adds val to all elements in range [left, right]
// Time: O(log n)
func (st *LazySegmentTree) RangeUpdate(left, right, val int) {
    if st.n == 0 {
        return
    }
    st.rangeUpdateHelper(0, 0, st.n-1, left, right, val)
}

func (st *LazySegmentTree) rangeUpdateHelper(node, start, end, left, right, val int) {
    if right < start || left > end {
        return
    }

    if left <= start && end <= right {
        st.tree[node] += val * (end - start + 1)
        st.lazy[node] += val
        return
    }

    st.pushDown(node, start, end)

    mid := start + (end-start)/2
    st.rangeUpdateHelper(2*node+1, start, mid, left, right, val)
    st.rangeUpdateHelper(2*node+2, mid+1, end, left, right, val)

    st.tree[node] = st.tree[2*node+1] + st.tree[2*node+2]
}

// Query returns sum of range [left, right]
func (st *LazySegmentTree) Query(left, right int) int {
    if st.n == 0 {
        return 0
    }
    return st.queryHelper(0, 0, st.n-1, left, right)
}

func (st *LazySegmentTree) queryHelper(node, start, end, left, right int) int {
    if right < start || left > end {
        return 0
    }

    if left <= start && end <= right {
        return st.tree[node]
    }

    st.pushDown(node, start, end)

    mid := start + (end-start)/2
    leftSum := st.queryHelper(2*node+1, start, mid, left, right)
    rightSum := st.queryHelper(2*node+2, mid+1, end, left, right)

    return leftSum + rightSum
}
```

### Junior → FAANG: Lazy Propagation as the Critical Complexity Unlock

Without lazy propagation, a range update on a segment tree requires visiting every leaf in the range: O(n) in the worst case, eliminating the advantage over brute force. With lazy propagation, a pending update is stored at an internal node and pushed down only when a query or update needs to go deeper. This transforms range update + range query from O(n) to O(log n). The interview bug pattern is forgetting to push down before recursing: if you query a range that overlaps a node holding a lazy value, you must apply and propagate that value before examining the children. Write a test immediately after implementing: apply a range update on `[0, n-1]`, then query a subrange and verify the result, to catch missing pushDown calls.

### Senior @ FAANG: Segment Tree Variants and Their Production Applications

The segment tree in this section implements range sum with lazy propagation, but the structure generalizes to any associative operation: range minimum, range maximum, range GCD, range AND/OR/XOR, and count of elements satisfying a predicate. Each variant has a specific production application. Range minimum query (RMQ) is used in suffix array LCP computation for full-text search. Range maximum is used in stock price analytics ("maximum price in a time window"). Persistent segment trees store the history of all past versions of the tree in O(n log n) total space, enabling "range sum at version k" queries for immutable distributed databases and version-controlled analytics. Merge sort trees (each node stores a sorted list) enable "count of elements in range [l, r] with value in [lo, hi]" in O(log^2 n), used in order statistics and quantile computation. The staff-level engineering challenge is choosing the right variant and implementing it correctly under the time and operational constraints of a production service: a persistent segment tree requires careful memory management (structural sharing of nodes across versions) and is significantly harder to debug than a standard segment tree, so the ADR must justify its use over simpler alternatives.
