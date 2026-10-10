## 70.3 Binary Search Tree Implementation

A binary search tree maintains the invariant that every node's left subtree contains only smaller values and its right subtree contains only larger values, enabling O(log n) average-case search, insert, and delete when the tree remains balanced. Deletion is the most complex BST operation: removing a node with two children requires replacing it with its inorder successor (the smallest value in its right subtree) to preserve the BST ordering property.

```go
package bst

// BST implements a binary search tree
type BST struct {
    Root *TreeNode
    size int
}

// NewBST creates an empty BST
func NewBST() *BST {
    return &BST{}
}

// Size returns the number of nodes
func (b *BST) Size() int {
    return b.size
}

// IsEmpty returns true if the tree is empty
func (b *BST) IsEmpty() bool {
    return b.size == 0
}

// Insert adds a value to the BST
// Time: O(h) where h is height, O(log n) average, O(n) worst
func (b *BST) Insert(val int) {
    var inserted bool
    b.Root, inserted = b.insertHelper(b.Root, val)
    if inserted {
        b.size++
    }
}

func (b *BST) insertHelper(node *TreeNode, val int) (*TreeNode, bool) {
    if node == nil {
        return &TreeNode{Val: val}, true
    }

    var inserted bool
    if val < node.Val {
        node.Left, inserted = b.insertHelper(node.Left, val)
    } else if val > node.Val {
        node.Right, inserted = b.insertHelper(node.Right, val)
    }
    // Duplicate values are not inserted (inserted remains false)

    return node, inserted
}

// InsertIterative inserts without recursion
func (b *BST) InsertIterative(val int) {
    newNode := &TreeNode{Val: val}

    if b.Root == nil {
        b.Root = newNode
        b.size++
        return
    }

    curr := b.Root
    for {
        if val < curr.Val {
            if curr.Left == nil {
                curr.Left = newNode
                b.size++
                return
            }
            curr = curr.Left
        } else if val > curr.Val {
            if curr.Right == nil {
                curr.Right = newNode
                b.size++
                return
            }
            curr = curr.Right
        } else {
            return // duplicate
        }
    }
}

// Search finds a value in the BST
// Time: O(h)
func (b *BST) Search(val int) *TreeNode {
    return b.searchHelper(b.Root, val)
}

func (b *BST) searchHelper(node *TreeNode, val int) *TreeNode {
    if node == nil || node.Val == val {
        return node
    }

    if val < node.Val {
        return b.searchHelper(node.Left, val)
    }
    return b.searchHelper(node.Right, val)
}

// SearchIterative searches without recursion
func (b *BST) SearchIterative(val int) *TreeNode {
    curr := b.Root
    for curr != nil && curr.Val != val {
        if val < curr.Val {
            curr = curr.Left
        } else {
            curr = curr.Right
        }
    }
    return curr
}

// Contains checks if a value exists
func (b *BST) Contains(val int) bool {
    return b.Search(val) != nil
}

// Delete removes a value from the BST
// Time: O(h)
func (b *BST) Delete(val int) bool {
    if !b.Contains(val) {
        return false
    }
    b.Root = b.deleteHelper(b.Root, val)
    b.size--
    return true
}

func (b *BST) deleteHelper(node *TreeNode, val int) *TreeNode {
    if node == nil {
        return nil
    }

    if val < node.Val {
        node.Left = b.deleteHelper(node.Left, val)
    } else if val > node.Val {
        node.Right = b.deleteHelper(node.Right, val)
    } else {
        // Found the node to delete

        // Case 1: No children (leaf)
        if node.Left == nil && node.Right == nil {
            return nil
        }

        // Case 2: One child
        if node.Left == nil {
            return node.Right
        }
        if node.Right == nil {
            return node.Left
        }

        // Case 3: Two children
        // Find inorder successor (smallest in right subtree)
        successor := b.findMin(node.Right)
        node.Val = successor.Val
        node.Right = b.deleteHelper(node.Right, successor.Val)
    }

    return node
}

// FindMin returns the minimum value node
func (b *BST) FindMin(node *TreeNode) *TreeNode {
    return b.findMin(node)
}

func (b *BST) findMin(node *TreeNode) *TreeNode {
    if node == nil {
        return nil
    }
    for node.Left != nil {
        node = node.Left
    }
    return node
}

// FindMax returns the maximum value node
func (b *BST) FindMax(node *TreeNode) *TreeNode {
    if node == nil {
        return nil
    }
    for node.Right != nil {
        node = node.Right
    }
    return node
}

// Min returns the minimum value
func (b *BST) Min() (int, bool) {
    node := b.findMin(b.Root)
    if node == nil {
        return 0, false
    }
    return node.Val, true
}

// Max returns the maximum value
func (b *BST) Max() (int, bool) {
    node := b.FindMax(b.Root)
    if node == nil {
        return 0, false
    }
    return node.Val, true
}

// InorderSuccessor finds the next larger element
func (b *BST) InorderSuccessor(node *TreeNode) *TreeNode {
    if node == nil {
        return nil
    }

    // If right subtree exists, find leftmost in right
    if node.Right != nil {
        return b.findMin(node.Right)
    }

    // Otherwise, find first ancestor where node is in left subtree
    var successor *TreeNode
    curr := b.Root

    for curr != nil {
        if node.Val < curr.Val {
            successor = curr
            curr = curr.Left
        } else if node.Val > curr.Val {
            curr = curr.Right
        } else {
            break
        }
    }

    return successor
}

// InorderPredecessor finds the previous smaller element
func (b *BST) InorderPredecessor(node *TreeNode) *TreeNode {
    if node == nil {
        return nil
    }

    // If left subtree exists, find rightmost in left
    if node.Left != nil {
        return b.FindMax(node.Left)
    }

    // Otherwise, find first ancestor where node is in right subtree
    var predecessor *TreeNode
    curr := b.Root

    for curr != nil {
        if node.Val > curr.Val {
            predecessor = curr
            curr = curr.Right
        } else if node.Val < curr.Val {
            curr = curr.Left
        } else {
            break
        }
    }

    return predecessor
}
```

### Junior -> FAANG: BST Operations and the Deletion Interview Question

BST deletion is the most commonly stumbled-upon BST operation in interviews. The three cases (leaf, one child, two children) must be handled in order of increasing complexity. The two-children case is the one that trips people up: you cannot simply remove the node without finding a replacement that preserves the BST property. The inorder successor (smallest value in the right subtree) is the canonical replacement because it is larger than all values in the left subtree and smaller than all remaining values in the right subtree.

Before coding BST deletion, draw an example tree and trace the operation manually for all three cases. Then code the three cases from the trace. Interviewers specifically test whether you handle the two-children case correctly, and whether you copy the successor's value into the node rather than splicing pointers, since value replacement is much easier to get right.

The recursive step in the two-children case is the part worth understanding rather than memorizing: `node.Right = b.deleteHelper(node.Right, successor.Val)`. Having copied the successor's value up, you must now delete the successor from the right subtree, and that recursive call is guaranteed to terminate in case 1 or case 2, never back in case 3. The reason is that the successor is the *minimum* of the right subtree, so by definition it has no left child. The recursion is at most one level deep, which is why deletion stays O(h) rather than degrading.

The `InorderSuccessor` and `InorderPredecessor` functions are tested independently in some interviews (LC 285: Inorder Successor in BST). Know that the successor of a node is its right child's leftmost descendant if it has a right child, or the first ancestor for which the node is in the left subtree if it does not.

### Senior @ FAANG: BST Performance Guarantees and Production Selection

The BST implementation shown here provides O(h) operations where h is the tree height. For random insertion order, h = O(log n) in expectation. For sorted or nearly sorted insertion (a common real-world case), h = O(n), making all operations linear. This is why bare BSTs are almost never used in production: the degenerate case is too common, and the degenerate case is *sorted input*, which is exactly what real data tends to be. Loading a table of timestamped records in file order is enough to turn this structure into a linked list.

Two details in the code above would draw comment in review. `Delete` calls `Contains` before `deleteHelper`, which walks the tree twice for every deletion. It is correct and it keeps `size` honest, but it doubles the work of the most expensive operation. Having `deleteHelper` report whether it removed anything, the way `insertHelper` already reports `inserted`, folds it back to a single pass.

The second is subtler and matters whenever anything outside the tree holds a `*TreeNode`. The two-children case deletes by *copying a value* into a surviving node, so the node object that disappears is the successor, not the node you asked to delete. Any external pointer to the successor now refers to a node spliced out of the tree, while a pointer to the "deleted" node still refers to a live node that has silently changed its value underneath the holder. If you expose node pointers, iterators, or cursors in your API, value-copy deletion violates the expectations those handles create, and pointer-splicing deletion, though fiddlier, is the honest implementation.

Production ordered-data structures in Go: `btree` from `github.com/google/btree` provides a balanced B-tree with configurable degree, suitable for in-memory sorted indexes. The standard library does not include a balanced BST, which is a deliberate design choice: Go's built-in `map` handles unordered lookups, and sorted requirements are best addressed by external libraries tuned for specific use cases.

The choice between a BST and a skip list (used in Redis's sorted sets) is an architectural decision. BSTs require rebalancing after insertion and deletion, which is efficient amortized but creates worst-case latency spikes during rotations. Skip lists trade O(log n) expected time (with a small constant probability of deviation) for simpler implementation and better concurrent performance, because skip lists can be made lock-free using atomic operations while balanced BSTs require complex locking strategies for concurrent modification. A staff engineer choosing between these two structures for a sorted-set implementation documents the tradeoff explicitly in the ADR.
