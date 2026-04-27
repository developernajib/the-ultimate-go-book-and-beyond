export default `## 7.4 Stack Deep Dive

### Stack Frame Structure

A stack frame contains the function's local variables, return address, and saved registers. Frame sizes are determined at compile time and reported by \`go tool objdump\` and the \`frames\` pprof profile.

\`\`\`
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Stack Frame Layout                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  High Address                                                                │
│  ┌────────────────────────────────────────────────────────────┐             │
│  │            Return Address (caller's next instruction)      │             │
│  ├────────────────────────────────────────────────────────────┤             │
│  │            Previous Frame Pointer (caller's BP)            │             │
│  ├────────────────────────────────────────────────────────────┤◄── BP       │
│  │                                                            │             │
│  │            Local Variables                                 │             │
│  │            (ordered by alignment, largest first)          │             │
│  │                                                            │             │
│  ├────────────────────────────────────────────────────────────┤             │
│  │                                                            │             │
│  │            Saved Registers                                 │             │
│  │                                                            │             │
│  ├────────────────────────────────────────────────────────────┤             │
│  │                                                            │             │
│  │            Arguments to called functions                   │             │
│  │                                                            │             │
│  └────────────────────────────────────────────────────────────┘◄── SP       │
│  Low Address                                                                 │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
\`\`\`

### Growable Stacks

Goroutine stacks start at just 2KB, small enough that creating millions of goroutines is practical. When a function needs more stack space than available, the runtime allocates a larger stack (typically double the current size), copies the contents, and updates all stack pointers. The maximum stack size is 1GB on 64-bit systems. The following program demonstrates stack growth under increasing recursion depths.

\`\`\`go
package main

import (
    "fmt"
    "runtime"
    "sync"
)

func recursive(n int, depth int) {
    var arr [1024]byte // 1KB on stack

    if depth == 0 {
        // Print stack info at deepest point
        var buf [4096]byte
        runtime.Stack(buf[:], false)
        fmt.Printf("At depth %d\\n", n)

        var m runtime.MemStats
        runtime.ReadMemStats(&m)
        fmt.Printf("Stack in use: %d KB\\n", m.StackInuse/1024)
    }

    if n > 0 {
        recursive(n-1, depth)
    }

    _ = arr // Prevent optimization
}

func main() {
    // Test stack growth with different depths
    for _, depth := range []int{10, 100, 500, 1000} {
        fmt.Printf("\\n=== Testing depth %d ===\\n", depth)
        recursive(depth, depth)
        runtime.GC() // Clean up
    }

    // Show stack growth with many goroutines
    var wg sync.WaitGroup
    for i := 0; i < 10000; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            recursive(10, 10)
        }()
    }
    wg.Wait()

    var m runtime.MemStats
    runtime.ReadMemStats(&m)
    fmt.Printf("\\nAfter 10000 goroutines:\\n")
    fmt.Printf("Stack in use: %d KB\\n", m.StackInuse/1024)
    fmt.Printf("Stack sys: %d KB\\n", m.StackSys/1024)
}
\`\`\`

### Stack Growth Mechanism

The compiler inserts a small prologue at the beginning of every non-leaf function that compares the current stack pointer against a guard value. If insufficient space remains for the function's frame, the runtime triggers stack growth.

\`\`\`go
// Pseudocode for function prologue
func myFunction() {
    // Compiler-inserted stack check
    if SP < stackguard {
        runtime.morestack()
    }

    // Actual function code
    // ...
}
\`\`\`

When more space is needed:
1. Allocate a new stack (typically 2x size)
2. Copy the old stack to the new location
3. Update all pointers that reference stack memory
4. Continue execution on new stack
5. Return old stack to pool

**Google's Design Decision**: Go uses copying stacks rather than segmented stacks (which were tried in early Go versions). Copying stacks provide better cache locality and simpler pointer handling.

### Stack Inspection Tools

The \`go tool pprof\` CPU profiler and \`runtime/debug.Stack\` expose stack information at different granularities. The goroutine profile lists all goroutine stacks, invaluable for diagnosing deadlocks and blocking patterns.

\`\`\`go
package main

import (
    "fmt"
    "os"
    "runtime"
    "runtime/debug"
)

func printStackInfo() {
    // Current goroutine's stack
    buf := make([]byte, 4096)
    n := runtime.Stack(buf, false)
    fmt.Printf("Current goroutine stack:\\n%s\\n", buf[:n])

    // All goroutines' stacks
    buf = make([]byte, 1024*1024)
    n = runtime.Stack(buf, true)
    if n > 1000 {
        fmt.Printf("All goroutines stack (truncated):\\n%s...\\n", buf[:1000])
    }
}

func panicWithStack() {
    defer func() {
        if r := recover(); r != nil {
            fmt.Printf("Recovered: %v\\n", r)
            debug.PrintStack()
        }
    }()

    panic("intentional panic")
}

func main() {
    // Set stack trace detail level
    debug.SetTraceback("all")

    printStackInfo()

    fmt.Println("\\n=== Panic recovery with stack ===")
    panicWithStack()

    // Write stack trace to file
    f, _ := os.Create("/tmp/stack.txt")
    fmt.Fprintf(f, "Stack trace at %s\\n", "now")
    buf := make([]byte, 1024*1024)
    n := runtime.Stack(buf, true)
    f.Write(buf[:n])
    f.Close()

    fmt.Println("\\nStack written to /tmp/stack.txt")
}
\`\`\`

### Stack Growth Pathologies

For a senior engineer, three stack behaviours can show up as performance issues:

1. **Growth thrashing.** A function with a deep call graph that hits the stack limit, triggers a copy, returns (stack shrinks back), then grows again on the next call. Each growth is a copy of the entire stack. The fix is usually to flatten the call graph or reduce per-frame local size.
2. **Massive stacks from recursion.** Recursive algorithms that run deep (parsers, tree traversals) can grow stacks to megabytes. The memory is real, held until the goroutine exits. For short-lived goroutines, the cost is bounded. For long-lived ones, consider iterative versions.
3. **Segmented-to-contiguous transition invisible in old docs.** Go moved from segmented stacks to contiguous stacks in 1.4. Any documentation that talks about "hot split" issues is out of date. Modern Go does not have the pre-1.4 pathology.

### Code-Review Lens (Senior Track)

Two patterns to flag:

1. **A recursive function with no bound.** A malicious input or a pathological case can grow the stack to the 1GB default max and then crash. Add a depth bound.
2. **A hot-path function with large local arrays.** \`var buf [65536]byte\` on the stack is fine for a few calls. In a million-call loop, the stack growth cost accumulates. Measure.

---
`;
