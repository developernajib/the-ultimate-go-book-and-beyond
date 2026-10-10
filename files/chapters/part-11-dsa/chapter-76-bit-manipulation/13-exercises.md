## Exercises

### Exercise 1: Maximum XOR of Two Numbers
Find maximum XOR of any two numbers in an array.

### Exercise 2: Complement of Base 10 Integer
Find the complement of a number (flip all bits).

### Exercise 3: Integer Replacement
Given n, find minimum operations to reach 1 (n/2 if even, n±1 if odd).

### Exercise 4: Maximum Product of Word Lengths
Find maximum product of lengths of two words with no common letters.

---

### Junior -> FAANG: Approaching Each Exercise with Intention

For Exercise 1 (Maximum XOR), resist the temptation to try all pairs in O(n^2). State the approach first: "I will build a binary trie of all numbers and for each number greedily choose the opposite bit at each position." Then implement the trie with a `[2]*TrieNode` children array and trace through a small example before coding.

For Exercise 4 (Maximum Product of Word Lengths), the key insight is that "no common letters" means the AND of their character bitmasks is zero. Precompute a 26-bit mask for each word in O(n * 26) time, then check all pairs in O(n^2) with an O(1) AND check. The total is O(n^2 + n * 26) = O(n^2), which is optimal since you must consider all pairs. State this complexity explicitly.

For Exercise 3 (Integer Replacement), the key decision is choosing `n+1` versus `n-1` when n is odd. You will find the rule "pick whichever yields more trailing zeros" stated as the answer. Check it before you trust it, because it is wrong, and the smallest counterexample is n = 3.

At n = 3, `n+1 = 4` has two trailing zeros and `n-1 = 2` has one, so the rule takes 4 and spends 3 steps (3 → 4 → 2 → 1). Going down instead costs 2 (3 → 2 → 1). Run that greedy against a memoized brute force over the first 20000 integers and it disagrees on more than a quarter of them, starting at 3, 6, 11, 12, 13. It is not a near-miss heuristic, it is simply not the rule.

The rule that does hold: when n is odd, take `n-1` if `n == 3`, otherwise take `n+1` when `(n+1) % 4 == 0` and `n-1` otherwise. The `(n+1) % 4 == 0` test asks whether incrementing clears at least two low bits, which is what pays for the extra step. Three is the exception because 2 is already one halving from the target, so there is no future to invest in. Verified against brute force over the same range, this agrees everywhere.

Two lessons worth more than the problem itself. First, "more trailing zeros" is a plausible-sounding local proxy for a global objective, and plausible is not proven. Second, the check cost about ten lines of brute force. When a greedy rule has no exchange argument behind it, write the brute force. This chapter's own text carried the wrong rule until someone did.

### Senior @ FAANG: What These Exercises Test at the Bar-Raiser Level

Exercise 2 (Complement of Base 10 Integer) is trivial as stated but becomes interesting with follow-up constraints: "find the complement within the significant bits of n only, not all 32 bits." The solution requires computing the bit length of n (via `bits.Len(uint(n))`), constructing a mask of that many ones, and XORing. The follow-up tests whether you know `math/bits.Len` and whether you can reason about bit length without trial and error.

Exercise 4 (Maximum Product of Word Lengths) becomes an engineering challenge at scale: if the word list has 100,000 words, the O(n^2) pair-checking loop is 10 billion operations. A senior candidate asks whether the constraint allows grouping words by their character bitmask (identical masks can be combined, keeping only the longest word for each mask) and whether the number of distinct 26-bit masks is small enough to justify a map-based approach that reduces the effective n. At FAANG scale, the engineering question is always "does this algorithm hold at 100x the given input size?" and the answer determines whether to optimize before shipping.
