export default `## 6.2 Empty Interface

The empty interface \`interface{}\` (or \`any\` since Go 1.18) accepts any value.

### When to Use

The empty interface (\`any\`) has legitimate uses, but overuse leads to type-unsafe code that pushes errors to runtime. Understanding the appropriate contexts prevents common design mistakes.

\`\`\`go
func printAnything(v any) {
    fmt.Printf("Type: %T, Value: %v\\n", v, v)
}

printAnything(42)
printAnything("hello")
printAnything([]int{1, 2, 3})
\`\`\`

Common uses:
- Generic containers (before Go 1.18 generics)
- JSON parsing (\`map[string]any\`)
- Variadic functions (\`fmt.Printf\`)
- Reflection

### Type Assertions

When a value is stored as \`any\`, you need a type assertion to recover the original type. The two-value form (\`value, ok\`) is safe and returns \`false\` on mismatch, while the single-value form panics if the type is wrong.

\`\`\`go
var v any = "hello"

// Unsafe: panics if wrong type
s := v.(string)

// Safe: returns ok=false if wrong type
s, ok := v.(string)
if ok {
    fmt.Println("String:", s)
}
\`\`\`

### Type Switches

A type switch branches on the concrete type stored inside an interface value. Each \`case\` binds the asserted type to the switch variable, giving you type-safe access without separate assertions.

\`\`\`go
func describe(v any) string {
    switch x := v.(type) {
    case nil:
        return "nil"
    case int:
        return fmt.Sprintf("int %d", x)
    case string:
        return fmt.Sprintf("string %q", x)
    case bool:
        return fmt.Sprintf("bool %t", x)
    case []int:
        return fmt.Sprintf("[]int len=%d", len(x))
    default:
        return fmt.Sprintf("unknown %T", x)
    }
}
\`\`\`

### Uber's Type Assertion Patterns

Uber's style guide recommends specific patterns for type assertions:

\`\`\`go
// Pattern 1: Assert and use immediately
func handleMessage(msg any) error {
    switch m := msg.(type) {
    case *CreateOrder:
        return s.createOrder(m)
    case *UpdateOrder:
        return s.updateOrder(m)
    case *DeleteOrder:
        return s.deleteOrder(m)
    default:
        return fmt.Errorf("unknown message type: %T", msg)
    }
}

// Pattern 2: Comma-ok idiom for optional behavior
func maybeFlush(w io.Writer) error {
    if f, ok := w.(interface{ Flush() error }); ok {
        return f.Flush()
    }
    return nil // Writer doesn't support flushing
}

// Pattern 3: Interface extension checking
type Validator interface {
    Validate() error
}

func process(data any) error {
    // Check if data implements optional Validator
    if v, ok := data.(Validator); ok {
        if err := v.Validate(); err != nil {
            return fmt.Errorf("validation failed: %w", err)
        }
    }
    // Continue processing...
    return nil
}
\`\`\`

### Migrating from interface{} to any (Go 1.18+)

Since Go 1.18, \`any\` is a built-in alias for \`interface{}\`. They are **identical** - same type, same behavior, same performance. The compiler treats them as interchangeable.

\`\`\`go
// These are exactly equivalent
var x interface{} = 42
var y any = 42
fmt.Println(x == y) // true
\`\`\`

**Why prefer \`any\`:**
- Shorter, more readable: \`map[string]any\` vs \`map[string]interface{}\`
- Consistent with other languages' naming conventions
- Signals intent: "I accept anything" is clearer as \`any\`
- The Go team uses \`any\` in all new standard library code

**Automated migration:**

\`\`\`bash
# Find all interface{} in your codebase
grep -rn 'interface{}' --include='*.go' .

# Use gofmt to automatically rewrite (Go 1.18+)
gofmt -w -r 'interface{} -> any' ./...

# Verify no functional changes
go build ./...
go test ./...
\`\`\`

**When \`interface{}\` is still required:**
- \`container/heap.Interface\` Push/Pop signatures (stdlib has not updated)
- Generated code from tools that emit \`interface{}\`
- Code that must compile with Go < 1.18

**When to avoid \`any\` entirely:**
- Use generics (\`[T comparable]\`, \`[T fmt.Stringer]\`) instead of \`any\` when you need specific behavior
- Use specific interfaces (\`io.Reader\`, \`error\`) when you need specific methods
- \`any\` should be a last resort, not a first choice

\`\`\`go
// AVOID: any when you need something specific
func Process(data any) { /* type switches everywhere */ }

// PREFER: constrained generic or interface
func Process[T encoding.BinaryMarshaler](data T) { /* type-safe */ }
func Process(data io.Reader) { /* focused interface */ }
\`\`\`

**Key point:** Migrating \`interface{}\` to \`any\` is purely cosmetic, it changes zero runtime behavior. But using generics or specific interfaces to *replace* \`any\` parameters improves type safety.

### Avoid Empty Interface Abuse

Empty interfaces lose type safety. Prefer specific interfaces or generics:

\`\`\`go
// Bad: loses type information
func Process(items []any) {
    for _, item := range items {
        s, ok := item.(string)
        if !ok {
            continue
        }
        // use s
    }
}

// Good: type-safe with generics
func Process[T any](items []T, fn func(T)) {
    for _, item := range items {
        fn(item)
    }
}
\`\`\`

### When \`any\` Is Legitimate

The legitimate uses of \`any\` in 2026 are narrow:

1. **At external API boundaries where the type is truly unknown.** \`json.Unmarshal\` takes \`any\` because it does not know the caller's destination type until runtime. This is correct. The caller passes a concrete type via pointer.
2. **Reflection-based libraries.** Libraries that inspect structure dynamically (ORMs, validators, serialisers) have legitimate reasons to accept \`any\` at their entry points. Internal code does not.
3. **Variadic formatting.** \`fmt.Printf\` and friends. This is the canonical use case that justifies the feature's existence.
4. **Error sentinel comparisons.** Not really. \`errors.Is\` takes \`error\`, not \`any\`.

For almost every other case in 2026, generics are the right answer. Pre-1.18 code that used \`any\` to simulate generics should be migrated.

### Code-Review Lens (Senior Track)

Three patterns to flag in PRs that use \`any\`:

1. **\`func F(x any)\` where every caller passes a string.** Replace with \`func F(x string)\`. The flexibility is not used and costs boxing.
2. **\`map[string]any\` for internal data flow.** Promote to a struct. The type system catches bugs the stringly-typed map hides.
3. **A generic helper that uses \`any\` as the type parameter everywhere.** The generic brings no type safety over the non-generic \`any\` version. Add constraints or drop the generic.

### Allocation Cost of \`any\`

Boxing a value into an \`any\` is not free. When you assign a value of a non-pointer type to \`any\`, the runtime must store the concrete type pointer and a data pointer. If the value is larger than a machine word or not already addressable, the compiler emits a heap allocation so the interface data pointer has something to reference. This is observable in pprof and in benchmark allocs-per-op.

\`\`\`go
func benchBox(b *testing.B) {
    var sink any
    for i := 0; i < b.N; i++ {
        sink = i // forces heap allocation of the int
    }
    _ = sink
}
\`\`\`

Small pointer-sized values (pointers, single-word integers on some versions of Go when the runtime caches the boxed form) may avoid the allocation, but the discipline is: do not rely on the optimization. On a hot path, measure. If the \`any\` appears in a tight loop, the heap allocations dominate everything else. Generics or concrete types are the fix. This is the kind of finding that gets surfaced in a staff-level performance review and it is almost always a decision made at design time, not discovered after shipping.

### Staff Lens: \`any\` Creep in Shared Packages

A platform team ships a helper that takes \`any\` "to stay flexible". Six months later, a hundred callers pass a hundred different concrete types, the function has grown a type switch with forty cases, and the team is blocked from tightening the type because the blast radius is unbounded. This is \`any\` creep. Prevent it at design time. If a shared helper's input cannot be expressed as a specific interface or a generic constraint, the helper is doing too much. Break it up. The staff-track instinct: when you see \`any\` in a public API of a platform package, treat it as a design smell that costs nothing to fix early and quarters to fix late.

---
`;
