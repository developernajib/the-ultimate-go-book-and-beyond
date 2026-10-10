## 70.7 Interview Tips

### Complexity Summary

| Operation | BST Average | BST Worst | Balanced BST |
|-----------|-------------|-----------|--------------|
| Search | O(log n) | O(n) | O(log n) |
| Insert | O(log n) | O(n) | O(log n) |
| Delete | O(log n) | O(n) | O(log n) |
| Min/Max | O(log n) | O(n) | O(log n) |
| Traversal | O(n) | O(n) | O(n) |

### Pattern Recognition

Recognizing the structural pattern of a tree problem before writing any code dramatically narrows the solution space. The key axis is whether information flows top-down (pass computed state from a parent node into recursive calls on its children) or bottom-up (return computed state from children back up to the parent). Top-down works when the parent has context the children need, such as valid BST bounds. Bottom-up works when the parent's answer depends on aggregated results from children, such as maximum path sum. Misidentifying this direction is the most common source of overcomplicated or incorrect tree solutions under interview pressure.

```
┌─────────────────────────────────────────────────────────────────┐
│              TREE PROBLEM PATTERNS                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. Top-Down vs Bottom-Up:                                      │
│     • Top-Down: Pass info from parent to children               │
│     • Bottom-Up: Collect info from children to parent           │
│                                                                 │
│  2. When to use which traversal:                                │
│     • Preorder: Process node before children (serialization)    │
│     • Inorder: Sorted order for BST                             │
│     • Postorder: Process children before node (delete tree)     │
│     • Level-order: Level by level (min depth)                   │
│                                                                 │
│  3. Common return types for tree recursion:                     │
│     • boolean: validation problems                              │
│     • int: counting, depth, sum                                 │
│     • TreeNode*: building or modifying trees                    │
│     • []int: collecting values                                  │
│                                                                 │
│  4. BST property usage:                                         │
│     • All left subtree < node < all right subtree               │
│     • Inorder traversal gives sorted sequence                   │
│     • Can use min/max bounds for validation                     │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Common LeetCode Problems

| Problem | Difficulty | Key Technique |
|---------|------------|---------------|
| 104. Maximum Depth | Easy | Recursion/BFS |
| 226. Invert Binary Tree | Easy | Recursion |
| 100. Same Tree | Easy | DFS comparison |
| 101. Symmetric Tree | Easy | Two pointers |
| 98. Validate BST | Medium | Inorder/Bounds |
| 102. Level Order | Medium | BFS |
| 236. Lowest Common Ancestor | Medium | Recursion |
| 124. Maximum Path Sum | Hard | Bottom-up recursion |
| 297. Serialize/Deserialize | Hard | BFS/Preorder |

### Junior -> FAANG: Pattern Recognition Before Code

The pattern recognition diagram in this section is the most valuable tool for the first minute of any tree interview. Before writing a single line of code, answer: "Is this top-down or bottom-up?" Top-down means you pass computed information from a parent node into the recursive calls on its children (examples: BST validation passing min/max bounds, path sum passing the running sum). Bottom-up means you collect information from children and return it to the parent (examples: height, diameter, max path sum).

A practical rule: if the recursive function returns a value that the caller uses, it is bottom-up. If the recursive function receives a parameter that was computed by the caller, it is top-down. Many problems use both: BST validation uses top-down bounds, but the boolean return is bottom-up propagation.

The complexity table confirms a core study priority: BST operations have O(n) worst case, which means every BST problem answer must acknowledge that the guarantee is O(log n) "when the tree is balanced" and O(n) in the degenerate case. Interviewers who ask "what is the time complexity of BST search?" expect you to give both cases and name what causes the worst case (sorted insertion).

### Senior @ FAANG: Complexity and Guarantees at the Platform Level

The complexity table is the starting point for a service-level discussion, not the end point. At the L6+ level, the question after the table is: "What is the height distribution of the trees your service will process, and does the average case or worst case bound your SLO?"

For a BST-based in-memory index on a write-heavy service, the average-case O(log n) applies only if keys are inserted in random order. If your service ingests time-series data and keys are monotonically increasing timestamps, every insertion goes to the far right of the tree, producing a degenerate linked list with O(n) lookup. The solution is either random key transformation (impossible if keys are meaningful values), a self-balancing BST (adds rotation overhead on writes), or a different data structure entirely. For the monotonic-timestamp case specifically, a sorted slice is worth a hard look: binary search gives O(log n) lookup, and because the keys arrive already in order, every insert is an append, which is O(1) amortized rather than the O(n) an out-of-order insert into a sorted array would cost. The very property that destroys the BST is the property that makes the slice trivial, and the slice wins again on cache locality by storing its keys contiguously.

A bar-raiser interview question for a senior candidate: "You have a service that builds an in-memory BST index on startup from 10 million sorted records stored on disk. After 1 hour of writes, the index is severely skewed. What is your remediation plan?" The expected answer covers: detecting skew using height-to-log(n) ratio monitoring, offline rebalancing during low-traffic windows, migrating to a self-balancing BST with explicit rotation guarantees, or replacing the in-memory BST with a B-tree or skip list that provides probabilistic or deterministic balance without reconstruction.
