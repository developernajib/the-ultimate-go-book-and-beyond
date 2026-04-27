export default `## Go 1.26: Self-Referential Generic Types

Go 1.26 (February 2026) lifted a long-standing restriction: a generic type can now reference itself in its own type parameter list. This enables patterns that were previously impossible.

### Before Go 1.26

Prior to Go 1.26, self-referential generic type constraints were not supported, requiring workarounds like additional type parameters to implement recursive data structures generically.

\`\`\`go
// COMPILE ERROR in Go ≤ 1.25:
type Adder[A Adder[A]] interface {  // self-reference was forbidden
    Add(A) A
}
\`\`\`

### After Go 1.26

Go 1.26 lifted the restriction on self-referential generic constraints, allowing types like \`type Node[T Node[T]]\` that model recursive data structures in a fully type-safe way.

\`\`\`go
// VALID in Go 1.26+
type Adder[A Adder[A]] interface {
    Add(A) A
}

// Pattern 1: Fluent builder that preserves concrete type
type Builder[B Builder[B]] interface {
    WithName(string) B
    WithTimeout(time.Duration) B
}

type RequestBuilder struct {
    name    string
    timeout time.Duration
}

func (r *RequestBuilder) WithName(n string) *RequestBuilder {
    r.name = n
    return r
}

func (r *RequestBuilder) WithTimeout(d time.Duration) *RequestBuilder {
    r.timeout = d
    return r
}

// Pattern 2: Custom ordered types for generic sorted containers
type Ranked[T Ranked[T]] interface {
    Score() float64
    Less(T) bool
}

// A generic sorted list that works with any self-ranked type
type RankedList[T Ranked[T]] struct {
    items []T
}

func (l *RankedList[T]) Insert(item T) {
    pos := sort.Search(len(l.items), func(i int) bool {
        return !l.items[i].Less(item)
    })
    l.items = append(l.items, item)
    copy(l.items[pos+1:], l.items[pos:])
    l.items[pos] = item
}

// Pattern 3: Mergeable data types
type Mergeable[M Mergeable[M]] interface {
    Merge(M) M
    IsZero() bool
}
\`\`\`

### When to Use Self-Referential Constraints

| Use Case | Self-Referential? | Example |
|----------|------------------|---------|
| Builder returning concrete type | Yes | \`Builder[B Builder[B]]\` |
| Custom comparable/ordered types | Yes | \`Ranked[T Ranked[T]]\` |
| Algebraic data type hierarchies | Yes | \`Mergeable[M Mergeable[M]]\` |
| Simple value transformations | No | \`func Map[T, U any]\` |
| Container with standard operations | No | \`[T comparable]\` |

Self-referential generics are a precision tool. Reach for them when you need the concrete type to flow through generic operations, not as a default pattern.

### Senior-Track Rule

Self-referential generics look powerful and should be approached with suspicion. Use them when the concrete type must flow through a generic chain (builders, custom ordering). Do not use them as a general-purpose "better generics" pattern. The code is harder to read and the benefit is narrow.

---
`;
