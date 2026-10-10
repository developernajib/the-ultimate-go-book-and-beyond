## 76.2 Common Bit Problems

### Single Number Problems

XOR is self-inverse (`a ^ a = 0`) and identity-preserving (`a ^ 0 = a`), so XOR-ing all elements together cancels every number that appears an even number of times and leaves only the number that appears an odd number of times. This trick reduces Single Number I to a single pass with O(1) space, replacing what would otherwise be an O(n) hash map solution.

```go
import "math/bits"

// SingleNumber finds the number that appears once (others appear twice).
// LeetCode 136: Single Number
//
// Works for any width and any sign, because XOR cancels pairs bit by bit and
// never looks at a specific bit position. Contrast SingleNumberII below, which
// does, and therefore has to care about the width of int.
// Time: O(n), Space: O(1)
func SingleNumber(nums []int) int {
    result := 0
    for _, num := range nums {
        result ^= num
    }
    return result
}

// SingleNumberII finds the number appearing once, where every other number
// appears exactly three times.
// LeetCode 137: Single Number II
// Time: O(n * bits.UintSize), Space: O(1)
//
// Iterate over the full width of int, not a hardcoded 32. LeetCode's inputs are
// int32-ranged and may be NEGATIVE, but Go's int is 64-bit. A 32-bit loop reads
// only the low half of a negative number's two's complement representation and
// reassembles a large positive value instead: for [-2,-2,1,1,-3,1,-3,-3,-4,-2]
// it returns 4294967292 rather than -4. The sign bit lives at bit 63.
func SingleNumberII(nums []int) int {
    // Count set bits at each position.
    result := 0
    for i := 0; i < bits.UintSize; i++ {
        sum := 0
        for _, num := range nums {
            sum += (num >> i) & 1
        }
        // If sum % 3 != 0, the single number has a 1 at position i.
        // Every thrice-repeated number contributes 0 or 3 to this position.
        if sum%3 != 0 {
            result |= 1 << i
        }
    }
    return result
}

// SingleNumberIII finds two numbers that appear once (others appear twice)
// LeetCode 260: Single Number III
// Time: O(n), Space: O(1)
func SingleNumberIII(nums []int) []int {
    // XOR all numbers to get a ^ b
    xorAll := 0
    for _, num := range nums {
        xorAll ^= num
    }

    // Find rightmost set bit (this bit differs between a and b)
    rightmostBit := xorAll & (-xorAll)

    // Divide numbers into two groups based on this bit
    var a, b int
    for _, num := range nums {
        if num&rightmostBit != 0 {
            a ^= num
        } else {
            b ^= num
        }
    }

    return []int{a, b}
}

// MissingNumber finds the missing number in 0 to n
// LeetCode 268: Missing Number
// Time: O(n), Space: O(1)
func MissingNumber(nums []int) int {
    n := len(nums)
    result := n
    for i := 0; i < n; i++ {
        result ^= i ^ nums[i]
    }
    return result
}
```

### Power of Two/Four

Powers of two have exactly one bit set in their binary representation, so the expression `n & (n-1)` clears that lone bit to zero, making the check `n > 0 && (n&(n-1)) == 0` a branchless O(1) test. Powers of four are also powers of two, but their single set bit must fall on an even bit position (bit 0, 2, 4 …). ANDing against a mask of ones at the even positions confirms that additional constraint in a single instruction.

The mask has to cover the whole type. This is the most common way this problem gets shipped broken: `0x55555555` is a 32-bit mask, and Go's `int` is 64-bit, so on `2^32` (which is `4^16`, a genuine power of four) the mask sees nothing and the function returns false. Match the mask width to the value width, or take an explicitly sized type.

```go
// IsPowerOfTwo checks whether n is a power of 2.
// LeetCode 231: Power of Two
// The n > 0 guard is required: for n == 0 the expression n&(n-1) is also 0,
// and negative powers of two do not exist.
func IsPowerOfTwo(n int) bool {
    return n > 0 && (n&(n-1)) == 0
}

// evenBitsMask has ones at every even bit position (0, 2, 4, ...) across the
// full width of int. Written as a constant expression rather than a literal so
// it is correct on any int width, instead of silently truncating at 32 bits.
const evenBitsMask = ^uint(0) / 3 // 0x5555...5555

// IsPowerOfFour checks whether n is a power of 4.
// LeetCode 342: Power of Four
//
// A power of 4 is a power of 2 whose single set bit sits at an even position.
// LeetCode bounds n to int32, but this works across the full int range:
// IsPowerOfFour(1 << 32) is correctly true, where a 0x55555555 mask says false.
func IsPowerOfFour(n int) bool {
    return n > 0 && (n&(n-1)) == 0 && (uint(n)&evenBitsMask) != 0
}
```

### Counting Bits

LeetCode 338 computes the popcount (number of set bits) for every integer from 0 to n in O(n) time by reusing previously computed results. The DP recurrence `result[i] = result[i>>1] + (i & 1)` works because right-shifting by one is equivalent to dividing by two, whose popcount is already known, and the lowest bit of `i` is the only difference. The alternative using `i & (i-1)` (which clears the lowest set bit) expresses the same idea: `result[i] = result[i&(i-1)] + 1`.

```go
// CountBits returns count of 1s for each number 0 to n
// LeetCode 338: Counting Bits
// Time: O(n), Space: O(n)
func CountBits(n int) []int {
    result := make([]int, n+1)

    for i := 1; i <= n; i++ {
        // i >> 1 removes lowest bit, i & 1 checks if lowest bit is set
        result[i] = result[i>>1] + (i & 1)
    }

    return result
}

// Alternative using i & (i-1)
func CountBitsAlt(n int) []int {
    result := make([]int, n+1)

    for i := 1; i <= n; i++ {
        result[i] = result[i&(i-1)] + 1
    }

    return result
}

// HammingWeight counts 1 bits in unsigned integer
// LeetCode 191: Number of 1 Bits
func HammingWeight(n uint32) int {
    count := 0
    for n != 0 {
        count++
        n &= n - 1
    }
    return count
}

// HammingDistance counts differing bits between two numbers
// LeetCode 461: Hamming Distance
func HammingDistance(x int, y int) int {
    xor := x ^ y
    count := 0
    for xor != 0 {
        count++
        xor &= xor - 1
    }
    return count
}

// TotalHammingDistance sums all pairwise hamming distances
// LeetCode 477: Total Hamming Distance
// Time: O(32n) = O(n)
func TotalHammingDistance(nums []int) int {
    total := 0
    n := len(nums)

    for i := 0; i < 32; i++ {
        ones := 0
        for _, num := range nums {
            ones += (num >> i) & 1
        }
        zeros := n - ones
        total += ones * zeros
    }

    return total
}
```

### Reverse and Rotate Bits

LeetCode 190 reverses all 32 bits of an unsigned integer, which the naive loop does one bit at a time in 32 iterations. The optimized divide-and-conquer variant mirrors bits in progressively finer groups (first swapping the two 16-bit halves, then 8-bit bytes, then nibbles, then pairs, then individual bits), completing the reversal in just five masked-shift operations. Rotation differs from reversal: rotating left by k shifts bits toward the MSB and wraps the overflow back at the LSB using `(n << k) | (n >> (32-k))`.

```go
// ReverseBits reverses bits of a 32-bit unsigned integer
// LeetCode 190: Reverse Bits
func ReverseBits(n uint32) uint32 {
    var result uint32

    for i := 0; i < 32; i++ {
        result = (result << 1) | (n & 1)
        n >>= 1
    }

    return result
}

// ReverseBitsOptimized using divide and conquer
func ReverseBitsOptimized(n uint32) uint32 {
    n = (n >> 16) | (n << 16)
    n = ((n & 0xff00ff00) >> 8) | ((n & 0x00ff00ff) << 8)
    n = ((n & 0xf0f0f0f0) >> 4) | ((n & 0x0f0f0f0f) << 4)
    n = ((n & 0xcccccccc) >> 2) | ((n & 0x33333333) << 2)
    n = ((n & 0xaaaaaaaa) >> 1) | ((n & 0x55555555) << 1)
    return n
}

// RotateLeft rotates bits left by k positions.
//
// Note this works for k == 0, where the second term becomes n >> 32. In C that
// is undefined behaviour. In Go a shift of 32 or more on a uint32 is defined to
// yield 0, so the expression collapses to n and is correct. It does NOT survive
// a negative k, which panics at runtime rather than wrapping.
//
// In production, do not write this. Use bits.RotateLeft32(n, k), which handles
// the sign of k and compiles to a single ROL instruction.
func RotateLeft(n uint32, k int) uint32 {
    k %= 32
    return (n << k) | (n >> (32 - k))
}

// RotateRight rotates bits right by k positions.
// Idiomatic equivalent: bits.RotateLeft32(n, -k). The standard library has no
// RotateRight, because rotating left by -k is the same operation.
func RotateRight(n uint32, k int) uint32 {
    k %= 32
    return (n >> k) | (n << (32 - k))
}

// Idiomatic versions. Prefer these everywhere outside an interview whiteboard:
// the compiler recognizes them as intrinsics, and they cannot be got wrong.
func reverseBitsStdlib(n uint32) uint32       { return bits.Reverse32(n) }
func hammingWeightStdlib(n uint32) int        { return bits.OnesCount32(n) }
func hammingDistanceStdlib(x, y uint32) int   { return bits.OnesCount32(x ^ y) }
func rotateLeftStdlib(n uint32, k int) uint32 { return bits.RotateLeft32(n, k) }
```

### Junior -> FAANG: The XOR Insight as an Interview Strategy

When an interviewer asks for a problem involving duplicates, missing numbers, or finding a unique element, the first question in your mind should be: "can I reduce this to an XOR scan?" For Single Number I, the answer is always yes. For Single Number II (elements appear three times), XOR alone is insufficient because its self-cancellation property only works for even counts. The bit-position counting approach (summing each bit position and taking mod 3) is the fallback. Practice articulating this hierarchy: "XOR works for modulo-2 problems. For modulo-3, I count bits per position."

The divide-and-conquer bit reversal is a specific optimization that appears in FAANG hardware and DSP problems. Before writing the naive 32-iteration loop, briefly mention that the O(log 32) version exists. You do not need to write it from memory if you can describe the strategy: "swap 16-bit halves, then 8-bit bytes, then nibbles, then pairs, then individual bits."

### Senior @ FAANG: Choosing Between XOR, Counting, and State Machine Approaches

The three approaches to Single Number II (bit counting, state machine with `ones`/`twos` variables, and arbitrary modulo reduction) differ in readability, generalizability, and performance. The bit counting approach is O(32n) and immediately readable. The `ones`/`twos` state machine is O(n) with a smaller constant but requires careful reasoning about the automaton transitions. The generalized approach (modulo k for arbitrary k) requires understanding number theory.

At FAANG design reviews, the selection criterion is not which approach is cleverest but which approach the next engineer will correctly modify six months from now. The bit counting approach wins on maintainability in almost all cases. Reserve the state machine approach for situations where n is very large and the constant factor genuinely matters, and document the automaton explicitly with a state transition table in the comments.

The Hamming Distance sum problem (LeetCode 477) is a good example of where the bit-level perspective reveals a non-obvious optimization: rather than summing all O(n^2) pairwise distances, count the number of ones at each bit position across the entire array in O(n) and then use `ones * (n - ones)` as the contribution of that position. This reframing from pair enumeration to population counting is the kind of insight that distinguishes a strong senior candidate. Practice expressing it as: "the contribution of bit position i to the total Hamming distance is the number of pairs where one element has a 1 and the other has a 0, which is ones[i] times zeros[i]."

**A closing discipline note on widths.** Two of the functions in this section were originally written with a hardcoded 32 while taking a Go `int`, and both were wrong for it. `SingleNumberII` reassembled negative inputs into large positive numbers, and `IsPowerOfFour` rejected `2^32`. LeetCode's int32-bounded constraints hide both, which is exactly why they survive into production. The rule worth carrying out of this chapter: the width of your loop bound and the width of your mask must match the width of your type, and if you are hardcoding 32 while holding an `int`, you have a bug that your tests are not looking for. Either use `bits.UintSize`, or take a `uint32` and make the width part of the signature.
