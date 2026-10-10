# Chapter 70: Trees and Binary Search Trees

> *"Computer science is no more about computers than astronomy is about telescopes."* - Edsger W. Dijkstra

A tree is a hierarchical data structure consisting of nodes connected by directed edges, with a single root node at the top and no cycles. Each node holds a value and references to zero or more child nodes. Binary trees restrict each node to at most two children, conventionally called left and right. The Binary Search Tree (BST) adds an ordering invariant: for any node, every value in its left subtree is smaller and every value in its right subtree is larger. Read that carefully, because it says *subtree*, not *child*. The invariant constrains whole ranges rather than immediate neighbors, and nearly every BST bug in this chapter traces back to forgetting that distinction. The payoff is O(log n) search, insertion, and deletion in a balanced tree, against the O(n) linear scan an unsorted array or linked list would force.

Trees permeate software engineering at every level. Your filesystem is a tree. HTML's Document Object Model is a tree. Abstract syntax trees power every compiler and interpreter. Decision trees drive machine learning classifiers. The B-trees and B+ trees underlying PostgreSQL, MySQL, and Go's `bbolt` key-value store are descendants of the same ordering idea, widened to trade tree height for disk-friendly node size. In distributed systems, Merkle trees power Git's content-addressable storage and blockchain integrity verification. Understanding trees is foundational literacy for reasoning about hierarchical data at any scale.

In coding interviews, trees are among the most tested data structures because they demand fluency in recursion, which is the natural language for hierarchical decomposition. Interviewers use tree problems to assess whether candidates think recursively, handle base cases cleanly, and reason about the O(n) time and O(h) space, where h is tree height, that recursive traversals consume. The canonical traversals (inorder, preorder, postorder, level-order), combined with recursive decomposition patterns (divide and conquer on subtrees), solve an enormous range of problems: lowest common ancestor, path sums, tree diameter, serialize/deserialize, and BST validation all reduce to elegant recursive formulations once you internalize the tree-thinking mindset.

**What you'll learn in this chapter:**

- Binary tree and BST node definition in Go, with clean recursive and iterative traversal implementations
- The four canonical traversals (inorder, preorder, postorder for DFS, and level-order for BFS) with Go code and complexity analysis
- BST search, insertion, and deletion in O(log n) average and O(n) worst case, with full discussion of the height-balance problem
- Recursive problem decomposition: using subtree return values to compute global properties (height, diameter, path sum)
- Lowest Common Ancestor (LCA) for binary trees and BSTs, one of the most frequently asked tree questions
- Tree validation: verifying the BST invariant with min/max ranges, checking symmetry, detecting balanced height in O(n)
- Self-balancing BST concepts: AVL trees and Red-Black trees, why they exist, and how rotations restore balance
- B-trees versus binary trees: why databases pick fanout over depth, and why Go's standard library ships no balanced tree container
- Serialization and deserialization of binary trees, combining DFS with string encoding

**Why this matters in interviews:**

Trees are a staple of coding rounds across large engineering organizations, and they carry unusual signal density: a single tree question tests recursion, base-case discipline, pointer handling, and complexity reasoning at once. A tree problem often anchors an entire 45-minute round, with the interviewer expecting a clean recursive solution, a discussion of DFS versus BFS tradeoffs, and an articulation of O(n) time with O(h) auxiliary space. LCA and binary tree recursion variants recur constantly. Tree problems also cross into system design, where "how would you implement a file system" or "how would you parse XML" are tree questions wearing a different hat. Difficulty: Easy (inorder traversal) to Hard (serialize/deserialize, recover BST). Expected solve time for medium problems: 20 minutes.

**Prerequisites:** Chapter 65 (Complexity Analysis), Chapter 67 (Linked Lists), Chapter 68 (Stacks and Queues), Go recursion and pointer fundamentals.

### Junior -> FAANG: Building Recursive Tree Intuition

The single biggest skill gap for junior candidates on tree problems is not knowing which traversal to reach for, and writing recursive functions that lack clean base cases. Before your first FAANG interview, build these three reflexes:

Reflex 1: every recursive tree function starts with `if node == nil { return ... }`. The base case always comes first. Panic on nil is the single most common tree interview bug.

Reflex 2: when the problem asks for a property of the entire tree (height, diameter, path sum), use bottom-up (postorder) recursion: compute left and right subtree answers, then combine them at the current node.

Reflex 3: when the problem passes context from parent to children (valid BST bounds, running sum for path), use top-down (preorder) recursion: use the parent's state to narrow the problem before recursing.

Practice the four canonical traversals (preorder, inorder, postorder, level-order) until you can write all four, both recursive and iterative, from memory. Inorder on a BST gives sorted output. Level-order is BFS and uses a queue. These two facts alone unlock a large fraction of tree interview problems.

### Senior @ FAANG: Trees as Architectural Analogies and Platform Primitives

Tree structures appear at every layer of production systems. Understanding them at the architectural level, not just the algorithmic level, is a mark of senior engineering fluency.

B-trees and B+ trees are the storage engine behind every major relational database. PostgreSQL's default index type is a B-tree, and it is the one you get from a plain `CREATE INDEX`, though it is only one of several: hash, GiST, SP-GiST, GIN, and BRIN each exist because B-trees are the wrong shape for some workloads. The reason the B-tree wins the default slot is arithmetic. Its node size is matched to the storage page (8KB in PostgreSQL), so each node holds hundreds of keys and the height is log base fanout of n, which lands around 3 to 4 levels even for billion-row tables. A binary tree over the same rows would be roughly 30 levels deep, and since each level is potentially one page fetch, the B-tree turns ~30 I/Os into ~4. That is the whole argument: when the cost of touching a node dwarfs the cost of comparing keys inside it, you want fat nodes and a shallow tree.

A staff engineer reviewing an index design asks whether the column's distribution and query shape suit a B-tree: yes for high-cardinality columns and range predicates, no for low-cardinality columns, where the index scans more pages than the table would, and no for containment queries over documents or arrays, where GIN is built for the job.

Merkle trees power Git's content-addressable storage, blockchain integrity verification, and distributed file system integrity checks (IPFS, Cassandra's anti-entropy repair). The tree property that allows efficient difference detection (two subtrees whose roots have the same hash are identical) is a direct application of the postorder hash-combination pattern seen in this chapter.

Segment trees and Fenwick trees (not covered in this chapter) extend BST concepts to range queries with O(log n) point updates, which is the data structure underlying competitive programming range problems and production systems that need rolling aggregate statistics.

A bar-raiser interviewer who asks "how would you implement a file system?" is testing whether you recognize that a file system is a tree, where directories are internal nodes and files are leaves, and that operations like "find all files modified after date X" are tree traversals with pruning.

---
