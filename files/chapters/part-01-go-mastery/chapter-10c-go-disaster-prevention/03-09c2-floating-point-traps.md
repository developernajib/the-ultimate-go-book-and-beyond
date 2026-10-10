## 10C.2 Floating Point Traps

IEEE 754 floating-point arithmetic has well-defined but counterintuitive behavior that regularly trips up Go programmers. The two biggest traps are NaN propagation (which silently poisons calculations) and equality comparison (which fails for values that appear identical).

### NaN: The Silent Poison

NaN ("Not a Number") is a special float64 value that:
- Propagates through calculations silently
- Is **never equal to itself**: `NaN != NaN` is always true
- Comparison operators (`<`, `>`, `<=`, `>=`) always return `false` when NaN is involved

```go
package main

import (
    "fmt"
    "math"
    "sort"
)

func main() {
    // How NaN is produced.
    // Note the zero variable: writing 0.0 / 0.0 with untyped constants is a
    // compile-time error ("division by zero"). Only runtime float division
    // reaches IEEE 754 semantics.
    zero := 0.0
    nan1 := math.NaN()
    nan2 := zero / zero   // 0/0 produces NaN, and unlike int division, no panic
    nan3 := math.Sqrt(-1) // sqrt of a negative
    inf := math.Inf(1)
    nan4 := inf - inf     // ∞ - ∞ = NaN

    fmt.Println(nan1, nan2, nan3, nan4) // NaN NaN NaN NaN

    // THE TRAP: NaN != NaN
    fmt.Println(nan1 == nan1) // false! NaN is not equal to itself
    fmt.Println(nan1 < 0)     // false
    fmt.Println(nan1 > 0)     // false
    fmt.Println(nan1 == 0)    // false, so nan1 is "none of the above"

    // NaN propagation poisons calculations silently
    result := nan1 + 42.0
    fmt.Println(result) // NaN, the 42.0 is gone

    // Sorting: sort.Float64s and slices.Sort both order NaN before every
    // other value, so the result is deterministic. The danger is different:
    // a comparator you write yourself with a bare `a < b` is not a valid
    // strict weak ordering once NaN is in the slice, and the sort can then
    // leave the data in an arbitrary order.
    values := []float64{3.0, nan1, 1.0, 2.0}
    sort.Float64s(values)
    fmt.Println(values) // [NaN 1 2 3]

    // NaN in a max/min comparison always wins, which is rarely what you want
    fmt.Println(math.Max(nan1, 5.0)) // NaN, the 5.0 is eaten
    fmt.Println(math.Min(5.0, nan1)) // NaN
}

// CORRECT: Always check for NaN before using float results
func SafeDivide(a, b float64) (float64, error) {
    if b == 0 {
        return 0, fmt.Errorf("division by zero")
    }
    result := a / b
    if math.IsNaN(result) {
        return 0, fmt.Errorf("result is NaN")
    }
    if math.IsInf(result, 0) {
        return 0, fmt.Errorf("result is Inf")
    }
    return result, nil
}

// CORRECT: NaN-safe comparison
func IsNaN(f float64) bool { return f != f }
func IsFinite(f float64) bool { return !math.IsNaN(f) && !math.IsInf(f, 0) }
```

### Float Comparison: Never Use ==

Floating-point arithmetic is inherently imprecise. Two computations of the same value may differ in the last few bits. Equality comparison with `==` almost always produces incorrect results for floats.

```go
package main

import (
    "fmt"
    "math"
)

func main() {
    // THE CLASSIC TRAP.
    // Note that x and y must be variables. Go evaluates untyped constant
    // expressions with arbitrary precision, so `a := 0.1 + 0.2` computes
    // exactly 3/10 and only then rounds to float64, giving a == 0.3. The
    // discrepancy only appears once the addition happens at runtime.
    x, y := 0.1, 0.2
    a := x + y
    b := 0.3
    fmt.Println(a == b) // false, because 0.1+0.2 = 0.30000000000000004
    fmt.Println(a)      // 0.30000000000000004

    // CORRECT: Use epsilon comparison
    const epsilon = 1e-9
    fmt.Println(math.Abs(a-b) < epsilon) // true

    // For financial calculations, NEVER use float
    // Use integer cents, or a decimal library like shopspring/decimal
    price := 10.10
    qty := 3.0
    total := price * qty
    fmt.Println(total) // 30.299999999999997, not 30.30

    // CORRECT for money: use integer cents
    priceCents := int64(1010) // $10.10 = 1010 cents
    qty2 := int64(3)
    totalCents := priceCents * qty2 // 3030 cents = $30.30 exactly
    fmt.Printf("$%d.%02d\n", totalCents/100, totalCents%100) // $30.30
}

// AlmostEqual: relative-error comparison that degrades to an absolute
// comparison near zero, where relative error is meaningless.
//
// minNormal is the smallest normalized float64. Below it, floats are
// subnormal and lose precision, so relative comparison stops being useful.
// Do not reach for math.SmallestNonzeroFloat64 here: that is the smallest
// *subnormal* (about 5e-324), and scaling epsilon by it yields a threshold
// so small that nothing ever compares equal.
const minNormal = 2.2250738585072014e-308

func AlmostEqual(a, b, epsilon float64) bool {
    if a == b {
        return true // handles Inf == Inf and exact hits
    }
    if math.IsNaN(a) || math.IsNaN(b) {
        return false // NaN is equal to nothing, including itself
    }
    diff := math.Abs(a - b)
    sum := math.Abs(a) + math.Abs(b)
    if a == 0 || b == 0 || sum < minNormal {
        // Near zero, relative error is unusable. Compare absolutely.
        return diff < epsilon*minNormal
    }
    return diff/math.Min(sum, math.MaxFloat64) < epsilon
}
```

---
