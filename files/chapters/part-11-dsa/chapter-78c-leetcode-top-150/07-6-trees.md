## 78C.6 Trees

Tree problems test recursion, DFS, and BFS. Master the three traversals (pre/in/post-order) and level-order BFS.

---
### LC 104 - Maximum Depth of Binary Tree 🟢

**Key Insight**: The depth is 1 + max(depth of left, depth of right), a classic recursive structure.

```go
func maxDepth(root *TreeNode) int {
    if root == nil {
        return 0
    }
    left := maxDepth(root.Left)
    right := maxDepth(root.Right)
    if left > right {
        return left + 1
    }
    return right + 1
}
```
**Time**: O(n).
**Space**: O(h) for the recursion depth.

---
### LC 100 - Same Tree 🟢

**Key Insight**: Two trees are the same if the roots match and both subtrees are the same. Recurse simultaneously.

```go
func isSameTree(p *TreeNode, q *TreeNode) bool {
    if p == nil && q == nil {
        return true
    }
    if p == nil || q == nil || p.Val != q.Val {
        return false
    }
    return isSameTree(p.Left, q.Left) && isSameTree(p.Right, q.Right)
}
```
**Time**: O(n).
**Space**: O(h).

---
### LC 226 - Invert Binary Tree 🟢

**Key Insight**: Swap left and right children at every node recursively.

```go
func invertTree(root *TreeNode) *TreeNode {
    if root == nil {
        return nil
    }
    root.Left, root.Right = invertTree(root.Right), invertTree(root.Left)
    return root
}
```
**Time**: O(n).
**Space**: O(h).

---
### LC 572 - Subtree of Another Tree 🟢

**Key Insight**: Check if any node in the main tree is the root of a subtree identical to the given subtree.

```go
func isSubtree(root *TreeNode, subRoot *TreeNode) bool {
    if root == nil {
        return false
    }
    if isSameTree(root, subRoot) {
        return true
    }
    return isSubtree(root.Left, subRoot) || isSubtree(root.Right, subRoot)
}

func isSameTree(p *TreeNode, q *TreeNode) bool {
    if p == nil && q == nil {
        return true
    }
    if p == nil || q == nil || p.Val != q.Val {
        return false
    }
    return isSameTree(p.Left, q.Left) && isSameTree(p.Right, q.Right)
}
```
**Time**: O(m × n) worst case.
**Space**: O(h).

---
### LC 543 - Diameter of Binary Tree 🟢

**Key Insight**: The diameter passes through some node where it equals leftDepth + rightDepth. Track the global maximum during depth computation.

```go
func diameterOfBinaryTree(root *TreeNode) int {
    maxDiam := 0

    var depth func(node *TreeNode) int
    depth = func(node *TreeNode) int {
        if node == nil {
            return 0
        }
        left := depth(node.Left)
        right := depth(node.Right)
        if left+right > maxDiam {
            maxDiam = left + right
        }
        if left > right {
            return left + 1
        }
        return right + 1
    }

    depth(root)
    return maxDiam
}
```
**Time**: O(n).
**Space**: O(h).

---
### LC 102 - Binary Tree Level Order Traversal 🟡

**Key Insight**: BFS with a queue. Process all nodes at the current level before moving to the next.

```go
func levelOrder(root *TreeNode) [][]int {
    if root == nil {
        return nil
    }

    var result [][]int
    queue := []*TreeNode{root}

    for len(queue) > 0 {
        size := len(queue)
        level := make([]int, 0, size)
        for i := 0; i < size; i++ {
            node := queue[0]
            queue = queue[1:]
            level = append(level, node.Val)
            if node.Left != nil {
                queue = append(queue, node.Left)
            }
            if node.Right != nil {
                queue = append(queue, node.Right)
            }
        }
        result = append(result, level)
    }
    return result
}
```
**Time**: O(n).
**Space**: O(n).

---
### LC 199 - Binary Tree Right Side View 🟡

**Key Insight**: BFS level-order. The last node at each level is visible from the right side.

```go
func rightSideView(root *TreeNode) []int {
    if root == nil {
        return nil
    }

    var result []int
    queue := []*TreeNode{root}

    for len(queue) > 0 {
        size := len(queue)
        for i := 0; i < size; i++ {
            node := queue[0]
            queue = queue[1:]
            if i == size-1 {
                result = append(result, node.Val)
            }
            if node.Left != nil {
                queue = append(queue, node.Left)
            }
            if node.Right != nil {
                queue = append(queue, node.Right)
            }
        }
    }
    return result
}
```
**Time**: O(n).
**Space**: O(n).

---
### LC 230 - Kth Smallest Element in a BST 🟡

**Key Insight**: In-order traversal of a BST visits nodes in sorted order, so the k-th visited node is the answer.

```go
func kthSmallest(root *TreeNode, k int) int {
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
            return curr.Val
        }
        curr = curr.Right
    }
    return -1
}
```
**Time**: O(H + k) where H is tree height.
**Space**: O(H).

---
### LC 98 - Validate Binary Search Tree 🟡

**Key Insight**: Comparing each node only against its two children is the classic wrong answer. The BST property is about **ranges**, not parents: every node must fall inside a window that narrows as you descend. Pass that window down.

```go
func isValidBST(root *TreeNode) bool {
    return validate(root, nil, nil) // root is unbounded on both sides
}

func validate(node *TreeNode, lo, hi *int) bool {
    if node == nil {
        return true // empty subtrees are valid
    }
    if lo != nil && node.Val <= *lo {
        return false
    }
    if hi != nil && node.Val >= *hi {
        return false
    }
    // going left tightens the upper bound, going right tightens the lower one
    return validate(node.Left, lo, &node.Val) && validate(node.Right, &node.Val, hi)
}
```

The tree `[5,4,6,null,null,3,7]` is the reason the range formulation matters. Every parent-child pair is individually fine, but the 3 sits in the right subtree of 5 and so violates a bound set two levels up. A parent-only check reports valid and the candidate loses the problem.

Using `*int` for the bounds rather than sentinel values is deliberate. LeetCode allows node values across the full int32 range, so any concrete sentinel is a value a node could legitimately hold. `nil` means "no bound yet" and cannot collide with real data. The strict `<=` and `>=` comparisons enforce that a valid BST holds no duplicates.

**Time**: O(n) - each node is visited once.
**Space**: O(H) - recursion stack, where H is tree height.

---
### LC 235 - Lowest Common Ancestor of a BST 🟡

**Key Insight**: In a BST, if both values are less than root go left, if both greater go right, otherwise root is the LCA.

```go
func lowestCommonAncestor(root, p, q *TreeNode) *TreeNode {
    for root != nil {
        if p.Val < root.Val && q.Val < root.Val {
            root = root.Left
        } else if p.Val > root.Val && q.Val > root.Val {
            root = root.Right
        } else {
            return root
        }
    }
    return nil
}
```
**Time**: O(h).
**Space**: O(1).

---
### LC 236 - Lowest Common Ancestor of a Binary Tree 🟡

**Key Insight**: Recursively search the left and right subtrees. If both return non-nil, the current node is the LCA.

```go
func lowestCommonAncestor(root, p, q *TreeNode) *TreeNode {
    if root == nil || root == p || root == q {
        return root
    }
    left := lowestCommonAncestor(root.Left, p, q)
    right := lowestCommonAncestor(root.Right, p, q)
    if left != nil && right != nil {
        return root
    }
    if left != nil {
        return left
    }
    return right
}
```
**Time**: O(n).
**Space**: O(h).

---
### LC 124 - Binary Tree Maximum Path Sum 🔴

**Key Insight**: At each node, the path can go through it (left + node + right) or continue upward (node + max(left, right)). Track the global max separately.

```go
func maxPathSum(root *TreeNode) int {
    result := root.Val

    var dfs func(node *TreeNode) int
    dfs = func(node *TreeNode) int {
        if node == nil {
            return 0
        }
        left := max(0, dfs(node.Left))
        right := max(0, dfs(node.Right))

        pathSum := node.Val + left + right
        if pathSum > result {
            result = pathSum
        }
        if left > right {
            return node.Val + left
        }
        return node.Val + right
    }

    dfs(root)
    return result
}
```

`max` is a builtin since Go 1.21. Clamping each child at 0 is what discards negative-sum branches.

**Time**: O(n).
**Space**: O(h).

---
### LC 297 - Serialize and Deserialize Binary Tree 🔴

**Key Insight**: Use preorder traversal with a sentinel for nil nodes. Serialization and deserialization follow the same order.

```go
type Codec struct{}

func Constructor() Codec {
    return Codec{}
}

func (c *Codec) serialize(root *TreeNode) string {
    var sb strings.Builder
    var build func(node *TreeNode)
    build = func(node *TreeNode) {
        if node == nil {
            sb.WriteString("#,")
            return
        }
        sb.WriteString(strconv.Itoa(node.Val))
        sb.WriteByte(',')
        build(node.Left)
        build(node.Right)
    }
    build(root)
    return sb.String()
}

func (c *Codec) deserialize(data string) *TreeNode {
    tokens := strings.Split(data, ",")
    idx := 0

    var build func() *TreeNode
    build = func() *TreeNode {
        if idx >= len(tokens) || tokens[idx] == "#" {
            idx++
            return nil
        }
        val, _ := strconv.Atoi(tokens[idx])
        idx++
        node := &TreeNode{Val: val}
        node.Left = build()
        node.Right = build()
        return node
    }

    return build()
}
```
**Time**: O(n) for both serialize and deserialize.
**Space**: O(n).

---
### LC 105 - Construct Binary Tree from Preorder and Inorder Traversal 🟡

**Key Insight**: Preorder tells you **who the root is** (always the next unconsumed element). Inorder tells you **how big the left subtree is** (everything to the left of the root's position). Consume preorder with a single moving cursor and give each recursive call an inorder range to own.

```go
func buildTree(preorder []int, inorder []int) *TreeNode {
    pos := make(map[int]int, len(inorder)) // value -> index, values are unique
    for i, v := range inorder {
        pos[v] = i
    }

    idx := 0 // cursor into preorder, shared across the whole recursion
    var build func(lo, hi int) *TreeNode
    build = func(lo, hi int) *TreeNode {
        if lo > hi {
            return nil // empty inorder range
        }
        val := preorder[idx]
        idx++
        node := &TreeNode{Val: val}
        mid := pos[val] // where this root splits the inorder range

        node.Left = build(lo, mid-1)  // must run first: it consumes the left subtree
        node.Right = build(mid+1, hi) // preorder cursor now sits at the right subtree
        return node
    }
    return build(0, len(inorder)-1)
}
```

The ordering of the two recursive calls is load bearing. Preorder is root, then the entire left subtree, then the entire right subtree, so the left call must run to completion and advance `idx` past every left-subtree node before the right call reads it. Swap those two lines and the tree comes out wrong with no compile error and no panic.

The index map is the difference between passing and timing out. Scanning `inorder` for the root on every call is O(n) per node and O(n²) overall, which is fatal on a skewed tree of 3000 nodes. Precomputing positions makes each split O(1).

**Time**: O(n) - one map build, then O(1) work per node.
**Space**: O(n) - the position map, plus O(H) recursion stack.

---

### Junior → FAANG: Recursive Thinking for Tree Problems

Tree problems are the domain where recursion is most natural and most commonly misapplied. The key discipline: define exactly what your recursive function returns before writing its body. For Lowest Common Ancestor, the function returns the LCA if it exists in the subtree rooted at the current node, or nil otherwise. Stating this return-value contract precisely prevents the common mistake of trying to return the LCA and a "found" flag simultaneously, which complicates the code unnecessarily.

For BST problems, always use the BST property (left subtree values are strictly less than node, right subtree values are strictly greater) in your approach. If your solution would work equally well on a non-BST tree, you are probably not using the BST property and have a less efficient solution than expected.

Serialize and Deserialize Binary Tree is the hardest problem in this section. The preorder traversal approach with null markers is the cleanest implementation: encode nulls explicitly, and the deserializer can reconstruct the tree deterministically by consuming nodes in preorder. Practice this problem until the encoding/decoding logic is automatic.

### Senior @ FAANG: Tree Serialization in Distributed Systems

Binary tree serialization is a specific instance of the general problem of converting recursive data structures to flat byte sequences for network transport. Protocol Buffer's serialization of nested message types uses a similar approach: each field is tagged and nulls are omitted (sparse representation). Understanding tree serialization at the invariant level lets you reason about proto binary encoding, JSON tree representations, and XML DOM serialization with the same mental model. When you see an unexpectedly large serialized payload in a production system, the debugging lens is "are nulls being encoded explicitly when they should be omitted, or vice versa?"
