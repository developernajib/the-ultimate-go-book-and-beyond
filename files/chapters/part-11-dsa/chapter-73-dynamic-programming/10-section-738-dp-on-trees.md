## 73.8 DP on Trees

### House Robber III

Tree DP solves problems where each node makes a decision that constrains its children. In House Robber III, each node can either be robbed (gaining its value plus the best outcomes of its grandchildren) or skipped (gaining the best outcomes of its direct children). Returning both outcomes as a pair from each recursive call avoids recomputation and keeps the solution O(n).

```go
// RobTree returns maximum money from tree-shaped houses
// LeetCode 337: House Robber III
type TreeNode struct {
    Val   int
    Left  *TreeNode
    Right *TreeNode
}

func RobTree(root *TreeNode) int {
    rob, notRob := robHelper(root)
    return max(rob, notRob)
}

// Returns (max if rob root, max if don't rob root)
func robHelper(node *TreeNode) (int, int) {
    if node == nil {
        return 0, 0
    }

    leftRob, leftNotRob := robHelper(node.Left)
    rightRob, rightNotRob := robHelper(node.Right)

    // If we rob this node, can't rob children
    robThis := node.Val + leftNotRob + rightNotRob

    // If we don't rob this node, take max from each child
    notRobThis := max(leftRob, leftNotRob) + max(rightRob, rightNotRob)

    return robThis, notRobThis
}
```

### Binary Tree Maximum Path Sum

A path in a binary tree can pass through any node as its highest point, meaning it may span left subtree → root → right subtree without continuing upward. This dual requirement (tracking the global maximum across all such paths while returning only a single-branch gain to the parent) is what makes this a DP problem rather than a simple traversal. At each node, `pathSum = node.Val + leftGain + rightGain` updates the global answer, but the return value is `node.Val + max(leftGain, rightGain)` because a path continuing upward can only extend in one direction. Negative subtree gains are clamped to zero so they are never included.

```go
// MaxPathSum finds maximum path sum in binary tree
// LeetCode 124: Binary Tree Maximum Path Sum
func MaxPathSum(root *TreeNode) int {
    maxSum := root.Val

    var maxGain func(*TreeNode) int
    maxGain = func(node *TreeNode) int {
        if node == nil {
            return 0
        }

        // Get max gain from left and right (ignore negative gains)
        leftGain := max(maxGain(node.Left), 0)
        rightGain := max(maxGain(node.Right), 0)

        // Path through current node
        pathSum := node.Val + leftGain + rightGain
        maxSum = max(maxSum, pathSum)

        // Return max gain if continuing from this node
        return node.Val + max(leftGain, rightGain)
    }

    maxGain(root)
    return maxSum
}
```

### Junior → FAANG: Tree DP and the Pair-Return Pattern

Tree DP differs from array DP in one key way: the traversal order is determined by the tree structure (post-order, computing children before parents), not by an explicit loop. The invariant is always: when processing a node, all its descendants have already been processed and their DP results are available.

The pair-return pattern in `robHelper` is the canonical tree DP idiom. Instead of returning a single value, return both the "yes" and "no" cases so that the parent can pick optimally. Without this pattern, you would need a separate pass or global state to combine the results, introducing either extra O(n) space or O(n) extra time. The pair-return keeps the solution in a single O(n) traversal.

For the maximum path sum problem (LeetCode 124), the critical distinction is between the value returned to the parent (single branch maximum gain) and the value used to update the global answer (both branches plus the current node). These are different quantities from the same computation, and confusing them is the most common mistake. A reliable approach: write a helper that returns the max single-branch gain upward, and update the global max inside the helper using both branches.

In Go, the closure pattern (`var maxGain func(*TreeNode) int` assigned inside the outer function) is the idiomatic way to share mutable state (the `maxSum` variable) across recursive tree traversal calls without passing extra parameters. This pattern appears frequently in LeetCode solutions and should be second nature.

### Senior @ FAANG: Tree DP in Organizational and Network Optimization

Tree DP is directly applicable to optimization over hierarchical organizational structures. Consider a company org chart where each employee has a "value" (e.g., expected output), and you must select a subset of employees to maximize total value subject to the constraint that a manager and their direct report cannot both be selected (the house robber tree problem). This is a real HR and cost-optimization model for restructuring decisions.

More practically, tree DP appears in network routing (optimal spanning tree problems with node capacity constraints), dependency resolution (optimal build order for a project with a dependency DAG), and compiler optimization (instruction selection over an expression tree). In all these cases, the O(n) tree traversal with pair-return values is the production algorithm.

A production concern specific to tree DP in Go: deeply unbalanced trees (or degenerate linear trees, i.e., linked lists) produce O(n) recursion depth, which can exhaust the goroutine stack for large n. The goroutine stack grows dynamically in Go, but there is a hard configurable limit (default 1 GB). For production tree DP on untrusted input (e.g., parsing a user-provided expression tree), the safe approach is to detect degenerate trees and either reject them (if the business logic permits) or convert the recursion to an explicit stack-based iteration, eliminating the goroutine stack risk entirely. Documenting this decision and the depth threshold in the code is a senior-level production habit.

### Junior → FAANG: Tree DP and the Post-Order Habit

The fundamental habit for tree DP is post-order traversal: process children before parents. In Go, this means the recursive call must happen before the decision logic at the current node. If you write the decision logic before the recursive calls, you are processing the parent before its children, which is pre-order, and the children's DP results are not yet available.

The pair-return idiom (`robHelper` returning two values) is the tree DP equivalent of the rolling-array optimization: instead of a second pass to combine results, you compute both the "use this node" and "skip this node" cases in the same traversal. Practice this idiom until you reach for it automatically on any tree DP problem. A reliable trigger: if the problem involves a binary choice at each node that depends on the choice made at the child nodes, the pair-return idiom applies.

For the maximum path sum problem (LeetCode 124), trace through a 5-node example by hand, writing the value returned upward from each node and the global max updated at each node. The distinction between what goes upward (single branch) and what updates the global answer (both branches) must be completely clear before you code. Confusion between these two quantities is the root cause of the wrong-answer submissions for this problem.

### Senior @ FAANG: Tree DP in Distributed System Topology Optimization

Tree DP is the computational backbone for a class of distributed system problems that are structured as hierarchical optimizations. In a multi-region CDN, the tree represents the hierarchy of PoPs (points of presence): root is the origin, children are regional PoPs, leaves are edge nodes. The decision at each internal node is whether to cache a content object at that node (paying the storage cost) or rely on parent nodes (paying the fetch latency cost on cache misses). This is the house robber tree problem with different cost functions.

For microservice dependency graphs, tree DP computes optimal deployment strategies: given a dependency tree of services and a budget of machines, assign services to machines to minimize the critical path latency. The tree structure is the dependency hierarchy, and the DP at each node decides the assignment of that service and propagates the constraint downstream.

Staff engineers who recognize these structural equivalences can reuse the tree DP framework across seemingly unrelated domains, reducing the design time for new optimization features. The key habit is to ask "what is the tree structure here?" before proposing a custom algorithm. In many distributed systems problems, a hierarchical tree structure is implicit in the system topology, and exposing it unlocks the full machinery of tree DP.
