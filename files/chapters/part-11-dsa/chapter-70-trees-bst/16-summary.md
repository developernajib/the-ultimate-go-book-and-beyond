## Summary

- Binary trees have at most two children per node
- **BST property** is defined over *subtrees*, not children, and enables O(log n) operations when balanced
- **Traversal types**: preorder, inorder, postorder (DFS), level-order (BFS). Only inorder yields sorted output on a BST
- **Morris traversal** achieves O(1) auxiliary space by temporarily threading the tree, which makes it unsafe to share or abandon mid-pass
- **B-trees** beat binary trees on disk by trading depth for fanout: fat nodes sized to the storage page turn ~30 levels into ~4
- Common patterns: top-down (pass context down), bottom-up (aggregate results up), level-by-level
- **Recursion** naturally fits tree structure, while **iteration** with an explicit stack moves the depth onto the heap and survives degenerate input
- Always consider edge cases: empty tree, single node, unbalanced tree, and the two-children delete

Trees are fundamental for interviews and appear in many variations. Master the basic traversals and recursive thinking patterns to tackle any tree problem.

### Junior -> FAANG: Chapter Mastery Checklist

Competency checklist - work through each item from memory in under 30 minutes:

Write all four traversals (preorder, inorder, postorder, level-order) in recursive form. Write inorder iteratively using an explicit stack. Explain why Morris traversal achieves O(1) space. Code BST Insert, Search, and Delete with correct handling of the two-children deletion case. Solve IsValidBST using the bounds-passing approach. Solve LowestCommonAncestor in both the general binary tree and BST variants. Code serialize and deserialize for a binary tree using BFS. State the time and space complexity of each operation, including the worst case for unbalanced BSTs.

If you are uncertain about any of these, spend focused time on that specific section before moving on. Breadth of exposure is less valuable than depth on the specific patterns that appear repeatedly in interviews.

### Senior @ FAANG: What Tree Mastery Means at the Staff Level

At the staff level, tree mastery means you can design and defend the data structure layer of a system for tree-shaped data. You can write an ADR comparing BST, AVL tree, Red-Black tree, B-tree, and skip list for a specific workload, with benchmark data or principled estimates to support the recommendation. You can identify when a recursive tree traversal in a service is a latency risk due to stack depth and propose the iterative alternative with a clear performance model. You can explain the relationship between BST inorder traversal and database index range scans in a way that helps a junior engineer understand why index selection matters. You can describe how Git's Merkle tree enables fast repository diff operations and what would need to change if the hash function were compromised.

These are the answers to questions that appear in L6/L7 design review discussions, not just in coding interviews. The algorithmic foundations in this chapter are the vocabulary for those conversations.
