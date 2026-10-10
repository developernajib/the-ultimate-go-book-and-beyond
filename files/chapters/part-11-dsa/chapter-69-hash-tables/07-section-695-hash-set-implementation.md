## 69.5 Hash Set Implementation

A hash set wraps Go's map with an empty struct value (`map[T]struct{}`) to achieve O(1) membership testing with zero per-entry memory overhead beyond the key. The generic implementation provides set algebra operations (union, intersection, difference, and subset checking), all expressed as O(n) map traversals.

```go
package hashset

// HashSet implements a set using Go's map
type HashSet[T comparable] struct {
    m map[T]struct{}
}

// New creates an empty hash set
func New[T comparable]() *HashSet[T] {
    return &HashSet[T]{m: make(map[T]struct{})}
}

// NewFromSlice creates a hash set from a slice
func NewFromSlice[T comparable](items []T) *HashSet[T] {
    hs := New[T]()
    for _, item := range items {
        hs.Add(item)
    }
    return hs
}

// Add adds an element to the set
func (s *HashSet[T]) Add(item T) {
    s.m[item] = struct{}{}
}

// Remove removes an element from the set
func (s *HashSet[T]) Remove(item T) {
    delete(s.m, item)
}

// Contains checks if an element exists
func (s *HashSet[T]) Contains(item T) bool {
    _, ok := s.m[item]
    return ok
}

// Size returns the number of elements
func (s *HashSet[T]) Size() int {
    return len(s.m)
}

// IsEmpty returns true if the set is empty
func (s *HashSet[T]) IsEmpty() bool {
    return len(s.m) == 0
}

// ToSlice converts set to slice
func (s *HashSet[T]) ToSlice() []T {
    result := make([]T, 0, len(s.m))
    for item := range s.m {
        result = append(result, item)
    }
    return result
}

// Union returns a new set with elements from both sets
func (s *HashSet[T]) Union(other *HashSet[T]) *HashSet[T] {
    result := New[T]()
    for item := range s.m {
        result.Add(item)
    }
    for item := range other.m {
        result.Add(item)
    }
    return result
}

// Intersection returns a new set with elements in both sets.
// We iterate the smaller set and probe the larger one, so the cost is
// O(min(|s|, |other|)) rather than O(|s|). Probing is O(1) either way,
// so scanning the larger side would only add work that cannot match.
func (s *HashSet[T]) Intersection(other *HashSet[T]) *HashSet[T] {
    smaller, larger := s, other
    if len(other.m) < len(s.m) {
        smaller, larger = other, s
    }

    result := New[T]()
    for item := range smaller.m {
        if larger.Contains(item) {
            result.Add(item)
        }
    }
    return result
}

// Difference returns elements in s but not in other
func (s *HashSet[T]) Difference(other *HashSet[T]) *HashSet[T] {
    result := New[T]()
    for item := range s.m {
        if !other.Contains(item) {
            result.Add(item)
        }
    }
    return result
}

// IsSubset checks if s is a subset of other
func (s *HashSet[T]) IsSubset(other *HashSet[T]) bool {
    if len(s.m) > len(other.m) {
        return false // a bigger set cannot fit inside a smaller one
    }
    for item := range s.m {
        if !other.Contains(item) {
            return false
        }
    }
    return true
}
```

### Junior -> FAANG: Why `map[T]struct{}` and When to Use a Set

The empty struct `struct{}` occupies zero bytes, making `map[T]struct{}` the most memory-efficient way to represent a set in Go. Using `map[T]bool` works but wastes one byte per entry because the `bool` value is stored. For a set with millions of entries, the difference is measurable.

In interviews, hash sets appear in four recurring patterns: cycle detection (store visited nodes), deduplication (insert all, count unique), existence check (is this value in the collection), and set algebra for problems involving overlapping arrays. The Longest Consecutive Sequence problem (LC 128) is the canonical example of a set enabling an O(n) solution that would otherwise require O(n log n) sorting: load all numbers into a set, then only start counting from values with no left neighbor.

Know when to use a set versus a sorted slice: use a set when you only need O(1) membership testing and do not need ordering - use a sorted slice when you need range queries, min/max, or ordered iteration.

### Senior @ FAANG: Generic Set Design and Production Tradeoffs

The generic `HashSet[T comparable]` using type parameters is correct idiomatic Go 1.18+. At the senior level, the design review focuses on what is missing: thread safety, iteration stability under concurrent modification, and size-bounded variants.

For production use, any set that is shared across goroutines needs a mutex. The interface design question is whether to embed the mutex in the set itself (simpler for callers, but prevents callers from composing multiple set operations atomically) or to expose a lock-free read path via atomic snapshots (more complex, better for read-heavy workloads). The correct answer depends on the access pattern and must be documented explicitly in the API contract.

The `Intersection` implementation iterates the smaller set to keep the runtime proportional to `min(|A|, |B|)` rather than to the receiver's size. This is a common optimization that naive implementations miss, and it matters most in the lopsided case: intersecting a 10-element set against a million-element one should cost 10 probes, not a million. Note that this only works because membership probing is O(1) in both directions, so the choice of which side to scan is free. The decision belongs in a code comment explaining the asymptotic reasoning, because the next engineer to read it needs to know the swap is deliberate rather than arbitrary.

`IsSubset` gets a related but distinct fast path: a set with more elements than its candidate superset cannot possibly be a subset, so the length comparison rejects it in O(1) before any iteration. Cheap invariant checks that short-circuit the loop entirely are worth reaching for whenever the data structure already tracks the quantity you need.
