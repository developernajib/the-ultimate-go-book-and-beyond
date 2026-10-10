## 70.9 Common Mistakes

### Mistake 1: Confusing Tree Traversal Orders

Only inorder traversal of a BST produces a sorted sequence. Preorder and postorder do not. Using the wrong traversal order for a problem that requires sorted output is a silent logic error. The code compiles and runs but returns incorrect results.

```go
// ❌ BAD: Wrong traversal for BST sorted output
func getSortedBad(root *TreeNode) []int {
    var result []int
    preorder(root, &result)  // Preorder doesn't give sorted!
    return result
}

// ✅ GOOD: Inorder traversal gives sorted BST output
func getSortedGood(root *TreeNode) []int {
    var result []int
    inorder(root, &result)
    return result
}

func inorder(node *TreeNode, result *[]int) {
    if node == nil {
        return
    }
    inorder(node.Left, result)
    *result = append(*result, node.Val)
    inorder(node.Right, result)
}
```

### Mistake 2: Stack Overflow in Deep Trees

A goroutine stack starts at 2KB and grows by copying itself, up to a hard 1GB ceiling on 64-bit platforms. A balanced tree never comes close, since depth is O(log n). A degenerate tree (effectively a linked list) pushes recursion depth to O(n), and blowing the ceiling is a fatal runtime throw that `recover` cannot catch, so it takes down the whole process rather than one request.

To be clear about the tradeoff: the recursive version below is not wrong, and it is the version to write when you control the input or the tree is balanced. It is the *unbounded* input that makes it a liability. The iterative version moves the frames onto the heap, where growth is bounded by ordinary memory limits and failure is a `panic` you can actually handle.

```go
// ❌ RISKY on adversarial input: recursion depth is unbounded
func maxDepthBad(root *TreeNode) int {
    if root == nil {
        return 0
    }
    return 1 + max(maxDepthBad(root.Left), maxDepthBad(root.Right))
}

// ✅ GOOD: Iterative with explicit stack
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

        maxD = max(maxD, curr.depth)

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

### Mistake 3: Not Handling Nil Properly

Tree functions must always handle the nil case, both as the base case for empty inputs and as the base case for recursion. Dereferencing a nil pointer before checking it is one of the most common runtime panics in tree problems.

```go
// ❌ BAD: Crashes on nil
func isBalancedBad(root *TreeNode) bool {
    leftH := height(root.Left)   // Crashes if root is nil!
    rightH := height(root.Right)
    return abs(leftH-rightH) <= 1
}

// ✅ GOOD: Check nil first
func isBalancedGood(root *TreeNode) bool {
    if root == nil {
        return true
    }
    return checkBalance(root) != -1
}

func checkBalance(node *TreeNode) int {
    if node == nil {
        return 0
    }

    left := checkBalance(node.Left)
    if left == -1 {
        return -1
    }

    right := checkBalance(node.Right)
    if right == -1 {
        return -1
    }

    if abs(left-right) > 1 {
        return -1
    }

    return max(left, right) + 1
}
```

### Junior -> FAANG: Avoiding the Three Fatal Tree Interview Bugs

These three mistakes are the most common causes of failing a tree interview that would otherwise have been passed:

Mistake 1 (wrong traversal order): write "inorder = sorted for BST" on your scratch paper before starting any BST problem. This one fact prevents using preorder when the problem needs sorted output.

Mistake 2 (stack overflow on deep trees): in interviews, you will not encounter inputs large enough to cause actual stack overflow. However, if you are asked "what is the space complexity of your recursive solution?", the correct answer is "O(h) where h is the height, which is O(n) for degenerate trees and O(log n) for balanced trees." If the interviewer follows up with "what if the tree is extremely deep?", offer the iterative alternative.

Mistake 3 (nil before check): get into the habit of writing the nil check as the very first line of every recursive tree function, before accessing any field of the node. A 5-second rule: if you are about to write `node.Val` or `node.Left`, the line before it must be `if node == nil { return ... }`.

### Senior @ FAANG: Common Mistakes as Code Review Signals

Each of these three mistakes appears in production code reviews under different guises.

Traversal order confusion in production: a background job that produces a sorted export of a BST-backed index using preorder traversal instead of inorder will produce an unsorted file. The bug is silent: the job succeeds, the file is produced, and the downstream consumer either fails or silently processes data in the wrong order. Catching this in code review requires the reviewer to know tree traversal properties and verify that the traversal matches the output requirement.

Stack overflow in production (mistake 2): deeply recursive tree processing in a service that handles user-provided data is a denial-of-service vector, and it is worse than it first looks. An adversarial user submits a sorted sequence, which a plain BST turns into a linked list, and the recursive traversal exceeds the stack limit. That is not a failed request. Exceeding the stack limit is a fatal runtime throw, immune to `recover`, so one crafted payload kills the entire process and every in-flight request on it. A single cheap input takes down the instance.

The mitigations stack: bound the height before recursing (`if height > maxAllowedHeight { return error }`), use an iterative traversal so the depth lives on the heap, or use a self-balancing structure so that adversarial ordering cannot produce depth beyond O(log n) in the first place. The last is the most reliable, because it removes the attacker's leverage rather than detecting its use.

Nil access before check (mistake 3): this is the most common source of nil pointer dereference panics in production Go tree processing code. A code review standard of "every tree function must check nil before accessing any field" should be in the team's Go style guide, enforced by static analysis if possible.

---
