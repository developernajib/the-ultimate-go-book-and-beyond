export default `## 10C.1 Integer Overflow and Underflow

### What It Is

Go integers have fixed sizes: \`int8\`, \`int16\`, \`int32\`, \`int64\`, and the platform-dependent \`int\` (64-bit on modern systems). When a value exceeds the maximum for its type, Go **silently wraps around** - no panic, no error, no warning.

\`\`\`
┌──────────────────────────────────────────────────────────────────┐
│              Integer Overflow - Silent Wraparound                │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  int8 range: -128 to 127                                        │
│                                                                  │
│  var x int8 = 127                                               │
│  x++   →  x = -128   (silent! no panic, no error)              │
│                                                                  │
│  uint8 range: 0 to 255                                          │
│                                                                  │
│  var y uint8 = 255                                              │
│  y++   →  y = 0      (silent! wraps to zero)                   │
│                                                                  │
│  This is DEFINED behavior in Go (unlike C where it's UB)       │
│  but it is STILL a bug in your business logic                  │
└──────────────────────────────────────────────────────────────────┘
\`\`\`

### The Disaster: Silent Financial Corruption

Integer overflow in financial calculations is a critical bug class because Go does not panic on overflow, it silently wraps around, producing incorrect results. The following example shows how using \`int32\` for monetary values can corrupt totals on large transactions without any runtime error.

\`\`\`go
package main

import "fmt"

// DISASTER: int32 can hold max 2,147,483,647 cents (~\$21 million)
// A large transaction will silently overflow and produce wrong totals.
type Order struct {
    Items []int32 // price in cents
}

func (o *Order) Total() int32 {
    var total int32
    for _, price := range o.Items {
        total += price // SILENT OVERFLOW if total > 2,147,483,647
    }
    return total
}

func main() {
    order := Order{
        Items: []int32{
            2_000_000_00, // \$2,000,000.00 (200 million cents)
            2_000_000_00, // \$2,000,000.00
        },
    }
    fmt.Println(order.Total()) // prints: -294967296 - NOT \$4,000,000!
}
\`\`\`

### Why It Happens

Go follows two's complement arithmetic. For \`int32\`:
- Maximum value: \`2^31 - 1 = 2,147,483,647\`
- Adding 1 to max: the sign bit flips, producing \`-2,147,483,648\`
- This is **completely silent** - the CPU instruction just wraps

### The Fix: Safe Arithmetic with Overflow Detection

Go's standard library provides \`math/bits\` for unsigned overflow detection, and you can write pre-condition checks for signed arithmetic. The following example demonstrates three approaches: bounds checking before the operation, using \`math/bits\`, and wrapping monetary values in a safe type.

\`\`\`go
package main

import (
    "errors"
    "fmt"
    "math"
    "math/bits"
)

// --- Method 1: Check before the operation (preferred for business logic) ---

var ErrOverflow = errors.New("integer overflow")

func AddInt64Safe(a, b int64) (int64, error) {
    // If both positive and result would exceed MaxInt64
    if b > 0 && a > math.MaxInt64-b {
        return 0, ErrOverflow
    }
    // If both negative and result would go below MinInt64
    if b < 0 && a < math.MinInt64-b {
        return 0, ErrOverflow
    }
    return a + b, nil
}

func MulInt64Safe(a, b int64) (int64, error) {
    if a == 0 || b == 0 {
        return 0, nil
    }
    result := a * b
    // Verify: if result/a != b, overflow occurred
    if result/a != b {
        return 0, ErrOverflow
    }
    return result, nil
}

// --- Method 2: Use math/bits for unsigned overflow detection ---

func AddUint64Safe(a, b uint64) (uint64, bool) {
    result, carry := bits.Add64(a, b, 0)
    return result, carry == 0 // false means overflow
}

// --- Method 3: Use int64 for financial calculations (never int32) ---

type Money struct {
    Cents int64 // Always use int64: supports \$92 quadrillion before overflow
}

func (m Money) Add(other Money) (Money, error) {
    result, err := AddInt64Safe(m.Cents, other.Cents)
    if err != nil {
        return Money{}, fmt.Errorf("money addition overflow: %w", err)
    }
    return Money{Cents: result}, nil
}

// --- Production Pattern: Integer overflow in loop ---

func SafeSum(values []int64) (int64, error) {
    var total int64
    for _, v := range values {
        var err error
        total, err = AddInt64Safe(total, v)
        if err != nil {
            return 0, fmt.Errorf("sum overflow after %d elements: %w", len(values), err)
        }
    }
    return total, nil
}

func main() {
    // Safe addition
    result, err := AddInt64Safe(math.MaxInt64, 1)
    fmt.Println(result, err) // 0, integer overflow

    // Safe money
    a := Money{Cents: 200_000_000_00} // \$2,000,000.00
    b := Money{Cents: 200_000_000_00}
    total, err := a.Add(b)
    fmt.Println(total.Cents, err) // 400000000000 <nil> - correct!

    // Overflow detection
    sum, err := SafeSum([]int64{math.MaxInt64, 1})
    fmt.Println(sum, err) // 0, sum overflow after 2 elements: integer overflow
}
\`\`\`

### Integer Conversion Traps

Converting between integer types can silently truncate values or change sign interpretation. Explicit range checks before conversion prevent silent data corruption when processing external input.

\`\`\`go
package main

import "fmt"

func main() {
    // TRAP 1: int64 to int32 truncation - silent data corruption
    var big int64 = 3_000_000_000
    var small int32 = int32(big) // SILENT TRUNCATION
    fmt.Println(small)           // -1294967296 - wrong!

    // FIX: Check bounds before converting
    if big > math.MaxInt32 || big < math.MinInt32 {
        fmt.Println("ERROR: value does not fit in int32")
    }

    // TRAP 2: Unsigned to signed conversion
    var u uint64 = math.MaxUint64
    var s int64 = int64(u) // becomes -1
    fmt.Println(s)         // -1 - silent!

    // TRAP 3: int to uint - negative numbers become huge positives
    var neg int = -1
    var u2 uint = uint(neg)
    fmt.Println(u2) // 18446744073709551615 (MaxUint64) - a disaster in slice indexing!

    // TRAP 4: Indexing with a negative int converted to uint
    slice := []int{1, 2, 3}
    idx := -1
    // slice[uint(idx)] would panic with index out of range [18446744073709551615]
    // Always check before converting
    if idx < 0 || idx >= len(slice) {
        fmt.Println("invalid index")
    }
}
\`\`\`

**Rule of thumb:** Use \`int64\` for all counts and financial values. Use \`math/big\` for arbitrary precision. Never convert between integer types without bounds checking.

---
`;
