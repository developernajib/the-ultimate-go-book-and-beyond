## 10C.11 Stack Overflow, Infinite Recursion

Every function call in Go uses stack memory to store local variables and the return address. Go goroutines start with a small stack (around 2KB) that grows dynamically, but it has a hard upper limit (1GB by default). If a recursive function lacks a proper base case, or if the recursion is simply too deep, the stack grows until it hits this limit, causing a fatal "stack overflow" error. Unlike most panics, a stack overflow cannot be caught with `recover()`, so it always crashes the program.

```go
package main

// DISASTER: infinite recursion → stack overflow
// Go stacks start small (~2KB) and grow dynamically up to 1GB by default
// Infinite recursion exhausts stack memory
// Error: "runtime: goroutine stack exceeds 1000000000-byte limit"
// Error: "fatal error: stack overflow", which recover() does NOT catch

// BUG: missing base case. This never terminates for ANY argument, not just
// awkward ones: n counts down past 1 into the negatives forever.
func factorial(n int) int {
    // Missing: if n <= 1 { return 1 }
    return n * factorial(n-1)
}

// BUG: mutual recursion that only terminates from above.
// isEven(4) is fine. isEven(-1) recurses through -2, -3, -4 and never meets
// the n == 0 base case, so it runs until the stack is gone. The base case
// exists, it is just unreachable from half the domain.
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
    return isEven(n - 1)
}
```

### Safe Recursive Patterns

Bounded recursion with explicit depth limits or iterative conversion using an explicit stack prevents stack overflow. The Go runtime will grow goroutine stacks up to 1GB by default before panicking.

```go
package main

import "fmt"

// FIX 1: Always have a base case, and make it reachable from every input.
// The n < 0 guard is not decoration: without it, the n <= 1 case is
// unreachable from negative arguments and the bug above comes right back.
//
// Note the second, unrelated hazard: int overflows silently at n == 21, so
// this returns a confidently wrong number rather than failing. Bounding the
// input is part of the fix, not an extra.
func factorialSafe(n int) int {
    if n < 0 {
        panic("factorial of negative number")
    }
    if n > 20 {
        panic("factorial overflows int64 above 20")
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

// FIX 3: the trampoline pattern, which converts recursion into iteration.
// Each step returns the next step instead of calling it, so the loop below
// runs at constant stack depth no matter how many steps there are. Go has
// no tail-call elimination, which is what makes this necessary.
type Thunk func() Thunk

func trampoline(f Thunk) {
    for f != nil {
        f = f() // the previous frame is gone before the next one starts
    }
}

// countdown returns a Thunk chain instead of recursing directly.
// trampoline(countdown(10_000_000)) runs in a few stack frames.
func countdown(n int) Thunk {
    if n == 0 {
        return nil // nil terminates the trampoline
    }
    return func() Thunk { return countdown(n - 1) }
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
```

---
