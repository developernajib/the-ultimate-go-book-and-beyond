## Learning Objectives

By the end of this chapter, you will:
- Understand tree terminology and binary tree properties
- Master all tree traversal methods (DFS and BFS)
- Implement Binary Search Trees with all operations
- Solve classic tree problems using recursion and iteration
- Balance BSTs and understand self-balancing tree concepts

### Junior -> FAANG: Turning Objectives into 30-Day Practice Plan

Objective 1 (terminology and properties): spend two hours on the diagram in the introduction section, labeling every concept (root, leaf, height, depth, complete tree, full tree, perfect tree) until you can draw a tree and annotate it from memory.

Objective 2 (traversal mastery): code all four traversals in both recursive and iterative form. Time yourself. Target: all eight implementations in under 30 minutes total. Traversal is the substrate a large share of tree problems are built on, so this practice compounds.

Objective 3 (BST operations): implement Insert, Search, and Delete from scratch. Focus on the two-children deletion case, which is the hardest and most frequently tested. Know the inorder-successor approach cold.

Objective 4 (recursive decomposition): solve LC 104 (max depth), LC 110 (balanced tree), LC 236 (LCA), LC 124 (max path sum), and LC 297 (serialize/deserialize) in sequence. Each one introduces one new recursive pattern.

Objective 5 (when to use trees): practice distinguishing "use a hash map" from "use a BST" by solving problems that superficially look similar but have different requirements (range query vs. point lookup, ordered output vs. any-order).

### Senior @ FAANG: Connecting Objectives to System Design

At the senior level, each objective maps to a system design capability. Traversal mastery enables reasoning about AST parsing in compilers, XML/JSON parsing in serialization layers, and directory scanning in file processors. BST operations ground the discussion of database index design, specifically why writes to a B-tree index are more expensive than writes to an unsorted heap and when a partial index is more appropriate than a full-table index. Recursive decomposition enables designing hierarchical data models: organizational charts, product category trees, permission hierarchies. Self-balancing BST concepts underlie understanding why Redis's sorted set is built from a skip list (probabilistically balanced) plus a hash table, rather than from a balanced BST. Redis executes commands on a single thread, so the motivation was not lock-friendliness. It was that a skip list delivers the same O(log n) with a much simpler implementation, no rotation logic, and naturally ordered range scans, which is exactly what `ZRANGE` needs. The transferable lesson is that "which structure has the better asymptotics" is often already a tie, and the decision gets made on implementation complexity and the shape of the dominant query.
