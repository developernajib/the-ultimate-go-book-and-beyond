export default `## 2.10 Forward Pointer: Type Assertions and Type Switches

This chapter introduced concrete types: structs, slices, maps, errors. Real Go programs also pass values around through **interface types** (covered in depth in Chapter 6). When a value travels as an interface, you sometimes need to ask "what is the concrete type underneath?" The answer is the **type assertion** and its sibling, the **type switch**.

You do not need to master these now. The goal of this section is so that the syntax is not a surprise the first time you see it in a real codebase.

### Type Assertion

A type assertion extracts a concrete value out of an interface.

\`\`\`go
var x any = "hello"

s := x.(string)        // panics if x is not a string
s, ok := x.(string)    // ok=false instead of panic
\`\`\`

The two-value form is almost always the safer choice. The single-value form is appropriate only when the type is guaranteed by an upstream invariant (e.g., you just stored a \`string\` and are pulling it back out).

You will see this most often when handling \`error\`:

\`\`\`go
var err error = doWork()
if pe, ok := err.(*os.PathError); ok {
    fmt.Println("path was:", pe.Path)
}
\`\`\`

Note that the modern idiom is \`errors.As\`, which walks wrapped errors automatically:

\`\`\`go
var pe *os.PathError
if errors.As(err, &pe) {
    fmt.Println("path was:", pe.Path)
}
\`\`\`

\`errors.As\` is preferred for \`error\` values because errors are often wrapped (\`fmt.Errorf("...: %w", err)\`), and a plain type assertion only inspects the outermost error.

### Type Switch

A type switch is a \`switch\` statement that dispatches on the concrete type of an interface value:

\`\`\`go
func describe(v any) string {
    switch t := v.(type) {
    case nil:
        return "nil"
    case int:
        return fmt.Sprintf("int: %d", t)
    case string:
        return fmt.Sprintf("string of length %d", len(t))
    case []byte:
        return fmt.Sprintf("byte slice of length %d", len(t))
    case fmt.Stringer:
        return "Stringer: " + t.String()
    default:
        return fmt.Sprintf("unknown: %T", v)
    }
}
\`\`\`

Three things to notice:

1. The form \`t := v.(type)\` is a **special syntax** that is only legal in the \`switch\` header. It binds \`t\` to the typed value inside each \`case\`.
2. Cases can be concrete types (\`int\`, \`*MyType\`), interface types (\`fmt.Stringer\`), or \`nil\`.
3. There is no fallthrough. Each case is independent, just like a regular \`switch\`.

Type switches are how you handle a small, closed set of possible types, parsing a JSON-like value, walking an AST, dispatching on a message-bus envelope.

### When to Use Which

- **One concrete type expected, with a fallback?** Use a two-value type assertion.
- **A handful of possible types, each handled differently?** Use a type switch.
- **Many types and growing?** That is a sign you should be using polymorphism through an interface method, not type-switching at all.

The last case is the senior-track instinct. A type switch over your own types is often a missed abstraction, the open-closed principle says you should be able to add a new type without modifying the switch.

### Where This Is Covered in Depth

- **Chapter 6 (Interfaces)** introduces interfaces from scratch and covers type assertions, type switches, and the empty interface (\`any\`) in detail.
- **Chapter 9 (Error Handling)** covers \`errors.Is\`, \`errors.As\`, and how they relate to type assertions on errors.
- **Chapter 7c (Reflection deep-dive)** covers the runtime machinery that makes type assertions work, including the cost (a single pointer comparison for concrete types, a method-set check for interface types).

### Migration Lens

- **From Java:** A type assertion is \`instanceof\` plus a cast, in one expression. The two-value form is the safe equivalent.
- **From C#:** Equivalent to the \`is\` pattern with cast (\`if (x is string s)\`).
- **From Rust:** A type switch is the closest analog to \`match\` on an enum, but it is open (any new type can show up at runtime), not exhaustive.
- **From Python:** Equivalent to \`isinstance\` chains, but the type switch is checked at compile time for case syntax and at runtime for the actual type.
`;
