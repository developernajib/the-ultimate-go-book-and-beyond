## 76.10 Interview Pitfalls

### Pitfall 1: Integer Overflow in Bit Shifts

**The failure**: a power-of-two check that iterates shift positions against a fixed-width type. At i = 31 the expression `1 << i` typed as int32 lands on the sign bit and becomes -2147483648 rather than 2147483648, so the comparison silently never matches. Go's integer types have fixed sizes and wrap on overflow, so nothing panics.

```go
// ❌ WRONG: Overflow on left shift
func isPowerOfTwoBad(n int32) bool {
    for i := 0; i < 32; i++ {
        if 1<<i == n {  // When i=31, 1<<31 overflows int32!
            return true
        }
    }
    return false
}

// ✅ CORRECT: Use unsigned or proper type
func isPowerOfTwoGood(n int) bool {
    if n <= 0 {
        return false
    }
    return n&(n-1) == 0  // Only one bit set means power of 2
}

// Or if you must iterate:
func isPowerOfTwoSafe(n int64) bool {
    if n <= 0 {
        return false
    }
    var bit int64 = 1
    for i := 0; i < 63; i++ {
        if bit == n {
            return true
        }
        bit <<= 1
    }
    return false
}
```

### Pitfall 2: XOR Precedence (a C trap that Go does not have)

This one is worth including precisely because the widely repeated version of it is **false for Go**, and repeating it in an interview will cost you credibility.

The C rule is real: in C, `^` has *lower* precedence than `==`, so `a ^ b == 0` parses as `a ^ (b == 0)` and silently does the wrong thing. That trap is why the advice exists.

Go changed the precedence. In Go, binary `^` sits at level 4 alongside `+`, `-`, and `|`, while comparisons sit at level 3, so `^` binds **tighter**. `a ^ b == 0` parses as `(a ^ b) == 0`, which is exactly what you wanted.

Go also closes the trap a second time, through the type system. Even if the precedence went the other way, `a ^ (b == 0)` would not compile, because Go has no implicit bool-to-int conversion:

```
invalid operation: a ^ (b == 0) (mismatched types int and untyped bool)
```

So there is no silent failure available here. The lesson is not "add parentheses to appease a rule Go does not have", it is that precedence is language-specific and C intuition needs re-checking against the Go spec.

```go
// Correct in Go. `^` binds tighter than `==`, so this is (a ^ b) == 0.
func areEqual(a, b int) bool {
    return a^b == 0
}

// Also correct, and clearer. Parentheses cost nothing and survive a reader who
// knows C but not Go.
func areEqualExplicit(a, b int) bool {
    return (a ^ b) == 0
}

// Best: say what you mean. The XOR adds nothing here.
func areEqualBest(a, b int) bool {
    return a == b
}
```

Go's bitwise precedence differs from C's in the other direction too, and this is the one that can actually surprise a C programmer. In Go, `&`, `<<`, and `>>` sit at level 5 alongside `*`, **above** `+` and `-`. In C they sit below `+`. So `a & b + c` is `(a & b) + c` in Go and `a & (b + c)` in C: same text, different tree, no diagnostic. With `a=12, b=10, c=3`, Go yields 11 and C would yield 12.

The honest takeaway is not a list of levels to memorize. It is that mixed bitwise-and-arithmetic expressions read differently depending on which language the reader learned first, so parenthesize them for the reader even where the compiler does not require it.

### Pitfall 3: Signed vs Unsigned Right Shift

**The failure**: bit counting that hangs on negative input. In Go, `>>` on a signed integer is an arithmetic shift that fills from the left with the sign bit, not a logical shift. For a negative value the loop below never reaches zero, because -1 >> 1 is -1 forever.

```go
// ❌ WRONG: Arithmetic shift preserves sign bit
func countOnesBad(n int) int {
    count := 0
    for n != 0 {
        if n&1 == 1 {
            count++
        }
        n >>= 1  // For negative n, this fills with 1s forever!
    }
    return count  // Infinite loop for negative numbers
}

// ✅ CORRECT: Use unsigned type or count iterations
func countOnesGood(n int) int {
    count := 0
    un := uint(n)  // Convert to unsigned
    for un != 0 {
        count += int(un & 1)
        un >>= 1  // Logical shift (fills with 0s)
    }
    return count
}

// Even better: use n&(n-1) trick
func countOnesBest(n int) int {
    count := 0
    un := uint(n)
    for un != 0 {
        un &= un - 1  // Clear lowest set bit
        count++
    }
    return count
}
```

### Pitfall 4: Forgetting Edge Case for -1 in Finding Single Number

**The failure**: a "single number II" solution (every element appears three times except one) that loops over 32 bit positions while holding Go `int` values. Negative inputs come back mangled, because the sign bit lives at position 63 and bits 32 through 63 are never examined. `[-467, 793, 793, 793]` returns 4294966829 instead of -467. LeetCode bounds these values to the int32 range, which is exactly what makes the bug survive testing.

```go
import "math/bits"

// ❌ WRONG: assumes int is 32 bits.
func singleNumberBad(nums []int) int {
    result := 0
    for i := 0; i < 32; i++ { // BUG: Go's int is 64-bit.
        sum := 0
        for _, n := range nums {
            sum += (n >> i) & 1
        }
        if sum%3 != 0 {
            result |= 1 << i
        }
    }
    return result // Rebuilds negatives as large positive numbers.
}

// ⚠️ BETTER, but still hardcoding a width.
// 64 is right on every platform Go currently supports, and the spec still
// says the size of int is implementation-defined. Ask the standard library
// instead of asserting.
func singleNumberOK(nums []int) int {
    result := 0
    for i := 0; i < bits.UintSize; i++ {
        sum := 0
        for _, n := range nums {
            sum += (n >> i) & 1
        }
        if sum%3 != 0 {
            result |= 1 << i
        }
    }
    return result
}

// ✅ BEST: a state machine with no width dependency at all.
// It never names a bit position, so it cannot be wrong about how many there
// are. Sidestepping the question beats answering it correctly.
func singleNumberBest(nums []int) int {
    ones, twos := 0, 0
    for _, n := range nums {
        ones = (ones ^ n) &^ twos
        twos = (twos ^ n) &^ ones
    }
    return ones
}
```

### Pitfall 5: Wrong Bit Mask for Extracting Bits

**The failure**: extracting the low 8 bits with `& 0xFF` and then reasoning about the result as though it were still signed. The masking itself is correct, and that is what makes this slippery: the value is now in 0..255, so any leftover sign-based logic is testing a condition that can no longer occur.

```go
// ❌ WRONG: Sign extension issues
func getLowerByteBad(n int) int {
    b := n & 0xFF  // Gets lower 8 bits correctly
    // But if we need this as an unsigned value...
    if b > 127 {   // This check is meaningless for extracted bits!
        // Wrong assumption about sign
    }
    return b
}

// ✅ CORRECT: Use appropriate types for bit operations
func getLowerByteGood(n int) byte {
    return byte(n)  // Explicitly converts to unsigned 8-bit
}

func extractBitsGood(n int, start, length int) int {
    mask := (1 << length) - 1  // e.g., length=8 gives 0xFF
    return (n >> start) & mask
}

// For setting bits:
func setBitsGood(n int, start, length, value int) int {
    mask := (1 << length) - 1
    n &^= mask << start        // Clear bits in position
    n |= (value & mask) << start  // Set new value
    return n
}
```

### Interview Pitfalls Quick Reference

| Pitfall | Symptom | Prevention |
|---------|---------|------------|
| Left shift into the sign bit | Value silently goes negative | Use an unsigned type, or a type wide enough |
| Shift count >= width (variable) | Silently yields 0, no error | Bounds-check computed shift amounts |
| Shift count >= width (constant) | Compile error, caught for you | Nothing needed. Go rejects it |
| Signed right shift | Infinite loop on negatives | Use uint when you want a logical shift |
| Assuming int is 32 bits | Negatives rebuilt as huge positives | Loop to `bits.UintSize`, or take a sized type |
| Mixing `&` with `+` | Parses differently than in C | Parenthesize for the reader |
| Sign extension issues | Wrong extracted value | Use byte/uint8 for byte operations |
| Off-by-one in shifts | Wrong bit position | Remember: bit 0 is LSB, shift by 0 doesn't move |

---

### Junior -> FAANG: Converting Pitfall Tables into Interview Habits

The pitfall table above is a self-diagnostic. Before submitting any bit manipulation solution in an interview, run through each row: "Is my shift count bounded? Am I using uint where I need a logical shift? Am I iterating `bits.UintSize` positions rather than a hardcoded 32? Did I use byte for 8-bit extraction?" This five-second review catches the majority of bit manipulation bugs.

Notice which pitfalls Go removes for you, because knowing where the language has your back is as useful as knowing where it does not. A constant shift count that is too wide is a compile error. A bool cannot be XORed with an int. Signed overflow is defined to wrap rather than being undefined. `^` binds tighter than `==`, so `a ^ b == 0` already means what you want. Each of those is a live hazard in C and a non-issue in Go, and a candidate who asserts the C version of any of them in a Go interview is telling the interviewer they have not checked.

What Go does *not* catch is the interesting list, and it is short: a **variable** shift count past the width (silently 0), an arithmetic shift on a signed value where you meant logical (silently sign-extended, or a hang), a hardcoded 32 against a 64-bit `int` (silently wrong for negatives), and a mask narrower than its type. Every one is silent. That is where your attention belongs.

### Senior @ FAANG: Treating Pitfalls as Systemic Signals

A recurring pitfall in a team's code history is not a training problem for individuals. It is a tooling gap. If multiple engineers have independently hit the "signed right shift on negative int" bug, the fix is not another reminder in a coding standards document. The fix is a linter rule that flags arithmetic right shift on variables declared with signed integer types when the result is used as a mask or index.

At FAANG, staff engineers own the CI pipeline for their area. When a postmortem identifies a recurring bit manipulation bug class (for example, three separate incidents over two years where teams extended a uint32 permission mask beyond 32 bits), the staff engineer's action item is to add a presubmit check that detects this pattern. The check does not need to be perfect. It needs to be good enough to catch the common case and file a ticket for the edge cases that slip through.

The failures catalogued in this section are all recognizable patterns rather than exotic accidents, which is the point: they recur because the type system permits them, not because engineers are careless. In a bar-raiser debrief, a candidate who recounts a bug they shipped, explains the root cause at the type-system level, and describes the systemic fix they implemented demonstrates exactly the ownership and platform thinking L6 interviews look for. Prepare a story from your own experience with that structure: bug, root cause, systemic fix, outcome.
