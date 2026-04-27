export default `## 10C.11 Stack Overflow, Infinite Recursion

Every function call in Go uses stack memory to store local variables and the return address. Go goroutines start with a small stack (around 8KB) that grows dynamically, but it has a hard upper limit (1GB by default). If a recursive function lacks a proper base case, or if the recursion is simply too deep, the stack grows until it hits this limit, causing a fatal "stack overflow" error. Unlike most panics, a stack overflow cannot be caught with \`recover()\`, so it always crashes the program.

\`\`\`go
package main

// DISASTER: infinite recursion → stack overflow
// Go stacks start small (~8KB) and grow dynamically up to 1GB by default
// Infinite recursion exhausts stack memory
// Error: "runtime: goroutine stack exceeds 1000000000-byte limit"
// Error: "fatal error: stack overflow" - NOT recoverable with recover()!

// BUG: missing base case
func factorial(n int) int {
    // Missing: if n <= 1 { return 1 }
    return n * factorial(n-1) // infinite recursion when called with -1 or no base
}

// BUG: mutual recursion without termination
func isEven(n int) bool {
    if n == 0 {
        return true
    }
    return isOdd(n - 1)
}

func isOdd(n int) bool {
    if n == 0 {
        return false
    }
    return isEven(n - 1) // fine for small n, but stack overflows for large n
}
\`\`\`

### Safe Recursive Patterns

Bounded recursion with explicit depth limits or iterative conversion using an explicit stack prevents stack overflow. The Go runtime will grow goroutine stacks up to 1GB by default before panicking.

\`\`\`go
package main

import "fmt"

// FIX 1: Always have a clear base case
func factorialSafe(n int) int {
    if n < 0 {
        panic("factorial of negative number")
    }
    if n <= 1 {
        return 1 // base case
    }
    return n * factorialSafe(n-1)
}

// FIX 2: Use iteration instead of recursion for deep trees
func factorialIterative(n int) int {
    if n < 0 {
        return -1
    }
    result := 1
    for i := 2; i <= n; i++ {
        result *= i
    }
    return result
}

// FIX 3: Trampoline pattern - converts recursion to iteration
// Avoids stack overflow for deeply recursive algorithms
type Thunk func() Thunk

func trampoline(f Thunk) {
    for f != nil {
        f = f()
    }
}

// FIX 4: Depth-limited recursion with explicit depth tracking
func traverseTree(node *TreeNode, depth, maxDepth int) {
    if node == nil || depth > maxDepth {
        return
    }
    fmt.Println(node.Value)
    traverseTree(node.Left, depth+1, maxDepth)
    traverseTree(node.Right, depth+1, maxDepth)
}

type TreeNode struct {
    Value       int
    Left, Right *TreeNode
}

// FIX 5: Explicit stack for tree traversal (replaces recursion entirely)
func traverseIterative(root *TreeNode) {
    if root == nil {
        return
    }
    stack := []*TreeNode{root}
    for len(stack) > 0 {
        node := stack[len(stack)-1]
        stack = stack[:len(stack)-1]
        fmt.Println(node.Value)
        if node.Right != nil {
            stack = append(stack, node.Right)
        }
        if node.Left != nil {
            stack = append(stack, node.Left)
        }
    }
}
\`\`\`

---
`;
