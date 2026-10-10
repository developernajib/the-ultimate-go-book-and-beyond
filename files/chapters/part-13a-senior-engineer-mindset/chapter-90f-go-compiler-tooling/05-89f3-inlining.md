## 90F.3 Inlining

### What Inlining Is and Why It Matters

Inlining replaces a function call with the function body at the call site. Benefits:
- Eliminates function call overhead (save/restore registers, stack frame setup)
- Enables further optimizations: constant folding, CSE, escape analysis improvement
- The `Add(a, b)` example: a 1-line function with overhead > body is a classic inlining win

```bash
# See which functions were/weren't inlined and why
go build -gcflags="-m" ./main.go 2>&1 | grep "inline"

# Output examples:
# ./main.go:3:6: can inline Add           ← eligible for inlining
# ./main.go:8:6: cannot inline processAll: function too complex  ← inlining budget exceeded
# ./main.go:15:11: inlining call to Add   ← was inlined at this call site
```

### Inlining Budget

The Go compiler uses a "budget" (AST node count) to decide what to inline. Default budget: ~80 AST nodes.

```go
type Item struct{}
type Result struct{}

// This gets inlined (small body):
// Note: max() is builtin since Go 1.21, shown here as inlining example
func add(a, b int) int {
    return a + b
}

// This doesn't get inlined (too complex):
func complexProcess(items []Item) Result {
    // Many branches, loops, function calls - exceeds budget
    // Use -gcflags="-m" to see: "cannot inline: function too complex"
    return Result{}
}

// Measuring inlining budget
// go build -gcflags="-d=checkptr" - won't show budget directly
// But: -gcflags="-m=2" shows budget for each function

// Force no inlining (for benchmarking to measure call overhead)
//go:noinline
func benchmarkTarget(x, y int) int {
    return x + y
}

// There is no //go:inline directive in Go (proposal golang/go#21536 was
// declined). To encourage inlining, split the hot path into a small
// function the budget accepts and mark the cold path //go:noinline.
```

### Checking What Gets Inlined

The most reliable way to verify inlining decisions is to run a benchmark that compares the inlined and non-inlined versions side by side. Annotating the non-inlined variant with `//go:noinline` creates a controlled baseline, and passing `-gcflags="-m"` to `go test` alongside `-bench` confirms whether the compiler actually inlined the call site. The `ns/op` difference between the two benchmarks quantifies the call overhead for your specific architecture and CPU.

```go
// Practical inlining investigation
package main

import "testing"

func add(a, b int) int { return a + b }

//go:noinline
func addNoInline(a, b int) int { return a + b }

func BenchmarkAdd(b *testing.B) {
    x, y := 3, 4
    b.Run("inlined", func(b *testing.B) {
        sum := 0
        for b.Loop() {
            sum += add(x, y) // Should be inlined → same as x+y
        }
        _ = sum
    })
    b.Run("not_inlined", func(b *testing.B) {
        sum := 0
        for b.Loop() {
            sum += addNoInline(x, y) // Function call overhead present
        }
        _ = sum
    })
}

// Run:
// go test -bench=BenchmarkAdd -gcflags="-m" .
// See which calls are inlined and measure ns/op difference
```

### Junior → FAANG: Inlining as a Benchmarking Discipline

The single most actionable takeaway from this section for junior engineers is the benchmark flag: `go test -bench=. -gcflags="-m"`. Running this on any hot function tells you immediately whether a call is inlined. When you see a benchmark result, always check whether inlining changed it. This habit signals to interviewers that you understand that benchmark numbers are meaningless without knowing what the compiler actually did to your code.

### Senior @ FAANG: Inlining Decisions as Architecture Trade-offs

At L6, inlining decisions intersect with API design. Functions with `recover` cannot be inlined. This is a concrete reason to avoid wrapping `recover` inside performance-critical helper functions. Interface method calls prevent devirtualization-assisted inlining unless the compiler can see the concrete type. This is a concrete reason to prefer generics over interfaces in hot paths. These are not abstract preferences but measurable performance decisions that should be documented when they occur in performance-sensitive code.

The `//go:noinline` directive creates a contract: this function must not be inlined because the benchmark or profiler showed that inlining it masks the true cost in profiles. Document why the directive exists, because the next engineer will remove it, benchmark, see no regression in their test, and delete it. The comment is the only guard against that.

---
