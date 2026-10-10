## 78B.12 The Bit Manipulation Pattern

Bit manipulation solves problems that would otherwise require extra space or multiple passes by exploiting the binary representation of integers directly. The two most useful properties are XOR's self-inverse nature (`x ^ x = 0`) and the `x & (x-1)` idiom, which clears exactly the lowest set bit and lets Hamming weight run in time proportional to the number of set bits rather than the word size.

**When to use Bit Manipulation:**
- Finding a single unique element among duplicates
- Counting or inspecting individual bits in a number
- Checking power-of-two properties without division
- Enumerating all subsets of a set (bitmask DP)

```
┌─────────────────────────────────────────────────────────────────┐
│                BIT MANIPULATION PATTERN                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Essential operations:                                          │
│  • x & (x-1)  : clear lowest set bit                            │
│  • x & (-x)   : isolate lowest set bit                          │
│  • x ^ x = 0  : XOR with self cancels                           │
│  • x ^ 0 = x  : XOR with zero preserves                         │
│                                                                 │
│  Key insight: XOR is self-inverse, commutative, associative     │
│  XOR of all elements cancels pairs, leaving the single one      │
│                                                                 │
│  Common patterns:                                               │
│  • Single number: XOR all elements                              │
│  • Counting bits: Brian Kernighan's algorithm                   │
│  • Power of 2: n & (n-1) == 0                                   │
│  • Bitmask for subsets: iterate i from 0 to 2^n - 1             │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

### Problem 1: Single Number (LC 136)

**Problem:** Every element appears twice except one. Find the single one.

**Approach:** XOR all elements. Pairs cancel out, leaving the single number.

```go
func singleNumber(nums []int) int {
    result := 0
    for _, n := range nums {
        result ^= n
    }
    return result
}
```

**Time Complexity:** O(n).
**Space Complexity:** O(1).

**Edge cases:**
- Single element array → return that element
- Negative numbers → XOR works on two's complement representation

---

### Problem 2: Number of 1 Bits (LC 191)

**Problem:** Return the number of set bits (1 bits) in an unsigned integer.

**Approach:** Brian Kernighan's algorithm: `n & (n-1)` clears the lowest set bit. Count iterations.

```go
func hammingWeight(n uint32) int {
    count := 0
    for n != 0 {
        n &= n - 1 // clear lowest set bit
        count++
    }
    return count
}
```

**Time Complexity:** O(k) where k is the number of set bits, at most 32.
**Space Complexity:** O(1).

In real code use `bits.OnesCount32(n)` from `math/bits`. The compiler lowers it to a POPCNT instruction where the target supports it and a fast fallback where it does not, so it beats this loop and reads better. Write the loop in an interview to show you understand the mechanism, then say which one you would ship.

**Edge cases:**
- n=0 → 0, the loop body never runs
- n=MaxUint32 → 32, the worst case for this loop
- Power of 2 → 1, one iteration

---

### Problem 3: Counting Bits (LC 338)

**Problem:** Given integer `n`, return an array `ans` of length `n+1` where `ans[i]` is the number of 1 bits in `i`.

**Approach:** DP using the relation `bits[i] = bits[i >> 1] + (i & 1)`. The number of bits in i equals the number of bits in i/2 plus whether i is odd.

```go
func countBits(n int) []int {
    bits := make([]int, n+1)

    for i := 1; i <= n; i++ {
        bits[i] = bits[i>>1] + (i & 1)
    }

    return bits
}
```

**Time Complexity:** O(n).
**Space Complexity:** O(n) for the output.

**Edge cases:**
- n=0 → [0]
- n=1 → [0, 1]

---

### Junior → FAANG: Recognizing Bit Manipulation Opportunities

Junior engineers overlook bit manipulation because the domain connection is not obvious. The signal to reach for bits: the problem involves finding a single element in an array where all others appear twice (XOR), counting set bits (Hamming weight), checking power-of-two, or generating subsets of a small set (bitmask). These are not heuristics. They are the canonical problem families where bit manipulation is the intended solution.

The XOR self-inverse property (`x ^ x = 0`, `x ^ 0 = x`) is the most powerful single-operation identity in competitive programming. XOR-ing all elements of an array where every element appears twice except one leaves only the unique element, in O(n) time and O(1) space. The reason this works: commutativity and associativity mean the order does not matter, and each duplicate pair cancels to zero.

The `x & (x-1)` trick: subtracting 1 from x flips the lowest set bit and all bits below it. ANDing with the original x clears the lowest set bit. This gives an O(number of set bits) loop for Hamming weight, which is more efficient than shifting 32 or 64 times for sparse numbers.

Entry-level signal: knowing that `math/bits` already has this. `bits.OnesCount`, `bits.OnesCount32`, and `bits.OnesCount64` are compiler intrinsics that lower to a POPCNT instruction on hardware that has one. Propose the standard library, then show the `x & (x-1)` loop to demonstrate you know what it is doing underneath. Knowing both, and knowing which to ship, is the signal.

### Senior @ FAANG: Bit Manipulation in Systems Programming and Cryptography

Bit manipulation is fundamental to systems programming in Go. Bitwise operations are used in hash table implementations (replacing modulo with bitwise AND when the table size is a power of two: `index = hash & (size - 1)`), in memory allocators (using bitsets to track free blocks), and in network packet parsing (extracting IP address fields, TCP flags, and IP header length from packed byte sequences).

In cryptography, XOR is the foundational operation of stream ciphers and one-time pads. SHA-2 and SHA-3 hash functions are composed almost entirely of bitwise operations (AND, OR, XOR, NOT) and rotations. Understanding the bit manipulation pattern at the interview level gives you the fluency to read and reason about cryptographic Go code in production without treating it as a black box.

ADR consideration: bit manipulation optimizations trade readability for performance. A `x & (size-1)` bucket selection is faster than `x % size` but requires that the caller maintain the invariant that size is always a power of two. If that invariant is broken (e.g., by a configuration change that sets a non-power-of-two table size), the bug is silent and produces incorrect behavior. Document power-of-two invariants explicitly and add an assertion at initialization time. The Go compiler does not check these invariants automatically.

Bar-raiser signal: the candidate discusses bitmask DP, where the state is a subset encoded as an integer, for problems like "minimum cost to visit all nodes," which is the Traveling Salesman Problem at small n. They size the state space as 2^n · n and note that this puts the practical ceiling around n = 20, and that the ceiling is what makes the constraint "n ≤ 20" in a problem statement a direct hint. They enumerate set bits with the `x & (x-1)` idiom rather than scanning all n positions. They also know `math/bits` gives portable `OnesCount`, `LeadingZeros`, and `TrailingZeros` that the compiler recognizes as intrinsics and lowers to single instructions where the target provides them, with correct fallbacks elsewhere, so the portable call is not a compromise.
