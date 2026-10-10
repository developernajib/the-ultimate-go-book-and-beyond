## 76.5 Gray Code

Gray code is a binary numbering system where consecutive values differ by exactly one bit. This property eliminates glitch states in hardware counters and rotary encoders, and it also underpins interview problems that require enumerating all states of n bits without repeating a transition. The core formula `i ^ (i >> 1)` converts any standard binary index into its Gray code equivalent in O(1), and its inverse (iteratively XORing the shifted value) recovers the original binary in O(n) passes.

```go
// GrayCode generates n-bit Gray code sequence
// LeetCode 89: Gray Code
// Time: O(2^n), Space: O(2^n)
func GrayCode(n int) []int {
    result := make([]int, 1<<n)

    for i := 0; i < (1 << n); i++ {
        result[i] = i ^ (i >> 1)
    }

    return result
}

// BinaryToGray converts binary to Gray code
func BinaryToGray(n int) int {
    return n ^ (n >> 1)
}

// GrayToBinary converts a Gray code value back to binary.
//
// The parameter is uint, and that is not cosmetic. Written as `n int`, this
// loop never terminates for a negative n: `>>` on a signed integer is an
// ARITHMETIC shift that keeps feeding in copies of the sign bit, so -1 >> 1 is
// -1 forever and `n != 0` is never satisfied. On a uint the shift is logical,
// zeros march in from the left, and the loop is guaranteed to reach 0 within
// bits.UintSize iterations. Gray codes are unsigned quantities, so let the type
// say so and the hang becomes unrepresentable.
func GrayToBinary(n uint) uint {
    result := n
    for n >>= 1; n != 0; n >>= 1 {
        result ^= n
    }
    return result
}

// CircularPermutation generates permutation starting at given value
// LeetCode 1238: Circular Permutation in Binary Representation
func CircularPermutation(n int, start int) []int {
    result := make([]int, 1<<n)

    for i := 0; i < (1 << n); i++ {
        result[i] = start ^ i ^ (i >> 1)
    }

    return result
}
```

### Junior -> FAANG: Gray Code as a Pattern Recognition Signal

Gray code appears in interview problems as a "1-bit change" constraint: generate a sequence of all n-bit integers where consecutive entries differ by exactly one bit. The O(1) formula `i ^ (i >> 1)` makes the naive recursive construction unnecessary. Know how to derive the formula: the standard binary-to-Gray conversion right-shifts by one and XORs with the original, which is exactly the formula. The inverse (Gray-to-binary) iterates XOR of shifted values, which reduces to a prefix XOR scan from the MSB.

For `CircularPermutation` (LeetCode 1238), notice that XORing every Gray code value with a constant `start` puts `start` itself at position 0, since `start ^ 0 ^ 0 = start`. Describe it precisely: this is not a rotation of the sequence, it is a relabelling of it. The values are permuted, not shifted, and the element that lands first is `start`, not "the Gray code of start".

Why it stays a valid Gray sequence: XOR with a constant is a bijection that preserves differences, because `(a ^ k) ^ (b ^ k) = a ^ b`. Adjacent entries therefore have exactly the same XOR as before, so if they differed in one bit they still do. That reasoning, that a bijection preserving the relevant structure lets you transport a solution, generalizes well beyond this problem.

### Senior @ FAANG: Gray Code in Hardware and Error-Resistant Systems

Gray code is not merely an interview curiosity. It appears in the design of rotary encoders, analog-to-digital converters, and Karnaugh maps for logic minimization. The key property is that during a state transition, only one bit changes at a time, which eliminates "glitch" states where intermediate values (produced when different bits settle at different speeds) are misread as valid codes.

In distributed systems, Gray code thinking appears in version vectors and logical clock designs where you want to detect transitions cleanly. A senior engineer asked to design a state machine for a hardware control loop should immediately ask "does any transition require changing multiple state bits simultaneously?" If yes, the system needs either Gray code encoding or explicit transition states that are treated as invalid. This constraint is often missed in pure software state machines and only becomes apparent when the system is deployed on hardware with propagation delays.

For the `GrayToBinary` inverse, the O(n) loop scanning from MSB is the standard implementation, but for fixed-width codes a constant-time parallel prefix XOR exists using the same masked-shift trick as bit reversal. This is relevant for FPGA implementations but rarely needed in Go application code. Knowing it exists, and knowing when to deploy it, is the distinction between a competent engineer and a staff-level one.
