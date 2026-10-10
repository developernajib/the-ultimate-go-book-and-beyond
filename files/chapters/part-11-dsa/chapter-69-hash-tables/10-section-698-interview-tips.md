## 69.8 Interview Tips

### Complexity Comparison

| Operation | Hash Table (avg) | Hash Table (worst) | BST (balanced) | Sorted Array |
|-----------|------------------|--------------------|--------------------|--------------|
| Search | O(1) | O(n) | O(log n) | O(log n) |
| Insert | O(1)* | O(n) | O(log n) | O(n) |
| Delete | O(1) | O(n) | O(log n) | O(n) |
| Min/Max | O(n) | O(n) | O(log n) | O(1) |
| Range Query | O(n) | O(n) | O(log n + k) | O(log n + k) |

*Amortized

### When to Use Hash Tables

Hash tables trade memory for speed: the O(1) average-case lookup works because the hash function maps a key directly to a bucket index, bypassing the comparisons required by trees or sorted arrays. However, that guarantee degrades to O(n) in the worst case when many keys hash to the same bucket, so avoid hash tables when deterministic worst-case latency is required (e.g., real-time systems) or when the query requires ordering. A BST or sorted slice will outperform a hash table for range queries and min/max operations.

```
┌─────────────────────────────────────────────────────────────────┐
│              WHEN TO USE HASH TABLES                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ✓ Use Hash Table when:                                         │
│    • Need O(1) lookup/insert/delete                             │
│    • Counting frequencies                                       │
│    • Checking for duplicates                                    │
│    • Caching/memoization                                        │
│    • Grouping by some criteria                                  │
│    • Two Sum type problems                                      │
│                                                                 │
│  ✗ Avoid Hash Table when:                                       │
│    • Need ordered data (use BST or sorted slice)                │
│    • Need min/max operations (use heap)                         │
│    • Need range queries (use BST)                               │
│    • Memory is very constrained                                 │
│    • Need deterministic worst-case performance                  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Common Patterns

1. **Frequency Counting**: Use `map[T]int` to count occurrences
2. **Set Operations**: Use `map[T]struct{}` for membership testing
3. **Prefix Sum + Hash**: For subarray sum problems
4. **Index Mapping**: Store value → index for quick lookups
5. **Grouping**: Group items by computed key (anagrams, etc.)

### Junior -> FAANG: Internalizing the "When to Use" Decision Tree

Before coding any interview problem, ask yourself these three questions in order:

1. Do I need to look up values by an arbitrary key in O(1)? If yes, use a hash map.
2. Do I need to check "have I seen this before?" in O(1)? If yes, use a hash set.
3. Do I need ordering, min/max, or range queries? If yes, use a sorted structure instead.

The table in this section shows the concrete tradeoffs. Memorize the last two rows: "Min/Max" and "Range Query" are both O(n) for hash tables, meaning a hash table is the wrong choice whenever those operations are in the critical path. Interviewers will specifically ask problems where a BST or sorted slice outperforms a map to test whether you know when NOT to use a hash table.

The five patterns at the bottom (frequency counting, set operations, prefix sum, index mapping, grouping) should be automatic responses to problem types, not things you derive during the interview. Treating them as templates you memorize frees cognitive bandwidth for the problem-specific logic.

### Senior @ FAANG: Complexity Guarantees and SLO Commitments

The complexity comparison table is the starting point for a senior discussion, not the conclusion. At the L6+ level, the interview question "when would you choose a hash table over a BST?" expects an answer grounded in production constraints, not just asymptotic notation.

Hash tables provide O(1) average with no ordering but have a non-deterministic worst case that requires Go's randomized hash seed to be practically safe. Balanced search trees (red-black trees, AVL trees, and the B-trees that back a PostgreSQL index) provide O(log n) for all operations including range queries and min/max, with a deterministic worst case. Note that Go's standard library ships no balanced tree container, so this choice means an external package such as `github.com/google/btree` or a hand-rolled structure. Keep the distinction straight, since interviewers do: a B-tree is not a binary search tree. It stores many keys per node specifically to match the page size of the storage beneath it, which is why databases use B-trees and in-memory containers usually do not. Chapter 70 develops this comparison in full. For a service with a latency SLO of P99 < 5ms, the non-deterministic worst case of a hash table is acceptable because Go's randomized seed makes adversarial worst-case inputs practically impossible. For a real-time system with a hard latency bound (embedded firmware, trading systems), the deterministic O(log n) of a balanced BST is the correct choice even though it is asymptotically slower on average.

A maturity signal in senior interviews: proactively discussing tail latency rather than average-case latency, because the tail, not the average, determines whether your service meets its SLO. Be precise about the two being different things, though. Big-O describes how work grows with n, while a percentile describes a measured distribution, so "P99 of O(1)" is a category error rather than a claim. The real statement is that a map whose probe lengths stay short keeps tail latency near the mean, whereas a map suffering clustering or a skewed hash grows a long tail: the average still looks fine while P99 quietly degrades, which is exactly the shape of an incident that dashboards miss.
