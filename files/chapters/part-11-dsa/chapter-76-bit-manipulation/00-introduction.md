# Chapter 76: Bit Manipulation

> *"Any sufficiently advanced bit manipulation is indistinguishable from magic."*
> - Adapted from Arthur C. Clarke

Bit manipulation is the art of treating integers not as numbers but as arrays of binary flags, exploiting the CPU's native bitwise operations to achieve results in O(1) time and space that would otherwise require loops, sets, or auxiliary data structures. At the hardware level, AND, OR, XOR, NOT, and shift operations are single CPU instructions. A skilled engineer who recognizes the opportunity to replace a conditional or a set membership check with a bitwise operation can write code that is simultaneously faster, smaller, and, once the pattern is internalized, more elegant than the naive alternative.

Go's type system makes bit manipulation both safe and expressive. Strong typing prevents the silent integer promotion bugs that plague C bitwise code, while Go's unsigned integer types (`uint`, `uint32`, `uint64`) and the `math/bits` standard library package give you access to population count (`bits.OnesCount`), leading zeros (`bits.LeadingZeros`), and trailing zeros (`bits.TrailingZeros`) as first-class operations. Go also removes a whole category of C undefined behaviour: shifting by more than the word width is well defined and simply yields 0, rather than being undefined. Go's `fmt.Sprintf("%b", n)` makes it trivial to visualize bit patterns during debugging, which is a real advantage in a whiteboard or screen-share interview where clarity of communication matters as much as correctness.

This chapter covers the complete toolkit of bit manipulation techniques: the fundamental operations and their algebraic properties, power-of-two detection, bit counting (Brian Kernighan's algorithm and POPCNT), single number isolation using XOR, subset generation using bitmask iteration, bitmask DP for TSP-class problems, and the applications in flags, permissions, and feature toggles that appear in real production systems. Each technique is presented with its Go implementation, its complexity, and the interview problem class it unlocks. You will finish this chapter able to look at a problem involving duplicates, missing numbers, or subsets and immediately ask: "can I solve this with XOR or a bitmask?"

**What you'll learn in this chapter:**

- Mastering the six bitwise operations in Go: AND, OR, XOR, NOT, left shift, right shift with concrete bit-level examples
- Detecting and manipulating individual bits: get, set, clear, toggle, and isolate the lowest set bit
- Counting set bits with Brian Kernighan's O(k) algorithm and Go's `bits.OnesCount` for O(1) POPCNT
- Solving the canonical XOR problems: single number I/II/III, missing number, find the difference
- Generating all 2^n subsets of a set using bitmask enumeration in O(2^n) with Go's integer iteration
- Applying bitmask DP to Hamiltonian path, assignment, and TSP-class problems
- Using bit fields as compact boolean arrays for visited tracking, permissions, and feature flags
- Recognizing the 10+ interview problem patterns that have elegant O(1) or O(n) bitwise solutions

**Why this matters in interviews:**

Bit manipulation shows up regularly in FAANG rounds, often as a "medium" or "hard" problem where the naive solution is obvious but the optimal one requires a bitwise insight. XOR-based problems (Single Number, Find the Difference, Missing Number) are the most common form: candidates who do not know the XOR self-inverse property (`a ^ a = 0`, `a ^ 0 = a`) get stuck at O(n) space when the optimal is O(1). Subset problems built on bitmask enumeration are a close second, and infrastructure-flavoured roles tend to probe bit-level thinking hardest. Beyond interviews, bit manipulation appears in network programming (subnet masks, flags), cryptography, embedded systems, and high-performance data processing, all domains where Go is prominent. This chapter ensures bit patterns are a tool you reach for confidently, not a topic that catches you off guard.

**Prerequisites:** Chapter 66 (Arrays and Strings), basic understanding of binary number representation and two's complement, familiarity with Go's integer types (`int`, `uint`, `int32`, `uint64`).

---

### Junior -> FAANG: Recognizing When Bit Manipulation Applies

The first barrier for junior candidates is not mechanics, it is pattern recognition. You can memorize `n & (n-1)` but if you reach for a hash map when the problem asks for the single unique element in an array, you have missed the moment. Build a habit of asking two questions before touching any algorithm: "does this problem involve detecting duplicates, counting elements, or selecting subsets?" and "is the state space small enough to encode in an integer?" If either answer is yes, reach for a bitwise approach first.

Worked example: LeetCode 268, Missing Number. The naive approach builds a set and checks membership for each number 0 to n, costing O(n) space. The XOR approach XORs every index and every value together in a single pass. Because `a ^ a = 0` and `a ^ 0 = a`, everything that appears twice cancels, leaving only the missing number. Write this out in a comment before coding: "index 0 XOR nums[0], index 1 XOR nums[1] ... the number that has no pair is the answer." That narration is what interviewers want to hear.

First-job habits worth building now: always use `math/bits.OnesCount` rather than a manual loop when you need popcount in production Go, and always use unsigned integers for bit mask operations so the compiler can choose the most efficient instruction. Document each bitmask constant with the bit positions it covers.

Interview entry-point framing: at the phone-screen stage, expect XOR single-number variants and power-of-two checks. Know all three XOR properties cold (`a^a=0`, `a^0=a`, commutativity) and be able to explain why they produce O(1)-space solutions. Verbalize your reasoning: "I know XOR cancels pairs, so if I XOR every number with every index I will cancel everything that appears twice."

### Senior @ FAANG: Bit Manipulation as a Platform Primitive

At L5 and above, bit manipulation is not an interview trick. It is a design primitive that shows up in flags systems, permission models, Bloom filters, protocol buffer wire formats, network packet parsing, and every bitmask DP problem that your team will encounter in capacity planning or scheduling. A senior engineer at FAANG is expected to know when to introduce this layer, what its operational limits are, and how to govern its use across a codebase.

**Architectural decision record: bit flags vs enum maps.** A `uint64` feature flag field stores up to 64 flags in 8 bytes and supports atomic compare-and-swap without a lock, which makes it attractive for per-request feature gating on a hot path. The trade-off is discoverability: a map with string keys is self-documenting, and a bitmask is not. A reasonable rule to encode in an ADR: use bitmasks only when (a) you need atomic multi-flag updates, (b) the flag count is stable and bounded below 64, and (c) you expose a typed const layer so no caller ever writes a raw integer literal. Condition (c) is the one teams skip and regret, because raw literals at call sites make every future renumbering unsafe.

**Bitmask DP at scale.** TSP-class bitmask DP with `n <= 20` runs in O(n^2 * 2^n), which peaks at roughly 400 million operations for n=20. That is feasible offline but not in a request path. Senior engineers know to precompute bitmask DP results and cache them, or to recognize when the problem can be decomposed into smaller independent subproblems. In infrastructure scheduling (bin packing, job-to-machine assignment), n rarely exceeds 20 machines per rack, which makes bitmask DP a practical tool. Document the n limit and the memory ceiling (`n * 2^n` entries) explicitly in code comments so the next engineer does not raise n to 25 thinking it is "just a constant change."

**Bloom filter governance.** Bloom filters are a production bit-manipulation structure. The false-positive rate is a function of the number of hash functions and the bit array size. Know the sizing formula `m = -n * ln(p) / (ln 2)^2`, and actually evaluate it rather than quoting a remembered figure: a target rate of 0.1% at 10 billion items needs roughly 1.44e11 bits, which is about 18 GB (16.7 GiB), typically sharded across a distributed cache. The companion formula `k = (m/n) * ln 2` gives the optimal hash count, about 10 here. Senior engineers own the sizing calculation, the hash function selection (a fast non-cryptographic hash for throughput, SipHash when inputs are adversarial and collision attacks are a concern), and the monitoring story, since fill ratio telemetry is what tells you a resize is due before the false-positive rate quietly drifts past its budget.

**Platform thinking: what `math/bits` actually promises.** The `math/bits` functions are recognized by the compiler as intrinsics on supported architectures, so `OnesCount64` can become a single POPCNT. Be precise about the promise, though, because it is weaker than it is usually stated and the difference is measurable. Nothing in the package documentation guarantees an instruction, and on amd64 at the default `GOAMD64=v1` you do not get a bare POPCNT at all. POPCNT is an SSE4.2 instruction that the v1 baseline cannot assume, so the compiler emits a runtime feature test against `runtime.x86HasPOPCNT` and branches: POPCNTQ when the CPU has it, a call to the portable implementation when it does not. Build the same code with `GOAMD64=v2` or higher and the check disappears, leaving one instruction.

The practical consequence is that the build tags matter as much as the function you called, and the way to know is to look:

```
go build -gcflags=-S ./pkg 2>&1 | grep POPCNT
```

For performance-critical code (network packet parsing, codec hot paths), confirm the instruction is present under the `GOAMD64` level you actually ship with, not the one on your laptop. This belongs in the performance review checklist for any function calling `math/bits` in a hot loop. It is still the right thing to call: the portable fallback is well optimized, and hand-rolling a popcount loop is slower than both paths.

**Bar-raiser signals.** An L7 candidate discussing bit manipulation will explain the algebraic group structure of XOR (bit strings of a fixed width under XOR form an abelian group, with 0 as identity and every element its own inverse, which is exactly why pairs cancel), derive the two-group partition algorithm for Single Number III from first principles rather than from memory, and raise the question of what happens when the value range grows beyond 64 bits, which requires arbitrary-precision arithmetic or a different approach entirely.

They will also correctly diagnose the XOR-swap trick, which is worth stating precisely because the usual explanation is wrong. The hazard has nothing to do with escape analysis, and escape analysis has no bearing on it whatsoever. The bug is aliasing: `x ^= y; y ^= x; x ^= y` silently zeroes the value when `x` and `y` are the same memory location, since the first step XORs the value with itself. Call `xorSwap(s, i, j)` with `i == j` and the element becomes 0 rather than staying put. A plain `s[i], s[j] = s[j], s[i]` is correct for `i == j`, is a single instruction pair after compilation, and is faster besides. XOR swap is a hazard that buys nothing, which is the whole reason to know it: not to use it, but to recognize and delete it.
