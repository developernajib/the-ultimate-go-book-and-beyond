## 70.2 Tree Traversals

Tree traversals define the order in which every node in a tree is visited, and the choice of order fundamentally changes what problems you can solve. The four canonical orderings (preorder, inorder, postorder, and level-order) each expose a different structural property of the tree: inorder on a BST yields a sorted sequence, postorder ensures children are fully processed before their parent (critical for deletion and free-list cleanup), and level-order processes nodes by depth, which maps directly to BFS shortest-path reasoning. Understanding which traversal to reach for is often the first and most important decision in a tree interview problem.

```
┌─────────────────────────────────────────────────────────────────┐
│                    TREE TRAVERSAL ORDER                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│                    ┌───┐                                        │
│                    │ 1 │                                        │
│                    └─┬─┘                                        │
│               ┌─────┴─────┐                                     │
│             ┌─┴─┐       ┌─┴─┐                                   │
│             │ 2 │       │ 3 │                                   │
│             └─┬─┘       └─┬─┘                                   │
│           ┌───┴───┐   ┌───┴───┐                                 │
│         ┌─┴─┐   ┌─┴─┐┌─┴─┐   ┌─┴─┐                              │
│         │ 4 │   │ 5 ││ 6 │   │ 7 │                              │
│         └───┘   └───┘└───┘   └───┘                              │
│                                                                 │
│  Preorder  (Root-Left-Right): 1, 2, 4, 5, 3, 6, 7               │
│  Inorder   (Left-Root-Right): 4, 2, 5, 1, 6, 3, 7               │
│  Postorder (Left-Right-Root): 4, 5, 2, 6, 7, 3, 1               │
│  Level Order: 1, 2, 3, 4, 5, 6, 7                               │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Recursive Traversals

The three depth-first traversal orders differ only in when the current node is visited relative to its children: preorder visits root first (useful for copying trees), inorder visits root between children (yields sorted order for BSTs), and postorder visits root last (useful for deletion and expression tree evaluation).

```go
package tree

// PreorderRecursive traverses root -> left -> right
func PreorderRecursive(root *TreeNode) []int {
    result := []int{}
    preorderHelper(root, &result)
    return result
}

func preorderHelper(node *TreeNode, result *[]int) {
    if node == nil {
        return
    }
    *result = append(*result, node.Val)
    preorderHelper(node.Left, result)
    preorderHelper(node.Right, result)
}

// InorderRecursive traverses left -> root -> right
func InorderRecursive(root *TreeNode) []int {
    result := []int{}
    inorderHelper(root, &result)
    return result
}

func inorderHelper(node *TreeNode, result *[]int) {
    if node == nil {
        return
    }
    inorderHelper(node.Left, result)
    *result = append(*result, node.Val)
    inorderHelper(node.Right, result)
}

// PostorderRecursive traverses left -> right -> root
func PostorderRecursive(root *TreeNode) []int {
    result := []int{}
    postorderHelper(root, &result)
    return result
}

func postorderHelper(node *TreeNode, result *[]int) {
    if node == nil {
        return
    }
    postorderHelper(node.Left, result)
    postorderHelper(node.Right, result)
    *result = append(*result, node.Val)
}
```

### Iterative Traversals

Iterative traversals replace the call stack with an explicit stack data structure, enabling depth control in environments with limited stack space. Iterative inorder requires careful pointer tracking to descend left as far as possible before processing, while iterative postorder is most elegantly handled with two stacks, where the second reverses the preorder-like traversal of the first.

```go
package tree

// PreorderIterative uses a stack
// Time: O(n), Space: O(h) where h is height
func PreorderIterative(root *TreeNode) []int {
    if root == nil {
        return []int{}
    }

    result := []int{}
    stack := []*TreeNode{root}

    for len(stack) > 0 {
        node := stack[len(stack)-1]
        stack = stack[:len(stack)-1]

        result = append(result, node.Val)

        // Push right first so left is processed first
        if node.Right != nil {
            stack = append(stack, node.Right)
        }
        if node.Left != nil {
            stack = append(stack, node.Left)
        }
    }

    return result
}

// InorderIterative uses a stack
// Time: O(n), Space: O(h)
func InorderIterative(root *TreeNode) []int {
    result := []int{}
    stack := []*TreeNode{}
    curr := root

    for curr != nil || len(stack) > 0 {
        // Go to the leftmost node
        for curr != nil {
            stack = append(stack, curr)
            curr = curr.Left
        }

        // Process current node
        curr = stack[len(stack)-1]
        stack = stack[:len(stack)-1]
        result = append(result, curr.Val)

        // Move to right subtree
        curr = curr.Right
    }

    return result
}

// PostorderIterative using two stacks
// Time: O(n), Space: O(n)
func PostorderIterative(root *TreeNode) []int {
    if root == nil {
        return []int{}
    }

    result := []int{}
    stack1 := []*TreeNode{root}
    stack2 := []*TreeNode{}

    for len(stack1) > 0 {
        node := stack1[len(stack1)-1]
        stack1 = stack1[:len(stack1)-1]
        stack2 = append(stack2, node)

        if node.Left != nil {
            stack1 = append(stack1, node.Left)
        }
        if node.Right != nil {
            stack1 = append(stack1, node.Right)
        }
    }

    for len(stack2) > 0 {
        node := stack2[len(stack2)-1]
        stack2 = stack2[:len(stack2)-1]
        result = append(result, node.Val)
    }

    return result
}

// PostorderIterativeOneStack using one stack
func PostorderIterativeOneStack(root *TreeNode) []int {
    result := []int{}
    stack := []*TreeNode{}
    var lastVisited *TreeNode
    curr := root

    for curr != nil || len(stack) > 0 {
        // Go to the leftmost node
        for curr != nil {
            stack = append(stack, curr)
            curr = curr.Left
        }

        // Peek top of stack
        top := stack[len(stack)-1]

        // If right child exists and hasn't been visited
        if top.Right != nil && top.Right != lastVisited {
            curr = top.Right
        } else {
            // Visit the node
            result = append(result, top.Val)
            lastVisited = top
            stack = stack[:len(stack)-1]
        }
    }

    return result
}
```

### Level Order Traversal (BFS)

Level-order traversal processes nodes layer by layer using a queue, making it the foundation for problems involving tree depth, level-specific operations, and shortest-path reasoning. Snapshotting the queue length at the start of each iteration isolates one complete level, enabling grouping into the `[][]int` output format.

```go
// LevelOrder returns nodes level by level
// LeetCode 102: Binary Tree Level Order Traversal
// Time: O(n), Space: O(n)
func LevelOrder(root *TreeNode) [][]int {
    if root == nil {
        return [][]int{}
    }

    result := [][]int{}
    queue := []*TreeNode{root}

    for len(queue) > 0 {
        levelSize := len(queue)
        level := make([]int, levelSize)

        for i := 0; i < levelSize; i++ {
            node := queue[0]
            queue = queue[1:]
            level[i] = node.Val

            if node.Left != nil {
                queue = append(queue, node.Left)
            }
            if node.Right != nil {
                queue = append(queue, node.Right)
            }
        }

        result = append(result, level)
    }

    return result
}

// LevelOrderBottom returns levels from bottom to top
// LeetCode 107: Binary Tree Level Order Traversal II
func LevelOrderBottom(root *TreeNode) [][]int {
    result := LevelOrder(root)

    // Reverse
    for i, j := 0, len(result)-1; i < j; i, j = i+1, j-1 {
        result[i], result[j] = result[j], result[i]
    }

    return result
}

// ZigzagLevelOrder alternates direction each level
// LeetCode 103: Binary Tree Zigzag Level Order Traversal
func ZigzagLevelOrder(root *TreeNode) [][]int {
    if root == nil {
        return [][]int{}
    }

    result := [][]int{}
    queue := []*TreeNode{root}
    leftToRight := true

    for len(queue) > 0 {
        levelSize := len(queue)
        level := make([]int, levelSize)

        for i := 0; i < levelSize; i++ {
            node := queue[0]
            queue = queue[1:]

            // Determine index based on direction
            idx := i
            if !leftToRight {
                idx = levelSize - 1 - i
            }
            level[idx] = node.Val

            if node.Left != nil {
                queue = append(queue, node.Left)
            }
            if node.Right != nil {
                queue = append(queue, node.Right)
            }
        }

        result = append(result, level)
        leftToRight = !leftToRight
    }

    return result
}
```

### Morris Traversal (O(1) Space)

Morris traversal achieves O(1) auxiliary space by temporarily threading each node's right pointer to its inorder successor, then restoring the original structure as it backtracks. This technique eliminates both the explicit stack of iterative traversal and the implicit call stack of recursion, at the cost of temporarily modifying the tree.

That last clause carries more weight than it appears to. While a Morris traversal is in flight the tree is genuinely malformed: some right pointers are threads pointing back up at ancestors, so a concurrent reader would see cycles rather than a tree, and it is a write operation despite reading nothing. Worse, the restoration only happens on the way back through. If the traversal is abandoned partway, by an early return, a `panic`, or a cancelled context, the threads are never unwound and the tree is left permanently corrupted. Morris is a fine tool for a memory-constrained single-threaded pass over a tree you own outright. It is the wrong tool for shared or long-lived structures.

```go
// MorrisInorder traverses without stack or recursion
// Time: O(n), Space: O(1)
func MorrisInorder(root *TreeNode) []int {
    result := []int{}
    curr := root

    for curr != nil {
        if curr.Left == nil {
            // No left subtree, visit and go right
            result = append(result, curr.Val)
            curr = curr.Right
        } else {
            // Find inorder predecessor (rightmost in left subtree)
            pred := curr.Left
            for pred.Right != nil && pred.Right != curr {
                pred = pred.Right
            }

            if pred.Right == nil {
                // Make curr the right child of predecessor
                pred.Right = curr
                curr = curr.Left
            } else {
                // Restore tree structure
                pred.Right = nil
                result = append(result, curr.Val)
                curr = curr.Right
            }
        }
    }

    return result
}

// MorrisPreorder does preorder traversal in O(1) space
func MorrisPreorder(root *TreeNode) []int {
    result := []int{}
    curr := root

    for curr != nil {
        if curr.Left == nil {
            result = append(result, curr.Val)
            curr = curr.Right
        } else {
            pred := curr.Left
            for pred.Right != nil && pred.Right != curr {
                pred = pred.Right
            }

            if pred.Right == nil {
                result = append(result, curr.Val) // Visit before going left
                pred.Right = curr
                curr = curr.Left
            } else {
                pred.Right = nil
                curr = curr.Right
            }
        }
    }

    return result
}
```

### Junior -> FAANG: Traversal Selection as First Interview Move

When you read a tree problem, your first decision is which traversal to use. Here is the decision rule:

Need sorted values from a BST? Use inorder. Need to clone or serialize a tree? Use preorder (root first lets you reconstruct). Need to free/delete a tree? Use postorder (children before parent, safe to delete). Need level-by-level processing (min depth, right side view, level averages)? Use level-order (BFS with a queue). Need to find height, diameter, or path sums (bottom-up aggregation)? Use postorder recursion.

State this reasoning aloud to your interviewer before writing code. It demonstrates pattern recognition, not just coding ability. An interviewer who hears "this is a bottom-up postorder recursion because I need the subtree height before I can determine balance at the current node" knows you understand the structure of the problem.

Morris traversal is rarely required in interviews but is a strong optional mention for O(1) space: "A Morris traversal would achieve O(1) auxiliary space by threading the tree, but it temporarily modifies the structure. I'll use the recursive approach for clarity unless space is constrained."

### Senior @ FAANG: Traversal Complexity and Stack Depth in Production

The recursive traversal implementations use O(h) stack space where h is the tree height. For a balanced tree, h = O(log n), which is safe for trees up to billions of nodes. For a degenerate tree (sorted insertion into a plain BST produces a linked list), h = O(n), and a tree with n = 100,000 nodes can overflow Go's goroutine stack.

A goroutine stack starts small, currently 2KB (`stackMin` in `runtime/stack.go`), and grows on demand by copying itself to a larger block. It is capped at 1GB on 64-bit platforms and 250MB on 32-bit, tunable with `runtime/debug.SetMaxStack`. `GOMAXPROCS` has nothing to do with this limit: it sets the number of OS threads running goroutines, not any stack bound.

The consequence for deep recursion is that a degenerate tree does not fail gracefully. A recursive traversal of a 1-million-node degenerate tree needs roughly 1 million live frames, and at even ~100 bytes per frame that is ~100MB of stack for one goroutine. Two things follow. Exceeding the cap is a fatal `goroutine stack exceeds 1000000000-byte limit` throw that `recover` cannot catch, so it takes the process down rather than failing one request. And because the stack grows by copying, a goroutine that transiently recurses deep keeps that large stack rather than immediately returning the memory. A service that recurses over user-provided trees should bound the height before recursing, or use an iterative implementation whose explicit stack lives on the heap where it is bounded by ordinary memory limits and a `panic` you can actually handle.

The iterative inorder traversal is the production-safe choice for tree traversal in services that handle user-provided tree data. The Morris traversal is the choice for embedded or memory-constrained environments where even the O(h) heap-allocated explicit stack is too large. Document which variant is used and why in the component's design notes.
