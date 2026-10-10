## 78C.14 Bit Manipulation

Bit manipulation uses bitwise operators for efficient computation. Key operations: AND, OR, XOR, shift, and `n & (n-1)` to clear lowest set bit.

---
### LC 136 - Single Number 🟢

**Key Insight**: XOR of a number with itself is 0. XOR all elements and the single number remains.

```go
func singleNumber(nums []int) int {
    result := 0
    for _, n := range nums {
        result ^= n
    }
    return result
}
```
**Time**: O(n).
**Space**: O(1).

---
### LC 191 - Number of 1 Bits 🟢

**Key Insight**: `n & (n-1)` clears the lowest set bit. Count how many times you can do that until n becomes 0.

```go
func hammingWeight(n uint32) int {
    count := 0
    for n != 0 {
        n &= n - 1
        count++
    }
    return count
}
```
**Time**: O(number of set bits).
**Space**: O(1).

---
### LC 190 - Reverse Bits 🟢

**Key Insight**: Shift the result left to open a slot while shifting the input right to expose its lowest bit. Thirty-two iterations pour the input into the result back to front.

```go
func reverseBits(num uint32) uint32 {
    var result uint32

    for range 32 {
        result = result<<1 | num&1 // make room, then drop in num's lowest bit
        num >>= 1
    }
    return result
}
```

The loop must run exactly 32 times, not until `num` becomes zero. An input like 1 has a single set bit, but the answer depends on that bit travelling all 31 remaining positions. Stopping early returns 1 instead of 2147483648.

The `uint32` type is doing real work here. On a signed type, `>>` is an arithmetic shift that copies the sign bit, so a negative input would smear ones downward forever. Unsigned shifts fill with zeros, which is what the algorithm assumes. Go's `range 32` over an integer, available since Go 1.22, expresses "do this 32 times" without an unused loop variable.

Note the follow-up interviewers ask: if the function is called many times, cache reversals of each byte in a 256-entry table and reverse four bytes per call. That turns 32 iterations into 4 lookups.

**Time**: O(1) - always exactly 32 iterations.
**Space**: O(1).

---
### LC 338 - Counting Bits 🟢

**Key Insight**: dp[i] = dp[i >> 1] + (i & 1). The number of set bits in i is the count for i/2 plus i's last bit.

```go
func countBits(n int) []int {
    dp := make([]int, n+1)
    for i := 1; i <= n; i++ {
        dp[i] = dp[i>>1] + (i & 1)
    }
    return dp
}
```
**Time**: O(n).
**Space**: O(n).

---
### LC 268 - Missing Number 🟢

**Key Insight**: XOR all indices 0..n with all array values. Duplicates cancel out, leaving the missing number.

```go
func missingNumber(nums []int) int {
    result := len(nums)
    for i, n := range nums {
        result ^= i ^ n
    }
    return result
}
```
**Time**: O(n).
**Space**: O(1).

---
### LC 371 - Sum of Two Integers 🟡

**Key Insight**: XOR gives the sum without carry. AND shifted left gives the carry. Repeat until no carry.

```go
func getSum(a int, b int) int {
    for b != 0 {
        carry := a & b
        a = a ^ b
        b = carry << 1
    }
    return a
}
```
**Time**: O(32) = O(1).
**Space**: O(1).

---

### Junior → FAANG: Core Bit Tricks Worth Memorizing

Four bit identities cover the majority of interview problems in this section. XOR with self yields zero (single number, missing number). `n & (n-1)` clears the lowest set bit (popcount, power-of-two check). XOR gives carry-less addition, AND shifted left gives the carry (sum without addition). `dp[x] = dp[x>>1] + (x&1)` gives the bit count recurrence used in Counting Bits, where the count for x reuses the already-computed count for x>>1. Practice these until they come out reflexively and annotate your solution with a one-line comment explaining which identity you are using, because interviewers often ask "why does that work?" immediately after you write the expression.

### Senior @ FAANG: Bit Manipulation in Low-Level Systems, Protocol Parsing, and Bloom Filters

At the senior level, bit manipulation moves from isolated interview problems to foundational tooling. Bloom filters use k independent hash functions and set/test individual bits in a large bitmap, achieving constant-time membership tests with controllable false-positive rates. Redis, Cassandra, and LevelDB all ship bloom filter implementations for their read path. Protocol parsing (network packet headers, database storage formats, binary file formats) requires extracting fields from packed byte arrays using masks and shifts. Go's `encoding/binary` package and direct bit manipulation are both used in practice. The bar-raiser interview question is: "Design a bloom filter for a URL deduplication system processing 10 billion URLs with a 0.1% false-positive rate. What is the optimal bit array size and hash function count?" The answer requires knowing the formulas `m = -n * ln(p) / (ln 2)^2` and `k = (m/n) * ln 2`, and then discussing hash function choice (murmur3, xxhash for speed), partitioned bloom filters for concurrent writes, and Counting Bloom Filters for deletion support. Run the numbers for 10 billion URLs at a 0.1% false-positive rate: m works out to about 1.44e11 bits, which is roughly 14.4 bits per URL and 10 hash functions. Watch the units here, because 14.4 is bits per element, not the total: 1.44e11 bits is about 18 GB, or 16.7 GiB. Ownership of such a system requires understanding that memory cost, the durability model, and how the filter is rebuilt after a restart from the source of truth.
