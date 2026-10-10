## 70.6 Advanced BST Operations

### Kth Smallest/Largest

Inorder traversal of a BST visits nodes in ascending order, so the k-th smallest element is simply the k-th node visited during inorder traversal. Early termination once the counter reaches k avoids traversing the entire tree, making the effective complexity O(h + k) rather than O(n).

```go
// KthSmallest finds the k-th smallest element in BST.
// Reports ok=false when the tree holds fewer than k nodes.
// Time: O(h + k), Space: O(h)
func KthSmallest(root *TreeNode, k int) (int, bool) {
    if k <= 0 {
        return 0, false
    }

    count := 0
    result := 0

    var inorder func(*TreeNode)
    inorder = func(node *TreeNode) {
        if node == nil || count >= k {
            return
        }

        inorder(node.Left)

        // Re-check: the left subtree may have already reached k.
        if count >= k {
            return
        }

        count++
        if count == k {
            result = node.Val
            return
        }

        inorder(node.Right)
    }

    inorder(root)
    return result, count >= k
}

// KthSmallestIterative using an explicit stack.
//
// The len(stack) > 0 term in the loop condition is load-bearing. Without it,
// a nil root or a k larger than the node count runs the stack empty and then
// indexes stack[-1], panicking instead of reporting "not found".
func KthSmallestIterative(root *TreeNode, k int) (int, bool) {
    if k <= 0 {
        return 0, false
    }

    stack := []*TreeNode{}
    curr := root

    for curr != nil || len(stack) > 0 {
        for curr != nil {
            stack = append(stack, curr)
            curr = curr.Left
        }

        curr = stack[len(stack)-1]
        stack = stack[:len(stack)-1]

        k--
        if k == 0 {
            return curr.Val, true
        }

        curr = curr.Right
    }

    return 0, false // fewer than k nodes in the tree
}
```

### Range Operations

BST range operations exploit the ordering property to prune entire subtrees: if the current node is below the lower bound, only the right subtree can contain valid values. If above the upper bound, only the left subtree. This pruning makes both range sum and BST trimming run in O(n) in the worst case but far faster on typical inputs.

```go
// RangeSumBST sums values in range [low, high]
// LeetCode 938: Range Sum of BST
// Time: O(h + k) where k is the number of in-range nodes, so O(n) worst case
// on a degenerate tree and O(log n + k) on a balanced one.
// Space: O(h)
func RangeSumBST(root *TreeNode, low int, high int) int {
    if root == nil {
        return 0
    }

    if root.Val < low {
        return RangeSumBST(root.Right, low, high)
    }
    if root.Val > high {
        return RangeSumBST(root.Left, low, high)
    }

    return root.Val +
        RangeSumBST(root.Left, low, high) +
        RangeSumBST(root.Right, low, high)
}

// TrimBST removes nodes outside range [low, high]
// LeetCode 669: Trim a Binary Search Tree
func TrimBST(root *TreeNode, low int, high int) *TreeNode {
    if root == nil {
        return nil
    }

    if root.Val < low {
        return TrimBST(root.Right, low, high)
    }
    if root.Val > high {
        return TrimBST(root.Left, low, high)
    }

    root.Left = TrimBST(root.Left, low, high)
    root.Right = TrimBST(root.Right, low, high)
    return root
}
```

### Delete Node in BST

BST deletion handles three cases by increasing complexity: a leaf is simply removed, a node with one child is replaced by that child, and a node with two children requires replacing its value with the inorder successor and then deleting that successor from the right subtree.

```go
// DeleteNode removes a node from BST
// LeetCode 450: Delete Node in a BST
func DeleteNode(root *TreeNode, key int) *TreeNode {
    if root == nil {
        return nil
    }

    if key < root.Val {
        root.Left = DeleteNode(root.Left, key)
    } else if key > root.Val {
        root.Right = DeleteNode(root.Right, key)
    } else {
        // Node to delete found

        // Case 1: Leaf node
        if root.Left == nil && root.Right == nil {
            return nil
        }

        // Case 2: One child
        if root.Left == nil {
            return root.Right
        }
        if root.Right == nil {
            return root.Left
        }

        // Case 3: Two children
        // Find inorder successor
        successor := root.Right
        for successor.Left != nil {
            successor = successor.Left
        }
        root.Val = successor.Val
        root.Right = DeleteNode(root.Right, successor.Val)
    }

    return root
}
```

### Junior -> FAANG: Advanced BST Operations in Interview Context

KthSmallest (LC 230) is a common medium-difficulty problem. The key insight is that inorder traversal of a BST visits nodes in ascending order, so the kth element visited is the kth smallest. The iterative version using an explicit stack is preferred for production because it allows early termination without unwinding the call stack.

The early-termination condition (`count >= k`) is what keeps the traversal from walking the whole tree after the answer is known. Note that it is checked twice in the recursive version, once on entry and once after the left subtree returns, because the left subtree can consume the entire budget on its own.

Both functions here return `(int, bool)` rather than a bare `int`, and that is worth copying. The LeetCode signature returns only `int` because the problem statement promises `1 <= k <= n`, but real callers have no such promise. A function that cannot express "there is no kth element" has to either panic or invent a value, and inventing `0` is the worse of the two, since `0` is a perfectly plausible element. Make absence representable in the signature.

RangeSumBST (LC 938) is a good problem for demonstrating BST property pruning: "if root.Val < low, only the right subtree can have values in range." Stating this explicitly to the interviewer demonstrates BST knowledge beyond memorized syntax.

The three-case BST deletion pattern (leaf, one child, two children) in DeleteNode is identical to the deletion implementation in the BST class above. If you are asked to implement `Delete` on a BST in an interview, code it as a recursive helper that returns the modified subtree root, exactly as shown.

### Senior @ FAANG: BST Augmentation for Order Statistics

The KthSmallest problem exposes a fundamental limitation of plain BSTs: finding the kth smallest requires O(h + k) time because there is no way to know how many elements are in the left subtree without traversing it. Augmenting each node with a `Size` field (the number of nodes in its subtree) enables O(h) order-statistics queries: if `leftSize >= k`, recurse left - if `leftSize + 1 == k`, return the current node, otherwise, recurse right with `k = k - leftSize - 1`.

Do not assume a library gives you this for free. `github.com/google/btree`, the usual Go answer for an ordered in-memory container, exposes `Get`, `Delete`, `Len`, and the `Ascend`/`Descend` range iterators, but no rank or select operation: it does not carry per-subtree counts, so "give me the 10,000th key" degrades to iterating 10,000 keys. Databases that do offer O(log n) rank queries pay for them with exactly this augmentation, maintained on every write.

That cost is the real design point. Size augmentation is not free, because every insert and delete must update the counter on each node along the path, and every rotation or node split must recompute the counts it disturbs. Decide on it when the structure is designed. Retrofitting it later means touching every mutation path in the implementation, and a single missed update produces a tree that answers rank queries wrongly while every other operation keeps working, which is a genuinely unpleasant bug to find.

RangeSumBST demonstrates the production pattern of query pruning using data structure invariants. A staff engineer reviews any range query implementation and asks: "Is this query exploiting the structural invariants of the underlying data structure, or is it doing a full scan?" A full scan of a BST for a range query is O(n), missing the point of the BST entirely. The pruned version shown is O(h + k) where k is the number of nodes in range, which on a balanced tree is O(log n + k) and is asymptotically optimal: you cannot beat paying for the descent plus the results you return. Keep the h rather than writing log n, though, since the pruning does nothing to fix a degenerate tree, and on one the same code is O(n).
