export default `# Interview Questions

These questions mirror patterns from FAANG and top-tier Go interviews. Work through them after reading the chapter.

### Q1: State the valid conversion rules for \`unsafe.Pointer\` and explain why they exist.

**What FAANG expects**: Recite the six patterns from the \`unsafe\` package docs and explain the GC and escape-analysis reasoning.

**Answer**: The \`unsafe.Pointer\` type has exactly six legal use patterns. Convert \`*T1\` to \`unsafe.Pointer\` and then to \`*T2\` for type punning. Convert \`unsafe.Pointer\` to \`uintptr\` and back to \`unsafe.Pointer\`, but only as part of an expression, never storing the \`uintptr\` in a variable that outlives the expression. Convert \`unsafe.Pointer\` to \`uintptr\` and back with arithmetic, again in a single expression. Pass a pointer to \`syscall.Syscall\` where the last argument is \`uintptr\`. Read a \`reflect.Value.Pointer\` or \`reflect.Value.UnsafeAddr\` result, converting the \`uintptr\` back immediately. Use \`reflect.SliceHeader\` and \`reflect.StringHeader\` only when constructed from a real slice or string, never as free-standing structs.

The rules exist because the garbage collector tracks \`unsafe.Pointer\` as a pointer but does not track \`uintptr\`. If you store a \`uintptr\` across a function call or yield point, the GC can collect or move the underlying object and your \`uintptr\` becomes a dangling integer. The single-expression rule keeps the conversion atomic from the compiler's view, so the pointer remains live.

As of Go 1.25, \`unsafe.Add\`, \`unsafe.Slice\`, \`unsafe.String\`, \`unsafe.StringData\`, and \`unsafe.SliceData\` are the preferred helpers. They encode the legal patterns in APIs the compiler and race detector understand. Reach for raw \`uintptr\` arithmetic only when those helpers do not cover your case.

**Follow-ups**:
- Why is \`reflect.SliceHeader\` deprecated in favor of \`unsafe.Slice\`?
- How does \`go vet\`'s \`unsafeptr\` check detect illegal \`uintptr\` conversions?

### Q2: What does "addressable" mean for a \`reflect.Value\`, and why do some \`Set\` calls panic?

**What FAANG expects**: Precise definition plus the canonical workaround using \`reflect.ValueOf(&x).Elem()\`.

**Answer**: A \`reflect.Value\` is addressable when it refers to a memory location the reflect package can take the address of. Values obtained from \`reflect.ValueOf(x)\` are not addressable because \`x\` was passed by value and the reflect package holds a copy. Values obtained by dereferencing a pointer with \`reflect.ValueOf(&x).Elem()\` are addressable because they refer to the original \`x\`. Fields of addressable structs are addressable, and elements of addressable arrays are addressable. Elements of maps are never addressable because map internals can move entries during growth.

\`Set\`, \`SetInt\`, \`SetString\`, and friends panic on non-addressable values because mutating a copy would be silently useless. The \`CanSet\` and \`CanAddr\` methods let you check first. \`CanSet\` also requires the value to be exported if it belongs to a struct, since reflection does not grant write access to unexported fields by design.

The canonical pattern for mutating via reflection:

\`\`\`go
type Config struct{ Port int }
c := Config{}
v := reflect.ValueOf(&c).Elem()
v.FieldByName("Port").SetInt(8080)
\`\`\`

Without the \`&c\` and \`.Elem()\`, the \`SetInt\` panics.

**Follow-ups**:
- How would you mutate an unexported field in tests, and why is that fragile?
- Why can you \`Set\` a slice element via reflection but not a map element?

### Q3: Describe Go's interface internals. Why is a nil-typed interface not equal to nil?

**What FAANG expects**: Two-word representation (\`itab\`, data) and the classic typed-nil bug.

**Answer**: An interface value is a two-word structure. For non-empty interfaces the first word is a pointer to an \`itab\`, which caches the interface type, the concrete type, and the method dispatch table. For empty interfaces (\`any\`) the first word is a \`*rtype\` describing the concrete type. The second word is a pointer to the underlying data, or the data itself if it fits in a word and the compiler chose direct representation.

An interface equals nil only when both words are nil. If the concrete type is set but the data pointer is nil, the interface is not nil. This produces the famous bug:

\`\`\`go
func load() error {
    var e *MyError
    if failed {
        e = &MyError{...}
    }
    return e
}

if load() != nil {
    // always true, even in the success case
}
\`\`\`

The return value carries the type \`*MyError\` in its first word even when the pointer is nil, so the interface comparison against untyped nil fails. The fix is to return \`nil\` explicitly as an untyped constant, or to track the error as an \`error\` variable throughout.

**Follow-ups**:
- How does the compiler decide whether to store data directly in the interface word or indirectly?
- What is an \`itab\`, how is it cached, and how does the runtime build one?

### Q4: Compare type assertion and type switch performance. When does each win?

**What FAANG expects**: Both compile to \`itab\` comparisons, plus awareness of branch density and the \`comma-ok\` form.

**Answer**: Type assertion \`v, ok := x.(T)\` compiles to a single \`itab\` pointer comparison for interface target types, or to a concrete type descriptor comparison for concrete target types. Cost is one load and one compare. A type switch compiles to a series of the same comparisons, with the compiler free to reorder cases, and for larger switches to a hash-based jump table similar to integer switches.

For one or two types, chained assertions are as fast as a type switch and sometimes faster because the compiler inlines more aggressively. For three or more types, the type switch wins because the compiler can build a jump structure and because the source is clearer. The single-type assertion without \`comma-ok\` is a trap in hot paths because a wrong type panics, and \`recover\` plus panic unwinding is far more expensive than the \`ok\` branch.

Measured cost on current hardware is a few nanoseconds per assertion when the \`itab\` is already in L1. Under contention or cold caches, the \`itab\` load dominates. Benchmark before optimizing. Caching a resolved concrete pointer outside the hot loop is the usual win when profiling flags assertion overhead.

**Follow-ups**:
- Why can a type switch on an interface type be slower than on concrete types?
- How does the compiler optimize \`switch x.(type) { case nil: ... }\`?

### Q5: What are the main performance pitfalls of \`reflect\`, and how do you mitigate them?

**What FAANG expects**: Allocation per call, lookup cost, and the \`reflect.Type\` caching strategy.

**Answer**: Reflection is slow for three reasons. First, most \`reflect.Value\` operations box values into \`interface{}\`, which allocates when the value does not fit in a word or is not already an interface. Second, method and field lookups by name walk the type's method or field list on every call unless you cache the \`reflect.StructField\` or \`reflect.Method\` up front. Third, \`reflect.Call\` copies arguments into an \`[]Value\` and pays a runtime type check per argument.

Mitigation follows a clear hierarchy. Prefer code generation or generics when the set of types is bounded at compile time. \`encoding/json\` and \`encoding/gob\` both added reflection-cache layers because the naive approach was too slow for production. If reflection is required, resolve and cache \`reflect.Type\`, field indices, and method indices once per type, keyed by \`reflect.Type\` in a \`sync.Map\`. Use \`FieldByIndex\` with a precomputed \`[]int\` instead of \`FieldByName\` in loops.

On Go 1.25, the compiler and runtime have improved reflect performance further, but the order of magnitude gap versus direct calls remains. Hot paths that process millions of values per second should use generated code or the \`unsafe\`-based approaches from high-performance JSON libraries like \`sonic\` and \`go-json\`.

**Follow-ups**:
- Show how you would cache field offsets for a reflection-based decoder.
- When would generics be a bad substitute for reflection?

### Q6 (Senior track): When would you approve a PR that uses \`unsafe\`?

**What FAANG expects**: a concrete rule. Not "never" and not "when the engineer says it is faster".

**Answer**: Three criteria, all required:

1. The use case is one of the blessed patterns (zero-copy string/bytes, typed atomic operations, cgo integration).
2. A benchmark demonstrates measurable improvement over the safe alternative.
3. The PR includes a test that exercises the boundary conditions of the \`unsafe\` use.

If any of the three is missing, the PR gets rejected or sent back for revision. The reviewer's job is to protect the codebase from \`unsafe\` that "works for now" but will surface as a subtle bug later.

### Q7 (Senior track): Your team has reflection-heavy code in a hot path. How do you evaluate the replacement?

**What FAANG expects**: a structured decision, not an absolute answer.

**Answer**: Three paths, depending on the profile:

1. **Generate code.** If the type set is known (say, all types that implement an interface in a specific package), write a code generator that produces the direct-access version. Replaces reflection entirely.
2. **Generics.** If the operation is uniform across types but the types vary per call site, generics produce the same code at zero runtime cost.
3. **Cache the reflection.** If the type set is genuinely unbounded and the operation is not trivially expressible in generics, cache the \`reflect.Type\` lookup at init and hot-path directly from the cache.

The decision tree is cost-driven. Generate code when the maintenance burden of the generator is less than the reflection overhead. Use generics when they express the operation cleanly. Cache when neither fits.
`;
