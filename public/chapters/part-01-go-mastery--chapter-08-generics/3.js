export default `## 8.2 Type Parameters

### Basic Syntax

Type parameters are declared in square brackets after the function or type name, followed by a constraint that bounds the set of types the parameter may be instantiated with.

\`\`\`go
// Generic function
func FunctionName[T Constraint](param T) T {
    // T is available as a type within the function
    var zero T  // Zero value of T
    return zero
}

// Generic type
type TypeName[T Constraint] struct {
    field T
}

// Generic interface
type Container[T any] interface {
    Get() T
    Set(T)
}
\`\`\`

### Multiple Type Parameters

Functions and types may declare multiple independent type parameters, each with its own constraint. This enables generic functions that operate on pairs of potentially different types, such as key-value conversions.

\`\`\`go
// Map transforms a slice using a function
func Map[T, U any](slice []T, fn func(T) U) []U {
    result := make([]U, len(slice))
    for i, v := range slice {
        result[i] = fn(v)
    }
    return result
}

// Usage
numbers := []int{1, 2, 3, 4, 5}
strings := Map(numbers, func(n int) string {
    return fmt.Sprintf("number-%d", n)
})
// strings = ["number-1", "number-2", "number-3", "number-4", "number-5"]

// Convert users to their IDs
type User struct {
    ID   int
    Name string
}
users := []User{{1, "Alice"}, {2, "Bob"}}
ids := Map(users, func(u User) int { return u.ID })
// ids = [1, 2]
\`\`\`

### Type Inference

The compiler can often deduce type arguments from the values you pass, so you rarely need to write them explicitly. When inference succeeds, generic call sites look identical to non-generic ones. When it fails, you supply the type arguments in square brackets at the call site.

\`\`\`go
func Identity[T any](x T) T {
    return x
}

// Explicit type argument (sometimes necessary)
result := Identity[int](42)

// Inferred type argument (preferred when possible)
result := Identity(42)  // T inferred as int

// Inference from multiple arguments
func Pair[T, U any](t T, u U) struct{ First T; Second U } {
    return struct{ First T; Second U }{t, u}
}
p := Pair(42, "hello")  // T=int, U=string inferred
\`\`\`

Inference works from:
- Function arguments (most common)
- Multiple arguments constraining same type parameter
- Constraint type inference (inferring one type parameter from another's constraint)

### Type Parameter Naming Conventions

The Go community follows naming conventions similar to those in Java and C# generics, but with a preference for brevity. Single uppercase letters work for simple cases. Descriptive PascalCase names are better when a function has multiple type parameters whose roles are not obvious from context.

\`\`\`go
// Single letter for simple, well-understood cases
func Filter[T any](s []T, pred func(T) bool) []T
func Keys[K comparable, V any](m map[K]V) []K
func Reduce[T, U any](s []T, init U, fn func(U, T) U) U

// Common single-letter meanings:
// T - Type (general)
// K - Key
// V - Value
// E - Element
// S - Slice
// M - Map
// N - Number
// R - Result

// Descriptive names for complex scenarios
func Transform[Input, Output any](in Input, fn func(Input) Output) Output
func Cache[Key comparable, Value any](size int) *LRUCache[Key, Value]

// Google's style guide recommends:
// - Single capital letter for simple generics
// - PascalCase descriptive names for complex or domain-specific generics
\`\`\`

### Type Parameter Naming Discipline

For a senior engineer reviewing PRs:

1. **Reject \`I\`, \`J\`, \`O\` type parameters.** They clash with array index variables and reduce readability.
2. **Accept \`T\`, \`K\`, \`V\`** as conventions: \`T\` for a generic type, \`K\` and \`V\` for map-style key and value.
3. **Require descriptive names for public APIs.** \`Transform[Input, Output any]\` reads better than \`Transform[T, U any]\` in documentation.

---
`;
