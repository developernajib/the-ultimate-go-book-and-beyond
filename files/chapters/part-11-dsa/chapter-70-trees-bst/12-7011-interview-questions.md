## 70.10 Interview Questions

### Question 1: Validate BST

A naive check of `left.Val < node.Val < right.Val` fails for deep descendants. A node in the right subtree of the root must exceed every ancestor, not just its immediate parent. Passing explicit `minVal` and `maxVal` bounds down each recursive call enforces this global constraint, correctly rejecting cases like a right-subtree node that is smaller than the root.

```go
func isValidBST(root *TreeNode) bool {
    return validate(root, nil, nil)
}

func validate(node *TreeNode, minVal, maxVal *int) bool {
    if node == nil {
        return true
    }

    if minVal != nil && node.Val <= *minVal {
        return false
    }
    if maxVal != nil && node.Val >= *maxVal {
        return false
    }

    return validate(node.Left, minVal, &node.Val) &&
           validate(node.Right, &node.Val, maxVal)
}
```

### Question 2: Lowest Common Ancestor

The algorithm exploits the fact that the LCA is the deepest node for which `p` and `q` appear in different subtrees. Returning a node immediately when it equals `p` or `q` short-circuits the recursion. When both left and right recursive calls return non-nil, the current node is the split point and therefore the LCA.

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

### Junior -> FAANG: Mastering the Two Core Interview Questions

BST Validation (Q1) is the classic trap, and it catches a large share of candidates who have not met the bounds-passing approach. If you write the simpler `node.Val > node.Left.Val && node.Val < node.Right.Val` check, you will fail on cases like `[5, 4, 6, nil, nil, 3, 7]`. Trace it: 3 is the left child of 6, and 6 is the right child of 5, so 3 sits in 5's right subtree while being smaller than 5. Every parent-child pair passes the local check (5 > 4, 5 < 6, 6 > 3, 6 < 7) and the tree is still not a BST. Practice stating the invariant precisely before coding: "Every node in the left subtree must be strictly less than the current node, and every node in the right subtree must be strictly greater. I pass down min and max bounds to enforce this constraint at every node, not just at the immediate parent."

LCA (Q2) requires internalizing one key fact: the LCA is the deepest node for which both p and q are in its subtree. The algorithm returns a non-nil value from a subtree when at least one of p or q is in that subtree. When both left and right returns are non-nil, the current node is the LCA. When only one is non-nil, that one subtree contains both targets and the LCA is deeper in it.

Practice both algorithms on paper with a 7-node tree before your interview. The muscle memory from tracing 10 examples is worth more than reading the explanation 20 times.

### Senior @ FAANG: Interview Questions as System Design Primers

BST Validation in production: any system that accepts tree structures as input (XML parsers, abstract syntax trees from untrusted sources, serialized permission hierarchies) must validate structural invariants before processing. For a BST specifically, the validation cost is O(n), which means it should not happen on the hot path. It should happen at ingestion time and be cached. A staff engineer designing a tree-based configuration system asks: "Where in the pipeline does invariant validation happen, who is responsible for it, and what happens when it fails?"

LCA in production: file system path resolution, permission inheritance computation, and organizational hierarchy queries all require LCA. For static trees (file systems that do not change while queries run), preprocessing with Euler tour + sparse table enables O(1) LCA queries after O(n log n) preprocessing. This is relevant for systems that issue millions of LCA queries against a large hierarchy: the preprocessing cost is paid once at load time, and subsequent queries are O(1) rather than O(n). Knowing when to propose this optimization (high query rate, stable hierarchy) vs. the naive O(n) approach (low query rate, frequently changing hierarchy) is a senior-level judgment call.

---
