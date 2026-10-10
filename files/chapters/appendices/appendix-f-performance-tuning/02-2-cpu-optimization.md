## 2. CPU Optimization

CPU optimization focuses on reducing computation time and improving instruction efficiency.

### 2.1 Hot Path Identification

**Finding Hot Paths**:

```go
// Example: Finding CPU hotspots in JSON processing
package main

import (
    "encoding/json"
    "testing"
)

type User struct {
    ID        int64    `json:"id"`
    Name      string   `json:"name"`
    Email     string   `json:"email"`
    Tags      []string `json:"tags"`
    Metadata  map[string]any `json:"metadata"`
}

func BenchmarkJSONMarshal(b *testing.B) {
    user := User{
        ID:    12345,
        Name:  "John Doe",
        Email: "john@example.com",
        Tags:  []string{"admin", "verified", "premium"},
        Metadata: map[string]any{
            "country": "US",
            "plan":    "enterprise",
        },
    }

    b.ReportAllocs()
    b.ResetTimer()

    for b.Loop() {
        _, err := json.Marshal(user)
        if err != nil {
            b.Fatal(err)
        }
    }
}

// Profile with:
// go test -bench=BenchmarkJSONMarshal -cpuprofile=cpu.prof
// go tool pprof -http=:8080 cpu.prof
```

**Optimized Version Using Code Generation**:

```go
//go:generate easyjson -all user.go

// User is now optimized with easyjson
type User struct {
    ID        int64                  `json:"id"`
    Name      string                 `json:"name"`
    Email     string                 `json:"email"`
    Tags      []string               `json:"tags"`
    Metadata  map[string]any `json:"metadata"`
}

func BenchmarkEasyJSONMarshal(b *testing.B) {
    user := User{
        ID:    12345,
        Name:  "John Doe",
        Email: "john@example.com",
        Tags:  []string{"admin", "verified", "premium"},
        Metadata: map[string]any{
            "country": "US",
            "plan":    "enterprise",
        },
    }

    b.ReportAllocs()
    b.ResetTimer()

    for b.Loop() {
        _, err := user.MarshalJSON() // Generated method
        if err != nil {
            b.Fatal(err)
        }
    }
}

// Typical results:
// BenchmarkJSONMarshal-8       500000      3245 ns/op    1024 B/op    12 allocs/op
// BenchmarkEasyJSONMarshal-8  2000000       856 ns/op     256 B/op     1 allocs/op
// ~3.8x faster, 4x less memory, 12x fewer allocations
```

### 2.2 Inlining Optimization

The Go compiler can inline small functions to eliminate call overhead.

**Understanding Inlining**:

```go
package main

import "testing"

// Simple function - likely to be inlined
func add(a, b int) int {
    return a + b
}

// Complex function - less likely to be inlined
func complexAdd(a, b int) int {
    result := a + b
    if result > 100 {
        result = result * 2
    }
    if result < 0 {
        result = -result
    }
    return result
}

// Force inlining hint (not an official Go pragma - the compiler decides inlining automatically)
// Note: There is no //go:inline directive in Go. Use small, simple functions to encourage inlining.
func mustInline(a, b int) int {
    return a + b
}

// Prevent inlining (useful for debugging)
//go:noinline
func noInline(a, b int) int {
    return a + b
}

func BenchmarkInlined(b *testing.B) {
    var result int
    for b.Loop() {
        result = add(i, i+1)
    }
    _ = result
}

func BenchmarkNotInlined(b *testing.B) {
    var result int
    for b.Loop() {
        result = noInline(i, i+1)
    }
    _ = result
}
```

**Check Inlining Decisions**:

```bash
# See inlining decisions
go build -gcflags='-m' main.go

# Output (example):
# ./main.go:6:6: can inline add
# ./main.go:11:6: cannot inline complexAdd: function too complex
# ./main.go:20:6: can inline mustInline
# ./main.go:28:6: cannot inline noInline: marked go:noinline

# More verbose inlining info
go build -gcflags='-m -m' main.go
```

**Inlining Best Practices**:

```go
// Good: Small, simple functions inline well
// Note: min()/max() are builtin since Go 1.21, shown here as inlining example
func add(a, b int) int {
    return a + b
}

// Good: Simple arithmetic
func calculateTax(price, rate float64) float64 {
    return price * rate
}

// Bad: Too complex for inlining
func processOrder(order Order) error {
    if err := validateOrder(order); err != nil {
        return err
    }
    if err := calculateShipping(order); err != nil {
        return err
    }
    if err := applyDiscounts(order); err != nil {
        return err
    }
    return saveOrder(order)
}

// Solution: Keep hot path simple, extract complexity
func processOrderFast(order Order) error {
    // Simple validation that can inline
    if order.ID == 0 {
        return ErrInvalidID
    }
    // Complex logic in separate function
    return processOrderComplex(order)
}
```

### 2.3 Bounds Check Elimination

Go automatically checks array/slice bounds. We can help eliminate these checks.

**Understanding Bounds Checks**:

```go
package main

import "testing"

func sumSlice(data []int) int {
    var sum int
    // Each data[i] incurs a bounds check
    for i := 0; i < len(data); i++ {
        sum += data[i]
    }
    return sum
}

func sumSliceOptimized(data []int) int {
    var sum int
    // Range eliminates bounds checks
    for _, v := range data {
        sum += v
    }
    return sum
}

func sumSliceHinted(data []int) int {
    var sum int
    n := len(data)
    // Compiler can prove i < n
    for i := 0; i < n; i++ {
        sum += data[i] // Bounds check eliminated
    }
    return sum
}

func sumSliceManual(data []int) int {
    if len(data) == 0 {
        return 0
    }

    var sum int
    // Manual bounds check elimination
    _ = data[len(data)-1] // Hint to compiler

    for i := 0; i < len(data); i++ {
        sum += data[i] // No bounds check
    }
    return sum
}

// Check bounds checks:
// go build -gcflags='-d=ssa/check_bce/debug=1' main.go
```

**Matrix Operations Example**:

```go
// Suboptimal: Multiple bounds checks
func multiplyMatrixSlow(a, b [][]float64) [][]float64 {
    n := len(a)
    result := make([][]float64, n)
    for i := 0; i < n; i++ {
        result[i] = make([]float64, n)
        for j := 0; j < n; j++ {
            for k := 0; k < n; k++ {
                result[i][j] += a[i][k] * b[k][j] // 3 bounds checks per iteration
            }
        }
    }
    return result
}

// Optimized: Eliminate bounds checks
func multiplyMatrixFast(a, b [][]float64) [][]float64 {
    n := len(a)
    result := make([][]float64, n)

    for i := 0; i < n; i++ {
        result[i] = make([]float64, n)
        rowA := a[i]    // Cache row
        rowR := result[i]

        for j := 0; j < n; j++ {
            var sum float64
            for k := 0; k < n; k++ {
                sum += rowA[k] * b[k][j]
            }
            rowR[j] = sum
        }
    }
    return result
}

// Even better: Flat array with manual indexing
func multiplyMatrixFlat(a, b []float64, n int) []float64 {
    result := make([]float64, n*n)

    for i := 0; i < n; i++ {
        for j := 0; j < n; j++ {
            var sum float64
            for k := 0; k < n; k++ {
                sum += a[i*n+k] * b[k*n+j]
            }
            result[i*n+j] = sum
        }
    }
    return result
}
```

### 2.4 Branch Prediction

Modern CPUs predict branch outcomes. Predictable branches are faster.

**Branch Prediction Friendly Code**:

```go
// Unpredictable: Random conditions
func processItemsUnpredictable(items []Item) int {
    count := 0
    for _, item := range items {
        // Unpredictable branch
        if item.Value%2 == 0 {
            count++
        }
    }
    return count
}

// Predictable: Sorted data helps branch prediction
func processItemsSorted(items []Item) int {
    count := 0
    for _, item := range items {
        // After first few iterations, branch becomes predictable
        if item.Value > 100 {
            count++
        }
    }
    return count
}

// Branch-free: Use arithmetic instead
func processItemsBranchFree(items []Item) int {
    count := 0
    for _, item := range items {
        // Convert boolean to int: true=1, false=0
        count += int(item.Value&1 == 0)
    }
    return count
}

// Even better: Bit manipulation
func countEvenBranchFree(items []int) int {
    count := 0
    for _, val := range items {
        // If even (LSB=0), add 1 - if odd (LSB=1), add 0
        count += 1 - (val & 1)
    }
    return count
}
```

**Real-World Example: Fast Path Optimization**:

```go
// HTTP router with predictable branches
type Router struct {
    commonRoutes map[string]http.HandlerFunc // Hot routes
    allRoutes    map[string]http.HandlerFunc // All routes
}

func (r *Router) ServeHTTP(w http.ResponseWriter, req *http.Request) {
    path := req.URL.Path

    // Fast path: Check common routes first (predictable branch)
    if handler, ok := r.commonRoutes[path]; ok {
        handler(w, req)
        return
    }

    // Slow path: Check all routes
    if handler, ok := r.allRoutes[path]; ok {
        handler(w, req)
        return
    }

    http.NotFound(w, req)
}
```

### 2.5 SIMD Concepts

Single Instruction Multiple Data (SIMD) processes multiple values simultaneously.

**Manual SIMD-like Optimization**:

```go
package main

import "testing"

// Scalar: Process one at a time
func sumScalar(data []float64) float64 {
    var sum float64
    for _, v := range data {
        sum += v
    }
    return sum
}

// Unrolled: Process multiple per iteration (SIMD-like)
func sumUnrolled4(data []float64) float64 {
    var sum1, sum2, sum3, sum4 float64

    i := 0
    n := len(data)

    // Process 4 at a time
    for ; i+3 < n; i += 4 {
        sum1 += data[i]
        sum2 += data[i+1]
        sum3 += data[i+2]
        sum4 += data[i+3]
    }

    // Handle remainder
    sum := sum1 + sum2 + sum3 + sum4
    for ; i < n; i++ {
        sum += data[i]
    }

    return sum
}

// Using assembly for true SIMD (AVX2)
//go:noescape
func sumAVX2(data []float64) float64

// Note: sumAVX2 would be implemented in .s file
// This is advanced - usually not needed
```

**When SIMD Matters**:

- Video/image processing
- Scientific computing
- Financial calculations (large datasets)
- Machine learning inference

For most Go applications, trust the compiler's auto-vectorization and focus on algorithmic improvements first.

---
