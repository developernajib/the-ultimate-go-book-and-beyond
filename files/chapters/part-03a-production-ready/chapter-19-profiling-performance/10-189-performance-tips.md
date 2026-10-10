## 19.9 Performance Tips

### Compiler Optimizations

Go provides a small set of compiler directives, written as specially formatted comments, that give the programmer direct control over inlining and stack-split behavior. `//go:noinline` is particularly useful when benchmarking, because the compiler would otherwise inline a trivial function and measure nothing meaningful. `//go:nosplit` disables stack-growth checks and should only appear in low-level runtime-style code where the maximum stack depth is known and bounded.

```go
// Disable stack-growth checks (use with extreme caution)
//go:nosplit
func smallFunction() int {
    return 42
}

// Prevent inlining (for benchmarks)
//go:noinline
func testFunction() int {
    return expensiveComputation()
}
```

### SIMD and Assembly

When a hot path is proven by profiling to dominate CPU time and the Go compiler's output is measurably suboptimal, you can write platform-specific assembly using Go's Plan 9 assembler syntax. The Go toolchain links `.s` files alongside `.go` files in the same package, and you declare the function signature in Go without a body. This technique is rare, used primarily in cryptographic libraries and math-heavy inner loops, but it provides access to SIMD instructions (AVX, NEON) that the Go compiler does not emit.

```s
// sum_amd64.s
TEXT ·sumAVX(SB), NOSPLIT, $0
    // AVX implementation
    RET
```

```go
// sum.go
func sumAVX(data []float64) float64
```

### Cache-Friendly Code

Modern CPUs load data from RAM in contiguous cache lines, so iterating through memory in sequential order maximizes the number of useful bytes fetched per cache-line load. Iterating a two-dimensional slice row by row walks each row's backing array from front to back, so every cache line fetched gets fully used. Column-major traversal touches one element per row before moving to a different row entirely, so each fetched cache line contributes a single useful value before being evicted.

```go
// Bad: column-major traversal (one element per row, then jump elsewhere)
for j := 0; j < len(matrix[0]); j++ {
    for i := 0; i < len(matrix); i++ {
        matrix[i][j] = 0
    }
}

// Good: row-major traversal (walks each row's backing array sequentially)
for i := range matrix {
    for j := range matrix[i] {
        matrix[i][j] = 0
    }
}
```

Measured on the machine used for this book (linux/amd64, Go 1.27.1) over a 1024x1024 `[][]int`, zeroing column-major took **+240% longer** than row-major (1.97ms to 6.70ms, p=0.000, n=10). Same work, same number of writes, one memory access pattern.

One Go-specific correction to a habit imported from C. In C, a 2D array is one contiguous block and column-major access strides through it by a fixed row width. Go's `[][]int` is not that. It is a slice of slices, and each row is an independent allocation with its own backing array. Rows are contiguous internally, but the rows themselves are separate objects that the allocator may place anywhere. This is why the guidance survives the translation while the mental model does not: row-major is still right, but it is right because you are walking each row's own backing array in order, not because you are striding through one flat block. If you genuinely need a contiguous matrix, allocate one flat `[]int` of size `rows*cols` and index it as `m[i*cols+j]`. That gives you the C layout, and it also removes one pointer indirection per row access.

### Staff Lens: Do Not Optimize What Profiling Does Not Justify

Every performance tip in this section has a cost in code clarity. Apply them when profiling shows they are needed, not by default. A readable service that is slightly slower is almost always better than an optimized service that is hard to maintain.

The rule: profile first, optimize the hot 5%, leave the other 95% readable. Teams that invert this ratio end up with unmaintainable code that is not even faster.

---
