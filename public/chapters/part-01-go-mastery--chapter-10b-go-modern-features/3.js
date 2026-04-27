export default `## 10B.1 Go 1.23 Iterators: Range-Over-Functions

### The Problem Before Iterators

Before Go 1.23, implementing a custom iterable collection required one of several awkward patterns:

\`\`\`go
// Pattern 1: Callback-style - not composable
func (t *Tree[T]) Walk(fn func(T)) {
    t.walkInOrder(t.root, fn)
}
tree.Walk(func(v int) { fmt.Println(v) })

// Pattern 2: Channel-based - goroutine overhead, can't break early cleanly
func (t *Tree[T]) Values() <-chan T {
    ch := make(chan T)
    go func() {
        defer close(ch)
        t.walkInOrder(t.root, func(v T) { ch <- v })
    }()
    return ch
}
for v := range tree.Values() { ... } // Goroutine leak if break early!

// Pattern 3: Slice - materializes all values into memory
func (t *Tree[T]) ToSlice() []T { ... }
for _, v := range tree.ToSlice() { ... } // Full allocation even if we only need first 10
\`\`\`

### iter.Seq and iter.Seq2

Go 1.23 introduces the \`iter\` package with two fundamental types:

\`\`\`go
// iter.Seq is an iterator over single values
type Seq[V any] func(yield func(V) bool)

// iter.Seq2 is an iterator over key-value pairs
type Seq2[K, V any] func(yield func(K, V) bool)
\`\`\`

The \`yield\` function returns \`false\` to signal early termination (like \`break\` in a range loop). Both types are plain function signatures, there is no interface to satisfy, no struct to embed. Any function matching the signature works with \`for range\`.

The following example implements an in-order iterator for a binary search tree. The key detail is propagating the \`yield\` return value through recursive calls so that a consumer's \`break\` stops the traversal immediately rather than walking the entire tree.

\`\`\`go
// Custom binary search tree with Go 1.23 iterators
package tree

import "iter"

type Node[T any] struct {
    Value T
    Left  *Node[T]
    Right *Node[T]
}

type BST[T any] struct {
    Root    *Node[T]
    Compare func(a, b T) int
}

// InOrder returns an iterator over values in sorted order
// The yield pattern enables lazy evaluation - values are only computed on demand
func (t *BST[T]) InOrder() iter.Seq[T] {
    return func(yield func(T) bool) {
        t.inOrderNode(t.root, yield)
    }
}

func (t *BST[T]) inOrderNode(node *Node[T], yield func(T) bool) bool {
    if node == nil {
        return true
    }
    // Visit left subtree; return false if caller stopped
    if !t.inOrderNode(node.Left, yield) {
        return false
    }
    // Yield current value; return false if caller stopped
    if !yield(node.Value) {
        return false
    }
    // Visit right subtree
    return t.inOrderNode(node.Right, yield)
}

// Indexed returns key-value pairs (index, value)
func (t *BST[T]) Indexed() iter.Seq2[int, T] {
    return func(yield func(int, T) bool) {
        i := 0
        t.inOrderNode(t.root, func(v T) bool {
            if !yield(i, v) {
                return false
            }
            i++
            return true
        })
    }
}

// Usage - idiomatic as range over regular slice/map
func main() {
    tree := NewBST[int](func(a, b int) int { return a - b })
    tree.Insert(5, 3, 8, 1, 4, 7, 9)

    // Range over iterator - looks just like range over slice
    for v := range tree.InOrder() {
        fmt.Println(v) // 1, 3, 4, 5, 7, 8, 9
    }

    // Early termination - no goroutine leak, no full materialization
    for i, v := range tree.Indexed() {
        if i >= 3 {
            break // yield returns false, traversal stops cleanly
        }
        fmt.Printf("[%d] %v\\n", i, v)
    }

    // Collect to slice using slices package
    all := slices.Collect(tree.InOrder())

    // Filter using iter combinators
    evens := func(seq iter.Seq[int]) iter.Seq[int] {
        return func(yield func(int) bool) {
            for v := range seq {
                if v%2 == 0 {
                    if !yield(v) {
                        return
                    }
                }
            }
        }
    }

    for v := range evens(tree.InOrder()) {
        fmt.Println(v) // 4, 8
    }
}
\`\`\`

### Pull Iterators: iter.Pull

For cases where you need to call \`next()\` imperatively (e.g., merging two sorted sequences):

\`\`\`go
// iter.Pull converts a push iterator into a pull (next, stop) pair
func MergeSorted[T cmp.Ordered](a, b iter.Seq[T]) iter.Seq[T] {
    return func(yield func(T) bool) {
        nextA, stopA := iter.Pull(a)
        defer stopA()
        nextB, stopB := iter.Pull(b)
        defer stopB()

        valA, okA := nextA()
        valB, okB := nextB()

        for okA && okB {
            if valA <= valB {
                if !yield(valA) {
                    return
                }
                valA, okA = nextA()
            } else {
                if !yield(valB) {
                    return
                }
                valB, okB = nextB()
            }
        }

        // Drain whichever is not exhausted
        for okA {
            if !yield(valA) {
                return
            }
            valA, okA = nextA()
        }
        for okB {
            if !yield(valB) {
                return
            }
            valB, okB = nextB()
        }
    }
}

// Usage: merge two sorted sequences without materializing either
aSeq := slices.Values([]int{1, 3, 5, 7, 9})
bSeq := slices.Values([]int{2, 4, 6, 8, 10})
for v := range MergeSorted(aSeq, bSeq) {
    fmt.Print(v, " ") // 1 2 3 4 5 6 7 8 9 10
}
\`\`\`

### Standard Library Iterator Methods

Go 1.23 added iterator-returning functions to the \`slices\` and \`maps\` packages. These replace common manual loops, reverse iteration, value-only iteration, and collecting filtered results into a new container, with concise, type-safe calls.

\`\`\`go
import (
    "iter"
    "maps"
    "slices"
)

// slices package iterators
nums := []int{10, 20, 30, 40, 50}

// slices.All - index, value pairs
for i, v := range slices.All(nums) {
    fmt.Printf("%d: %d\\n", i, v)
}

// slices.Values - values only (equivalent to range over slice without index)
for v := range slices.Values(nums) {
    fmt.Println(v)
}

// slices.Backward - reverse iteration
for i, v := range slices.Backward(nums) {
    fmt.Printf("%d: %d\\n", i, v) // 4:50, 3:40, 2:30, 1:20, 0:10
}

// slices.Collect - collect iterator into slice
evens := slices.Collect(func(yield func(int) bool) {
    for _, v := range nums {
        if v%20 == 0 {
            if !yield(v) {
                return
            }
        }
    }
})
// evens = [20, 40]

// maps package iterators
m := map[string]int{"a": 1, "b": 2, "c": 3}

// maps.All - key, value pairs (order not guaranteed)
for k, v := range maps.All(m) {
    fmt.Printf("%s: %d\\n", k, v)
}

// maps.Keys - keys only
for k := range maps.Keys(m) {
    fmt.Println(k)
}

// maps.Values - values only
for v := range maps.Values(m) {
    fmt.Println(v)
}

// maps.Collect - collect iterator into map
filtered := maps.Collect(func(yield func(string, int) bool) {
    for k, v := range m {
        if v > 1 {
            if !yield(k, v) {
                return
            }
        }
    }
})
// filtered = {"b": 2, "c": 3}
\`\`\`

### Iterator Combinators (Composing Iterators)

Iterator combinators like \`Filter\`, \`Map\`, and \`Take\` build new iterators from existing ones, enabling lazy pipeline processing without materializing intermediate slices.

\`\`\`go
// Filter combinator
func Filter[V any](seq iter.Seq[V], fn func(V) bool) iter.Seq[V] {
    return func(yield func(V) bool) {
        for v := range seq {
            if fn(v) {
                if !yield(v) {
                    return
                }
            }
        }
    }
}

// Map combinator
func Map[V, W any](seq iter.Seq[V], fn func(V) W) iter.Seq[W] {
    return func(yield func(W) bool) {
        for v := range seq {
            if !yield(fn(v)) {
                return
            }
        }
    }
}

// Take combinator - first N elements
func Take[V any](seq iter.Seq[V], n int) iter.Seq[V] {
    return func(yield func(V) bool) {
        i := 0
        for v := range seq {
            if i >= n {
                return
            }
            if !yield(v) {
                return
            }
            i++
        }
    }
}

// Reduce - aggregate all values
func Reduce[V, W any](seq iter.Seq[V], init W, fn func(W, V) W) W {
    acc := init
    for v := range seq {
        acc = fn(acc, v)
    }
    return acc
}

// Example: pipeline without materializing intermediate values
users := getUserIterator(db) // returns iter.Seq[User]
totalAge := Reduce(
    Map(
        Filter(users, func(u User) bool { return u.Active }),
        func(u User) int { return u.Age },
    ),
    0,
    func(sum, age int) int { return sum + age },
)
\`\`\`

### Comparison with Python Generators and Rust Iterators

| Feature | Go iter.Seq | Python Generator | Rust Iterator |
|---------|------------|-----------------|---------------|
| Lazy evaluation | Yes | Yes | Yes |
| Early termination | yield returns false | \`return\` or \`StopIteration\` | \`Iterator::take\` |
| Pull API | \`iter.Pull\` | built-in | built-in |
| Type safety | Generic | No | Generic |
| Goroutines needed | No | No | No |
| Overhead | Minimal (stack call) | Frame objects | Zero-cost |

Go's push model (caller passes yield function) is different from Python's generator (which uses coroutine suspension). The \`iter.Pull\` adapter provides the pull model when needed.

---
`;
