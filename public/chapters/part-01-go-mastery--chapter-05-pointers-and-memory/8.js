export default `## 5.7 Memory Layout

On modern CPUs, data moves between main memory and the processor in fixed-size cache lines (typically 64 bytes). How a struct's fields are arranged in memory determines how much padding the compiler inserts, how large the struct is, and whether hot fields land in the same cache line.

### Alignment Rules

Types have alignment requirements:

| Type | Alignment | Size |
|------|-----------|------|
| \`bool\`, \`int8\`, \`uint8\` | 1 byte | 1 byte |
| \`int16\`, \`uint16\` | 2 bytes | 2 bytes |
| \`int32\`, \`uint32\`, \`float32\` | 4 bytes | 4 bytes |
| \`int64\`, \`uint64\`, \`float64\`, \`complex64\` | 8 bytes | 8 bytes |
| \`complex128\` | 8 bytes | 16 bytes |
| Pointer, \`int\`, \`uint\`, \`uintptr\` | 8 bytes* | 8 bytes* |
| String | 8 bytes* | 16 bytes* |
| Slice | 8 bytes* | 24 bytes* |

*On 64-bit systems

### Padding

The compiler inserts invisible padding bytes between fields to satisfy alignment requirements. Reordering fields can eliminate much of this waste. Compare these two layouts of the same three fields:

\`\`\`go
// 24 bytes (wasteful)
type Wasteful struct {
    a bool    // 1 byte
              // 7 bytes padding
    b int64   // 8 bytes
    c bool    // 1 byte
              // 7 bytes padding (for alignment)
}

// 16 bytes (efficient)
type Efficient struct {
    b int64   // 8 bytes
    a bool    // 1 byte
    c bool    // 1 byte
              // 6 bytes padding
}
\`\`\`

### Checking Size and Alignment

The \`unsafe.Sizeof\` and \`unsafe.Alignof\` functions report the memory layout of Go types at compile time. Use them to audit struct sizes and verify that field reordering actually reduced padding:

\`\`\`go
import "unsafe"

type Example struct {
    a bool
    b int64
    c bool
}

fmt.Println(unsafe.Sizeof(Example{}))  // 24
fmt.Println(unsafe.Alignof(Example{})) // 8
fmt.Println(unsafe.Offsetof(Example{}.a)) // 0
fmt.Println(unsafe.Offsetof(Example{}.b)) // 8
fmt.Println(unsafe.Offsetof(Example{}.c)) // 16
\`\`\`

### Optimal Field Ordering

The general rule is to sort fields from largest alignment to smallest. This packs smaller fields together at the end, minimizing the padding inserted between them:

\`\`\`go
// Before: 40 bytes
type User struct {
    Active    bool      // 1 + 7 padding
    ID        int64     // 8
    Status    byte      // 1 + 3 padding
    Score     float32   // 4
    Name      string    // 16
}

// After: 32 bytes
type User struct {
    ID     int64     // 8
    Name   string    // 16
    Score  float32   // 4
    Status byte      // 1
    Active bool      // 1 + 2 padding
}
\`\`\`

### Tools for Analysis

The \`fieldalignment\` tool from \`golang.org/x/tools\` detects structs with suboptimal field ordering and can automatically reorder them. The \`-fix\` flag rewrites source files in place:

\`\`\`bash
go install golang.org/x/tools/go/analysis/passes/fieldalignment/cmd/fieldalignment@latest
fieldalignment -fix ./...
\`\`\`

### Cache-Friendly Structures

Beyond minimizing size, grouping fields by access frequency keeps hot-path data in a single cache line. Fields read on every request go first. Fields touched only during initialization or error handling go last:

\`\`\`go
// Hot fields (accessed frequently) together
type Connection struct {
    // Hot path: accessed every request
    ID        uint64
    State     uint32
    LastPing  int64

    // Cold path: rarely accessed
    CreatedAt time.Time
    Metadata  map[string]string
}
\`\`\`

### Netflix's Memory Layout Optimization

Netflix's streaming metadata services maintain millions of concurrent \`StreamSession\` structs in memory. Their layout separates fields into hot, warm, and cold tiers based on access frequency, ensuring that the most-read fields fit within a single 64-byte cache line:

\`\`\`go
// Netflix pattern: hot/cold field separation
type StreamSession struct {
    // === HOT FIELDS (every frame) ===
    // Keep in first cache line (64 bytes)
    SessionID    uint64    // 8 bytes
    BitrateKbps  uint32    // 4 bytes
    BufferMs     uint32    // 4 bytes
    FrameCount   uint64    // 8 bytes
    LastFrameAt  int64     // 8 bytes
    State        uint8     // 1 byte
    Flags        uint8     // 1 byte
    _padding     [2]byte   // 2 bytes (explicit padding)
    // Total: 36 bytes + 28 padding = 64 bytes (one cache line)

    // === WARM FIELDS (per-second) ===
    QualityScore float64
    Rebuffers    uint32
    DroppedFrame uint32

    // === COLD FIELDS (session start/end) ===
    ClientIP     net.IP
    DeviceType   string
    StartedAt    time.Time
    Metadata     map[string]string
}

// Verify layout
func init() {
    var s StreamSession
    // Ensure hot fields fit in cache line
    if unsafe.Offsetof(s.State) > 56 {
        panic("hot fields exceed cache line")
    }
}
\`\`\`

### False Sharing in Concurrent Code

When two goroutines mutate fields that fall in the same cache line, the CPU's cache-coherence protocol invalidates each goroutine's copy of the line on every write. This is "false sharing" and it can dominate the performance of otherwise-correct concurrent code. The defence is explicit padding to push hot per-goroutine state onto separate cache lines:

\`\`\`go
type Counter struct {
    count uint64
    _     [56]byte // pad to 64-byte cache line
}

type Counters struct {
    perCPU [maxCPU]Counter
}
\`\`\`

The \`_ [56]byte\` is the canonical padding pattern. The size depends on the cache line (64 bytes is the modern default, check with \`unsafe.Sizeof\` and \`runtime.NumCPU()\` if you target unusual hardware). For services that have measurable contention on per-CPU counters or per-shard state, the padding is one of the cheapest performance wins available.

### Code-Review Lens (Senior Track)

Three patterns a staff reviewer flags in memory-layout PRs:

1. **A struct with poor field ordering on a hot allocation path.** Run \`fieldalignment\` and accept the suggestion. The discipline is automated, the savings are real for high-allocation services.
2. **A concurrent counter without cache-line padding.** When pprof or \`go tool trace\` shows scheduler contention on the counter's address, add the padding.
3. **An attempt to micro-optimise a struct allocated rarely.** The savings are zero. Decline the change.

### Migration Lens

Coming from C, Go's struct layout follows essentially the same alignment rules. The \`unsafe.Sizeof\` and \`unsafe.Alignof\` are the equivalents of \`sizeof\` and \`alignof\`. Coming from Java, the JVM hides struct layout entirely (object headers, padding, and reordering are JVM-specific). Go's \`unsafe\` makes the layout visible, which is the foundation of the kind of performance work this section enables. Coming from Rust, Go does not reorder fields automatically (Rust does, by default). The \`fieldalignment\` tool gives you the suggested order. Go does not apply it on its own.

---
`;
