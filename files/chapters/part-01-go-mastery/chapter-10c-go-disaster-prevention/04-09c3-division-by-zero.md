## 10C.3 Division by Zero

Division by zero behaves differently for integers and floats in Go, and this inconsistency trips up many developers. Integer division by zero causes an immediate panic that crashes your program. Float division by zero, however, does not panic at all, it silently returns special values like positive infinity, negative infinity, or NaN. These special float values then propagate through all subsequent calculations, corrupting results without any visible error.

```go
package main

import (
    "fmt"
    "math"
)

func main() {
    // INTEGER division by zero: PANICS immediately
    // panic: runtime error: integer divide by zero
    // a := 10 / 0  // compile error, the compiler catches constant zero
    b := 0
    // c := 10 / b  // runtime panic, b is a variable so the compiler cannot

    // FLOAT division by zero: does NOT panic, it returns ±Inf or NaN.
    // The zero must be a variable here too. Constant float division by a
    // constant zero is also a compile error, so `x := 10.0 / 0.0` never
    // reaches IEEE 754 at all.
    zero := 0.0
    x := 10.0 / zero     // +Inf, no panic
    y := -10.0 / zero    // -Inf, no panic
    z := zero / zero     // NaN, no panic
    fmt.Println(x, y, z) // +Inf -Inf NaN

    // This inconsistency traps engineers coming from other languages.
    // Inf and NaN silently poison every downstream calculation.
    result := x * 2.0
    fmt.Println(result) // +Inf, still Inf, no panic

    _ = b
    _ = math.IsInf(x, 0)
}

// Always guard division
func Divide(a, b int64) (int64, error) {
    if b == 0 {
        return 0, fmt.Errorf("division by zero")
    }
    // Also guard against MinInt64 / -1. Per the Go spec this does NOT panic,
    // it silently overflows back to MinInt64 (-9223372036854775808), which is
    // a wrong answer rather than a crash.
    if a == math.MinInt64 && b == -1 {
        return 0, fmt.Errorf("overflow: MinInt64 / -1")
    }
    return a / b, nil
}

func DivideFloat(a, b float64) (float64, error) {
    if b == 0 {
        return 0, fmt.Errorf("float division by zero")
    }
    result := a / b
    if math.IsInf(result, 0) || math.IsNaN(result) {
        return 0, fmt.Errorf("float division produced invalid result: %v", result)
    }
    return result, nil
}
```

---
