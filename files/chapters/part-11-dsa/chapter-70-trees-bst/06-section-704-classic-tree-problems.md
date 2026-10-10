## 70.4 Classic Tree Problems

### Maximum Depth

Maximum tree depth is the canonical post-order recursion: compute the depth of both subtrees, then return the larger plus one. The BFS alternative counts levels by processing the queue in layer-sized batches and increments a depth counter after each complete level.

```go
// MaxDepth returns the maximum depth of a binary tree
// LeetCode 104: Maximum Depth of Binary Tree
// Time: O(n), Space: O(h)
func MaxDepth(root *TreeNode) int {
    if root == nil {
        return 0
    }
    leftDepth := MaxDepth(root.Left)
    rightDepth := MaxDepth(root.Right)
    return max(leftDepth, rightDepth) + 1
}

// MaxDepthIterative using BFS
func MaxDepthIterative(root *TreeNode) int {
    if root == nil {
        return 0
    }

    depth := 0
    queue := []*TreeNode{root}

    for len(queue) > 0 {
        depth++
        levelSize := len(queue)
        for i := 0; i < levelSize; i++ {
            node := queue[0]
            queue = queue[1:]
            if node.Left != nil {
                queue = append(queue, node.Left)
            }
            if node.Right != nil {
                queue = append(queue, node.Right)
            }
        }
    }

    return depth
}
```

### Check Balanced Tree

The naive O(n²) balance check calls the height function separately at every node, revisiting subtrees repeatedly. The optimized O(n) approach fuses the height computation and balance check into a single pass, using -1 as a sentinel to propagate the "unbalanced" signal up the call stack without visiting any node twice.

```go
// IsBalanced checks if tree is height-balanced
// LeetCode 110: Balanced Binary Tree
// Time: O(n), Space: O(h)
func IsBalanced(root *TreeNode) bool {
    return checkHeight(root) != -1
}

func checkHeight(node *TreeNode) int {
    if node == nil {
        return 0
    }

    leftHeight := checkHeight(node.Left)
    if leftHeight == -1 {
        return -1
    }

    rightHeight := checkHeight(node.Right)
    if rightHeight == -1 {
        return -1
    }

    if abs(leftHeight-rightHeight) > 1 {
        return -1
    }

    return max(leftHeight, rightHeight) + 1
}

func abs(x int) int {
    if x < 0 {
        return -x
    }
    return x
}
```

### Same Tree and Symmetric Tree

Tree structural comparison recurses over corresponding node pairs simultaneously: two trees are identical when their roots match and both subtrees are recursively identical. Symmetry is a variation where the left and right subtrees are mirror images rather than identical copies, requiring a helper that compares nodes from opposite sides of the tree.

```go
// IsSameTree checks if two trees are identical
// LeetCode 100: Same Tree
func IsSameTree(p *TreeNode, q *TreeNode) bool {
    if p == nil && q == nil {
        return true
    }
    if p == nil || q == nil {
        return false
    }
    return p.Val == q.Val &&
        IsSameTree(p.Left, q.Left) &&
        IsSameTree(p.Right, q.Right)
}

// IsSymmetric checks if tree is mirror of itself
// LeetCode 101: Symmetric Tree
func IsSymmetric(root *TreeNode) bool {
    if root == nil {
        return true
    }
    return isMirror(root.Left, root.Right)
}

func isMirror(left, right *TreeNode) bool {
    if left == nil && right == nil {
        return true
    }
    if left == nil || right == nil {
        return false
    }
    return left.Val == right.Val &&
        isMirror(left.Left, right.Right) &&
        isMirror(left.Right, right.Left)
}

// IsSymmetricIterative using queue
func IsSymmetricIterative(root *TreeNode) bool {
    if root == nil {
        return true
    }

    queue := []*TreeNode{root.Left, root.Right}

    for len(queue) > 0 {
        left := queue[0]
        right := queue[1]
        queue = queue[2:]

        if left == nil && right == nil {
            continue
        }
        if left == nil || right == nil || left.Val != right.Val {
            return false
        }

        queue = append(queue, left.Left, right.Right)
        queue = append(queue, left.Right, right.Left)
    }

    return true
}
```

### Lowest Common Ancestor

The LCA algorithm relies on a key observation: if one target node is in the left subtree and the other is in the right subtree, the current root is their LCA. For BSTs, the ordering property allows a direct iterative descent: descend left if both targets are smaller than the current node, descend right if both are larger, and return the current node when the path splits.

```go
// LowestCommonAncestor finds LCA of two nodes in a binary tree
// LeetCode 236: Lowest Common Ancestor of a Binary Tree
// Time: O(n), Space: O(h)
func LowestCommonAncestor(root, p, q *TreeNode) *TreeNode {
    if root == nil || root == p || root == q {
        return root
    }

    left := LowestCommonAncestor(root.Left, p, q)
    right := LowestCommonAncestor(root.Right, p, q)

    if left != nil && right != nil {
        return root // p and q are in different subtrees
    }
    if left != nil {
        return left
    }
    return right
}

// LowestCommonAncestorBST for BST (use BST property)
// LeetCode 235: Lowest Common Ancestor of a Binary Search Tree
// Time: O(h), Space: O(1) iterative
func LowestCommonAncestorBST(root, p, q *TreeNode) *TreeNode {
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

### Validate BST

A common mistake is checking only that each node is greater than its left child and less than its right child. This passes locally but fails for subtrees that violate an ancestor's constraint. The correct approach threads min/max bounds through the recursion, tightening the valid range as it descends into each subtree.

The counterexample every interviewer keeps in their pocket is this tree:

```
      5
     / \
    1   6
       / \
      3   7
```

Every parent-child pair is individually fine: 1 < 5, 6 > 5, 3 < 6, 7 > 6. The tree is still not a BST, because 3 sits in 5's right subtree while being smaller than 5. A parent-only check reports valid. The range-based check catches it, because descending into 6 narrows the valid interval to (5, +inf), and 3 fails it immediately. This is the whole reason the invariant is stated over *subtrees* rather than children.

Note the implementation detail that makes the version below robust: the bounds are carried as `*TreeNode` rather than as `int` sentinels. Reaching for `math.MinInt` and `math.MaxInt` as initial bounds seems natural and then quietly breaks on a tree that legitimately contains those values, since the comparison against the sentinel is indistinguishable from a real violation. A nil pointer means "no bound on this side" and cannot collide with any data.

```go
// IsValidBST checks if tree is a valid BST
// LeetCode 98: Validate Binary Search Tree
// Time: O(n), Space: O(h)
func IsValidBST(root *TreeNode) bool {
    return isValidBSTHelper(root, nil, nil)
}

func isValidBSTHelper(node *TreeNode, minNode, maxNode *TreeNode) bool {
    if node == nil {
        return true
    }

    if minNode != nil && node.Val <= minNode.Val {
        return false
    }
    if maxNode != nil && node.Val >= maxNode.Val {
        return false
    }

    return isValidBSTHelper(node.Left, minNode, node) &&
        isValidBSTHelper(node.Right, node, maxNode)
}

// IsValidBSTInorder using inorder traversal
// Valid BST has strictly increasing inorder traversal
func IsValidBSTInorder(root *TreeNode) bool {
    var prev *TreeNode

    var inorder func(*TreeNode) bool
    inorder = func(node *TreeNode) bool {
        if node == nil {
            return true
        }

        if !inorder(node.Left) {
            return false
        }

        if prev != nil && node.Val <= prev.Val {
            return false
        }
        prev = node

        return inorder(node.Right)
    }

    return inorder(root)
}
```

### Path Sum Problems

Path sum problems differ in what "path" means: LeetCode 112 checks for any root-to-leaf path that totals a target, while LeetCode 113 collects all such paths by carrying a mutable slice and copying it only when a valid leaf is reached. LeetCode 437 generalizes further by allowing paths that start and end at any nodes. The prefix sum map trick converts this O(n²) brute-force into O(n) by counting how many prefix sums differ from the current running sum by exactly the target.

```go
// HasPathSum checks if tree has root-to-leaf path with given sum
// LeetCode 112: Path Sum
func HasPathSum(root *TreeNode, targetSum int) bool {
    if root == nil {
        return false
    }

    if root.Left == nil && root.Right == nil {
        return root.Val == targetSum
    }

    remaining := targetSum - root.Val
    return HasPathSum(root.Left, remaining) || HasPathSum(root.Right, remaining)
}

// PathSum finds all root-to-leaf paths with given sum
// LeetCode 113: Path Sum II
func PathSum(root *TreeNode, targetSum int) [][]int {
    result := [][]int{}
    pathSumHelper(root, targetSum, []int{}, &result)
    return result
}

func pathSumHelper(node *TreeNode, remaining int, path []int, result *[][]int) {
    if node == nil {
        return
    }

    path = append(path, node.Val)

    if node.Left == nil && node.Right == nil && remaining == node.Val {
        // Copy path to avoid modification
        pathCopy := make([]int, len(path))
        copy(pathCopy, path)
        *result = append(*result, pathCopy)
        return
    }

    pathSumHelper(node.Left, remaining-node.Val, path, result)
    pathSumHelper(node.Right, remaining-node.Val, path, result)
}

// PathSumIII counts paths summing to target (not necessarily root-to-leaf)
// LeetCode 437: Path Sum III
// Time: O(n), Space: O(n) using prefix sum
func PathSumIII(root *TreeNode, targetSum int) int {
    prefixSum := make(map[int64]int)
    prefixSum[0] = 1
    return pathSumIIIHelper(root, 0, int64(targetSum), prefixSum)
}

func pathSumIIIHelper(node *TreeNode, currSum int64, target int64, prefixSum map[int64]int) int {
    if node == nil {
        return 0
    }

    currSum += int64(node.Val)
    count := prefixSum[currSum-target]

    prefixSum[currSum]++

    count += pathSumIIIHelper(node.Left, currSum, target, prefixSum)
    count += pathSumIIIHelper(node.Right, currSum, target, prefixSum)

    prefixSum[currSum]-- // backtrack

    return count
}
```

### Maximum Path Sum

LeetCode 124 is tricky because the optimal path can start and end at any two nodes, bending through any root, not just a root-to-leaf path. The key insight is to separate two concerns: a `maxGain` helper returns the best one-sided gain a subtree can contribute to its parent's path, while a global `maxSum` variable is updated at each node with the full two-sided path value `node.Val + leftGain + rightGain`. Negative subtree gains are clamped to zero, ensuring they never reduce a path's total.

```go
// MaxPathSum finds maximum path sum (any path)
// LeetCode 124: Binary Tree Maximum Path Sum
// Time: O(n), Space: O(h)
func MaxPathSum(root *TreeNode) int {
    maxSum := root.Val

    var maxGain func(*TreeNode) int
    maxGain = func(node *TreeNode) int {
        if node == nil {
            return 0
        }

        // Get max gain from left and right subtrees
        leftGain := max(maxGain(node.Left), 0)
        rightGain := max(maxGain(node.Right), 0)

        // Path through current node
        pathSum := node.Val + leftGain + rightGain

        // Update global max
        if pathSum > maxSum {
            maxSum = pathSum
        }

        // Return max gain when node is part of path
        return node.Val + max(leftGain, rightGain)
    }

    maxGain(root)
    return maxSum
}
```

### Junior -> FAANG: Classic Problems as Templates

These problem families (max depth, balanced tree, same/symmetric tree, LCA, validate BST, path sum, max path sum, serialize/deserialize) are the canonical tree interview problems. Solve each one from scratch until you can write the solution in under 20 minutes.

The most important conceptual distinctions:

IsBalanced vs. MaxDepth: IsBalanced requires the balanced-sentinel trick (return -1 to signal imbalance and propagate it upward) rather than calling MaxDepth at every node (which would be O(n²)). If you write `abs(maxDepth(left) - maxDepth(right)) <= 1` at every node, you have the O(n²) solution - the O(n) solution fuses the depth calculation and balance check into one pass.

LowestCommonAncestor: the key insight is that if `left != nil && right != nil` after recursing both subtrees, you are at the LCA. Practice tracing this on a 7-node tree with different target pairs until the insight is intuitive, not memorized.

MaxPathSum: the two-role trick (maxGain returns the best one-sided contribution to the parent, while the global max is updated with the two-sided value at each node) is the hardest pattern in this set. Trace through a 5-node tree manually before coding.

Serialize/Deserialize: the BFS approach shown is the simplest to implement correctly. Know it well enough to code it cleanly under 25 minutes.

### Senior @ FAANG: Classic Problems as System Design Building Blocks

Each classic problem here maps to a production system pattern:

Max Depth: tree height bounds the worst-case lookup time in any tree-based index. Monitoring the height of a BST-based in-memory index over time reveals whether insertion patterns are creating degenerate trees that need rebalancing.

LCA: file system operations like "find the nearest common parent directory" and permission inheritance systems ("which policy applies to both this user and this resource?") are LCA problems. A production file system daemon that needs to compute common ancestors frequently should pre-compute an Euler tour and sparse table for O(1) LCA queries, not use the O(n) recursive algorithm on every request.

Serialize/Deserialize: this is the core operation of any persistent tree structure, and the efficiency of the serialization format directly affects storage cost and network transfer time. The formats worth studying differ in exactly the dimension this problem exposes. Protocol Buffers encodes a nested message as a length-delimited field containing the child's own encoding, so structure is recovered by recursive descent and the whole payload must be parsed into objects before use. Cap'n Proto instead lays structs out in an arena and encodes child references as offset pointers, so the serialized bytes are already the in-memory layout and reading a field requires no parse step at all. That is the tradeoff to reach for in a design discussion: Protobuf pays decode cost on every message to get a compact wire format, while Cap'n Proto pays in bytes on the wire to make decode close to free. Which one wins depends on whether you are bottlenecked on network or on CPU, and on whether you read most fields or only a few.

MaxPathSum: in network routing, the maximum-weight path through a graph is a generalization of this problem. In organizational hierarchy analytics, the maximum-impact path through a reporting chain uses the same two-role postorder pattern. The algorithm structure transfers directly to these domains.

### Serialize and Deserialize

LeetCode 297 requires encoding a binary tree to a string and reconstructing it exactly, which BFS level-order traversal handles cleanly by writing `"null"` placeholders for absent children. During deserialization, the same BFS queue is used in lock-step: for each node dequeued, the next two values in the list become its left and right children, restoring the original structure without needing any delimiter beyond commas.

```go
import (
    "strconv"
    "strings"
)

// Codec serializes and deserializes a binary tree
// LeetCode 297: Serialize and Deserialize Binary Tree
type Codec struct{}

// Serialize encodes a tree to a string
func (c *Codec) Serialize(root *TreeNode) string {
    if root == nil {
        return "null"
    }

    result := []string{}
    queue := []*TreeNode{root}

    for len(queue) > 0 {
        node := queue[0]
        queue = queue[1:]

        if node == nil {
            result = append(result, "null")
        } else {
            result = append(result, strconv.Itoa(node.Val))
            queue = append(queue, node.Left)
            queue = append(queue, node.Right)
        }
    }

    // Trim trailing nulls
    for len(result) > 0 && result[len(result)-1] == "null" {
        result = result[:len(result)-1]
    }

    return "[" + strings.Join(result, ",") + "]"
}

// Deserialize decodes a string to a tree
func (c *Codec) Deserialize(data string) *TreeNode {
    if data == "[]" || data == "null" {
        return nil
    }

    // Remove brackets
    data = data[1 : len(data)-1]
    values := strings.Split(data, ",")

    if len(values) == 0 || values[0] == "null" {
        return nil
    }

    rootVal, _ := strconv.Atoi(values[0])
    root := &TreeNode{Val: rootVal}
    queue := []*TreeNode{root}
    i := 1

    for len(queue) > 0 && i < len(values) {
        node := queue[0]
        queue = queue[1:]

        // Left child
        if i < len(values) && values[i] != "null" {
            val, _ := strconv.Atoi(values[i])
            node.Left = &TreeNode{Val: val}
            queue = append(queue, node.Left)
        }
        i++

        // Right child
        if i < len(values) && values[i] != "null" {
            val, _ := strconv.Atoi(values[i])
            node.Right = &TreeNode{Val: val}
            queue = append(queue, node.Right)
        }
        i++
    }

    return root
}
```
