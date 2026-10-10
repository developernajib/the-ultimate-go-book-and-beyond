## Exercises

### Exercise 1: Count Complete Tree Nodes
Count nodes in a complete binary tree in O(log^2 n) time.

### Exercise 2: Flatten Binary Tree to Linked List
Flatten tree to "linked list" in-place using right pointers only.

### Exercise 3: Binary Tree Right Side View
Return values visible when looking at tree from the right side.

### Exercise 4: BST Iterator
Implement an iterator that returns elements in inorder one at a time.

### Junior -> FAANG: Sequencing These Exercises by Difficulty

Exercise 1 (Count Complete Tree Nodes, LC 222): the O(log² n) trick exploits the structure of a complete tree. Find the height of the leftmost and rightmost paths: if they are equal, the subtree is perfect and has `2^height - 1` nodes (compute without traversal). If they differ, recurse. This is a Medium problem that becomes Easy once you internalize the "perfect subtree shortcut" idea.

Exercise 2 (Flatten Binary Tree, LC 114): the target order is preorder, and the simple approach reflects that directly. Run a preorder traversal, collect the nodes, then relink each one's `Right` to the next and set every `Left` to nil. Collect first and relink second, because rewiring pointers mid-traversal severs the subtree you have not visited yet.

The O(1)-space version is the one interviewers are usually fishing for. For each node with a left subtree, find the rightmost node of that left subtree, which is the node's inorder predecessor and, more to the point, the last node of the left subtree in preorder. Splice the current node's right subtree onto that node's `Right`, move the whole left subtree over to `Right`, clear `Left`, then advance to `Right` and repeat. The trick is the same threading insight behind Morris traversal: the rightmost node of the left subtree has a free `Right` pointer, so it is exactly where the right subtree can be parked.

Exercise 3 (Right Side View, LC 199): this is a level-order BFS where you take the last element of each level. It looks like it requires a special traversal but it is just BFS with `result = append(result, level[len(level)-1])` after each level.

Exercise 4 (BST Iterator, LC 173): implement `Next()` and `HasNext()` with O(h) space using a stack. The stack simulates the call stack of iterative inorder traversal, initializing by pushing all left-spine nodes, then popping the top, visiting it, and pushing the right child's left spine. This pattern is used in database cursors and file system iterators.

### Senior @ FAANG: Exercises as Architectural Patterns

Exercise 2 (Flatten to Linked List) is a specific instance of tree linearization, which appears in serialization pipelines, expression tree evaluation, and DOT language renderers for graphviz. The in-place version with no extra memory is the production form for memory-constrained environments. The preorder-collect version is the production form for clarity and testability.

Exercise 4 (BST Iterator) is the canonical interface for lazy evaluation in ordered data structures. Database cursors (PostgreSQL's cursor-based query result iteration), Go's `database/sql.Rows` interface, and file system directory walkers all implement this pattern. A production BST iterator must handle concurrent modification: if the tree is modified while an iterator is active, the iterator's position may be invalidated. Designing an iterator that either detects modification (version counter) or tolerates it (snapshot isolation) is a system design sub-problem that appears in database engine interviews.
