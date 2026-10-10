## Overview

Bit manipulation operates directly on the binary representation of numbers, providing extremely fast operations. Many problems that seem complex have elegant O(1) solutions using bitwise operators.

```
┌─────────────────────────────────────────────────────────────────┐
│                    BITWISE OPERATIONS                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Binary: 13 = 1101, 5 = 0101                                    │
│                                                                 │
│  AND (&):  1101 & 0101 = 0101 (5)     Both bits must be 1       │
│  OR (|):   1101 | 0101 = 1101 (13)    Either bit is 1           │
│  XOR (^):  1101 ^ 0101 = 1000 (8)     Bits must differ          │
│  NOT (^):  ^1101 = ...11110010        Flip all bits             │
│            Go spells NOT as unary ^, not ~                      │
│  ANDNOT (&^): 1101 &^ 0101 = 1000 (8) Clear bits set in RHS     │
│            Go-only operator, no C equivalent                    │
│  Left Shift (<<):  0101 << 2 = 010100 (20)  Multiply by 2^n     │
│  Right Shift (>>): 1101 >> 2 = 0011 (3)     Divide by 2^n       │
│            Signed >> is ARITHMETIC (fills with sign bit)        │
│            Unsigned >> is LOGICAL (fills with zeros)            │
│                                                                 │
│  Key Properties:                                                │
│  • a ^ a = 0          (XOR with self = 0)                       │
│  • a ^ 0 = a          (XOR with 0 = self)                       │
│  • a & (a-1)          (clears the lowest set bit)               │
│  • a & (a-1) == 0     (TEST: a is a power of two, for a > 0)    │
│  • a & (-a)           (isolates the lowest set bit)             │
│  • a | (a+1)          (sets the lowest 0 bit)                   │
│                                                                 │
│  Note the two a & (a-1) lines are different claims. The         │
│  expression's VALUE is a with its lowest set bit cleared:       │
│  12 & 11 = 8, not 0. Comparing it to 0 is what tests for a      │
│  power of two, since only then is there one bit to clear.       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Junior -> FAANG: Building the Mental Model Before Memorizing Formulas

The diagram above shows formulas, but the real skill is deriving them from first principles so you never forget them under pressure. Start with two's complement: negating a number flips all bits and adds one.

Now derive `n & (-n)` concretely, with `n = 12`:

```
 n  = 0000 1100
^n  = 1111 0011      flip every bit
-n  = 1111 0100      then add 1
n & (-n) = 0000 0100 = 4
```

Watch what the "add 1" does. Below the lowest set bit, `n` is all zeros, so `^n` is all ones there, and adding 1 makes them carry all the way up to that lowest set bit, turning them back to zeros and flipping that bit to 1. Above the lowest set bit, the carry stops, so those bits stay flipped, the exact opposite of `n`. So `-n` agrees with `n` at exactly one position, the lowest set bit, and disagrees everywhere above it while both are zero below it. AND them and only that one bit survives. Reconstruct that in 60 seconds and the formula is unforgettable.

The same derivation approach works for `n & (n-1)`: subtracting one from `n` borrows from the lowest set bit, flipping it to zero and setting all bits below it to one. ANDing with the original `n` clears those flipped bits, netting exactly "n with its lowest set bit removed." Draw this out for `n = 12` (1100) to confirm: `n-1 = 11` (1011), `n & (n-1) = 1000 = 8`.

### Senior @ FAANG: Teaching the Derivation, Not the Result

A senior engineer's value in an interview debrief or onboarding session is the ability to derive these properties on a whiteboard from the definition of two's complement, not from a cheat sheet. When a staff engineer explains `n & (-n)` by tracing through the borrowing mechanism of binary subtraction, they build lasting intuition in the listener. When they just write the formula, they create a fragile dependency.

In production code reviews, require that any non-obvious bitmask expression has a comment explaining the derivation, not just the result. "Isolate lowest set bit" is a label. "subtract 1 borrows from the LSB, flipping it and all lower bits, so AND with original isolates that bit" is a proof. Engineers who inherit your code need the proof. The label is useless when they try to adapt the pattern to a slightly different problem.
