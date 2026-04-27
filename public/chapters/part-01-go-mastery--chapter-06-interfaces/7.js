export default `## 6.6 Interface Internals and Performance

Interface values carry runtime type information that enables dynamic dispatch, type assertions, and reflection. Knowing how this information is laid out in memory explains why interface calls cost more than direct calls and why nil interfaces behave the way they do.

### Interface Representation

At runtime, an interface value is a two-word structure: a pointer to type information (the itab) and a pointer to the data. Understanding this layout explains interface performance characteristics and the nil interface trap.

\`\`\`go
// Non-empty interface with methods
type iface struct {
    tab  *itab           // Type information + method pointers
    data unsafe.Pointer  // Pointer to actual value
}

type itab struct {
    inter *interfacetype  // Interface type
    _type *_type          // Concrete type
    hash  uint32          // Copy of _type.hash
    _     [4]byte
    fun   [1]uintptr      // Method addresses (variable size)
}

// Empty interface (any)
type eface struct {
    _type *_type
    data  unsafe.Pointer
}
\`\`\`

### Performance Implications

**Interface allocation**: Storing a value in an interface may allocate:

\`\`\`go
var i any = 42  // 42 is copied to heap
\`\`\`

Small values (≤ pointer size) may be stored inline, but this is implementation-dependent.

**Method dispatch cost**: Interface method calls are slightly slower than direct calls:

\`\`\`go
// Direct call: ~1ns
func directCall(b *Buffer) {
    b.Write(data)
}

// Interface call: ~2-3ns
func interfaceCall(w io.Writer) {
    w.Write(data)
}
\`\`\`

For hot paths, consider avoiding interfaces. For most code, the flexibility is worth the minimal cost.

### Benchmarking Interface Overhead

Interface dispatch adds a small but measurable overhead compared to direct function calls due to indirect method lookup. The following benchmark quantifies this cost in practice.

\`\`\`go
package bench

import (
    "io"
    "testing"
)

type Buffer struct {
    data []byte
}

func (b *Buffer) Write(p []byte) (int, error) {
    b.data = append(b.data, p...)
    return len(p), nil
}

var data = []byte("hello world")
var buf = &Buffer{data: make([]byte, 0, 1024)}
var w io.Writer = buf

func BenchmarkDirectCall(b *testing.B) {
    for b.Loop() {
        buf.Write(data)
    }
}

func BenchmarkInterfaceCall(b *testing.B) {
    for b.Loop() {
        w.Write(data)
    }
}

// Results:
// BenchmarkDirectCall-8      100000000    10.2 ns/op
// BenchmarkInterfaceCall-8   100000000    12.4 ns/op
// ~20% overhead, usually negligible
\`\`\`

### Type Assertion Cost

Type assertions are relatively cheap (~1ns for successful assertion):

\`\`\`go
func BenchmarkTypeAssertion(b *testing.B) {
    var w io.Writer = &Buffer{}
    for b.Loop() {
        if _, ok := w.(*Buffer); ok {
            // found
        }
    }
}

func BenchmarkTypeSwitch(b *testing.B) {
    var w io.Writer = &Buffer{}
    for b.Loop() {
        switch w.(type) {
        case *Buffer:
            // found
        case *os.File:
            // not this
        default:
            // unknown
        }
    }
}

// Results:
// BenchmarkTypeAssertion-8   1000000000   0.8 ns/op
// BenchmarkTypeSwitch-8      1000000000   1.2 ns/op
\`\`\`

### Google's Interface Performance Guidelines

From Google's internal Go performance guide:

\`\`\`go
// HOT PATH - Avoid interfaces when performance critical
type FastProcessor struct {
    buffer *Buffer // Concrete type for hot path
}

func (p *FastProcessor) ProcessFast(data []byte) {
    p.buffer.Write(data) // Direct call
}

// NORMAL PATH - Use interfaces for flexibility
type FlexibleProcessor struct {
    writer io.Writer // Interface for flexibility
}

func (p *FlexibleProcessor) Process(data []byte) {
    p.writer.Write(data) // Interface call - OK for normal paths
}

// Pattern: Extract hot path to avoid interface overhead
type Processor struct {
    writer     io.Writer  // Used for non-critical writes
    fastBuffer *Buffer    // Used for high-frequency writes
}

func (p *Processor) ProcessCritical(data []byte) {
    // Fast path: direct call
    if p.fastBuffer != nil {
        p.fastBuffer.Write(data)
        return
    }
    // Slow path: interface call
    p.writer.Write(data)
}
\`\`\`

### Interface Performance in Context

For a senior engineer reviewing a hot path, the interface cost is real but usually not the bottleneck. Three specific costs:

1. **Dispatch overhead.** An interface method call is roughly 2-3 ns slower than a direct call on a 2026 CPU, mostly because the CPU cannot inline through the dispatch and the branch predictor sees more cold call targets.
2. **Boxing allocations.** Storing a value in an interface (\`var i any = x\` or passing \`x\` to a function taking \`any\`) allocates on the heap unless the value fits inline (pointers, small integers) and the compiler can prove it does not escape. For hot paths that pass values to \`any\`, this is the expensive part, not the dispatch.
3. **Devirtualisation limits.** The compiler can sometimes devirtualise interface calls when the concrete type is statically known, but the optimisation is fragile and does not fire reliably.

The discipline: pprof first, optimise second. For the vast majority of services, interface costs are in the noise. For the specific hot paths where they matter, the options are (1) use concrete types, (2) use generics with a type parameter, (3) accept the cost as part of the flexibility. Each is a legitimate choice in context.

### Code-Review Lens (Senior Track)

Two patterns to flag:

1. **Premature replacement of interfaces with concrete types for "performance".** Without profile evidence, this trades maintainability for no benefit.
2. **An interface used in a million-operations-per-second inner loop without benchmarking.** The allocation from boxing may or may not matter. Measure.

### Escape Analysis and Interface Boxing

The only reliable way to reason about interface allocation is \`go build -gcflags='-m'\`. The compiler prints its escape decisions. Look for lines like \`x escapes to heap\` near the interface assignment. If the value being boxed escapes, the allocation is confirmed. If not, the compiler kept it on the stack and the cost is a register copy.

\`\`\`bash
go build -gcflags='-m=2' ./... 2>&1 | grep -E 'escapes|moved to heap'
\`\`\`

For a hot path, pair this with \`go test -bench=. -benchmem\` and look at \`allocs/op\`. Zero allocs per op means interface boxing is not happening. A non-zero count in what should be a pure-computation loop is the tell for a hidden \`any\` or small-value boxing. This is the level of rigor a performance-sensitive codebase demands.

### Devirtualisation in Go 1.21+

Go 1.21 added PGO (Profile-Guided Optimisation), and with it, a devirtualisation pass that can turn a hot interface call into a direct call when the profile shows a dominant concrete type. Activation:

\`\`\`bash
go test -cpuprofile=cpu.prof -run=^\$ -bench=.
go build -pgo=cpu.prof ./...
\`\`\`

The effect is measurable on dispatch-heavy code: interface calls where one concrete type dominates the call site can reach direct-call speeds. This does not eliminate interface costs (boxing still allocates, the \`itab\` lookup still happens when types are heterogeneous), but it closes the gap for the common case. For a staff engineer debating "interface vs concrete type on the hot path", PGO is the third option that was not available before Go 1.21 and that most teams have not turned on.

### Staff Lens: The Real Performance Bottleneck Is Rarely Interfaces

In the staff-level performance reviews that matter, interface dispatch almost never shows up as the top entry in pprof. The top entries are usually: GC pressure from allocations, lock contention, JSON or protobuf serialization, and synchronous network I/O. A team that spends a week removing interfaces to save 2 ns per call, while the service spends 50 ms per request waiting on a downstream RPC, has optimized the wrong thing. The instinct to develop: read the flame graph, identify the top three hot spots, and only then decide whether interface dispatch is in the critical path. Most of the time it is not. The discipline to teach the team: measure, do not assume, and preserve interface-driven design unless the profile demands otherwise.

---
`;
