## 76.1 Fundamental Bit Operations

### Basic Operations

Bitwise operations manipulate individual bits within an integer, enabling O(1) computations that would otherwise require loops or arithmetic. The operations are AND `&`, OR `|`, XOR `^`, left shift `<<`, and right shift `>>`, plus two that deserve special mention in Go.

The first is `^` used as a unary operator, which is bitwise NOT. Go spells complement with `^x`, not `~x` as C does, so `^` does double duty: binary XOR and unary NOT.

The second is `&^`, AND NOT, also called bit clear. `x &^ y` clears from `x` every bit set in `y`, making it exactly one operator instead of C's `x & ~y`. It has no C equivalent and is easy to miss, but it is the idiomatic way to clear bits in Go, and it is worth knowing that `&^=` exists too.

Two Go properties matter before the code, because both are places where C intuition misleads. Right shift on a **signed** integer is arithmetic: it fills from the left with the sign bit, so `-8 >> 1` is `-4`, not a large positive number. On an **unsigned** integer it is logical, filling with zeros. This single distinction is behind a large share of wrong answers in bit problems, so decide deliberately whether a value is signed. And shift counts are not undefined behaviour in Go the way they are in C: shifting a `uint64` by 64 or more yields 0 rather than garbage, and Go permits shifts by any amount. A negative shift count panics at runtime.

```go
package bits

import "math/bits"

// GetBit returns the i-th bit of n
func GetBit(n, i int) int {
    return (n >> i) & 1
}

// SetBit sets the i-th bit of n to 1
func SetBit(n, i int) int {
    return n | (1 << i)
}

// ClearBit sets the i-th bit of n to 0.
// Uses Go's AND NOT operator, which is one operator rather than C's & ~.
func ClearBit(n, i int) int {
    return n &^ (1 << i)
}

// ToggleBit flips the i-th bit of n
func ToggleBit(n, i int) int {
    return n ^ (1 << i)
}

// UpdateBit sets the i-th bit to v (0 or 1)
func UpdateBit(n, i, v int) int {
    mask := ^(1 << i)
    return (n & mask) | (v << i)
}

// CountSetBits returns number of 1 bits (population count)
func CountSetBits(n int) int {
    count := 0
    for n != 0 {
        count++
        n &= n - 1 // Clear rightmost 1 bit
    }
    return count
}

// CountSetBitsBuiltin uses Go's built-in
func CountSetBitsBuiltin(n uint) int {
    return bits.OnesCount(n)
}

// IsPowerOfTwo checks if n is a power of 2
func IsPowerOfTwo(n int) bool {
    return n > 0 && (n&(n-1)) == 0
}

// RightmostSetBit returns position of rightmost 1 bit (0-indexed)
func RightmostSetBit(n int) int {
    if n == 0 {
        return -1
    }
    return bits.TrailingZeros(uint(n))
}

// LowestSetBit returns the value of the lowest set bit
func LowestSetBit(n int) int {
    return n & (-n)
}

// ClearLowestSetBit clears the lowest set bit
func ClearLowestSetBit(n int) int {
    return n & (n - 1)
}
```

### Two's Complement and Negation

```go
// Two's complement representation:
// -x = ^x + 1   (Go spells bitwise NOT as unary ^, not ~)
//
// Example for 8-bit:
// 5 =  00000101
// -5 = 11111011 (flip bits and add 1)

// shiftAll is the shift needed to smear the sign bit across the whole word.
// Do NOT hardcode 63. The Go spec leaves the width of int implementation
// defined, and bits.UintSize is the portable way to ask (64 on every platform
// Go currently supports, 32 on a hypothetical 32-bit target).
const shiftAll = bits.UintSize - 1

// Abs returns the absolute value of n without branching.
//
// Abs(math.MinInt) returns math.MinInt. This is not a bug in the trick, it is
// two's complement: the range is asymmetric, so -math.MinInt is not
// representable. Any abs, branchless or not, has to either return this or
// panic. Document it, or use a wider type.
func Abs(n int) int {
    mask := n >> shiftAll // All 1s if negative, all 0s otherwise.
    return (n + mask) ^ mask
}

// Min and Max: prefer the builtins.
//
// Go 1.21 added min and max as builtins, so this is the entire correct
// implementation. It is also branchless once compiled.
func Min(a, b int) int { return min(a, b) }
func Max(a, b int) int { return max(a, b) }

// The classic branchless versions are shown only to be refuted, because they
// circulate widely and they are broken:
//
//     func Min(a, b int) int {
//         diff := a - b                        // OVERFLOWS
//         return b + (diff & (diff >> 63))
//     }
//
// The subtraction a - b overflows whenever the true difference falls outside
// the int range, and then the sign of diff is the opposite of the sign of the
// real difference, so the function confidently returns the wrong operand.
// Min(math.MaxInt64, -1) yields MaxInt64. Fuzzing it against the builtin over
// uniformly random int64 pairs disagrees on about a quarter of them, so this
// is not an exotic edge case, it is a coin flip on wide inputs.
//
// The same overflow is why comparators must use cmp.Compare(a, b) rather than
// returning a - b. Same bug, different costume.

// Swap: do not use XOR swap. Use Go's tuple assignment.
//
// The XOR trick (a ^= b - b ^= a - a ^= b) is a correctness hazard, not a
// cleverness. When both operands name the same memory, the first XOR zeroes
// the value and it is gone. Tuple assignment is correct even when i == j, is
// clearer, and compiles to the same or better code. There is no case in Go
// where XOR swap is the right answer.
func Swap(a, b int) (int, int) {
    return b, a
}

// SignOf returns -1, 0, or 1.
// Correct across the full range, including math.MinInt.
func SignOf(n int) int {
    return (n >> shiftAll) | int(uint(-n)>>shiftAll)
}
```

### Junior -> FAANG: Getting Bit Operations Right Under Pressure

The operations shown above (GetBit, SetBit, ClearBit, ToggleBit, UpdateBit, CountSetBits) are the vocabulary of bit manipulation. In an interview you will rarely be asked to implement them by name. You will be asked to solve a problem that requires composing them correctly. The risk is that under stress you confuse `ClearBit` (AND NOT: `n &^ mask`) with `ToggleBit` (XOR: `n ^ mask`). The mnemonic: clearing forces a bit to zero regardless of what was there, which needs AND NOT. Toggling flips whatever is there, which is exactly what XOR does.

The branchless `Abs` is a classic interview surprise. Trace it for n = -5: right-shifting a **signed** integer fills with the sign bit, so `(-5) >> 63` on a 64-bit int is all ones, which is -1. Then `(n + mask) ^ mask` becomes `(-5 + (-1)) ^ (-1) = (-6) ^ (-1)`. In two's complement `-6` is `...11111010` and `-1` is `...11111111`, so the XOR gives `...00000101 = 5`. The whole trick rests on `>>` being arithmetic on signed types. Had `n` been unsigned, the shift would fill with zeros, the mask would be 0, and the function would return `n` unchanged.

Two details to state rather than absorb silently. The shift constant is written `bits.UintSize - 1`, not `63`, because the Go spec does not fix the width of `int`. It is 64 on every platform Go currently supports, so `63` happens to work today, but writing the assumption down costs nothing and makes it checkable. And `Abs(math.MinInt)` returns `math.MinInt`, because two's complement has one more negative value than positive and `-math.MinInt` does not exist. That is a property of the representation, not of the trick.

### Senior @ FAANG: Production Use of Fundamental Operations

The primitive operations above form the foundation of several production patterns. In a permission system, `SetBit` and `ClearBit` are the grant and revoke operations. In a feature flag store, `ToggleBit` is the experiment flip. These operations are correct only if they are atomic in concurrent systems.

Go's `sync/atomic` package does not expose bitwise primitives directly until Go 1.23 introduced `atomic.And` and `atomic.Or`. Before that, the standard pattern was a CAS loop: load the current value, compute the new value with the desired bitwise operation, and `CompareAndSwap` in a loop until the swap succeeds. The code in the Google case study later in this chapter shows this pattern. In a design review, require that any production bitmask field accessed from multiple goroutines uses either the `sync/atomic` CAS loop or is protected by a mutex. A naked read-modify-write of a bitmask is a data race.

The branchless `Abs`, `Min`, and `Max` tricks are micro-optimizations that are almost never worth writing in application code, and the `Min`/`Max` versions are worse than not worth it: they are wrong. Modern compilers already emit branchless CMOV for `if n < 0 { return -n }`, and since Go 1.21 `min` and `max` are builtins, so the hand-rolled versions trade correctness for nothing at all. This is the shape of the classic bad optimization: it is not that the clever code is fast and risky, it is that it is risky and not faster.

There is a narrow exception worth naming honestly. Constant-time code in cryptography deliberately avoids data-dependent branches, not for speed but so that timing cannot leak secrets. There, branchless arithmetic is a security requirement and the compiler's freedom to reintroduce a branch is the problem, which is why such code lives in assembly or uses `crypto/subtle` rather than clever expressions in Go. That is a different discipline from performance tuning, and conflating the two is how people end up defending broken `Min` implementations on the grounds that they are branchless. Outside that case, require profiler evidence before approving hand-written branchless arithmetic in review.
