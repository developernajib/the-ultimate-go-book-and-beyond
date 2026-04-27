export default `## 4.3 Arrays

Arrays are fixed-size, value types. They're rarely used directly. Slices are more common.

### Array Basics

An array's size is part of its type: \`[5]int\` and \`[10]int\` are different types that cannot be assigned to each other. Arrays can be declared with an explicit size, with \`[...]\` to infer the size from the literal, or with sparse initialization that sets specific indices.

\`\`\`go
// Declaration
var arr [5]int                    // [0, 0, 0, 0, 0]
arr := [5]int{1, 2, 3, 4, 5}     // Literal
arr := [...]int{1, 2, 3, 4, 5}   // Size inferred
arr := [5]int{0: 1, 4: 5}        // Sparse: [1, 0, 0, 0, 5]

// Access
arr[0] = 10
x := arr[0]

// Length (compile-time constant)
len(arr)  // 5
\`\`\`

### Value Semantics

Unlike slices, arrays are values. Assigning one array to another copies every element. Passing an array to a function copies it entirely. This value-copy behavior makes arrays safe from unintended mutation, but expensive for large sizes.

\`\`\`go
a := [3]int{1, 2, 3}
b := a         // Copy, not reference
b[0] = 100
fmt.Println(a) // [1, 2, 3] - unchanged
fmt.Println(b) // [100, 2, 3]
\`\`\`

This means passing arrays to functions copies them:

\`\`\`go
func modify(arr [1000]int) {
    arr[0] = 999  // Modifies copy
}

var arr [1000]int
modify(arr)
// arr[0] is still 0
\`\`\`

For large arrays, pass a pointer:

\`\`\`go
func modify(arr *[1000]int) {
    arr[0] = 999  // Modifies original
}
\`\`\`

### When to Use Arrays

Arrays are appropriate when:
- Size is fixed and known at compile time
- You need a map key (arrays are comparable, slices aren't)
- You want value semantics (copying is desired)
- Working with low-level code or specific memory layouts

\`\`\`go
// Array as map key
type Point [2]int
visited := make(map[Point]bool)
visited[Point{1, 2}] = true

// Array as IPv4 address
type IPv4 [4]byte
ip := IPv4{192, 168, 1, 1}

// SHA-256 hash (always 32 bytes)
type SHA256 [32]byte
\`\`\`

### How Google Uses Arrays in Protocol Buffers

Protocol Buffers uses fixed-size arrays for wire encoding:

\`\`\`go
// Varint encoding uses array for temporary storage
func encodeVarint(x uint64) []byte {
    var buf [10]byte  // Max 10 bytes for uint64 varint
    n := binary.PutUvarint(buf[:], x)
    return buf[:n]
}
\`\`\`

### Why Arrays Are Not "Just Slices With Fixed Size"

The size-is-part-of-the-type rule makes arrays serve a specific role that slices cannot fill. Three senior-track uses that recur in production Go:

1. **Stack-allocated scratch buffers.** A \`var buf [4096]byte\` lives on the stack (unless the escape analyser disagrees). A \`buf := make([]byte, 4096)\` almost always heap-allocates. For hot paths that read a few KB at a time, the array variant avoids the allocator entirely. The \`n := io.ReadFull(r, buf[:])\` pattern is idiomatic here.
2. **Comparable composites.** Arrays with comparable element types are comparable, which means they can be map keys. Slices cannot be. A struct that contains an array field is still comparable. A struct that contains a slice field is not. If you need struct equality or want to use the struct as a map key, an array field is one of the rare cases where the fixed-size constraint is a feature.
3. **Fixed-layout wire formats.** Network protocol headers, hash outputs (\`[32]byte\` for SHA-256), IP addresses (\`[4]byte\` for v4, \`[16]byte\` for v6), MAC addresses, crypto keys. The fixed size is the protocol, and encoding it as an array makes the contract visible in the type system.

### Escape Analysis and Array Size

A sufficiently large array escapes to the heap even when declared on the stack, because the stack has a bounded size (typically starts at 8KB and grows). The threshold is not fixed and depends on the goroutine's stack state. For production services that use array scratch buffers, verify with \`go build -gcflags=-m\` that the array does not escape. If it does, either reduce the size or use \`sync.Pool\` to reuse a single allocation. A \`[65536]byte\` on the stack is usually fine. A \`[1048576]byte\` almost always escapes.

### Code-Review Lens (Senior Track)

Three patterns a staff reviewer flags in array code:

1. **An array passed by value to a function.** If the array is more than a few KB, the function call copies it. This is almost always wrong. Pass \`*[N]T\` or convert to a slice \`arr[:]\` at the call site.
2. **An array literal where a slice is idiomatic.** \`[10]int{1, 2, 3, 4, 5, 6, 7, 8, 9, 10}\` is rarely the right type. Use \`[]int{...}\` unless the fixed size has domain meaning.
3. **An array type in a public API surface where the caller has to match the size exactly.** \`func Encode(out [16]byte)\` forces every caller to have exactly a \`[16]byte\`. \`func Encode(out []byte) int\` with a length check is almost always a better API.

### Migration Lens

Coming from C, Go's array is the same shape as C's, but with bounds checking and value semantics. Passing a C array decays to a pointer. Passing a Go array copies. Coming from Java, there is no direct analogue because Java's arrays are reference types backed by objects. The closest Go equivalent is a slice, not an array. Coming from Rust, Go arrays are close to Rust's \`[T; N]\`, with the main difference that Go arrays can be copied implicitly and Rust requires \`Copy\` derivation. Coming from Python or JavaScript, there is no native fixed-size array, and the Go array is used in places where those languages would use tuples or typed buffer classes.

---
`;
