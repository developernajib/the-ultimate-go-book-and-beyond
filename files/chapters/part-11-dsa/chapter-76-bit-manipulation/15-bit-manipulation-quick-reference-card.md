## Bit Manipulation Quick Reference Card

This reference card consolidates the essential bit manipulation primitives, patterns, and Go-specific behaviors you need during an interview. Bit operations execute in O(1) time with zero memory overhead because they map directly to CPU instructions, making them the fastest possible tool for problems involving flags, subsets, or parity. The patterns here cover the full interview landscape, from isolating bits with masks, to leveraging XOR's self-cancellation property, to driving bitmask DP over subsets.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    BIT MANIPULATION QUICK REFERENCE                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  FUNDAMENTAL OPERATIONS                                                     │
│  ─────────────────────────────────────────────────────────────────────────  │
│  Operation              Code                    Example (n=13, i=2)         │
│  Get i-th bit           (n >> i) & 1            (13>>2)&1 = 1               │
│  Set i-th bit           n | (1 << i)            13|(1<<2) = 13 (already 1)  │
│  Clear i-th bit         n &^ (1 << i)           13 &^ (1<<2) = 9            │
│  Toggle i-th bit        n ^ (1 << i)            13^(1<<2) = 9               │
│  Clear lowest set bit   n & (n - 1)             13&12 = 12                  │
│  Isolate lowest set bit n & (-n)                13&(-13) = 1                │
│  Set lowest unset bit   n | (n + 1)             13|14 = 15                  │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  XOR PROPERTIES                                                             │
│  ─────────────────────────────────────────────────────────────────────────  │
│  a ^ a = 0              Self-cancellation                                   │
│  a ^ 0 = a              Identity                                            │
│  a ^ b = b ^ a          Commutative                                         │
│  (a ^ b) ^ c = a ^ (b ^ c)  Associative                                     │
│  a ^ b ^ b = a          Cancel pairs                                        │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  COMMON CHECKS                                                              │
│  ─────────────────────────────────────────────────────────────────────────  │
│  Is power of 2?         n > 0 && (n & (n-1)) == 0                           │
│  Is power of 4?         isPow2(n) && (uint(n) & evenBits) != 0              │
│    evenBits = ^uint(0)/3, NOT the 32-bit literal 0x55555555.                │
│    A 32-bit mask wrongly rejects 1<<32, which is 4^16.                      │
│  Is even?               (n & 1) == 0                                        │
│  Is odd?                (n & 1) == 1                                        │
│  Have same sign?        (a ^ b) >= 0    (treats 0 as positive)              │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  BIT COUNTING METHODS                                                       │
│  ─────────────────────────────────────────────────────────────────────────  │
│  Brian Kernighan:       count := 0                                          │
│                         for n != 0 { n &= n-1; count++ }                    │
│                                                                             │
│  Go Built-in:           bits.OnesCount(uint(n))                             │
│                                                                             │
│  DP (0 to n):           dp[i] = dp[i>>1] + (i&1)                            │
│                         dp[i] = dp[i&(i-1)] + 1                             │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  USEFUL MASKS                                                               │
│  ─────────────────────────────────────────────────────────────────────────  │
│  All 1s (32-bit)        0xFFFFFFFF or ^uint32(0)                            │
│  All 1s (any width)     ^uint(0)                                            │
│  Lower n bits           (1 << n) - 1                                        │
│  Bit i only             1 << i                                              │
│  All except bit i       ^(1 << i)                                           │
│  Even positions         0x55555555 (01010101...)                            │
│  Odd positions          0xAAAAAAAA (10101010...)                            │
│  Lower nibbles          0x0F0F0F0F                                          │
│  Upper nibbles          0xF0F0F0F0                                          │
│                                                                             │
│  WARNING: every literal above is 32 bits wide. Against a 64-bit int they    │
│  silently mask off the entire upper half. Width-independent forms:          │
│    even positions  ^uint(0)/3          (0x5555...5555)                      │
│    odd positions   ^uint(0)/3*2        (0xAAAA...AAAA)                      │
│    lower nibbles   ^uint(0)/255*15     (0x0F0F...0F0F)                      │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  PROBLEM PATTERNS                                                           │
│  ─────────────────────────────────────────────────────────────────────────  │
│                                                                             │
│  Single Number (once vs twice):                                             │
│    • XOR all elements → pairs cancel, unique remains                        │
│                                                                             │
│  Single Number (once vs thrice):                                            │
│    • Count bits at each position mod 3                                      │
│    • Or use state machine: ones, twos variables                             │
│                                                                             │
│  Two Unique Numbers:                                                        │
│    • XOR all → get a^b                                                      │
│    • Find differing bit (rightmost: a^b & -(a^b))                           │
│    • Partition by this bit, XOR each group                                  │
│                                                                             │
│  Subset Enumeration:                                                        │
│    • for mask := 0; mask < (1<<n); mask++                                   │
│    • Check element i: (mask >> i) & 1                                       │
│                                                                             │
│  Subset of Mask:                                                            │
│    • for sub := mask; sub > 0; sub = (sub-1) & mask                         │
│                                                                             │
│  Bitmask DP State:                                                          │
│    • dp[mask] = answer for subset represented by mask                       │
│    • Transition: iterate unset bits or subsets                              │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  GO-SPECIFIC TIPS                                                           │
│  ─────────────────────────────────────────────────────────────────────────  │
│  • int is 64-bit everywhere Go currently runs, but the spec calls it        │
│    implementation-defined. Loop to bits.UintSize, not to 32 or 64.          │
│  • Use uint for logical right shift (>> fills with 0s)                      │
│  • Signed >> is arithmetic (fills with sign bit)                            │
│  • ^x is bitwise NOT. Go has no ~ operator.                                 │
│  • &^ is AND NOT (bit clear). No C equivalent.                              │
│  • Shift >= width: yields 0 if the count is a VARIABLE, compile error if    │
│    it is a CONSTANT. Never undefined. Negative count panics.                │
│  • Signed overflow wraps and is defined, unlike C.                          │
│  • ^ binds tighter than ==, so a^b == 0 means (a^b) == 0.                   │
│  • &, <<, >> bind tighter than + and - (opposite of C).                     │
│  • import "math/bits" for OnesCount, TrailingZeros, Len, Reverse,           │
│    RotateLeft, and UintSize.                                                │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  INTERVIEW CHECKLIST                                                        │
│  ─────────────────────────────────────────────────────────────────────────  │
│  □ Handle edge cases: 0, negative numbers, overflow                         │
│  □ Use unsigned types when you want a logical shift                         │
│  □ Loop to bits.UintSize, never a hardcoded 32, when int is involved        │
│  □ Match mask width to type width (0x55555555 is 32 bits!)                  │
│  □ XOR swap breaks when both operands are the SAME MEMORY, not merely       │
│    equal in value. Just use a, b = b, a                                     │
│  □ Signed right shift preserves sign (fills with 1s for negative), so a     │
│    n >>= 1 loop on a negative int never terminates                          │
│                                                                             │
│  NOT worth checking in Go (these are C habits):                             │
│  □ "Parenthesize ^ against ==" - Go's ^ already binds tighter               │
│  □ "Shift past width is undefined" - Go defines it as 0, or rejects it      │
│    at compile time for constant counts                                      │
│  □ "Signed overflow is undefined" - Go defines it as wrapping               │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  TIME COMPLEXITY GUIDE                                                      │
│  ─────────────────────────────────────────────────────────────────────────  │
│  Operation                          Time          Space                     │
│  Single bitwise op                  O(1)          O(1)                      │
│  Count bits (Kernighan)             O(k), k=bits  O(1)                      │
│  Count bits (built-in)              O(1)          O(1)                      │
│  Generate all subsets               O(2^n)        O(1) or O(2^n)            │
│  Bitmask DP                         O(n * 2^n)    O(2^n)                    │
│  TSP with bitmask                   O(n² * 2^n)   O(n * 2^n)                │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

### Junior -> FAANG: Using the Reference Card Actively

Print or memorize the reference card, then use it as a self-quiz. Cover the right column and reconstruct the formula for each operation from the operation name alone. Do this until you can produce all seven fundamental operations in under 60 seconds. Then cover the left column and state the operation name from the formula. The two directions test different things: formula recall and pattern recognition.

The useful masks section is the most frequently forgotten. Before your next interview, write out the hex values from memory: `0x55555555` is alternating bits (01010101...), `0xAAAAAAAA` is the complement (10101010...), `0x0F0F0F0F` is alternating nibbles. These appear in bit-reversal, popcount, and parity calculations, and interviewers notice at once whether you know them or are deriving them live.

Memorize the width along with the value, though, because that is the part that bites. Each of those literals is 32 bits. Use one against a Go `int` and you have silently masked away the top half of the value, which is how a power-of-four check ends up rejecting 2^32. Say the width out loud when you write the mask.

The interview checklist at the bottom is the most important section. Commit it to memory and verbalize it at the end of every bit manipulation solution: "edge cases: zero, negative, overflow. Unsigned where I want a logical shift. Mask width matches type width. Looping `bits.UintSize`, not a hardcoded 32."

Note what is *not* on that list. Do not say "and I've parenthesized the XOR against the comparison" or "shifting past the width is undefined". Both are C facts that Go does not share, and asserting them tells a Go interviewer you are reciting rather than reasoning. Knowing which hazards your language has already eliminated is itself a signal.

### Senior @ FAANG: Maintaining the Reference as a Living Document

Reference cards become dangerous when they are static, and more dangerous when they are inherited from another language. This one shipped for a while asserting C's XOR precedence and C's undefined over-wide shift, neither of which is true in Go. A senior engineer maintains the team's reference as a living document that tracks Go version changes (`atomic.And` and `atomic.Or` arrived in Go 1.23, `min`/`max` builtins in Go 1.21, `math/bits` in Go 1.9), and records platform behaviour with the precision it actually has.

That last point deserves care, because it is the sort of claim that gets repeated confidently and is subtly wrong. "`OnesCount64` compiles to POPCNT" is true only at `GOAMD64=v2` and above. At the default `v1` baseline, POPCNT is an SSE4.2 instruction the compiler cannot assume, so it emits a runtime feature check against `runtime.x86HasPOPCNT` and branches to a software fallback when absent. So the honest entry is "POPCNT when the build's GOAMD64 level permits it, otherwise a checked branch", and the way to settle it for your build is `go build -gcflags=-S | grep POPCNT`, not the reference card.

The time complexity guide is correct but incomplete for production reasoning. "Single bitwise op is O(1)" holds at the instruction level, while cache effects dominate for large bitmask DP tables. A `dp[mask]` table at `n=20` is `2^20` states, 8 MiB at 8 bytes each, which is within L3 on many server CPUs. At `n=25` it is 256 MiB, far outside any cache, and the DP becomes memory-bound. Note that a `dp[mask][last]` table (as Held-Karp needs) is `n` times larger and blows past L3 at n=20 already. Record where that breakpoint sits for your own workload rather than trusting a general number.
