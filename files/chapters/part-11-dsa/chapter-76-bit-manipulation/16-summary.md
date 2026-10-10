## Summary

- **Bitwise operations** (`&`, `|`, `^`, unary `^` for NOT, `&^` for AND NOT, and shifts) provide O(1) operations
- **XOR** is powerful: a ^ a = 0, a ^ 0 = a, useful for finding unique elements
- **n & (n-1)** clears the lowest set bit. Comparing it to 0 is the power-of-two test
- **n & (-n)** isolates the lowest set bit
- **Bitmask DP** represents subsets as integers for state compression
- **Two's complement**: -n = ^n + 1 (Go spells NOT as unary `^`, never `~`)
- **`math/bits`** is the idiomatic answer for OnesCount, Len, TrailingZeros, Reverse, and RotateLeft. Prefer it over hand-rolled loops
- **Width discipline**: Go's `int` is 64-bit. A hardcoded 32, or a 32-bit mask like `0x55555555`, silently corrupts negative and large values. Use `bits.UintSize`
- **Signed `>>` is arithmetic, unsigned `>>` is logical**. This single distinction causes more wrong answers than any other
- Common patterns: power of 2 check, bit counting, finding unique elements

Bit manipulation problems often have elegant, efficient solutions. Master the fundamental operations and common patterns to tackle these problems confidently.

### Junior -> FAANG: What to Consolidate After This Chapter

Three things should be automatic after finishing this chapter: the XOR self-inverse property and its application to duplicate detection, the `n & (n-1)` lowest-set-bit trick and its application to popcount and power-of-two checking, and the bitmask subset enumeration pattern with the `sub = (sub-1) & mask` inner loop. Everything else in the chapter can be reconstructed from these three foundations.

Test consolidation by solving LeetCode 136, 137, 260, and 338 from memory, then LeetCode 698 (partition k subsets) with bitmask DP. If you can solve all five correctly in under 30 minutes total without references, you are ready for bit manipulation questions at the FAANG phone-screen level.

The next chapter or topic to study after this is Trie data structures, because the maximum XOR problem (using a binary trie for greedy bit-by-bit maximization) bridges bit manipulation and tree algorithms.

### Senior @ FAANG: Strategic Value of Bit Manipulation Mastery

At the senior and staff level, bit manipulation mastery unlocks three high-value contributions beyond interview performance.

First, it enables you to design compact data representations that reduce memory footprint and improve cache utilization in hot paths. Sixty-four flags in a `uint64` occupy 8 bytes where 64 `bool` struct fields occupy 64, a whole cache line, so eight times as many records fit in the same cache. The honest framing is that this shrinks the working set, which may or may not change which level of the hierarchy you hit. Whether it matters depends on whether the workload was memory-bound to begin with, and that is a question for a benchmark rather than a rule of thumb. The bitmask also buys atomic multi-flag updates via a single CAS, which 64 separate bools cannot offer at any density.

Second, it provides the conceptual foundation for understanding and reviewing cryptographic code, which is dense with bit operations. An engineer who cannot read bitmask expressions fluently cannot meaningfully review a hash function or a symmetric cipher implementation. At FAANG, security-critical code requires reviewer sign-off from engineers who demonstrate this fluency.

Third, it gives you the language to communicate precisely with hardware and embedded systems teams. When a firmware engineer says "the interrupt status register has the RX_FULL flag at bit 3," a software engineer who thinks in bitmasks can translate immediately to `status & (1 << 3) != 0` and write the correct Go binding. Engineers who lack this fluency introduce translation errors at hardware-software boundaries, which are among the hardest bugs to diagnose.
