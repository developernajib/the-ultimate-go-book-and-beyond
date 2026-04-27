export default `## 7C.1 The unsafe Package

### What unsafe Provides

The \`unsafe\` package bypasses Go's type system to expose low-level memory operations. These functions exist for interoperating with C, implementing high-performance data structures, and accessing runtime internals.

\`\`\`go
import "unsafe"

// unsafe is a pseudo-package - the compiler handles it specially
// It provides:
//   unsafe.Pointer   - a special pointer type that can hold any pointer
//   unsafe.Sizeof    - size of a type in bytes (compile-time constant)
//   unsafe.Alignof   - required alignment of a type in bytes
//   unsafe.Offsetof  - byte offset of a struct field from the struct start
//   unsafe.Add       - pointer arithmetic (Go 1.17+)
//   unsafe.Slice     - create a slice from a pointer and length (Go 1.17+)
//   unsafe.SliceData - get the underlying array pointer of a slice (Go 1.20+)
//   unsafe.String    - create a string from pointer and length (Go 1.20+)
//   unsafe.StringData -  get underlying byte pointer of a string (Go 1.20+)
\`\`\`

### Memory Layout Inspection

The \`unsafe.Sizeof\`, \`unsafe.Alignof\`, and \`unsafe.Offsetof\` functions expose struct field offsets and alignment requirements at compile time, used to optimize struct layout and write correct memory-mapped structures.

\`\`\`go
package main

import (
    "fmt"
    "unsafe"
)

type Example struct {
    A bool    // 1 byte
    B float64 // 8 bytes (but starts at offset 8 due to padding!)
    C int32   // 4 bytes
    D int16   // 2 bytes
}

type ExampleOptimized struct {
    B float64 // 8 bytes - largest first eliminates padding
    C int32   // 4 bytes
    D int16   // 2 bytes
    A bool    // 1 byte
    _ [1]byte // explicit padding to maintain alignment
}

func main() {
    // Size and alignment
    fmt.Println("--- Example layout ---")
    fmt.Printf("Sizeof(Example)          = %d bytes\\n", unsafe.Sizeof(Example{}))
    fmt.Printf("Sizeof(bool)             = %d bytes\\n", unsafe.Sizeof(bool(false)))
    fmt.Printf("Sizeof(float64)          = %d bytes\\n", unsafe.Sizeof(float64(0)))

    // Field offsets reveal padding
    var e Example
    fmt.Printf("Offsetof(A)  = %d\\n", unsafe.Offsetof(e.A)) // 0
    fmt.Printf("Offsetof(B)  = %d\\n", unsafe.Offsetof(e.B)) // 8 (7 bytes padding after A!)
    fmt.Printf("Offsetof(C)  = %d\\n", unsafe.Offsetof(e.C)) // 16
    fmt.Printf("Offsetof(D)  = %d\\n", unsafe.Offsetof(e.D)) // 20
    // Total: 1+7(pad)+8+4+2+2(pad) = 24 bytes

    fmt.Println("--- Optimized layout ---")
    fmt.Printf("Sizeof(ExampleOptimized) = %d bytes\\n", unsafe.Sizeof(ExampleOptimized{}))
    // 8+4+2+1+1 = 16 bytes - 33% smaller!

    // Alignment requirements
    fmt.Printf("Alignof(Example)  = %d\\n", unsafe.Alignof(Example{}))
    fmt.Printf("Alignof(float64)  = %d\\n", unsafe.Alignof(float64(0)))
    fmt.Printf("Alignof(bool)     = %d\\n", unsafe.Alignof(bool(false)))
}
\`\`\`

### The Five unsafe.Pointer Conversion Rules

The Go specification defines exactly five legal conversions involving \`unsafe.Pointer\`. Any conversion outside these five rules produces undefined behavior, the garbage collector may relocate objects, corrupt memory, or silently produce wrong results. The compiler does not enforce these rules, so violations compile and run until they do not, often manifesting as rare, non-reproducible crashes.

\`\`\`go
package main

import (
    "fmt"
    "unsafe"
)

// ============================================================
// RULE 1: Convert any pointer type to unsafe.Pointer
// ============================================================
func rule1() {
    x := 42
    p := unsafe.Pointer(&x) // *int → unsafe.Pointer: SAFE
    _ = p
}

// ============================================================
// RULE 2: Convert unsafe.Pointer to any pointer type
// ============================================================
func rule2() {
    var f float64 = 3.14
    p := unsafe.Pointer(&f)
    bits := (*uint64)(p) // reinterpret float64 bits as uint64
    fmt.Printf("float64 %f = bits 0x%016X\\n", f, *bits)
    // float64 3.140000 = bits 0x400091EB851EB852
}

// ============================================================
// RULE 3: Convert unsafe.Pointer to uintptr (for arithmetic)
//         But NEVER store a uintptr as the only reference!
// ============================================================
func rule3() {
    type T struct {
        A int32
        B int64
    }
    t := T{A: 1, B: 2}

    // Access field B by offset
    // CORRECT: all in ONE expression (GC cannot move pointer between statements)
    pB := (*int64)(unsafe.Pointer(uintptr(unsafe.Pointer(&t)) + unsafe.Offsetof(t.B)))
    fmt.Println(*pB) // 2

    // DANGER: The following is WRONG and can crash:
    // ptr := uintptr(unsafe.Pointer(&t)) // uintptr is just a number!
    // // GC could move t here, ptr is now stale
    // pB2 := (*int64)(unsafe.Pointer(ptr + unsafe.Offsetof(t.B))) // UNDEFINED BEHAVIOR
}

// ============================================================
// RULE 4: Convert unsafe.Pointer to uintptr when calling syscall.Syscall
//         (special case: syscall knows about this pattern)
// ============================================================
// syscall.Syscall(SYS_READ, fd, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))

// ============================================================
// RULE 5: Convert uintptr result of reflect.Value.Pointer() or
//         reflect.Value.UnsafeAddr() to unsafe.Pointer
// ============================================================
func rule5() {
    // Use reflect.Value methods that return uintptr
    // Must be in the SAME expression:
    // p := (*int)(unsafe.Pointer(reflect.ValueOf(&x).Pointer()))
}

// ============================================================
// NEVER: Store uintptr as the only reference to live memory
// ============================================================
var gPtr uintptr // DANGER: GC does not see this as a reference!
// If the object is only referenced via gPtr, GC may collect it!
\`\`\`

### Zero-Copy String/Bytes Conversion

One of the most common legitimate uses of \`unsafe\` is converting between \`string\` and \`[]byte\` without allocating memory. This matters in hot paths processing many small strings.

\`\`\`go
package main

import (
    "fmt"
    "unsafe"
)

// StringToBytes converts a string to []byte without allocation.
// The returned slice MUST NOT be modified - strings are immutable in Go.
// This is safe because Go's string and slice headers share the same
// Data pointer field layout.
func StringToBytes(s string) []byte {
    if len(s) == 0 {
        return nil
    }
    // Go 1.20+: use unsafe.StringData
    return unsafe.Slice(unsafe.StringData(s), len(s))
}

// BytesToString converts a []byte to string without allocation.
// The string is valid as long as the backing slice is not modified.
func BytesToString(b []byte) string {
    if len(b) == 0 {
        return ""
    }
    // Go 1.20+: use unsafe.SliceData
    return unsafe.String(unsafe.SliceData(b), len(b))
}

func main() {
    // Safe zero-copy conversion
    s := "hello, world"
    b := StringToBytes(s)
    fmt.Println(string(b)) // hello, world

    // Never modify b:
    // b[0] = 'H' // SEGFAULT or data race - string memory is read-only!

    // BytesToString
    buf := []byte("foo bar")
    str := BytesToString(buf)
    fmt.Println(str) // foo bar
    // Keep buf alive while using str:
    _ = buf
}

// Pre-Go 1.20 approach (for reference):
// type stringHeader struct {
//     Data unsafe.Pointer
//     Len  int
// }
// type sliceHeader struct {
//     Data unsafe.Pointer
//     Len  int
//     Cap  int
// }
// func oldStringToBytes(s string) []byte {
//     sh := (*stringHeader)(unsafe.Pointer(&s))
//     return *(*[]byte)(unsafe.Pointer(&sliceHeader{
//         Data: sh.Data, Len: sh.Len, Cap: sh.Len,
//     }))
// }
\`\`\`

### Reading/Writing Struct Fields by Offset

When building ORMs, serializers, or configuration loaders, you often need to map field names to values at runtime. Reflection can do this, but it boxes every value into an interface, allocating on every access. The alternative is to compute field byte offsets once at startup and then read or write fields directly through pointer arithmetic. This avoids the per-access allocation cost, making it practical for hot paths that execute millions of times per second.

\`\`\`go
package main

import (
    "fmt"
    "unsafe"
)

type Config struct {
    Host    string
    Port    int
    Debug   bool
    Timeout float64
}

// FieldOffset maps field names to their byte offsets (computed once at startup)
var configOffsets = map[string]uintptr{
    "Host":    unsafe.Offsetof(Config{}.Host),
    "Port":    unsafe.Offsetof(Config{}.Port),
    "Debug":   unsafe.Offsetof(Config{}.Debug),
    "Timeout": unsafe.Offsetof(Config{}.Timeout),
}

// SetStringField sets a string field in a struct by offset (unsafe, fast)
func SetStringField(structPtr unsafe.Pointer, offset uintptr, value string) {
    field := (*string)(unsafe.Pointer(uintptr(structPtr) + offset))
    *field = value
}

func SetIntField(structPtr unsafe.Pointer, offset uintptr, value int) {
    field := (*int)(unsafe.Pointer(uintptr(structPtr) + offset))
    *field = value
}

func main() {
    cfg := &Config{}
    ptr := unsafe.Pointer(cfg)

    SetStringField(ptr, configOffsets["Host"], "localhost")
    SetIntField(ptr, configOffsets["Port"], 8080)

    fmt.Println(cfg.Host, cfg.Port) // localhost 8080
}
\`\`\`

### atomic.Pointer and Unsafe

Before Go 1.19, atomic pointer operations required manually casting through \`unsafe.Pointer\` and \`atomic.StorePointer\`/\`atomic.LoadPointer\`. This was error-prone because nothing prevented you from storing a \`*Config\` and loading it as a \`*User\`. Go 1.19 introduced \`atomic.Pointer[T]\`, a generic type that provides the same lock-free guarantees with full type safety. Unless you are targeting Go versions older than 1.19, prefer \`atomic.Pointer[T]\` over the raw \`unsafe.Pointer\` atomic functions.

\`\`\`go
package main

import (
    "fmt"
    "sync/atomic"
)

// atomic.Pointer[T] (Go 1.19+) is the safe replacement for unsafe pointer atomics
type Config struct {
    MaxConns int
    Timeout  int
}

var globalConfig atomic.Pointer[Config]

func init() {
    globalConfig.Store(&Config{MaxConns: 100, Timeout: 30})
}

func UpdateConfig(newCfg *Config) {
    globalConfig.Store(newCfg) // atomic store - safe for concurrent access
}

func GetConfig() *Config {
    return globalConfig.Load() // atomic load - always returns valid pointer
}

func main() {
    cfg := GetConfig()
    fmt.Println(cfg.MaxConns) // 100

    UpdateConfig(&Config{MaxConns: 200, Timeout: 60})
    cfg = GetConfig()
    fmt.Println(cfg.MaxConns) // 200
}
\`\`\`

### Code-Review Lens (Senior Track)

Three patterns to flag in \`unsafe\` PRs:

1. **\`unsafe.Pointer\` for performance without a benchmark.** The premise "this will be faster" needs evidence. Often the compiler produces the same code without \`unsafe\`.
2. **\`uintptr\` stored in a variable.** The GC does not track \`uintptr\` as a pointer. If the original object is otherwise unreachable, it gets collected and the \`uintptr\` becomes dangling. The \`unsafe\` rules say \`uintptr\` should only exist as part of a single expression, not persist.
3. **\`unsafe\` without an accompanying test.** The invariants \`unsafe\` relies on are subtle. Every \`unsafe\` use should have a test that exercises the boundary conditions.

### When \`unsafe\` Is Actually Worth It

Three cases where \`unsafe\` genuinely earns its place:

1. **Zero-copy string/byte conversion at high volume.** \`unsafe.String\` (Go 1.20+) and \`unsafe.Slice\` are the blessed patterns. Verified by the Go team as safe when used correctly.
2. **Lock-free data structures using \`atomic.Pointer[T]\`.** The 1.19+ typed atomic pointers remove most of the need, but some lock-free algorithms still need the raw pointer.
3. **Interfacing with C via cgo.** \`unsafe.Pointer\` is the bridge for data passed across the Go/C boundary.

For almost everything else, the Go team's guidance applies: "if you are not sure you need \`unsafe\`, you do not."

---
`;
