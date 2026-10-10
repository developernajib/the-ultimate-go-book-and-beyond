## 70.1 Binary Tree Implementation

### TreeNode Definition

The `TreeNode` struct is the universal building block for binary tree problems, with a value and left/right child pointers. The `BuildTree` helper deserializes a level-order slice representation (the same format used by LeetCode) into a proper tree by processing nodes in BFS order and assigning children sequentially.

```go
package tree

// TreeNode represents a node in a binary tree
type TreeNode struct {
    Val   int
    Left  *TreeNode
    Right *TreeNode
}

// NewTreeNode creates a new tree node
func NewTreeNode(val int) *TreeNode {
    return &TreeNode{Val: val}
}

// IsLeaf returns true if node has no children
func (n *TreeNode) IsLeaf() bool {
    return n != nil && n.Left == nil && n.Right == nil
}

// Height returns the height of the tree rooted at this node
func (n *TreeNode) Height() int {
    if n == nil {
        return -1 // or 0 depending on definition
    }
    leftHeight := n.Left.Height()
    rightHeight := n.Right.Height()
    if leftHeight > rightHeight {
        return leftHeight + 1
    }
    return rightHeight + 1
}

// Size returns the number of nodes
func (n *TreeNode) Size() int {
    if n == nil {
        return 0
    }
    return 1 + n.Left.Size() + n.Right.Size()
}

// BuildTree creates a binary tree from a level-order slice, where -1 marks a
// missing child. Children of a missing node are simply omitted from the slice
// rather than padded, which is the compact form LeetCode uses.
//
// Caveat worth knowing: -1 is an in-band sentinel, so this cannot build a tree
// that legitimately contains -1. Test data in this chapter avoids -1 for that
// reason. A production decoder would use []*int, a separate presence bitmap, or
// an explicit token type so that no value is stolen from the domain.
func BuildTree(values []int) *TreeNode {
    if len(values) == 0 || values[0] == -1 {
        return nil
    }

    root := &TreeNode{Val: values[0]}
    queue := []*TreeNode{root}
    i := 1

    for len(queue) > 0 && i < len(values) {
        node := queue[0]
        queue = queue[1:]

        if i < len(values) && values[i] != -1 {
            node.Left = &TreeNode{Val: values[i]}
            queue = append(queue, node.Left)
        }
        i++

        if i < len(values) && values[i] != -1 {
            node.Right = &TreeNode{Val: values[i]}
            queue = append(queue, node.Right)
        }
        i++
    }

    return root
}
```

### Junior -> FAANG: The TreeNode as Interview Foundation

The `TreeNode` struct is identical across virtually every tree problem on LeetCode. Memorizing its definition is table stakes: `Val int`, `Left *TreeNode`, `Right *TreeNode`. The `IsLeaf`, `Height`, and `Size` methods are implementations of recursive patterns you will use in dozens of problems. Practice writing the Height function from memory because it is the basis for the balanced-tree check (LC 110), tree diameter (LC 543), and maximum path sum (LC 124).

The `BuildTree` function from level-order values is how LeetCode constructs test trees. Understanding how it works helps you trace test cases: values in the input slice correspond to BFS-order nodes, with -1 standing in for null. The tree in the introduction diagram is `BuildTree([]int{8, 3, 10, 1, 6, -1, 14, -1, -1, 4, 7, 13})`, which yields `8(3(1,6(4,7)),10(_,14(13,_)))`. Note that the slice stops as soon as the remaining nodes are all leaves: trailing nulls are not written out, and children of an absent node are skipped rather than padded, which is why the `-1` at position 5 consumes no further slots.

Two Go details in this code are worth stealing. First, `Height` and `Size` are called on possibly-nil receivers (`n.Left.Height()`), which is legal in Go: a method with a pointer receiver runs fine on a nil pointer as long as it checks `n == nil` before touching a field. That is what lets the recursion terminate without a nil guard at every call site. Second, `IsLeaf` returns false rather than panicking on nil, so the whole API is nil-safe by construction.

The most important method to internalize is the nil check: every recursive tree function calls methods or accesses fields of nodes, and every one of those calls must be guarded by checking for nil first. The idiomatic Go pattern is to put the nil check at the top of the function and return immediately, keeping the main logic unindented and clean.

### Senior @ FAANG: TreeNode Design and Production Ergonomics

The `TreeNode` as shown is the minimal interview struct. Production tree implementations require additional fields depending on the use case: a `Parent *TreeNode` pointer enables upward traversal, which certain LCA algorithms and tree modification operations need. It does create parent-child reference cycles, but be careful about the reason to avoid it: Go's garbage collector is a tracing collector, so cycles are collected without ceremony and are not a leak. This is a real difference from reference-counted runtimes such as CPython or C++ `shared_ptr`, where a parent cycle genuinely does leak unless one side is made weak. The actual costs in Go are that every node grows by a pointer word, the GC has one more edge per node to trace, and every structural mutation must now keep two pointers consistent instead of one. A `Height int` field enables O(1) balance checks in AVL trees but must be updated atomically during rotations. A `Size int` field enables O(log n) order-statistics queries (k-th smallest) without a full traversal.

The `BuildTree` function using a slice-based BFS queue is an O(n) deserialization. In production systems where trees are persisted and reconstructed frequently (for example, a B-tree index node deserialized from disk on every lookup), the deserialization path is performance-critical and must avoid unnecessary allocations. Encoding nodes as a flat array with index arithmetic (`left = 2*i+1, right = 2*i+2`) eliminates pointer allocations entirely and is the representation used by binary heaps in Go's `container/heap`. The choice between pointer-based and array-based tree representation is an ADR-level decision when designing a storage-intensive component.
