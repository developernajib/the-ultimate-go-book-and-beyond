export default `## 5.3 Stack vs Heap

Every Go variable lives on either the stack or the heap, and the difference between the two has direct consequences for allocation speed, garbage collector load, and overall service latency.

### Stack Allocation

The stack is:
- Extremely fast (just moving a pointer)
- Automatically managed (cleaned up when function returns)
- Per-goroutine, starts at 2KB and grows on demand (the hard cap is 1GB by default, tunable via \`debug.SetMaxStack\`)

Stack-allocated values:
- Local variables that do not escape
- Function parameters
- Return values (small ones)

\`\`\`go
func stackOnly() int {
    x := 42      // Stack allocated
    y := x * 2   // Stack allocated
    return y     // Copied to caller's stack
}
\`\`\`

### Heap Allocation

The heap is:
- Managed by the garbage collector
- Slower than stack (requires GC work)
- Unlimited in size (up to available memory)

Heap-allocated values:
- Variables that outlive their function
- Variables shared across goroutines
- Large allocations

\`\`\`go
func heapAllocated() *int {
    x := 42
    return &x  // x escapes to heap (returned pointer)
}
\`\`\`

### Why It Matters

Stack and heap allocation have fundamentally different performance characteristics. Stack allocations are free, while heap allocations require the allocator and eventually the garbage collector.

\`\`\`go
// Stack allocation: ~1ns
func stackAlloc() int {
    x := 42
    return x
}

// Heap allocation: ~25ns + GC pressure
func heapAlloc() *int {
    x := 42
    return &x
}
\`\`\`

Every heap allocation adds work for the garbage collector: it must track the object, mark it during the next GC cycle, and eventually sweep it. In aggregate, thousands of unnecessary heap allocations per second translate to measurable GC pause time.

### Viewing Allocations

Use benchmarks with \`-benchmem\`:

\`\`\`bash
go test -bench=. -benchmem
\`\`\`

\`\`\`go
func BenchmarkStack(b *testing.B) {
    for b.Loop() {
        _ = stackAlloc()
    }
}

func BenchmarkHeap(b *testing.B) {
    for b.Loop() {
        _ = heapAlloc()
    }
}
\`\`\`

Output:
\`\`\`
BenchmarkStack-8    1000000000    0.25 ns/op    0 B/op    0 allocs/op
BenchmarkHeap-8     50000000      25.1 ns/op    8 B/op    1 allocs/op
\`\`\`

### Cloudflare's Stack Optimization

Cloudflare's edge servers process millions of requests per second. They aggressively optimize for stack allocation:

\`\`\`go
// Cloudflare pattern: preallocate on stack
func ProcessRequest(r *http.Request) Response {
    // Stack-allocated buffer for small responses
    var buf [4096]byte
    n := buildResponse(buf[:], r)

    if n <= len(buf) {
        // Fast path: response fits in stack buffer
        return Response{Data: buf[:n]}
    }

    // Slow path: allocate on heap for large responses
    largeBuf := make([]byte, n)
    buildResponse(largeBuf, r)
    return Response{Data: largeBuf}
}

// Stack allocation for common case
type RequestContext struct {
    // Fixed-size fields stay on stack
    TraceID   [16]byte
    StartTime int64
    Flags     uint32

    // These might escape, but that's ok for edge cases
    Headers   map[string]string
}

func NewContext() RequestContext {
    return RequestContext{
        StartTime: time.Now().UnixNano(),
    }
}
\`\`\`

### Goroutine Stacks Are Not Like Thread Stacks

A goroutine starts with a 2KB stack and grows on demand by copying. When the runtime detects that a goroutine needs more stack than it has, it allocates a new, larger stack (usually 2x), copies the existing frames, updates pointers within the stack, and resumes execution. This is invisible to your code. Three implications:

1. **Recursion is bounded by the max stack size** (1GB by default), not by a small thread stack. Deep recursion that would crash on a JVM thread typically runs fine on a goroutine.
2. **Stack growth has a cost.** A function call that triggers stack growth pays a copy cost proportional to the stack size. For services with many short-lived goroutines that grow once, this is negligible. For long-lived goroutines that repeatedly grow and shrink, the cost compounds. The runtime collects the cost in the trace, visible via \`go tool trace\`.
3. **Pointer addresses are not stable across stack growth.** If you take the address of a stack variable and then trigger stack growth, the address may have changed. The compiler and runtime cooperate to update on-stack references. Off-stack references (the heap, other goroutines) are why the variable would have escaped in the first place.

### What "Escape" Costs You

Each escape to the heap adds work for the garbage collector at three points:

1. **Allocation.** The allocator finds a free slot, zeros it, and returns a pointer. Cost: ~25ns for small objects in current implementations, faster after the 1.26 Green Tea changes.
2. **Marking.** During the next GC cycle, the collector visits the object and traces its pointer fields. Cost is proportional to the object's size and pointer count.
3. **Sweeping.** Once the GC determines the object is unreachable, the sweeper returns its memory to the allocator's free pool.

For a service that allocates 1 million small objects per second, the marking phase alone is significant CPU work. Reducing allocations by half cuts the marking work in half. This is why escape analysis matters for hot paths.

### Code-Review Lens (Senior Track)

Three patterns a staff reviewer flags in stack-vs-heap-related PRs:

1. **A function that returns \`&T{}\` for a small \`T\`.** The pointer return forces the value to the heap. If the caller does not need pointer semantics, return \`T\` directly.
2. **A loop that allocates per iteration.** \`for i := 0; i < N; i++ { x := &T{...} ... }\` creates N allocations. If the values do not escape (they are used only within the loop body), restructure to reuse a single allocation.
3. **An interface parameter on a hot path.** Passing a value to an \`any\` (or \`interface{}\`) parameter requires boxing the value into an interface, which is a heap allocation for everything except small values that fit inline. Concrete-type parameters or generics avoid the boxing.

### Migration Lens

Coming from C, you choose stack vs heap explicitly with \`T x\` vs \`T *x = malloc(...)\`. Go decides for you via escape analysis, and the decision is sometimes counter-intuitive. The \`-gcflags=-m\` output is the C equivalent of "let me see what the compiler is doing". Coming from Java, all object allocations go on the heap, period. The JVM's escape analysis (added in HotSpot) sometimes promotes objects to the stack but it is opaque. Go's escape decisions are visible. Coming from Rust, the stack-vs-heap choice is more explicit (\`Box<T>\` is heap, \`T\` is stack). Go's escape analysis sits between Rust's explicit choice and Java's no-choice model.

---
`;
