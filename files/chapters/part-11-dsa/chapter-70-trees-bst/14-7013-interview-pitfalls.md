## 70.12 Interview Pitfalls

### Pitfall 1: Confusing Traversal Orders for BST

**Failure mode**: Asked to print BST elements in sorted order, the candidate reaches for preorder. Preorder emits the root first, so the output starts at the middle of the range and is not sorted. Only inorder visits left-root-right and therefore produces ascending order for a BST. This one is unforgiving in an interview because the code looks right, runs, and returns a plausible-looking list.

```go
// ❌ WRONG: Preorder doesn't give sorted order
func getSortedBad(root *TreeNode) []int {
    var result []int
    var preorder func(*TreeNode)
    preorder = func(node *TreeNode) {
        if node == nil {
            return
        }
        result = append(result, node.Val)  // Process before children
        preorder(node.Left)
        preorder(node.Right)
    }
    preorder(root)
    return result  // NOT sorted! Gives root-first order
}

// ✅ CORRECT: Inorder gives sorted order for BST
func getSortedGood(root *TreeNode) []int {
    var result []int
    var inorder func(*TreeNode)
    inorder = func(node *TreeNode) {
        if node == nil {
            return
        }
        inorder(node.Left)                 // Left first
        result = append(result, node.Val)  // Then root
        inorder(node.Right)                // Then right
    }
    inorder(root)
    return result  // Sorted! Left < Root < Right property
}
```

### Pitfall 2: BST Validation Using Only Parent Comparison

**Failure mode**: The validation compares each node only with its direct parent. That misses violations against ancestors further up, so it accepts invalid trees such as `[5,4,6,null,null,3]`. Trace it: 3 is the left child of 6, and 6 is the right child of 5. Every parent-child pair checks out (4 < 5, 6 > 5, 3 < 6), yet 3 sits in 5's right subtree while being smaller than 5. The invariant is defined over subtrees, not over neighbors.

```go
// ❌ WRONG: Only compares with immediate parent
func isValidBSTBad(root *TreeNode) bool {
    return validateBad(root, nil, true)
}

func validateBad(node, parent *TreeNode, isLeft bool) bool {
    if node == nil {
        return true
    }
    if parent != nil {
        if isLeft && node.Val >= parent.Val {
            return false  // Only checks parent!
        }
        if !isLeft && node.Val <= parent.Val {
            return false
        }
    }
    return validateBad(node.Left, node, true) &&
           validateBad(node.Right, node, false)
}

// ✅ CORRECT: Track valid range from all ancestors
func isValidBSTGood(root *TreeNode) bool {
    return validateGood(root, nil, nil)
}

func validateGood(node *TreeNode, minVal, maxVal *int) bool {
    if node == nil {
        return true
    }

    // Must be greater than ALL ancestors in left path
    if minVal != nil && node.Val <= *minVal {
        return false
    }
    // Must be less than ALL ancestors in right path
    if maxVal != nil && node.Val >= *maxVal {
        return false
    }

    return validateGood(node.Left, minVal, &node.Val) &&
           validateGood(node.Right, &node.Val, maxVal)
}
```

### Pitfall 3: Stack Overflow on Deep Trees

**Failure mode**: A service recursively traverses a tree built from unvalidated input. The input arrives sorted, the plain BST degenerates into a linked list, and recursion depth becomes O(n) instead of O(log n).

Get the numbers right, because the folklore here is wrong in both directions. A goroutine stack does not start at 1MB and it is not fixed: it starts at 2KB and grows by copying itself, up to 1GB on 64-bit platforms (250MB on 32-bit), adjustable via `runtime/debug.SetMaxStack`. So a tree 10,000 deep is nowhere near a problem. At roughly 100 bytes per frame you need on the order of 10 million frames to reach the ceiling. The danger is not that the limit is low, it is that the failure is catastrophic: exceeding it is `fatal error: stack overflow`, an unrecoverable throw that `recover` cannot intercept, so it kills the process and every in-flight request rather than failing one.

```go
// ❌ RISKY: recursion depth is bounded only by the input
func maxDepthBad(root *TreeNode) int {
    if root == nil {
        return 0
    }
    // Fine for balanced trees (depth ~log n). On a degenerate tree,
    // depth is O(n) and large enough n takes the whole process down.
    return 1 + max(maxDepthBad(root.Left), maxDepthBad(root.Right))
}

// ✅ CORRECT: Iterative with explicit stack
func maxDepthGood(root *TreeNode) int {
    if root == nil {
        return 0
    }

    type item struct {
        node  *TreeNode
        depth int
    }

    stack := []item{{root, 1}}
    maxD := 0

    for len(stack) > 0 {
        curr := stack[len(stack)-1]
        stack = stack[:len(stack)-1]

        if curr.depth > maxD {
            maxD = curr.depth
        }

        if curr.node.Left != nil {
            stack = append(stack, item{curr.node.Left, curr.depth + 1})
        }
        if curr.node.Right != nil {
            stack = append(stack, item{curr.node.Right, curr.depth + 1})
        }
    }

    return maxD
}
```

### Pitfall 4: Not Handling Nil in Tree Operations

**Failure mode**: The LCA code touches `root.Val` before checking whether `root` is nil, so it panics the moment the recursion walks off a leaf. This is the single most common tree interview bug, and it is fatal in a way the others are not: the code does not return a wrong answer, it crashes in front of the interviewer.

```go
// ❌ WRONG: Accesses fields before nil check
func lcaBad(root, p, q *TreeNode) *TreeNode {
    if root.Val == p.Val || root.Val == q.Val {  // Crashes if root is nil!
        return root
    }

    left := lcaBad(root.Left, p, q)
    right := lcaBad(root.Right, p, q)

    if left != nil && right != nil {
        return root
    }
    if left != nil {
        return left
    }
    return right
}

// ✅ CORRECT: Check nil FIRST
func lcaGood(root, p, q *TreeNode) *TreeNode {
    if root == nil {  // Nil check BEFORE any access
        return nil
    }
    if root == p || root == q {
        return root
    }

    left := lcaGood(root.Left, p, q)
    right := lcaGood(root.Right, p, q)

    if left != nil && right != nil {
        return root
    }
    if left != nil {
        return left
    }
    return right
}
```

### Pitfall 5: Path Sum Off-by-One in Leaf Check

**Failure mode**: The path sum solution uses `root == nil` as its success condition, so it reports paths that end at internal nodes rather than leaves. The bug is subtle enough to survive the obvious test cases. Consider the tree `1 -> 2` (a single left child) with target 1. Recursing into the *absent* right child of node 1 hits `root == nil` with `target == 0` and reports success, even though the path "1" stops at an internal node and is not root-to-leaf. The same flaw makes an empty tree report true for target 0, where LeetCode 112 requires false.

```go
// ❌ WRONG: Doesn't properly check for leaf nodes
func hasPathSumBad(root *TreeNode, target int) bool {
    if root == nil {
        // This catches when we go past a leaf,
        // but also when target reaches 0 at non-leaf!
        return target == 0
    }
    return hasPathSumBad(root.Left, target-root.Val) ||
           hasPathSumBad(root.Right, target-root.Val)
}

// ✅ CORRECT: Explicitly check for leaf node
func hasPathSumGood(root *TreeNode, target int) bool {
    if root == nil {
        return false  // Nil is never a valid end
    }

    // Only return true at LEAF nodes
    if root.Left == nil && root.Right == nil {
        return root.Val == target
    }

    remaining := target - root.Val
    return hasPathSumGood(root.Left, remaining) ||
           hasPathSumGood(root.Right, remaining)
}
```

### Interview Pitfalls Quick Reference

| Pitfall | Symptom | Prevention |
|---------|---------|------------|
| Wrong traversal order | Unsorted BST output | Remember: inorder = sorted for BST |
| Parent-only BST check | Invalid BSTs accepted | Pass min/max bounds down |
| Recursion overflow | Stack overflow crash | Use iterative with explicit stack |
| Nil access before check | Nil pointer panic | Always check nil FIRST |
| Non-leaf path counting | Wrong path sum results | Explicitly check leaf condition |
| Forgetting base cases | Infinite recursion | Handle nil, single node first |

### Junior -> FAANG: Pitfalls as Pre-Interview Mental Rehearsal

These five pitfalls represent the most common reasons a tree interview goes wrong. Rehearse the correction for each until it is automatic:

Preorder used for sorted BST output. Say: "I need inorder traversal, because left-root-right produces ascending order for a BST. Preorder emits the root first, so it starts in the middle of the range."

Only the immediate parent checked in BST validation. Say: "I pass min and max bounds down the recursion. The invariant is over subtrees, not children, so a node must satisfy every ancestor's bound, not just its parent's."

Unbounded recursion depth on a degenerate tree. Say: "The recursive version is O(h) space, which is O(n) on a degenerate tree. If the input is untrusted I'll use the iterative version, because a stack overflow in Go is an unrecoverable throw that takes the process down rather than failing the request."

Node fields accessed before the nil check. Say: "My first line is always `if node == nil { return ... }`. I touch fields only after verifying non-nil."

Non-leaf paths counted in path sum. Say: "The leaf check `node.Left == nil && node.Right == nil` has to be explicit, and nil must return false. Using nil as the success condition accepts paths that stop at internal nodes."

### Senior @ FAANG: Pitfalls as Production Incident Categories

Each pitfall in the quick reference table corresponds to a production incident category that a senior engineer owns preventing at the system level.

Wrong traversal order is a data integrity bug: it produces incorrect output that may not be immediately detected if the consumer does not validate ordering. The mitigation is output validation at the consumer: if the output should be sorted, add an assertion that verifies sortedness on a sample of outputs in staging. This catches the bug without requiring the reviewer to audit every tree traversal in the codebase.

Stack overflow (pitfall 3) is a reliability bug with a denial-of-service vector when tree depth is user-controlled. The platform-level mitigation is defense in depth: depth validation at ingestion (reject trees deeper than the configured max), timeout enforcement on tree processing goroutines, and circuit breakers that trigger when the tree processing error rate exceeds a threshold.

Nil access (pitfall 4) is the highest-frequency production panic category in Go tree processing code. The platform mitigation is `recover()` in goroutines that process user-provided tree data, combined with structured logging that captures the input tree at panic time for root-cause analysis. This is not a substitute for correct nil handling, but it prevents a single malformed input from taking down the entire service.

Note the asymmetry with pitfall 3, because it decides where you spend your effort. A nil dereference is a `panic`, so `recover` contains it to one request. A stack overflow is a runtime *throw*, which `recover` cannot intercept at all, so no amount of defensive middleware saves you. That is why depth must be bounded before the recursion starts: for the nil case you can catch the failure, and for the depth case you can only prevent it.

---
