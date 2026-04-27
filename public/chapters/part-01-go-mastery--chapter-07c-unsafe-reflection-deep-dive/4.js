export default `## 7C.3 reflect Performance, When to Cache, When to Avoid

Reflection has real costs. Every \`reflect.ValueOf()\` call boxes the value into an interface, which allocates on the heap. Field lookup by name (\`FieldByName\`) performs a linear scan of the struct's fields. Together, these costs make naive reflection 10-100x slower than direct field access. The benchmark below quantifies the difference and shows the most effective optimization: caching \`reflect.Type\` and field indices at startup, so the hot path only pays for the interface boxing.

\`\`\`go
package main

import (
    "fmt"
    "reflect"
    "testing"
)

type Data struct {
    Name  string
    Value int
}

// Direct access: ~1ns
func DirectAccess(d Data) string {
    return d.Name
}

// Reflect access: ~50-100ns (50-100x slower)
func ReflectAccess(d any) string {
    rv := reflect.ValueOf(d)
    return rv.FieldByName("Name").String()
}

// OPTIMIZATION: Cache reflect.Type and field indices at startup
var (
    dataType       = reflect.TypeOf(Data{})
    nameFieldIndex int
)

func init() {
    f, ok := dataType.FieldByName("Name")
    if !ok {
        panic("field Name not found")
    }
    nameFieldIndex = f.Index[0]
}

// Cached reflect access: ~10-20ns
func CachedReflectAccess(d any) string {
    rv := reflect.ValueOf(d)
    return rv.Field(nameFieldIndex).String()
}

// FURTHER OPTIMIZATION: Use unsafe pointer arithmetic (for library code only)
// See StringToBytes pattern - avoids boxing entirely

func BenchmarkComparison(b *testing.B) {
    d := Data{Name: "test", Value: 42}

    b.Run("Direct", func(b *testing.B) {
        for range b.N {
            _ = DirectAccess(d)
        }
    })

    b.Run("Reflect", func(b *testing.B) {
        for range b.N {
            _ = ReflectAccess(d)
        }
    })

    b.Run("CachedReflect", func(b *testing.B) {
        for range b.N {
            _ = CachedReflectAccess(d)
        }
    })
}

func main() {
    fmt.Println("Run benchmarks with: go test -bench=. -benchmem")
    // Direct: ~1-2 ns/op, 0 allocs
    // Reflect: ~50-80 ns/op, 1 alloc/op
    // CachedReflect: ~15-25 ns/op, 1 alloc/op (still allocs for interface boxing)
}
\`\`\`

### When to Use reflect vs Alternatives

The deciding factor is whether the type set is known at compile time. If you know all the types upfront, code generation (sqlc, mockgen, Wire) gives you zero-reflection performance with full type safety. Generics handle cases where the operation is the same across types but the type itself varies. Reflection is the right tool when the type set is open-ended or only known at runtime, serialization libraries, config loaders, and dependency injection containers are classic examples. The following matrix summarizes common use cases and their best-fit approach.

\`\`\`
┌────────────────────────────────────────────────────────────────────────┐
│              reflect vs Alternatives Decision Matrix                   │
├─────────────────────┬──────────────────────────────────────────────────┤
│  Use Case           │  Best Approach                                   │
├─────────────────────┼──────────────────────────────────────────────────┤
│ JSON serialization  │ encoding/json (uses reflect internally, cached)  │
│ Type-safe SQL       │ sqlc (code generation - zero reflect at runtime) │
│ Validation          │ reflect in init, cache indices for hot paths     │
│ Deep copy           │ reflect.DeepCopy helper or code gen              │
│ Dependency inject.  │ Google Wire (code generation) or manual          │
│ Mock generation     │ mockgen (code generation - zero reflect)         │
│ Dynamic config load │ reflect once at startup, then direct access      │
│ Test comparison     │ reflect.DeepEqual (tests, not hot paths)         │
│ Plugin loading      │ plugin package or shared interfaces              │
│ Hot path (>1M/s)    │ Generate code or use unsafe (library code only)  │
└─────────────────────┴──────────────────────────────────────────────────┘
\`\`\`

### The Cache-Once Pattern

For a senior engineer writing reflection-heavy code, the canonical pattern is:

1. At package init or lazily at first call, do the reflection (walk the struct, collect field indices, build a dispatch table).
2. Cache the result in a map keyed by \`reflect.Type\`.
3. In hot paths, look up the cached result and operate on it directly.

This collapses the per-call reflection cost to a single map lookup plus the direct operation. \`encoding/json\` does this internally. Your reflection-heavy code should too.

### Migration Path: From Reflection to Generics

For a team with existing reflection-based code, the migration path:

1. Identify types where the set is known at compile time. Replace with generic helpers.
2. Identify types where the set is open but the operations are uniform. Replace with interface-based helpers.
3. Keep reflection for genuinely dynamic cases (JSON, validation against arbitrary structs).

The migration pays off in measurable performance and in type-checker-caught bugs. The cost is the refactor effort, which compounds downward over the codebase's life.

---
`;
