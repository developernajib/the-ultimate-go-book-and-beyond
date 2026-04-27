export default `# Struct Layout and Alignment in Go

## Why Field Order Matters

In most high-level languages, field order in a struct is purely a style choice. In Go, field order directly determines memory layout, which determines memory usage, cache behavior, and in some cases correctness with concurrent access patterns.

Go follows the same layout rules as C:

- Each field is placed at the lowest address that satisfies its alignment requirement.
- Padding bytes are inserted silently between fields to maintain alignment.
- The struct's total size is rounded up to a multiple of the struct's own alignment requirement (the maximum alignment among all fields).

You do not write the padding. The compiler adds it invisibly. But you pay for it in every allocation of that struct type.

---

## Measuring Layout with reflect and unsafe

Two packages give you introspection into struct layout:

\`\`\`go
package main

import (
    "fmt"
    "reflect"
    "unsafe"
)

type Example struct {
    A bool
    B int64
    C bool
    D int32
}

func main() {
    var e Example
    t := reflect.TypeOf(e)

    fmt.Printf("Struct size: %d bytes\\n", unsafe.Sizeof(e))
    fmt.Printf("Struct alignment: %d bytes\\n", unsafe.Alignof(e))
    fmt.Println()

    for i := 0; i < t.NumField(); i++ {
        f := t.Field(i)
        fmt.Printf("%-6s  offset=%-4d size=%-4d align=%d\\n",
            f.Name,
            f.Offset,
            f.Type.Size(),
            f.Type.Align(),
        )
    }
}
\`\`\`

Output:
\`\`\`
Struct size: 24 bytes
Struct alignment: 8 bytes

A       offset=0    size=1    align=1
B       offset=8    size=8    align=8
C       offset=16   size=1    align=1
D       offset=20   size=4    align=4
\`\`\`

The data bytes sum to 1+8+1+4 = 14. The struct is 24 bytes. 10 bytes are padding (42% overhead).

---

## Viewing Assembly Output for Struct Offsets

The \`-gcflags="-S"\` flag prints the compiler's assembly output, which shows exact memory offsets:

\`\`\`bash
go build -gcflags="-S" ./... 2>&1 | grep -A 20 "Example"
\`\`\`

For a function that accesses struct fields, you will see instructions like:

\`\`\`asm
MOVQ    8(AX), CX    // load B: offset 8 from struct base
MOVL    20(AX), DX   // load D: offset 20 from struct base
\`\`\`

These offsets in the assembly are the actual byte offsets of each field. If you see \`MOVQ 8(AX)\` where you expected offset 1 (because A is 1 byte and B follows), the gap from 1 to 8 is the compiler-inserted padding.

---

## Optimizing Field Order: Largest Alignment First

The general rule: order fields from largest alignment requirement to smallest. Fields with the same alignment can be grouped together.

\`\`\`go
// Before: 24 bytes with 10 bytes padding
type Wasteful struct {
    A bool    // 1 byte
    B int64   // 8 bytes
    C bool    // 1 byte
    D int32   // 4 bytes
}

// After: 16 bytes with 2 bytes padding
type Efficient struct {
    B int64   // 8 bytes, offset 0
    D int32   // 4 bytes, offset 8
    A bool    // 1 byte,  offset 12
    C bool    // 1 byte,  offset 13
              // 2 bytes padding at end (total must be multiple of 8)
}
\`\`\`

Trace the optimal layout:
\`\`\`
Offset  0: B (int64, 8 bytes)
Offset  8: D (int32, 4 bytes)
Offset 12: A (bool, 1 byte)
Offset 13: C (bool, 1 byte)
Offset 14: [2 bytes padding to reach 16, which is multiple of 8]
Total: 16 bytes
\`\`\`

A 33% reduction in size for this struct. For a \`[]Efficient\` with 1 million elements:
- Wasteful: 24MB
- Efficient: 16MB

And because the elements are denser, more of them fit in each cache line (64 bytes). A 64-byte cache line holds 2.6 Wasteful elements or 4 Efficient elements. Iteration is roughly 50% faster on the cache-friendly version because you fetch the same data in fewer cache lines.

---

## The \`go vet\` fieldalignment Checker

The \`fieldalignment\` analyzer (part of \`golang.org/x/tools\`) detects structs where reordering fields would reduce size:

\`\`\`bash
go install golang.org/x/tools/cmd/structlayout@latest
go install golang.org/x/tools/cmd/structlayout-optimize@latest

# Show current layout with sizes
structlayout -json mypkg MyStruct | structlayout-pretty

# Show what the optimal layout would be
structlayout-optimize mypkg MyStruct
\`\`\`

With \`golangci-lint\`, enable the \`fieldalignment\` linter:

\`\`\`yaml
# .golangci.yml
linters:
  enable:
    - govet
linters-settings:
  govet:
    enable:
      - fieldalignment
\`\`\`

This will fail CI on any struct that can be reduced by reordering. Whether you enforce this for every struct or only hot-path structs is a team decision. Apply it where it matters: high-frequency allocations and large slices.

---

## sync.Mutex: Zero-Allocation Embedded Lock

\`sync.Mutex\` is two \`uint32\` fields, 8 bytes total, alignment 4:

\`\`\`go
// From the Go standard library:
type Mutex struct {
    state int32
    sema  uint32
}
\`\`\`

When you embed a \`sync.Mutex\` in your struct, no heap allocation occurs. The mutex lives directly in the struct's memory:

\`\`\`go
type SafeCounter struct {
    mu    sync.Mutex
    count int64
}

func (c *SafeCounter) Inc() {
    c.mu.Lock()
    c.count++
    c.mu.Unlock()
}
\`\`\`

Layout:
\`\`\`
Offset 0: mu.state (int32, 4 bytes)
Offset 4: mu.sema  (uint32, 4 bytes)
Offset 8: count    (int64, 8 bytes)
Total: 16 bytes
\`\`\`

No pointer indirection to reach the mutex. The lock and the data it protects are in the same cache line. This is the Go idiom: embed the mutex adjacent to the data it guards, not in a separate allocation.

One pitfall: copying a \`sync.Mutex\` by value is a bug. The mutex state is in the copied value, not shared with the original. \`go vet -copylocks\` detects this.

---

## atomic.Int64: Self-Aligning Atomic Fields

\`sync/atomic.Int64\` (Go 1.19+) is a struct that guarantees 8-byte alignment even on 32-bit platforms:

\`\`\`go
type Int64 struct {
    _ noCopy
    _ align64  // internal type that enforces 8-byte alignment
    v int64
}
\`\`\`

The \`align64\` embedded type makes \`Int64\`'s alignment requirement 8 bytes. On 64-bit platforms this is the natural alignment of \`int64\`. On 32-bit platforms (arm, 386), \`int64\` normally has 4-byte alignment, which can cause \`atomic.AddInt64\` to fault if the address is not 8-byte aligned. The \`align64\` trick prevents this.

Use \`atomic.Int64\` instead of raw \`int64\` with \`sync/atomic\` functions:

\`\`\`go
// Old style: fragile on 32-bit, verbose
var counter int64
atomic.AddInt64(&counter, 1)
v := atomic.LoadInt64(&counter)

// New style: safe, clear intent
var counter atomic.Int64
counter.Add(1)
v := counter.Load()
\`\`\`

When embedding \`atomic.Int64\` in a struct, the compiler handles the alignment automatically:

\`\`\`go
type Stats struct {
    requests atomic.Int64  // naturally 8-byte aligned
    errors   atomic.Int64
    latencyNs atomic.Int64
}
\`\`\`

---

## False Sharing: When Alignment Hurts Concurrent Code

Two goroutines writing to different fields of the same struct can cause false sharing: both fields live in the same 64-byte cache line. The CPU cache coherence protocol forces each core to invalidate the other's cache copy on every write, even though the two goroutines are writing different data.

\`\`\`go
// Problematic: both fields fit in 64 bytes, likely share a cache line
type Counters struct {
    reqs  atomic.Int64  // goroutine A writes here
    errs  atomic.Int64  // goroutine B writes here
}
\`\`\`

Solution: pad each hot field to occupy a full cache line:

\`\`\`go
const cacheLineSize = 64

type PaddedCounter struct {
    v   atomic.Int64
    _   [cacheLineSize - 8]byte  // pad to fill 64 bytes
}

type Counters struct {
    reqs PaddedCounter  // occupies its own cache line
    errs PaddedCounter  // occupies its own cache line
}
\`\`\`

Now goroutine A and goroutine B write to different cache lines. No false sharing. The tradeoff: memory use increases 8x per counter. This is only worthwhile for counters updated at very high frequency by multiple goroutines simultaneously.

Go's \`sync.Pool\` and per-P data structures use similar padding internally to avoid false sharing between goroutines on different OS threads.

---

## Pointer-Heavy Structs and GC Pressure

Struct layout also affects the garbage collector. The GC scans heap-allocated structs to find pointers. A struct with many pointer fields (slices, maps, interfaces, pointers) requires more GC work than a struct with only scalar fields.

If you have a large slice of structs that each contain a slice header:

\`\`\`go
type Row struct {
    ID   int64
    Name string  // string header = pointer + length = 16 bytes
    Tags []string // slice header = pointer + length + cap = 24 bytes
}
\`\`\`

Every \`Row\` has two GC-traceable pointers. For 1 million rows, the GC must scan 2 million pointers per collection cycle.

Alternatives:
- Use flat \`[]byte\` slabs with manual offset tracking for string data.
- Use index-based references instead of pointers within arrays.
- Use \`arena\` allocators (experimental in Go 1.20+) for collections that are freed as a unit.

This is advanced territory, but knowing that pointer fields have GC cost is part of understanding how struct layout choices affect runtime behavior.

---

## Summary Table

| Technique | Benefit | Cost |
|-----------|---------|------|
| Sort fields largest alignment first | Reduce padding, lower memory use | Reduced readability (group logically first, optimize second) |
| Embed sync.Mutex inline | Zero allocation, same cache line as data | Must not copy by value |
| Use atomic.Int64 | Safe on 32-bit, clear intent | 8 bytes larger than raw int64 (on 32-bit) |
| Cache-line padding | Eliminate false sharing | 8x memory per padded field |
| Minimize pointer fields | Reduce GC scan work | May require more complex data management |

**Watch:** [The size of your variables matters](https://www.youtube.com/watch?v=hwyRnHA54lI)
`;
