export default `## 5.1 Pointer Fundamentals

A pointer holds the memory address of a value. Unlike C/C++, Go's pointers are safe: no pointer arithmetic means no buffer overflows.

### Basic Syntax

Pointers in Go use two operators: \`&\` to take the address of a value and \`*\` to dereference a pointer. Unlike C, Go has no pointer arithmetic, making pointers safer while retaining their utility for sharing data.

\`\`\`go
var x int = 42
var p *int = &x  // p holds the address of x

fmt.Println(x)   // 42 (value)
fmt.Println(&x)  // 0xc0000140a0 (address)
fmt.Println(p)   // 0xc0000140a0 (same address)
fmt.Println(*p)  // 42 (value at address)

*p = 100         // Modify value through pointer
fmt.Println(x)   // 100
\`\`\`

### Operators

- \`&\` (address-of): Gets the memory address of a variable
- \`*\` (dereference): Gets the value at an address

\`\`\`go
name := "Alice"
ptr := &name      // &name is *string type
value := *ptr     // *ptr is string type
\`\`\`

### Zero Value

The zero value of a pointer is \`nil\`:

\`\`\`go
var p *int        // p is nil
fmt.Println(p)    // <nil>
// fmt.Println(*p) // Panic: nil pointer dereference
\`\`\`

Always check for nil before dereferencing:

\`\`\`go
if p != nil {
    fmt.Println(*p)
}
\`\`\`

### No Pointer Arithmetic

Unlike C/C++, Go doesn't allow pointer arithmetic:

\`\`\`go
arr := [3]int{1, 2, 3}
p := &arr[0]
// p++        // Compile error
// p + 1      // Compile error
\`\`\`

This eliminates an entire class of buffer overflow bugs. This design decision was intentional: the Go team at Google prioritized safety over the flexibility that pointer arithmetic provides.

### Pointer Comparison

Two pointers are equal if they point to the same memory address. Two pointers to different variables are not equal even if the values at those addresses are identical:

\`\`\`go
x := 42
p1 := &x
p2 := &x
p3 := new(int)
*p3 = 42

fmt.Println(p1 == p2)   // true (same address)
fmt.Println(p1 == p3)   // false (different addresses)
fmt.Println(*p1 == *p3) // true (same value)
\`\`\`

### Creating Pointers with new()

The \`new()\` function allocates zeroed memory for a given type and returns a pointer to it. For most types, the composite literal syntax (\`&T{}\`) is more common in practice, but \`new\` is useful when you need a zero-valued pointer without specifying fields:

\`\`\`go
// These are equivalent
p1 := new(int)
p2 := &struct{}{}

// new() returns zeroed memory
p := new(int)
fmt.Println(*p)  // 0

// Useful for types without composite literals
type Stats struct {
    Count int
    Total float64
}
s := new(Stats)  // &Stats{Count: 0, Total: 0.0}
\`\`\`

### Pointers to Pointers

Go supports multiple levels of indirection. A \`**int\` is a pointer to a pointer to an int. Each dereference follows one level of indirection:

\`\`\`go
x := 42
p := &x   // *int
pp := &p  // **int

fmt.Println(**pp)  // 42

**pp = 100
fmt.Println(x)  // 100
\`\`\`

While possible, double pointers are rare in idiomatic Go, prefer simpler designs.

### Why Go Has Pointers at All

Unlike languages that abstract pointers away (Python, Ruby, Java) or make them deeply unsafe (C, C++), Go's pointer model is calibrated for a specific engineering outcome: explicit shared mutation with compile-time safety. Three consequences of the design:

1. **No implicit sharing.** If you pass a value, the callee gets a copy and your original is untouched. If you pass a pointer, the callee can mutate through it. The decision is visible at the call site and at the function signature, which makes code review auditable in a way that reference-by-default languages (Java, Python) are not.
2. **No memory-safety hazards from pointer arithmetic.** The lack of arithmetic means a pointer cannot stray outside the object it points to. Every dereference is to a valid address (or nil). This eliminates the class of buffer-overflow bugs that has produced the majority of exploitable vulnerabilities in C and C++ code over decades.
3. **Cost transparency.** When you pass a pointer, you know it is cheap. When you pass a large value, you know it is copied. The cost is visible at the source level and the compiler's escape analysis makes the heap-vs-stack decision explicit if you ask (\`-gcflags=-m\`).

### Code-Review Lens (Senior Track)

Three patterns a staff reviewer flags in pointer-heavy PRs:

1. **A function that takes \`*T\` and never mutates.** The function is misleading. Pass \`T\` instead, unless the copy cost is measurable and documented.
2. **A function that returns \`*T\` where \`T\` would do.** If the type is small and the caller does not need mutation, the pointer return forces a heap allocation (escape) for no benefit. Return the value.
3. **\`new(T)\` where \`&T{}\` would be clearer.** \`new(T)\` gives you a zeroed \`*T\` and nothing else. \`&T{Field: value}\` gives you a constructed \`*T\` with initial state. Prefer the composite literal except when you literally want the zero value.

### Migration Lens

Coming from C, the lack of pointer arithmetic feels restrictive for the first week and the removed bug class makes up for it forever. Coming from Java, the explicit distinction between \`T\` and \`*T\` restores a level of control you did not know you were missing. Java's "everything is a reference except primitives" model hides the cost of sharing. Coming from Python or JavaScript, the pointer concept may be new, and the one-line answer is "Go objects are passed by value unless you explicitly pass a pointer". Coming from Rust, the absence of borrow checking is the biggest shift. Go gives you the performance of shared mutable state without the compile-time guarantees. The trade is ship velocity for compile-time rigor.

---
`;
