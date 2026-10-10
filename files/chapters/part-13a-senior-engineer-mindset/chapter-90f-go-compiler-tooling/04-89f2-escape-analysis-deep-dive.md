## 90F.2 Escape Analysis Deep Dive

### What Escape Analysis Does

The Go compiler analyzes each variable to determine whether it "escapes" to the heap (requires GC) or can live on the stack (automatic cleanup, no GC).

Stack variables:
- Automatically freed when function returns (no GC cost)
- Faster allocation (just move stack pointer)

Heap variables:
- Managed by the garbage collector
- Slower allocation, GC overhead

```bash
# Verbose escape analysis output
go build -gcflags="-m -m" ./main.go 2>&1

# Level 1 (-m): shows escape decisions
# Level 2 (-m -m): shows the reason for each escape decision
```

### All Escape Reasons with Examples

The compiler escapes a variable to the heap whenever it cannot guarantee the variable's lifetime is bounded by the current stack frame. There are eight common escape triggers, each arising from a different relationship between the variable and something that outlives the function. Recognizing these patterns lets you predict allocation behavior during code review rather than discovering it only through profiling. The annotated examples below map each escape reason to a concrete Go construct and the corresponding compiler diagnostic output.

```go
package escapeanalysis

import "fmt"

// Escape Reason 1: Returned pointer
// → Variable outlives the stack frame
func newInt(v int) *int {
    x := v     // x escapes to heap - returned pointer outlives function
    return &x  // ./main.go:8:9: &x escapes to heap
}

// Escape Reason 2: Interface (any) conversion
// → Compiler doesn't know the concrete type - must put on heap
func printValue(v any) {
    fmt.Println(v)
}

func callPrintValue() {
    x := 42
    printValue(x) // x escapes to heap: x passed to any (any)
    // ./main.go:16:13: x escapes to heap
}

// Escape Reason 3: Stored in a data structure that escapes
func appendToSlice() []*int {
    results := make([]*int, 0)
    for i := 0; i < 10; i++ {
        n := i
        results = append(results, &n) // n escapes - pointer stored in slice
    }
    return results
}

// Escape Reason 4: Closure captures
func makeCounter() func() int {
    count := 0 // count escapes - captured by returned closure
    return func() int {
        count++
        return count
    }
    // ./main.go:XX: count escapes to heap
}

// Escape Reason 5: Too large for stack
func process(b []byte) {}

func largeAlloc() {
    var buf [1 << 20]byte // 1MB - too large for stack, escapes to heap
    process(buf[:])
    // Threshold is roughly 10MB in practice, but varies by stack size
}

// Escape Reason 6: Global references
var globalSlice []int

func storeGlobal(v int) {
    globalSlice = append(globalSlice, v) // v doesn't escape, but globalSlice is heap-allocated
}

// Escape Reason 7: map values
func mapValues() {
    m := make(map[string]*int)
    x := 42
    m["key"] = &x // x escapes - map values live on heap
    _ = m
}

// Escape Reason 8: reflect.Value
func useReflect(v any) {
    // Any use of reflect typically causes escapes
    // reflect.ValueOf(v) materializes v on heap for reflection
}
```

### Techniques to Prevent Unnecessary Escapes

Unnecessary heap allocations are one of the most common sources of GC pressure in high-throughput Go services. The patterns below show the structural changes that move data from heap to stack: returning values instead of pointers, using `sync.Pool` for objects that must be heap-allocated but can be reused, and preferring struct embedding over pointer fields. Each pattern comes with a benchmark harness so you can measure the allocation reduction directly using `b.ReportAllocs()`.

```go
package escapeanalysis

import (
    "sync"
    "testing"
)

type User struct {
    Name string
}

type InnerConfig struct {
    Port int
}

func processData(dst, src []byte) []byte {
    return append(dst, src...)
}

// Pattern 1: Return value instead of pointer (avoid "returned pointer" escape)
// Bad: heap allocation
func newUser() *User {
    return &User{Name: "Alice"} // User escapes to heap
}

// Good: return value, let caller decide lifetime
func newUserValue() User {
    return User{Name: "Alice"} // User stays on stack in caller if not escaped there
}

// Pattern 2: Avoid interface conversion in hot paths
// Bad: interface conversion in hot path
type Processor interface {
    Process(v int) int
}

func processList(items []int, p Processor) {
    for _, v := range items {
        p.Process(v) // Interface method call - may cause allocations
    }
}

// Good: use concrete type when possible, or use generics
func processListGeneric[P interface{ Process(int) int }](items []int, p P) {
    for _, v := range items {
        p.Process(v) // Inlined and devirtualized when compiler knows P
    }
}

// Pattern 3: Pre-allocate with sync.Pool for repeated allocations
var bufPool = sync.Pool{
    New: func() any {
        return make([]byte, 0, 4096)
    },
}

func processRequest(data []byte) []byte {
    buf := bufPool.Get().([]byte)
    defer func() {
        buf = buf[:0] // Reset without shrinking
        bufPool.Put(buf)
    }()

    buf = processData(buf, data)
    result := make([]byte, len(buf)) // Final allocation - only once
    copy(result, buf)
    return result
}

// Pattern 4: Struct embedding to keep data together
// Bad: pointer to inner struct causes both to escape
type BadConfig struct {
    Inner *InnerConfig
}

// Good: embed to keep both on stack
type GoodConfig struct {
    Inner InnerConfig // No pointer - stays on stack with outer
}

// Pattern 5: Verify with benchmarks
func BenchmarkEscapeComparison(b *testing.B) {
    b.Run("with_escape", func(b *testing.B) {
        b.ReportAllocs()
        for b.Loop() {
            _ = newUser() // Heap allocation per iteration
        }
    })

    b.Run("without_escape", func(b *testing.B) {
        b.ReportAllocs()
        for b.Loop() {
            _ = newUserValue() // Stack - 0 allocations
        }
    })
}
```

### Reading Escape Analysis Output

The `-gcflags="-m=2"` flag makes the compiler emit a diagnostic line for every escape decision, explaining both the outcome and the reason. Learning to parse these messages is essential for optimization work: `escapes to heap` tells you a heap allocation will occur, `does not escape` confirms a stack allocation, `leaking param` means the parameter's reachable data is stored somewhere that outlives the call, and `moved to heap` indicates a closure capture forced the variable off the stack.

```bash
$ go build -gcflags="-m=2" ./example.go 2>&1

# Understanding the output:
# ./example.go:8:9: &x escapes to heap      ← address of x sent somewhere that outlives function
# ./example.go:16:13: x does not escape     ← stays on stack
# ./example.go:24:18: leaking param content: v  ← v's content (not v itself) is stored somewhere
# ./example.go:31:6: moved to heap: count   ← count moved to heap for closure capture
# ./example.go:40:15: make([]int, 0, 10) escapes to heap  ← slice backing array on heap

# "leaking param" means: the parameter (or something reachable through it)
# escapes through a field/index store, even though the parameter value itself is on stack
```

### Junior → FAANG: Escape Analysis as a Practical Interview Topic

The allocation question ("when does this Go code allocate on the heap?") appears in Go-specific performance interviews. The answer is never "always" or "never" without proof. Candidates who say "I would run `go build -gcflags='-m'` and check the compiler output" are demonstrating exactly the right instinct: let the tool decide, do not guess. Knowing the common escape reasons (interface conversion, closure capture, returned pointer, size exceeds stack) lets you make an educated initial guess and then verify.

### Senior @ FAANG: Escape Analysis in Production Investigation

At L6, escape analysis investigation is part of the performance review for any high-throughput service. The process is: profile to find the goroutine or function with the highest allocation rate, then run escape analysis on that function to identify which specific variables are escaping and why, then make the minimal structural change to eliminate the allocation, then benchmark to confirm. This workflow should be documented in your team's performance runbook.

The `sync.Pool` pattern shown in this section is a concurrency trade-off as much as a performance one: you are trading allocation overhead for synchronization overhead. At staff level, you document the choice in an ADR: when is `sync.Pool` appropriate, and what allocation rate threshold justifies its added complexity? Without this documentation, the next engineer who inherits the code will not know whether to remove it or add more of it.

---
