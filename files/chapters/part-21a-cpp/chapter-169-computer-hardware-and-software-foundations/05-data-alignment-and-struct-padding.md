## 05. Data Alignment and Struct Padding

### Why the CPU Cares About Alignment

A 64-bit CPU reads memory in chunks aligned to natural boundaries. An `int64` at address 8 is read in one bus operation. The same `int64` at address 6 crosses a cache line or word boundary, requiring two reads and a join operation in the memory controller.

On x86-64, unaligned access is supported in hardware and does not crash your program. But it is slower: 1-2 extra cycles per access, which compounds in hot loops. On ARM, many operations require alignment, and an unaligned access causes a hardware exception. Go's runtime on ARM enforces alignment, but if you use `unsafe` carelessly or call C code through CGo, misalignment can cause panics or undefined behavior.

The alignment requirement for a type is the number of bytes that its starting address must be a multiple of:

| Type | Size (bytes) | Alignment (bytes) |
|------|-------------|-------------------|
| bool | 1 | 1 |
| int8, uint8, byte | 1 | 1 |
| int16, uint16 | 2 | 2 |
| int32, uint32, float32 | 4 | 4 |
| int64, uint64, float64 | 8 | 8 |
| complex64 | 8 | 4 |
| complex128 | 16 | 8 |
| pointer | 8 | 8 |
| slice header | 24 | 8 |
| string header | 16 | 8 |
| interface | 16 | 8 |

The alignment requirement says: this type's address must be a multiple of N. The size says: this type occupies N bytes.

---

### How Go Lays Out Struct Fields

Go follows the same rules as C for struct layout:
1. Each field is placed at the next address that satisfies its alignment requirement.
2. If a field cannot start at the current offset, the compiler inserts padding bytes until the address is valid.
3. The struct itself is padded at the end to make its total size a multiple of the largest alignment requirement among its fields.

These rules are applied by the compiler automatically. You never write the padding explicitly. But you do pay for it in memory.

---

### A Wasteful Struct Layout

```go
type Wasteful struct {
    A bool    // 1 byte, alignment 1
    B int64   // 8 bytes, alignment 8
    C bool    // 1 byte, alignment 1
    D int32   // 4 bytes, alignment 4
}
```

Let's trace the layout manually:

```
Offset 0:  A (bool)        , 1 byte used
Offset 1:  [padding]       , 7 bytes padding (to align B to 8)
Offset 8:  B (int64)       , 8 bytes used
Offset 16: C (bool)        , 1 byte used
Offset 17: [padding]       , 3 bytes padding (to align D to 4)
Offset 20: D (int32)       , 4 bytes used
Offset 24: [end padding]   , 0 bytes (24 is multiple of 8, the max alignment)

Total: 24 bytes
Actual data: 1+8+1+4 = 14 bytes
Wasted: 10 bytes (42% overhead)
```

Check this in Go:

```go
package main

import (
    "fmt"
    "reflect"
    "unsafe"
)

type Wasteful struct {
    A bool
    B int64
    C bool
    D int32
}

func main() {
    var w Wasteful
    t := reflect.TypeOf(w)

    fmt.Printf("Size: %d bytes\n", unsafe.Sizeof(w))
    for i := 0; i < t.NumField(); i++ {
        f := t.Field(i)
        fmt.Printf("Field %s: offset=%d, size=%d, align=%d\n",
            f.Name,
            f.Offset,
            f.Type.Size(),
            f.Type.Align(),
        )
    }
}
```

Output:
```
Size: 24 bytes
Field A: offset=0, size=1, align=1
Field B: offset=8, size=8, align=8
Field C: offset=16, size=1, align=1
Field D: offset=20, size=4, align=4
```

---

### Optimal Layout: Sort Fields Largest-First

Reorder the fields from largest to smallest by alignment requirement:

```go
type Optimal struct {
    B int64   // 8 bytes, alignment 8
    D int32   // 4 bytes, alignment 4
    A bool    // 1 byte, alignment 1
    C bool    // 1 byte, alignment 1
}
```

Layout trace:

```
Offset 0:  B (int64)  , 8 bytes used
Offset 8:  D (int32)  , 4 bytes used
Offset 12: A (bool)   , 1 byte used
Offset 13: C (bool)   , 1 byte used
Offset 14: [padding]  , 2 bytes (to make total size multiple of 8)

Total: 16 bytes
Actual data: 8+4+1+1 = 14 bytes
Wasted: 2 bytes (12.5% overhead)
```

The same four fields went from 24 bytes to 16 bytes just by reordering. In a slice of one million such structs, that is 8MB of memory saved.

---

### `unsafe.Sizeof` and `unsafe.Alignof`

The `unsafe` package provides introspection without reflection:

```go
package main

import (
	"fmt"
	"unsafe"
)

type S struct {
	A bool
	B int64
}

func main() {
	var x int64
	fmt.Println(unsafe.Sizeof(x))  // 8
	fmt.Println(unsafe.Alignof(x)) // 8

	var s S
	fmt.Println(unsafe.Sizeof(s))     // 16
	fmt.Println(unsafe.Offsetof(s.B)) // 8
}
```

`unsafe.Sizeof` returns the size in bytes. `unsafe.Alignof` returns the alignment requirement. `unsafe.Offsetof` returns the byte offset of a struct field from the start of the struct. These are compile-time constants on the platforms where the sizes are fixed.

Important: `unsafe.Sizeof` does NOT include the memory pointed to by pointers, slice backing arrays, string data, or interface values. It only measures the size of the descriptor in the struct.

---

### The `go vet` fieldalignment Checker

Go's static analysis tool includes a `fieldalignment` analyzer (via `golang.org/x/tools/go/analysis/passes/fieldalignment`):

```bash
go install golang.org/x/tools/cmd/structlayout@latest
go install golang.org/x/tools/cmd/structlayout-optimize@latest

# Show current layout
structlayout mypackage MyStruct

# Show optimized layout suggestion
structlayout-optimize mypackage MyStruct
```

Or use `go vet` with the fieldalignment check via `staticcheck` or `golangci-lint`:

```bash
go vet -copylocks ./...   # related: checks for copying mutex by value
```

The `fieldalignment` pass warns when a struct can be made smaller by reordering fields. It does not automatically reorder because field order can matter for API compatibility and readability.

---

### Special Cases: sync.Mutex and atomic.Int64

#### sync.Mutex

`sync.Mutex` is defined as:

```go
type Mutex struct {
    state int32
    sema  uint32
}
```

Size: 8 bytes. Alignment: 4 bytes. When you embed a `sync.Mutex` in a struct, the mutex fields are embedded at that location with their alignment requirements. There is no heap allocation. The lock state lives directly inside the struct.

If you put a `sync.Mutex` after an `int64` in a struct:

```go
type Good struct {
    counter int64    // offset 0
    mu      sync.Mutex  // offset 8 (8-byte aligned int64 satisfied, then Mutex at 8)
}
```

If you put it before:

```go
type AlsoOk struct {
    mu      sync.Mutex  // offset 0, size 8
    counter int64       // offset 8 (naturally aligned)
}
```

Both work here. The concern arises on 32-bit platforms where `int64` has 4-byte alignment and you need to ensure `counter` starts at an 8-byte boundary for atomic operations. On 64-bit platforms (all modern targets for Go), this is not an issue.

#### atomic.Int64

`sync/atomic.Int64` (added in Go 1.19) is a struct:

```go
type Int64 struct {
    _ noCopy
    _ align64
    v int64
}
```

The `align64` field (an internal type) ensures the `Int64` struct is always 8-byte aligned even on 32-bit platforms. This is needed because `atomic.AddInt64` and `atomic.LoadInt64` require 8-byte alignment to work correctly on 32-bit ARM and x86.

If you embed an `atomic.Int64` inside a larger struct, Go's compiler handles the alignment automatically. If you use the old-style `sync/atomic` functions (e.g., `atomic.AddInt64(&x, 1)`) with a raw `int64`, you must manually ensure 8-byte alignment on 32-bit targets.

Using `atomic.Int64` instead of raw `int64` + function calls is safer and clearer:

```go
type Counter struct {
    hits atomic.Int64  // safe, self-aligned
}

func (c *Counter) Inc() { c.hits.Add(1) }
func (c *Counter) Get() int64 { return c.hits.Load() }
```

---

### Comparison Table: Worst vs Optimal Layout

```go
// Worst case: 40 bytes
type Worst struct {
    a bool    // 1 + 7 pad
    b int64   // 8
    c bool    // 1 + 3 pad
    d int32   // 4
    e bool    // 1 + 7 pad
    f int64   // 8
}

// Optimal: 24 bytes
type Best struct {
    b int64   // 8
    f int64   // 8
    d int32   // 4
    a bool    // 1
    c bool    // 1
    e bool    // 1
    _ [1]byte // explicit pad to multiple of 8 (compiler adds this anyway)
}
```

| Struct | Size | Data bytes | Padding | Overhead |
|--------|------|-----------|---------|----------|
| Worst | 40 | 23 | 17 | 43% |
| Best | 24 | 23 | 1 | 4% |

---

### When Alignment Actually Matters

Do not prematurely optimize every struct. Focus on:

1. **Hot path structs.** Structs stored in large slices that are iterated in tight loops.
2. **Structs crossing cache lines.** If a struct is 72 bytes, instances in an array will straddle cache line boundaries (64 bytes). Padding or shrinking to 64 bytes can improve cache behavior.
3. **Structs with atomic fields.** Alignment bugs with atomics on 32-bit platforms are hard to debug.
4. **Network protocol structs.** When using `encoding/binary` to serialize, the Go struct layout may not match the wire format, requiring explicit field ordering.

For everything else, write readable code first. Use `structlayout-optimize` when profiling shows memory pressure.

**Watch:** [The size of your variables matters](https://www.youtube.com/watch?v=hwyRnHA54lI)
