## 76.4 Advanced Bit Tricks

### Sum Without Arithmetic

Binary addition can be decomposed into two operations: `a XOR b` computes the sum bits without carrying, and `(a AND b) << 1` computes the carry bits. Iterating this substitution until no carry remains produces the final sum using only bitwise operations, which is a common interview curiosity demonstrating hardware-level addition logic.

```go
import "math"

// GetSum calculates a + b without the + or - operators.
// LeetCode 371: Sum of Two Integers
//
// This is correct across the full int range, including cases that overflow.
// Go defines signed integer overflow as wrapping (unlike C, where it is
// undefined behaviour), so the carry propagation here matches what + does.
func GetSum(a int, b int) int {
    for b != 0 {
        carry := (a & b) << 1
        a = a ^ b
        b = carry
    }
    return a
}

// Subtract using bit manipulation
func Subtract(a int, b int) int {
    return GetSum(a, GetSum(^b, 1))
}

// Multiply using shift-and-add (the classic "Russian peasant" method).
//
// Note the same asymmetry caveat as Divide: if a or b is math.MinInt, then
// -a == a and the sign normalization below silently fails. The inputs are
// assumed to be well inside the int range. In real code, use *.
func Multiply(a int, b int) int {
    negative := (a < 0) != (b < 0)
    if a < 0 {
        a = -a
    }
    if b < 0 {
        b = -b
    }

    result := 0
    for b > 0 {
        if b&1 == 1 {
            result = GetSum(result, a)
        }
        a <<= 1
        b >>= 1
    }

    if negative {
        return -result
    }
    return result
}

// Divide performs integer division using only shifts and subtraction.
// LeetCode 29: Divide Two Integers, which truncates toward zero.
//
// Three guards here are load-bearing, and the original version of this function
// (a common one, found all over the internet) had none of them right:
//
//  1. divisor == 0 must be rejected up front. Without it, `for a >= b` with
//     b == 0 never terminates: a >= 0 is always true and b<<k stays 0, so the
//     shift counter runs away. An infinite loop, not a panic.
//
//  2. The overflow clamp must use the bounds of the type you actually have.
//     Writing `dividend == -1<<31 && divisor == -1 { return 1<<31 - 1 }` is
//     correct for a 32-bit int and wrong for Go's int: 2^31 is perfectly
//     representable in 64 bits, so that clamp returns 2147483647 for a
//     division whose true answer is 2147483648. Use math.MinInt/math.MaxInt.
//     LeetCode's int32 framing is the source of this bug, not a justification
//     for it.
//
//  3. abs(math.MinInt) is still negative (two's complement is asymmetric), so
//     the loop below would compare a negative `a` and return 0. Handle the one
//     genuinely non-representable case, MinInt / -1, before taking abs.
func Divide(dividend int, divisor int) int {
    if divisor == 0 {
        panic("integer divide by zero")
    }

    // The only true overflow in two's complement division.
    if dividend == math.MinInt && divisor == -1 {
        return math.MaxInt
    }

    negative := (dividend < 0) != (divisor < 0)

    // Accumulate in uint so that abs(math.MinInt) is representable.
    a := absToUint(dividend)
    b := absToUint(divisor)
    var result uint

    for a >= b {
        shift := 0
        // Guard the shift itself: b<<(shift+1) must not overflow uint.
        for b<<(shift+1) <= a && b<<(shift+1) > b<<shift {
            shift++
        }
        result += 1 << shift
        a -= b << shift
    }

    if negative {
        return -int(result)
    }
    return int(result)
}

// absToUint returns |n| as a uint, which is exact for every int including
// math.MinInt, where a plain -n would overflow back to itself.
func absToUint(n int) uint {
    if n < 0 {
        return uint(-(n + 1)) + 1
    }
    return uint(n)
}
```

### Finding Duplicates and Missing

XOR's key property (that XORing a value with itself cancels to zero) makes it ideal for detecting a single anomaly in a set where every other element appears exactly once. When both a missing and a repeating number must be found simultaneously, XORing the entire array with `1..n` yields `missing XOR repeating`. Isolating any differing bit (via `xorAll & -xorAll`) then partitions both sequences into two independent groups, each solvable with a single XOR scan.

```go
// FindDuplicate finds the duplicate in array of 1 to n
// (Using bit manipulation - alternative to Floyd's algorithm)
// LeetCode 287: Find the Duplicate Number
func FindDuplicateBits(nums []int) int {
    n := len(nums) - 1
    result := 0

    for bit := 0; bit < 32; bit++ {
        mask := 1 << bit
        countNums := 0
        countExpected := 0

        for i := 0; i <= n; i++ {
            if i&mask != 0 {
                countExpected++
            }
            if nums[i]&mask != 0 {
                countNums++
            }
        }

        if countNums > countExpected {
            result |= mask
        }
    }

    return result
}

// FindMissingAndRepeating finds both missing and repeating number
func FindMissingAndRepeating(nums []int) (int, int) {
    n := len(nums)

    // XOR all numbers and 1 to n
    xorAll := 0
    for i := 1; i <= n; i++ {
        xorAll ^= i
        xorAll ^= nums[i-1]
    }

    // xorAll = missing ^ repeating

    // Find rightmost set bit
    rightBit := xorAll & (-xorAll)

    // Divide into two groups
    var group1, group2 int
    for i := 1; i <= n; i++ {
        if i&rightBit != 0 {
            group1 ^= i
        } else {
            group2 ^= i
        }
        if nums[i-1]&rightBit != 0 {
            group1 ^= nums[i-1]
        } else {
            group2 ^= nums[i-1]
        }
    }

    // Determine which is missing and which is repeating
    for _, num := range nums {
        if num == group1 {
            return group2, group1 // group2 is missing, group1 is repeating
        }
    }
    return group1, group2
}
```

### UTF-8 Validation

UTF-8 encodes code points using 1-4 bytes where the leading byte signals the total byte count via its high-bit prefix (`0xxxxxxx`, `110xxxxx`, `1110xxxx`, `11110xxx`) and every subsequent continuation byte must match the pattern `10xxxxxx`. Right-shifting the byte by the appropriate amount and comparing against these binary constants lets bitwise operations validate the encoding without any string parsing, making the check straightforward to verify against the exact bit-level specification.

```go
// ValidUtf8 checks if byte array is valid UTF-8
// LeetCode 393: UTF-8 Validation
func ValidUtf8(data []int) bool {
    remaining := 0

    for _, b := range data {
        if remaining > 0 {
            // Continuation byte must start with 10
            if (b >> 6) != 0b10 {
                return false
            }
            remaining--
        } else {
            // Determine number of bytes in character
            if (b >> 7) == 0 {
                remaining = 0 // 1-byte character
            } else if (b >> 5) == 0b110 {
                remaining = 1 // 2-byte character
            } else if (b >> 4) == 0b1110 {
                remaining = 2 // 3-byte character
            } else if (b >> 3) == 0b11110 {
                remaining = 3 // 4-byte character
            } else {
                return false
            }
        }
    }

    return remaining == 0
}
```

### Junior -> FAANG: Advanced Tricks as Teaching Moments

The `GetSum` function (adding without `+`) is an interview artifact almost never used in production, but understanding it reveals how hardware adders work: XOR computes the sum bits without carry, AND followed by left-shift computes the carry bits, and iterating converges because carries eventually run out. This understanding matters when you encounter questions about integer overflow detection in ALU design or when you need to implement safe integer arithmetic for cryptography.

The `FindDuplicateBits` and `FindMissingAndRepeating` functions are harder than they look. The key prerequisite is understanding why XOR of a range `1..n` is predictable: it follows the pattern `[n, 1, n+1, 0]` cycling with period 4 based on n mod 4. Know this pattern so you can compute `XOR(1..n)` in O(1) without a loop: if `n % 4 == 0` the result is `n` - if `n % 4 == 1` the result is `1` - if `n % 4 == 2` the result is `n+1` - if `n % 4 == 3` the result is `0`. Use this O(1) formula rather than a loop when the range is large.

For UTF-8 validation, the bit-level approach maps directly to the RFC 3629 specification. Practice reading binary literals in Go (`0b10xxxxxx`) and translating the spec byte patterns into shift-and-compare expressions.

### Senior @ FAANG: Production Arithmetic Without `+` and Safe Division

The `GetSum` and `Divide` functions above serve as references for understanding how hardware arithmetic works, but in production Go you would never implement them this way. The value for a senior engineer is different: they expose the assumptions Go's integer arithmetic bakes in, and the review discipline they demand generalizes.

`Divide` is the more instructive of the two, because the version that circulates online is wrong in three separate ways that all share one root cause: it was written for a 32-bit int and then typed as Go's `int`. The overflow clamp `dividend == -1<<31 && divisor == -1` is the tell. Those are int32 bounds, and on a 64-bit `int` they clamp a result (2^31) that is perfectly representable, so the function returns 2147483647 for a division whose answer is 2147483648. Meanwhile the real overflow case, `math.MinInt / -1`, sails straight through unguarded into an `abs` that cannot represent its own result. Add a zero divisor and the loop simply never terminates. LeetCode's int32 constraints hide all three, which is exactly why they survive the copy into production. When you see a bare `1<<31` in Go code operating on `int`, treat it as a bug until proven otherwise, and reach for `math.MaxInt` and `math.MinInt`.

The performance point is worth stating accurately too. `Divide` loops O(log(dividend/divisor)) times, so it is *slowest* for small divisors, where the quotient is large. Hardware `DIV` is a single instruction (not literally O(1) in latency, it is one of the slowest integer instructions on most cores, but it is constant work rather than a loop). The lesson is that reimplementing arithmetic in software is almost always wrong except in two contexts: extending arithmetic beyond machine word size via `math/big`, and constant-time arithmetic for cryptographic code that must not leak secrets through timing.

For UTF-8 validation in production, use `unicode/utf8.Valid` from the standard library rather than a hand-rolled bit parser. The standard library implementation handles edge cases (overlong encodings, surrogate code points, values beyond U+10FFFF) that are easy to miss in a hand-rolled version. In a security review, any hand-rolled UTF-8 parser should immediately raise the question: "does this correctly reject the five categories of invalid sequences that browsers historically exploited?" Require a test suite that covers all RFC 3629 invalid byte sequences before approving a custom implementation.
