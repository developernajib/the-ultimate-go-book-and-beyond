export default `## 8.1 Why Generics?

Before generics, Go had three options for type-agnostic code, each with significant drawbacks:

### 1. Empty Interface (any)

\`[]int\` cannot be passed where \`[]any\` is expected, they are distinct types in Go's type system, so callers must manually copy values into a new \`[]any\`, incurring an allocation per element. Type assertions on retrieval push errors to runtime, making the API unsafe by construction.

\`\`\`go
func PrintSlice(s []any) {
    for _, v := range s {
        fmt.Println(v)
    }
}

// Problem: loses type safety and requires conversion
ints := []int{1, 2, 3}
PrintSlice(ints)  // Compile error! []int is not []any

// Must convert manually (creates allocation)
anys := make([]any, len(ints))
for i, v := range ints {
    anys[i] = v
}
PrintSlice(anys)

// Type assertion required on retrieval
func GetFirst(s []any) any {
    return s[0]
}
val := GetFirst(anys).(int)  // Runtime panic if wrong type!
\`\`\`

**Problems**:
- Type safety lost at compile time
- Runtime type assertions can panic
- Allocation overhead for interface boxing
- No IDE auto-completion for specific types

### 2. Code Generation

\`go generate\` with tools like \`genny\` produces separate files for each concrete type that must be committed to the repository. Any bug fix must be applied to every generated copy, and the generated code complicates diffs, code review, and editor navigation.

\`\`\`go
//go:generate genny -in=template.go -out=gen-int.go gen "T=int"
//go:generate genny -in=template.go -out=gen-string.go gen "T=string"

// template.go
func MapT(slice []T, fn func(T) T) []T {
    result := make([]T, len(slice))
    for i, v := range slice {
        result[i] = fn(v)
    }
    return result
}
\`\`\`

**Problems**:
- Requires external tools
- Generated code must be committed
- Build process complexity
- Code duplication in repository
- Harder to debug (generated code)

### 3. Copy-Paste

Writing \`MaxInt\`, \`MaxInt64\`, \`MaxFloat64\`, and \`MaxString\` separately means a logic fix in one must be propagated manually to every copy. Each duplicated function is an independent site for bugs to diverge, and the codebase grows proportionally to the number of types supported.

\`\`\`go
func MaxInt(a, b int) int {
    if a > b { return a }
    return b
}
func MaxInt64(a, b int64) int64 {
    if a > b { return a }
    return b
}
func MaxFloat64(a, b float64) float64 {
    if a > b { return a }
    return b
}
func MaxString(a, b string) string {
    if a > b { return a }
    return b
}
// ... repeat for every type
\`\`\`

**Problems**:
- Violates DRY principle
- Bug fixes must be applied to all copies
- Easy to make mistakes
- Code bloat

### The Generic Solution

Generic functions and types express algorithms that work correctly for multiple types with full compile-time type checking. The type parameter syntax captures the commonality without sacrificing safety.

\`\`\`go
import "cmp"

func Max[T cmp.Ordered](a, b T) T {
    if a > b {
        return a
    }
    return b
}

// One function works for all ordered types
Max(1, 2)           // Returns 2 (int)
Max(1.5, 2.5)       // Returns 2.5 (float64)
Max("apple", "banana")  // Returns "banana" (string)
Max(int64(100), int64(200))  // Returns 200 (int64)
\`\`\`

**Benefits**:
- **Type-safe**: Compile-time type checking
- **No duplication**: Single implementation
- **Near-zero runtime overhead**: GCShape stenciling (compiler generates specialized code per GC shape)
- **IDE support**: Full auto-completion and type inference
- **Readable**: Clear, single source of truth

### How Companies Use Generics

**Google**: Internal Go libraries at Google use generics for type-safe collections and protobuf message handling, replacing earlier \`interface{}\`-based APIs.

**Uber**: Uber's open-source \`uber-go\` repositories and internal platform libraries apply generics to retry mechanisms, typed configuration loading, and metrics collection.

**Netflix**: Netflix's Go services use generics in cache interfaces, middleware chains, and circuit breaker implementations to eliminate type assertions at call sites.

### The "Do You Actually Need Generics?" Test

For a senior engineer evaluating whether generics are the right tool:

1. Would the non-generic version require \`any\` everywhere? Yes means generics likely win.
2. Would the non-generic version require copy-paste for each type? Yes means generics likely win.
3. Would the non-generic version use an interface with a single method? Use the interface, not generics.
4. Would the non-generic version use an interface that would need faking for tests? Interface still wins.

Generics are not a replacement for interfaces. They solve a different problem (compile-time polymorphism with typed compile-time instantiation) than interfaces (runtime polymorphism with dynamic dispatch). Know which you need.

---
`;
