export default `## 10C.2 Floating Point Traps

IEEE 754 floating-point arithmetic has well-defined but counterintuitive behavior that regularly trips up Go programmers. The two biggest traps are NaN propagation (which silently poisons calculations) and equality comparison (which fails for values that appear identical).

### NaN: The Silent Poison

NaN ("Not a Number") is a special float64 value that:
- Propagates through calculations silently
- Is **never equal to itself**: \`NaN != NaN\` is always true
- Comparison operators (\`<\`, \`>\`, \`<=\`, \`>=\`) always return \`false\` when NaN is involved

\`\`\`go
package main

import (
    "fmt"
    "math"
)

func main() {
    // How NaN is produced
    nan1 := math.NaN()
    nan2 := 0.0 / 0.0   // 0/0 produces NaN (unlike int division by zero, no panic!)
    nan3 := math.Sqrt(-1) // sqrt of negative
    inf := math.Inf(1)
    nan4 := inf - inf    // ∞ - ∞ = NaN

    fmt.Println(nan1, nan2, nan3, nan4) // NaN NaN NaN NaN

    // THE TRAP: NaN != NaN
    fmt.Println(nan1 == nan1) // false! NaN is not equal to itself
    fmt.Println(nan1 < 0)     // false
    fmt.Println(nan1 > 0)     // false
    fmt.Println(nan1 == 0)    // false - so nan1 appears to be "none of the above"

    // NaN propagation - poisons calculations silently
    result := nan1 + 42.0
    fmt.Println(result) // NaN - the 42.0 is gone!

    // DISASTER: NaN in a sort makes the sort nondeterministic
    values := []float64{3.0, nan1, 1.0, 2.0}
    // sort.Float64s(values) - behavior is undefined when NaN present!

    // NaN in a max/min comparison always loses
    fmt.Println(math.Max(nan1, 5.0)) // NaN - 5.0 is eaten!
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
\`\`\`

### Float Comparison: Never Use ==

Floating-point arithmetic is inherently imprecise. Two computations of the same value may differ in the last few bits. Equality comparison with \`==\` almost always produces incorrect results for floats.

\`\`\`go
package main

import (
    "fmt"
    "math"
)

func main() {
    // THE CLASSIC TRAP
    a := 0.1 + 0.2
    b := 0.3
    fmt.Println(a == b)  // false! 0.1+0.2 = 0.30000000000000004
    fmt.Println(a)        // 0.30000000000000004

    // CORRECT: Use epsilon comparison
    const epsilon = 1e-9
    fmt.Println(math.Abs(a-b) < epsilon) // true

    // For financial calculations, NEVER use float
    // Use integer cents, or a decimal library like shopspring/decimal
    price := 10.10
    qty := 3.0
    total := price * qty
    fmt.Println(total) // 30.299999999999997 - NOT 30.30!

    // CORRECT for money: use integer cents
    priceCents := int64(1010) // \$10.10 = 1010 cents
    qtyCents := int64(3)
    totalCents := priceCents * qtyCents // 3030 cents = \$30.30 exactly
    fmt.Printf("\$%d.%02d\\n", totalCents/100, totalCents%100) // \$30.30
}

// AlmostEqual: safe float comparison with ULP-based epsilon
func AlmostEqual(a, b, epsilon float64) bool {
    if a == b {
        return true // handles Inf == Inf
    }
    diff := math.Abs(a - b)
    if a == 0 || b == 0 || diff < math.SmallestNonzeroFloat64 {
        return diff < epsilon*math.SmallestNonzeroFloat64
    }
    return diff/(math.Abs(a)+math.Abs(b)) < epsilon
}
\`\`\`

---
`;
