export default `## 5.14 The Hardware View of Stack and Heap

The previous sections explained stack and heap from the programmer's perspective. This section goes one level lower and explains *why* they behave the way they do, from the CPU and OS side. Understanding this permanently changes how you write Go.

### What the Stack Actually Is

The stack is a region of memory managed entirely by a single CPU register: the **stack pointer** (SP on x86-64, called RSP). Allocating memory on the stack is a single instruction:

\`\`\`asm
SUB RSP, 32    ; "allocate" 32 bytes: just move the pointer
\`\`\`

Freeing that memory is equally trivial:

\`\`\`asm
ADD RSP, 32    ; "free" 32 bytes: move the pointer back
\`\`\`

There is no allocator, no lock, no bookkeeping, no garbage collector. The CPU just moves a register. This is why stack allocation is essentially free: it takes the same number of CPU cycles as any arithmetic operation, typically one.

The OS allocates a fixed region of virtual address space for the stack when a thread or goroutine starts. On Linux the default thread stack is 8 MB. Go starts goroutines with a 2–8 KB stack and grows it as needed (more on that below).

### Why Stack Allocation Is So Fast

Three reasons compound on top of each other:

**1. No allocator cost.** There is no \`malloc\` equivalent. The CPU adjusts RSP and the memory is yours.

**2. Cache locality.** The stack grows and shrinks from the same end. The memory your function just used is still hot in L1 or L2 cache when the caller resumes. Heap allocations scatter across gigabytes of virtual address space, which defeats the cache.

**3. No synchronization.** Each goroutine or thread has its own stack. Nothing is shared, so no locks or atomic operations are needed to allocate.

\`\`\`go
// This benchmark shows the cost difference
func BenchmarkStack(b *testing.B) {
    for i := 0; i < b.N; i++ {
        var buf [256]byte  // stack allocation
        _ = buf[0]
    }
}

func BenchmarkHeap(b *testing.B) {
    for i := 0; i < b.N; i++ {
        buf := make([]byte, 256)  // heap allocation (runtime.mallocgc)
        _ = buf[0]
    }
}
\`\`\`

On a typical machine the stack version runs in under 1 nanosecond. The heap version runs in 20-50 nanoseconds, 20-50x slower, and that is before considering GC pressure.

### Why Heap Allocation Is Slow

The heap is a large pool of memory shared by every goroutine in the process. This introduces four costs that the stack never pays:

**Allocator overhead.** \`runtime.mallocgc\` must find a free block of the right size, mark it as used, and return a pointer. Go's allocator is fast (it uses size-class arenas and thread-local caches), but it is never as fast as \`SUB RSP, N\`.

**Synchronization.** Even with thread-local caches, the allocator eventually acquires a lock when its local cache is exhausted. Under high concurrency this becomes a bottleneck.

**Fragmentation.** After many allocations and frees, the heap develops gaps. A 64-byte allocation might need to skip over several gaps before finding a fit. More gaps mean more cache misses finding them.

**Garbage collection.** Every heap allocation is a liability the GC must eventually collect. A GC scan touches every live pointer in the heap, which can thrash the CPU cache. A short-lived allocation that escapes to the heap costs GC time proportional to its size.

\`\`\`go
// Avoiding heap allocation with a pre-allocated pool
var bufPool = sync.Pool{
    New: func() any { return make([]byte, 0, 4096) },
}

func process(data []byte) {
    buf := bufPool.Get().([]byte)
    defer bufPool.Put(buf[:0])

    buf = append(buf, data...)
    // use buf...
}
\`\`\`

\`sync.Pool\` re-uses heap allocations across calls, amortizing the allocator cost and reducing GC pressure. The buffer still lives on the heap, but it is allocated once and reused many times.

### The Stack From the OS Perspective

When your program starts, the OS maps a chunk of virtual address space as the stack. On Linux, accesses near the bottom of the stack trigger a page fault, and the kernel silently extends the mapping. This is called **stack growth by demand** and is why you can write recursive code without pre-allocating the full stack depth upfront.

Go takes this further: goroutine stacks start tiny (2–8 KB) and grow dynamically. The Go runtime inserts a stack overflow check at the start of every function. When the check triggers, the runtime allocates a new, larger stack (typically 2x), copies the old stack into it, updates all pointers, and resumes. This is called **stack copying** and it is why goroutines are cheap to create even when you create millions of them.

\`\`\`go
// A million goroutines is fine in Go because each starts with ~4KB
func main() {
    var wg sync.WaitGroup
    for i := 0; i < 1_000_000; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            time.Sleep(time.Second)
        }()
    }
    wg.Wait()
}
\`\`\`

An equivalent program in C or Java with OS threads would exhaust memory. An OS thread needs ~1–8 MB of committed stack. A million goroutines at 4 KB each need only ~4 GB of virtual address space (not physical RAM, just address space), and far less in practice because most goroutines are idle.

### What Escape Analysis Does (Hardware View)

Go's compiler runs **escape analysis** to decide whether a variable goes on the stack or the heap. A variable *escapes* to the heap when it outlives the function that created it, when its address is stored somewhere that survives the function return.

\`\`\`go
func noEscape() *int {
    x := 42         // might look like it goes on the heap...
    return &x        // but escape analysis sees x escapes: heap allocated
}

func doesNotEscape() int {
    x := 42
    return x        // x stays on the stack: no address taken
}
\`\`\`

You can see escape analysis decisions with:

\`\`\`bash
go build -gcflags="-m" ./...
\`\`\`

Output lines like \`./main.go:5:2: moved to heap: x\` tell you what escaped. Every \`moved to heap\` line is a heap allocation that costs 20-50 ns and adds GC pressure. Eliminating unnecessary escapes is one of the highest-ROI performance optimizations in Go.

### Rules of Thumb

| Situation | Where it lives |
|---|---|
| Local variable, address never leaves function | Stack |
| Local variable, returned by pointer | Heap |
| Slice/map/channel created with \`make\` | Heap |
| Value stored in interface | Heap (the value is copied onto heap) |
| Goroutine closure captures a variable | Heap |
| Small fixed-size value, no address taken | Stack |

### Putting It Together

The stack is fast because the CPU already knows exactly where it is (RSP), and allocation is one arithmetic instruction. The heap is slow because it requires an allocator, synchronization, fragmentation management, and GC bookkeeping. Go's escape analysis minimizes heap use automatically, but knowing the rules lets you write code that helps the compiler keep more values on the stack.

For a visual, hardware-level walkthrough of how the stack and heap work from the ground up:

**Watch:** [Stack vs Heap Memory - Simple Explanation](https://www.youtube.com/watch?v=5OJRqkYbK-4), excellent beginner walkthrough with diagrams.

**Watch:** [WHY IS THE STACK SO FAST?](https://www.youtube.com/watch?v=N3o5yHYLviQ), covers the SP register, cache locality, and why the stack beats the heap.

**Watch:** [WHY IS THE HEAP SO SLOW?](https://www.youtube.com/watch?v=LDhoD4IVElk), covers allocator cost, fragmentation, and synchronization in detail.

For a complete treatment of DRAM internals, virtual memory, page faults, and swap, see **Chapter 167: Memory Architecture Deep Dive**.
`;
