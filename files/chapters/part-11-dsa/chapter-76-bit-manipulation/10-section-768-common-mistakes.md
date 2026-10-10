## 76.8 Common Mistakes

### Mistake 1: Signed vs Unsigned Shift Confusion

Go's right shift operator `>>` is arithmetic for signed integers (sign bit is propagated) and logical for unsigned integers (zero-filled). Converting to `uint32` or `uint64` before shifting ensures zero-fill behavior, which is required when using the shifted result as a logical bit index or mask.

```go
import (
    "fmt"
    "math/bits"
)

// BAD: Arithmetic right shift on negative numbers
func badRightShift() {
    x := int32(-8) // Binary: 11111111111111111111111111111000
    result := x >> 2
    // Result is -2 (sign-extended), not 1073741822
    fmt.Printf("Signed shift: %d\n", result) // -2
}

// GOOD: Use unsigned for logical right shift
func goodRightShift() {
    x := int32(-8)
    result := uint32(x) >> 2
    // Result is 1073741822 (zero-filled)
    fmt.Printf("Unsigned shift: %d\n", result) // 1073741822
}
```

### Mistake 2: Overflow in Left Shift

Left-shifting into or past the sign bit produces results that are zero or unexpectedly negative. Go's rules here are stricter and safer than C's, and the distinction that matters is whether the shift count is a **constant** or a **variable**.

If the count is a constant too large for the type, the program does not compile. `x << 64` where `x` is an `int` is rejected outright with "x (64 bits) too small for shift of 64", so the compiler catches this class for you.

If the count is a variable, the shift is legal and defined to yield 0 once it reaches the type's width. This is not undefined behaviour as it would be in C, but it is silent, and it is where a computed bit position can quietly produce an all-zeros mask. Shifting `int32(1)` left by 31 lands exactly on the sign bit and gives `math.MinInt32`, which is a genuine result and usually not the intended one. A negative shift count is the one case that panics at runtime.

```go
// BAD: shifting into the sign bit, and shifting past the width at runtime.
func badLeftShift() {
    // Note: `x << 64` with a CONSTANT 64 would not compile at all:
    //   "x (64 bits) too small for shift of 64"
    // The zero result below requires a VARIABLE count to slip past the
    // compiler's check.
    x := 1
    n := 64
    fmt.Println(x << n) // 0, defined but silent. A mask of nothing.

    // Shifting into the sign bit of a signed type.
    y := int32(1)
    z := y << 31 // Lands on the sign bit.
    fmt.Println(z) // -2147483648, i.e. math.MinInt32
}

// GOOD: Check shift amount and use appropriate types
func goodLeftShift() {
    // Use uint64 for large shifts
    x := uint64(1)
    if shift := 63; shift < 64 {
        result := x << shift
        fmt.Printf("Safe shift: %d\n", result)
    }

    // For known large values, use big.Int
    // big.NewInt(1).Lsh(big.NewInt(1), 100)
}
```

### Mistake 3: XOR Swap Anti-Pattern

The XOR swap trick exchanges two variables without a temporary by applying three consecutive XOR operations. It breaks completely when both operands alias the same memory location, zeroing the value instead of leaving it unchanged. In Go, the idiomatic multi-assignment `a, b = b, a` is cleaner, safer, and no slower.

Be precise about what "alias" means here, because the usual illustration of this bug does not actually reproduce it. Two separate variables holding equal values are not aliased: `b := a` copies, so XOR-swapping them works fine and leaves both at their original value. The bug needs a single memory location reached through two names, which in Go means two pointers to the same variable, or two slice indices that are equal. That is not exotic. Any `swap(i, j)` helper inside a sort will be called with `i == j` sooner or later.

```go
// NOT a demonstration of the bug. Two distinct variables that happen to hold
// equal values do NOT alias, so the trick works here and both end as 5. Copying
// a value never creates a shared location, and "same reference conceptually" is
// not a thing in Go. To hit the bug you need one memory location reached twice.
func notActuallyBroken() {
    a := 5
    b := a // A copy. a and b are separate variables.

    a = a ^ b
    b = a ^ b
    a = a ^ b
    // a == 5, b == 5. Nothing was destroyed.
}

// BAD: this is the real failure. Both parameters may name one location.
func xorSwap(a, b *int) {
    *a ^= *b // If a == b, this is *a ^= *a, which is 0. The value is gone.
    *b ^= *a
    *a ^= *b
}

func demonstrateTheBug() {
    x := 5
    xorSwap(&x, &x) // x is now 0, not 5.

    s := []int{7, 9}
    xorSwap(&s[0], &s[0]) // s is now [0 9].
    // A real sort calls swap(i, j) with i == j more often than you would think.
}

// GOOD: Go's tuple assignment. Correct even when the operands alias, because
// the right-hand side is fully evaluated before anything is assigned.
func goodSwap(a, b *int) {
    *a, *b = *b, *a
}
```

### Mistake 4: Incorrect Bit Counting

Counting set bits with a naive loop that inspects every bit position iterates the full width of the integer even when most bits are zero. Brian Kernighan's algorithm improves this by clearing the lowest set bit with `n &= n-1` on each iteration, so the loop runs exactly as many times as there are set bits. For production Go code, the `math/bits` package's `OnesCount64` is the best choice because it compiles to a single hardware popcount instruction on supported architectures.

```go
// SLOW, but not wrong. Worth being accurate about the criticism: n is uint64,
// so `n > 0` and `n != 0` are identical here and the loop is correct. The cost
// is that it iterates once per BIT POSITION up to the highest set bit, rather
// than once per SET BIT.
//
// The version of this warning you will hear, "it is wrong for negative n", does
// not apply to this code and only applies if you carelessly change the
// parameter to a signed int. Then `n >>= 1` becomes an arithmetic shift, -1
// stays -1 forever, and `n > 0` is false immediately (returning 0) while
// `n != 0` would spin without end. Both outcomes are bad, and the type is what
// prevents them.
func slowBitCount(n uint64) int {
    count := 0
    for n > 0 {
        if n&1 == 1 {
            count++
        }
        n >>= 1
    }
    return count
}

// GOOD: Use Brian Kernighan's algorithm
func goodBitCount(n uint64) int {
    count := 0
    for n != 0 {
        n &= n - 1 // Clear lowest set bit
        count++
    }
    return count
}

// BEST: use the standard library (math/bits, imported at the top of the file).
// Recognized as a compiler intrinsic, so it lowers to POPCNT where the target
// supports it. Faster than both loops and impossible to get wrong.
func bestBitCount(n uint64) int {
    return bits.OnesCount64(n)
}
```

### Mistake 5: Power of 2 Check Edge Cases

The bitwise power-of-two test `n & (n-1) == 0` works because powers of two have exactly one set bit, so subtracting one flips all lower bits and the AND produces zero. However, zero also satisfies this expression because `0 & (-1) == 0`, making the naive form return a false positive. Always add an explicit `n > 0` guard to exclude zero, and for signed integers this also excludes negative values that would otherwise wrap in unexpected ways.

```go
// BAD: Missing zero check
func badIsPowerOf2(n int) bool {
    return n&(n-1) == 0 // Returns true for 0!
}

// GOOD: Handle edge cases
func goodIsPowerOf2(n int) bool {
    return n > 0 && n&(n-1) == 0
}

// safePowerOf2 is identical to goodIsPowerOf2 above. The n > 0 guard already
// rejects negatives along with zero, so there is nothing further to add for
// signed types.
func safePowerOf2(n int) bool {
    return n > 0 && n&(n-1) == 0
}
```

### Junior -> FAANG: Turning Common Mistakes into Checklists

Convert each mistake above into a pre-submit question you ask yourself: "Am I right-shifting a signed integer and using the result as an index or mask?" "Am I left-shifting toward or past the sign bit?" "Could the two arguments to my swap be the same location?" "Is my bit-counting loop typed unsigned, so `>>` is logical and the loop is guaranteed to terminate?" "Am I checking power of two without the `n > 0` guard?"

Write these as a five-item checklist on a sticky note and consult it before submitting any bit manipulation solution in an interview or a pull request. Interviewers respect candidates who catch their own bugs by verbally self-reviewing: "Let me check edge cases: zero, one, the maximum value, and a negative value."

The power-of-two mistake is the most common because it is almost correct. `n & (n-1) == 0` passes for 0 in Go (since `0 & -1 == 0`), so every test case that does not include zero will pass, and the bug will survive code review unless someone specifically tests zero. In interview settings, always say "and I need to guard against zero" as you write the condition.

### Senior @ FAANG: Making Mistakes Impossible Through Type Design

The mistakes above are symptoms of a deeper design problem: the code is operating on raw `int` values where a typed wrapper would prevent misuse. A senior engineer's response to "signed vs unsigned shift confusion" is not to add a comment, it is to change the type:

```
// BitMask is a newtype that ensures all bit operations use unsigned semantics.
type BitMask uint64

func (m BitMask) Get(i int) bool { return (m>>i)&1 == 1 }
func (m BitMask) Set(i int) BitMask  { return m | (1 << i) }
func (m BitMask) Clear(i int) BitMask { return m &^ (1 << i) }
```

With this type, a caller cannot accidentally pass a signed integer, cannot accidentally use arithmetic right shift, and cannot confuse `Clear` with `Toggle` because they are named methods rather than raw expressions.

The XOR swap anti-pattern is eliminated by the language's multi-assignment: `a, b = b, a` is correct under aliasing because Go fully evaluates the right-hand side before assigning. The review rule follows from that, and it is simpler than guarding: do not write a custom swap at all. If one exists, the question is not "does it guard against `a == b`" but "why does this exist when tuple assignment does the job."

Linter enforcement: a custom `go vet` analyzer, or `staticcheck`, can flag `x >>= 1` loops where `x` has a signed type, which is the shape that spins forever on a negative value. A domain-specific linter like this is a staff-engineer deliverable, and it beats a style-guide paragraph because it runs on every commit rather than on the days a reviewer happens to remember it.
