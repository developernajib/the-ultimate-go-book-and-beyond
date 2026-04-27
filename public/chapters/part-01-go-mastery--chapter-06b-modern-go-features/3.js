export default `## Section 1: Range-Over-Function Iterators (Go 1.23+)

Range-over-function was first available as an experiment in Go 1.22 behind \`GOEXPERIMENT=rangefunc\`, then stabilized in Go 1.23 along with the new \`iter\` standard library package. For production code, treat Go 1.23 as the required floor. Together they represent the most significant language change since generics.

### 1.1 Iterator Types

Range-over-function iterators introduce three function signatures corresponding to different \`range\` loop forms: zero-value, single-value, and key-value. Each yields elements by calling a user-provided yield function.

\`\`\`go
package iterators

import (
	"iter"
	"slices"
)

// iter.Seq[V] - yields values
// iter.Seq2[K, V] - yields key-value pairs

// Simple value iterator
func Fibonacci() iter.Seq[int] {
	return func(yield func(int) bool) {
		a, b := 0, 1
		for {
			if !yield(a) {
				return // consumer stopped
			}
			a, b = b, a+b
		}
	}
}

// Key-value iterator
func Enumerate[V any](s []V) iter.Seq2[int, V] {
	return func(yield func(int, V) bool) {
		for i, v := range s {
			if !yield(i, v) {
				return
			}
		}
	}
}

// Using iterators with range
func ExampleIterators() {
	// Range over fibonacci - Go 1.22+ syntax
	for n := range Fibonacci() {
		if n > 100 {
			break // yield returns false, iterator cleans up
		}
		_ = n
	}

	// Range over key-value iterator
	names := []string{"Alice", "Bob", "Charlie"}
	for i, name := range Enumerate(names) {
		_ = i
		_ = name
	}
}
\`\`\`

### 1.2 Custom Collection Iterators

Custom collections implement iterators by returning a function that calls yield for each element. The yield function returns a boolean signaling whether to continue, enabling clean early termination.

\`\`\`go
package iterators

import (
	"iter"
	"sync"
)

// Tree with iterator support
type TreeNode[K comparable, V any] struct {
	Key   K
	Value V
	Left  *TreeNode[K, V]
	Right *TreeNode[K, V]
}

type BST[K interface{ ~int | ~string }, V any] struct {
	root *TreeNode[K, V]
}

// InOrder returns an in-order iterator - no intermediate slice allocation
func (t *BST[K, V]) InOrder() iter.Seq2[K, V] {
	return func(yield func(K, V) bool) {
		var traverse func(node *TreeNode[K, V]) bool
		traverse = func(node *TreeNode[K, V]) bool {
			if node == nil {
				return true
			}
			if !traverse(node.Left) {
				return false
			}
			if !yield(node.Key, node.Value) {
				return false
			}
			return traverse(node.Right)
		}
		traverse(t.root)
	}
}

// Thread-safe iterator using a snapshot
type SafeMap[K comparable, V any] struct {
	mu   sync.RWMutex
	data map[K]V
}

func (m *SafeMap[K, V]) All() iter.Seq2[K, V] {
	// Take snapshot under read lock
	m.mu.RLock()
	snapshot := make(map[K]V, len(m.data))
	for k, v := range m.data {
		snapshot[k] = v
	}
	m.mu.RUnlock()

	// Iterate snapshot without holding lock
	return func(yield func(K, V) bool) {
		for k, v := range snapshot {
			if !yield(k, v) {
				return
			}
		}
	}
}
\`\`\`

### 1.3 Iterator Combinators

Iterator combinators compose iterators to produce new iterators that filter, transform, or limit sequences without materializing intermediate slices. This enables lazy, memory-efficient processing.

\`\`\`go
package iterators

import "iter"

// Filter wraps an iterator, yielding only matching elements
func Filter[V any](seq iter.Seq[V], pred func(V) bool) iter.Seq[V] {
	return func(yield func(V) bool) {
		for v := range seq {
			if pred(v) {
				if !yield(v) {
					return
				}
			}
		}
	}
}

// Map transforms values in an iterator
func Map[V, W any](seq iter.Seq[V], f func(V) W) iter.Seq[W] {
	return func(yield func(W) bool) {
		for v := range seq {
			if !yield(f(v)) {
				return
			}
		}
	}
}

// Take limits an iterator to n elements
func Take[V any](seq iter.Seq[V], n int) iter.Seq[V] {
	return func(yield func(V) bool) {
		count := 0
		for v := range seq {
			if count >= n {
				return
			}
			if !yield(v) {
				return
			}
			count++
		}
	}
}

// Zip combines two iterators into pairs
func Zip[A, B any](seqA iter.Seq[A], seqB iter.Seq[B]) iter.Seq2[A, B] {
	return func(yield func(A, B) bool) {
		nextA, stopA := iter.Pull(seqA)
		nextB, stopB := iter.Pull(seqB)
		defer stopA()
		defer stopB()

		for {
			a, okA := nextA()
			b, okB := nextB()
			if !okA || !okB {
				return
			}
			if !yield(a, b) {
				return
			}
		}
	}
}

// Collect materializes an iterator into a slice
func Collect[V any](seq iter.Seq[V]) []V {
	var result []V
	for v := range seq {
		result = append(result, v)
	}
	return result
}

// Reduce folds an iterator into a single value
func Reduce[V, R any](seq iter.Seq[V], initial R, f func(R, V) R) R {
	acc := initial
	for v := range seq {
		acc = f(acc, v)
	}
	return acc
}

// Pipeline example: find top-5 even Fibonacci numbers
func Top5EvenFibs() []int {
	return Collect(
		Take(
			Filter(Fibonacci(), func(n int) bool { return n%2 == 0 }),
			5,
		),
	)
}
\`\`\`

### 1.4 Pull Iterators for Stateful Consumption

Pull iterators invert the control flow: the caller pulls elements one at a time rather than receiving them via a yield callback. \`iter.Pull\` converts a push iterator to a pull iterator.

\`\`\`go
package iterators

import "iter"

// iter.Pull converts a push iterator to a pull iterator
// This enables manual stepping, pausing, and cleanup

func PullExample() {
	// Convert to pull style for manual control
	next, stop := iter.Pull(Fibonacci())
	defer stop() // MUST call stop to release resources

	// Manually advance
	first, ok := next()
	_ = first
	_ = ok

	// Skip ahead
	for i := 0; i < 5; i++ {
		next()
	}

	// Resume from current position
	value, _ := next()
	_ = value
}

// Merge two sorted iterators (requires pull style)
func MergeSorted[V interface{ ~int | ~float64 | ~string }](
	a, b iter.Seq[V],
) iter.Seq[V] {
	return func(yield func(V) bool) {
		nextA, stopA := iter.Pull(a)
		nextB, stopB := iter.Pull(b)
		defer stopA()
		defer stopB()

		va, okA := nextA()
		vb, okB := nextB()

		for okA && okB {
			if va <= vb {
				if !yield(va) {
					return
				}
				va, okA = nextA()
			} else {
				if !yield(vb) {
					return
				}
				vb, okB = nextB()
			}
		}

		// Drain remaining
		for ; okA; va, okA = nextA() {
			if !yield(va) {
				return
			}
		}
		for ; okB; vb, okB = nextB() {
			if !yield(vb) {
				return
			}
		}
	}
}
\`\`\`

### When to Reach for Iterators (and When Not To)

The iterator API is powerful enough that engineers reach for it in places where a slice or a callback would be simpler. Three rules:

1. **Reach for iterators when the producer owns resources that need cleanup.** File handles, database cursors, streaming APIs. The iterator's \`yield\` returning false lets the producer release resources without exposing the resource lifecycle to the consumer.
2. **Reach for iterators when materialising the full sequence is wasteful.** Streaming a million log lines through an iterator is fine. Streaming three lines through an iterator is over-engineering.
3. **Stick with a slice when the data is small and the API surface needs to be obvious.** A function that returns \`[]Result\` is easier to read, easier to test, and easier to compose than one that returns \`iter.Seq[Result]\`. The iterator is the right answer for the standard library helpers (\`maps.Keys\`, \`slices.Values\`) where the consumer often needs to break early.

### Code-Review Lens (Senior Track)

Three patterns a staff reviewer flags in iterator-related PRs:

1. **An iterator that does not respect the \`yield\` return value.** A producer that ignores the bool from \`yield\` and keeps going is a bug. The consumer's break leaks the iterator's remaining resources.
2. **An iterator that allocates per-yield.** Iterators are supposed to be cheap. If each yield allocates a struct, the abstraction is more expensive than the slice it replaced. Profile.
3. **An iterator wrapped in another iterator wrapped in another.** Past two layers, the call stack becomes hard to debug. Materialise to a slice or restructure.

### Migration Lens

Coming from Python, range-over-function iterators are roughly Python's generator functions, with the difference that Go's iterators do not support \`send\` (only one direction). Coming from JavaScript, they are roughly the iterator protocol with \`Symbol.iterator\`, with the difference that Go iterators are typed. Coming from Rust, they are roughly the \`Iterator\` trait, with the difference that Go iterators are functions, not types. The Go choice prioritises simplicity over composability.

---
`;
