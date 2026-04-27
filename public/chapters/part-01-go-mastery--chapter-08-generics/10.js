export default `## 8.9 Common Mistakes

### 1. Overusing Generics

When a function only calls methods defined on an interface, using a type parameter adds instantiation overhead with no benefit. An interface parameter is simpler, readable, and sufficient. Reach for generics only when you need to preserve the concrete type or operate on multiple related types simultaneously.

\`\`\`go
// BAD: Generic where interface suffices
func ProcessLogger[T Logger](l T) {
    l.Log("processing")
}

// GOOD: Interface is simpler and clearer
func ProcessLogger(l Logger) {
    l.Log("processing")
}

// BAD: Generic for single type
func ProcessUsers[T User](users []T) { ... }

// GOOD: Just use the type
func ProcessUsers(users []User) { ... }
\`\`\`

### 2. Wrong Constraint

The \`any\` constraint only guarantees the type exists. It does not permit the \`==\` operator. Using \`comparable\` tells the compiler the type supports equality, making the check type-safe at compile time rather than producing a cryptic constraint violation error.

\`\`\`go
// BAD: Using any when comparable is needed
func Contains[T any](slice []T, target T) bool {
    for _, v := range slice {
        if v == target {  // Compile error! any doesn't support ==
            return true
        }
    }
    return false
}

// GOOD: Use comparable
func Contains[T comparable](slice []T, target T) bool {
    for _, v := range slice {
        if v == target {  // Works!
            return true
        }
    }
    return false
}
\`\`\`

### 3. Forgetting Zero Values

When no element satisfies the predicate, a generic function cannot return a meaningful \`T\` without an explicit zero-value declaration. Declaring \`var zero T\` and pairing the return with a boolean \`ok\` gives callers a safe way to distinguish "found" from "not found" without introducing a second error path.

\`\`\`go
// BAD: Returning uninitialized variable on error
func Find[T any](slice []T, pred func(T) bool) T {
    for _, v := range slice {
        if pred(v) {
            return v
        }
    }
    // What to return here? Uninitialized T!
}

// GOOD: Return zero value with ok pattern
func Find[T any](slice []T, pred func(T) bool) (T, bool) {
    for _, v := range slice {
        if pred(v) {
            return v, true
        }
    }
    var zero T
    return zero, false
}
\`\`\`

### 4. Method Type Parameter Confusion

Go methods cannot introduce their own type parameters beyond those of the receiver's type. A method that needs to convert \`Container[T]\` to a different type \`U\` must be expressed as a standalone generic function, which is also more composable and avoids receiver ambiguity.

\`\`\`go
// BAD: Trying to add type parameters to methods
type Container[T any] struct {
    value T
}

// This doesn't work - methods can't have their own type parameters
// func (c *Container[T]) Transform[U any](fn func(T) U) U { }

// GOOD: Use a function instead
func Transform[T, U any](c *Container[T], fn func(T) U) U {
    return fn(c.value)
}
\`\`\`

### 5. Inefficient Constraint Unions

Manually listing every numeric and string type in a constraint union is error-prone and easy to extend incorrectly. The standard library's \`cmp.Ordered\` constraint already covers all ordered types and is maintained alongside the language, making custom unions redundant for common cases.

\`\`\`go
// BAD: Overly broad constraint
type TooGeneric interface {
    ~int | ~int8 | ~int16 | ~int32 | ~int64 |
    ~uint | ~uint8 | ~uint16 | ~uint32 | ~uint64 |
    ~float32 | ~float64 | ~complex64 | ~complex128 |
    ~string
}

// GOOD: Use standard library constraints
import "cmp"
type BetterConstraint = cmp.Ordered
\`\`\`

### Senior-Track Detection

Each mistake here has a code-review detection path:

1. **Generics where an interface suffices.** Ask "what does this type parameter buy us that an interface would not?". Usually the answer is "nothing".
2. **Deeply nested type parameters.** \`Process[A any, B any, C any, D any](...)\` reads badly. Promote to a struct parameter.
3. **Custom constraints duplicating standard ones.** \`grep\` for \`cmp.Ordered\` and replace.

---
`;
