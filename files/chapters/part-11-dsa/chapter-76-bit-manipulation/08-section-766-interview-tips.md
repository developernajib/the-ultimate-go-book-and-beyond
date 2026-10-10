## 76.6 Interview Tips

### Common Bit Patterns

Interviewers test bit manipulation by expecting solutions that replace branches and loops with arithmetic. Memorizing these formulas is not rote learning. Each one encodes a specific insight: `n & (n-1)` clears the lowest set bit because subtracting 1 flips all bits from that position downward, and ANDing with the original cancels them. Similarly, `n & (-n)` isolates the lowest set bit because two's complement negation produces exactly the complement-plus-one needed to zero out all other bits.

```
┌─────────────────────────────────────────────────────────────────┐
│               ESSENTIAL BIT PATTERNS                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Operation              Formula (Go syntax)                     │
│  ─────────────────────  ──────────────────────────────────      │
│  Get i-th bit           (n >> i) & 1                            │
│  Set i-th bit           n | (1 << i)                            │
│  Clear i-th bit         n &^ (1 << i)                           │
│  Toggle i-th bit        n ^ (1 << i)                            │
│  Clear lowest set bit   n & (n - 1)                             │
│  Isolate lowest set bit n & (-n)                                │
│  Set lowest unset bit   n | (n + 1)                             │
│  Check power of 2       n > 0 && (n & (n-1)) == 0               │
│  Count set bits         bits.OnesCount(uint(n))                 │
│  Check if i-th bit set  (n & (1 << i)) != 0                     │
│                                                                 │
│  Go syntax notes (C habits will bite here):                     │
│  NOT is unary ^x, NOT ~x. Go has no ~ operator.                 │
│  &^ is AND NOT (bit clear): x &^ y == x & ^y, one operator.     │
│  Signed >> is arithmetic, unsigned >> is logical.               │
│  Shift count >= width yields 0. It is NOT undefined.            │
│  Negative shift count panics at runtime.                        │
│                                                                 │
│  XOR Properties:                                                │
│  a ^ a = 0              a ^ 0 = a                               │
│  a ^ b ^ b = a          (a ^ b) ^ c = a ^ (b ^ c)               │
│                                                                 │
│  Two's Complement:                                              │
│  -n = ^n + 1            n + ^n = -1                             │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Problem Categories

| Pattern | Example Problems |
|---------|-----------------|
| XOR find unique | Single Number I/II/III |
| Count bits | Number of 1 Bits, Counting Bits |
| Power of 2/4 | Power of Two, Power of Four |
| Bit masking | Subsets, TSP |
| Arithmetic | Sum of Two Integers, Divide |
| Gray code | Gray Code, Circular Permutation |

### Junior -> FAANG: Using the Pattern Table as a Diagnostic Tool

Before writing any code in an interview, scan the problem statement for the words that map to each row in the table above. "Unique," "appears once," and "appears twice" all point to XOR. "Count ones," "weight," and "Hamming" point to popcount. "Power," "align," and "next multiple" point to power-of-two checks. "All subsets" or "all combinations" with small n points to bitmask enumeration. "Minimum/maximum over partitions" with small n points to bitmask DP.

The danger zone is treating the table as a lookup rather than a reasoning tool. An interviewer who probes will ask "why does XOR work here?" and you need the algebraic answer: XOR forms an abelian group where every element is its own inverse, so XOR-ing a value an even number of times produces zero. Practice giving this explanation out loud until it is fluent.

Timing benchmark for self-assessment: you should be able to write a correct `IsPowerOfTwo` function in under 30 seconds and a correct `SingleNumber` function in under 60 seconds. If either takes longer, you need more repetition with the formulas.

### Senior @ FAANG: Building a Team Bit Manipulation Taxonomy

The problem categories table above is useful for individuals. For teams, the value is codified in a style guide entry that says: "before writing a data structure that stores boolean flags, ask whether a bitmask with typed constants would be more appropriate." This is not always the right answer (discoverability, debuggability, and team familiarity matter), but the question should be explicit.

At FAANG, staff engineers maintain the team's algorithm taxonomy as a living document. For bit manipulation, the taxonomy includes: (1) a list of approved production uses (permission models, feature flags, Bloom filters, CRC computation, network protocol parsing), (2) a list of prohibited uses (any situation where the number of flags may grow beyond 64, any situation where a flag's meaning changes between versions without a migration plan), and (3) a list of required review triggers (any new bitmask constant, any read-modify-write on a shared bitmask field without a synchronization note).

This taxonomy does more than capture knowledge. It prevents the class of bugs where a team inherits a bitmask permission system and extends it past 64 bits by changing the type to a slice, breaking all existing serialization. The right answer in that situation is to migrate to a named permission enum with a set representation, and that migration is easier when the original constraint was documented.
