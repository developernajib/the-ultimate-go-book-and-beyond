## Overview

Trees are hierarchical data structures that model relationships with a parent-child structure. Binary trees, where each node has at most two children, are particularly important in computer science for searching, sorting, and organizing data.

```
┌─────────────────────────────────────────────────────────────────┐
│                    TREE TERMINOLOGY                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│                        ┌───┐                                    │
│         Root ────────► │ 8 │ ◄──── Level 0                      │
│                        └─┬─┘                                    │
│                     ┌────┴────┐                                 │
│                    ╱          ╲                                 │
│                 ┌─┴─┐       ┌─┴─┐                               │
│     Internal ──►│ 3 │       │ 10│ ◄──── Level 1                 │
│                 └─┬─┘       └─┬─┘                               │
│               ┌───┴───┐       └───┐                             │
│              ╱        ╲           ╲                             │
│           ┌─┴─┐     ┌─┴─┐      ┌──┴──┐                          │
│           │ 1 │     │ 6 │      │ 14  │ ◄──── Level 2            │
│           └───┘     └─┬─┘      └──┬──┘                          │
│             ▲       ┌─┴─┐      ┌──┴──┐                          │
│             │      ╱     ╲    ╱       ╲                         │
│           Leaf  ┌─┴─┐   ┌─┴─┐┌─┴─┐   ┌─┴─┐                      │
│                 │ 4 │   │ 7 ││ 13│   │   │ ◄── Level 3          │
│                 └───┘   └───┘└───┘   └───┘                      │
│                                                                 │
│  Height = 3 (number of edges from root to deepest leaf)         │
│  Depth of node 6 = 2 (edges from root to node)                  │
│                                                                 │
│  Binary Search Tree Property:                                   │
│  Left subtree < Node < Right subtree                            │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Junior -> FAANG: Reading Tree Diagrams to Drive Interview Clarity

The diagram above is not just an illustration. It is a tool for verifying your understanding during an interview. Before writing any code for a tree problem, draw a small example tree on the whiteboard (or in your notes) and trace the expected output manually. This serves three purposes: it confirms your understanding of the problem, it gives the interviewer a clear view of your reasoning, and it provides a concrete test case you can use to verify your code.

From the diagram, practice identifying: the height of any given node (number of edges to deepest leaf in its subtree), the depth of any given node (number of edges from root), which nodes are leaves, and the BST property (verify that every node satisfies left subtree < node < right subtree for the sample BST in the diagram). Node 6 in the diagram has depth 2 and height 1 because its children (4 and 7) are leaves.

### Senior @ FAANG: Tree Terminology Precision in System Design

Terminology precision matters in senior interviews and design documents. "Height" and "depth" are frequently confused: height is a property of a subtree (how deep it extends below), depth is a property of a node (how far it is from the root). A tree of height 3 has nodes at depth 0, 1, 2, and 3. Confusing these terms in a design review forces reviewers to ask clarifying questions rather than evaluating the actual design.

"Balanced" also requires precision. An AVL tree guarantees |height(left) - height(right)| <= 1 at every node, ensuring O(log n) operations. A Red-Black tree guarantees that the height of the tree is at most 2 * log(n+1), a weaker balance condition that enables faster insertions and deletions at the cost of slightly deeper trees. A B-tree of order m guarantees all leaves are at the same depth and each internal node has between m/2 and m children, which is a completely different balance definition tuned for disk I/O. When specifying a "balanced tree" in a design document, name the specific balance invariant and justify why that particular guarantee meets the service's performance requirements.
