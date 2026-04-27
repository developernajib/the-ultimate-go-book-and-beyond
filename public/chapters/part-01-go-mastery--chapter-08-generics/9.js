export default `## 8.8 Performance Considerations

### Generics vs Interface{} vs Code Generation

The performance of generics relative to \`interface{}\` and code generation depends on whether the compiler monomorphizes type parameters into separate function bodies. The following benchmark measures the practical difference.

\`\`\`go
// Benchmark comparison
package benchmark

import (
    "testing"
)

// Generic version
func SumGeneric[T ~int | ~float64](s []T) T {
    var sum T
    for _, v := range s {
        sum += v
    }
    return sum
}

// Interface version (pre-generics approach)
func SumInterface(s []any) any {
    switch s[0].(type) {
    case int:
        sum := 0
        for _, v := range s {
            sum += v.(int)
        }
        return sum
    case float64:
        sum := 0.0
        for _, v := range s {
            sum += v.(float64)
        }
        return sum
    }
    return nil
}

// Type-specific version (code generation approach)
func SumInt(s []int) int {
    sum := 0
    for _, v := range s {
        sum += v
    }
    return sum
}

func BenchmarkSumGeneric(b *testing.B) {
    data := make([]int, 10000)
    for i := range data {
        data[i] = i
    }

    b.ResetTimer()
    for b.Loop() {
        SumGeneric(data)
    }
}

func BenchmarkSumInterface(b *testing.B) {
    data := make([]any, 10000)
    for i := range data {
        data[i] = i
    }

    b.ResetTimer()
    for b.Loop() {
        SumInterface(data)
    }
}

func BenchmarkSumTypeSpecific(b *testing.B) {
    data := make([]int, 10000)
    for i := range data {
        data[i] = i
    }

    b.ResetTimer()
    for b.Loop() {
        SumInt(data)
    }
}

// Typical results:
// BenchmarkSumGeneric-8        1000000    1050 ns/op    0 B/op    0 allocs/op
// BenchmarkSumInterface-8       200000    8500 ns/op    0 B/op    0 allocs/op
// BenchmarkSumTypeSpecific-8   1000000    1048 ns/op    0 B/op    0 allocs/op
//
// Key insight: for primitive value types like int, generics match
// type-specific code because the compiler can stencil a specialized
// body. For method calls through a type parameter, dictionary dispatch
// adds a small per-call cost; see GC-shape stenciling below.
\`\`\`

### GCShape Stenciling

Go does not fully monomorphize generics the way C++ templates do. Instead, the compiler groups types by their "GC shape", a classification based on size and pointer layout. All pointer types share the same GC shape, so \`Stack[*User]\`, \`Stack[*Order]\`, and \`Stack[*Product]\` compile to one function body that uses a runtime dictionary for type-specific operations. Value types with different sizes or layouts get separate implementations. This is a middle ground: less binary bloat than C++ full monomorphization, better performance than Java's type erasure.

\`\`\`go
// These share the same implementation (same GC shape):
Stack[*User]
Stack[*Order]
Stack[*Product]

// These may have separate implementations:
Stack[int]
Stack[string]
Stack[float64]
\`\`\`

### Binary Size Impact

Generics may increase binary size when the compiler monomorphizes type parameters into separate function bodies. The following analysis measures the size impact for common generic patterns.

\`\`\`bash
# Generics can increase binary size due to monomorphization
# Measure with:
go build -o myapp
ls -la myapp

# Compare generic vs interface versions:
# Generic: More code generated per type instantiation
# Interface: Single implementation, runtime dispatch
\`\`\`

### When Generics Are Slower

When the compiler cannot determine the concrete type at compile time, it uses dictionary-based dispatch instead of direct calls. This prevents inlining and adds a small overhead per call. The difference is negligible for most code, but on tight loops processing millions of elements it can matter. If benchmarks show a measurable gap on a hot path, consider a type-specific fast path with a generic fallback.

\`\`\`go
// Case: Generic with constraint checking at runtime
type Number interface {
    ~int | ~int64 | ~float64
}

// If the constraint includes many types and the compiler can't
// determine the type at compile time, there may be some overhead

// Best practice: Use specific constraints when possible
type IntOnly interface { ~int }  // Better than Number if only int is used
\`\`\`

### GCShape Stenciling in One Sentence

Go does not produce one compiled copy per type (C++ style) or one erased copy (Java style). It produces one copy per "GC shape" (roughly, one per distinct pointer layout). The implications: two instantiations with different GC shapes produce separate code and separate inlining decisions. Two instantiations with the same GC shape share code and pay a small dictionary-lookup cost. Benchmark if hot.

---
`;
