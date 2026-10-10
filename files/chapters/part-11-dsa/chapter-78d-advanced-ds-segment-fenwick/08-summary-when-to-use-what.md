## Summary

| Technique | Use When |
|---|---|
| **Segment Tree** | Range queries + updates (sum, min, max). Range updates with lazy propagation |
| **Fenwick Tree** | Prefix sums + point updates, count inversions, rank queries |
| **Sweep Line** | Interval overlap counting, area/perimeter of union of rectangles, meeting rooms |
| **Monotonic Stack** | Next/previous greater/smaller element, histogram problems, trapping rain water |
| **Monotonic Deque** | Sliding window min/max, shortest subarray with sum >= k |
| **Interval Sorting** | Merge/insert/remove intervals, activity selection, scheduling |

### Interview Tips

1. **Segment tree is rarely needed in interviews.** Most interviewers will not ask you to build one from scratch. Recognizing when one is warranted, and saying so, carries most of the signal.

2. **Fenwick tree is a great alternative** when the problem only needs prefix sums. It is far less code. It is *not* less error-prone: the 1-indexing is mandatory, every off-by-one is silent, and there is no legible intermediate state to inspect when it is wrong. Short and forgiving are different properties.

3. **Monotonic stack problems are common.** LC 42, 84, and 739 are the ones worth knowing cold.

4. **Interval problems follow a pattern.** Sort first, then scan. The real work is deciding whether to sort by start or by end, and that follows from the problem, not from habit: merging wants start, activity selection wants end.

5. **Sweep line is the key insight** for meeting rooms and calendar problems. Convert intervals to events, sort, sweep. Then check the tie-break, because that is where it breaks.

6. **State the interval convention before you write a comparison.** Half-open `[start, end)` and closed `[start, end]` differ by exactly one character in your code, differ only on coincident endpoints in your tests, and the problems in this chapter genuinely use both.

### Complexity Quick Reference

| Operation | Segment Tree | Fenwick Tree | Prefix Array |
|---|---|---|---|
| Build | O(n) | O(n) | O(n) |
| Point Update | O(log n) | O(log n) | O(n) |
| Range Query | O(log n) | O(log n) | O(1) |
| Range Update | O(log n)* | O(log n)** | O(n) |
| Space | O(4n) | O(n) | O(n) |

\* With lazy propagation
\*\* Only with the two-BIT construction. A single Fenwick tree cannot do range update plus range query: one tree gives you range update with *point* query (store deltas, and a prefix sum reconstructs a single element), or point update with range query, but not both at once. Supporting both needs two trees, where the second corrects the first's linear error term. Treat the table's O(log n) here as conditional on building that, not as something the code in Part 2 already does.

A note on the "Prefix Array" column, which is easy to misread as the loser. Its O(1) range query beats both trees, and its O(n) update is only a problem if updates actually happen. For static data, the prefix array is the correct answer and reaching for a tree is over-engineering. The trees exist to buy update capability, and you pay for that in both query latency and code you have to keep correct. Ask what the update-to-query ratio really is before paying.

---

### Junior → FAANG: Making the Selection Decision in Under 2 Minutes

The selection table is useful, but in an interview you need to make the decision faster. Use this decision chain: does the problem ask about ranges with updates? If yes, can it be answered with prefix sums only? If yes, use Fenwick. If it needs min/max or range updates, use segment tree. Does it involve interval overlap counting or area? Use sweep line. Does it ask for next/previous greater/smaller or sliding window extremum? Use monotonic stack or deque. Print this chain and internalize it before your onsite. Stating your selection choice and reason aloud (before coding) is a positive signal that distinguishes L5 from L4 candidates.

### Senior @ FAANG: Complexity Governance and Algorithmic Architecture Reviews

At the senior level, this table feeds a decision that does not exist at the junior level: reviewing whether a design's algorithmic choices survive its projected scale. Take each core structure and ask whether the complexity still holds at 10x and 100x the current data volume and query rate. A Fenwick tree chosen for prefix sums, in a product whose roadmap clearly implies range min/max within a year, should carry a documented migration path to a segment tree along with the cost. A sorted slice scanned linearly for interval queries should carry a threshold at which it becomes an interval tree.

Push equally hard in the other direction, because the failure mode is not only under-engineering. A segment tree in a system whose data never changes is pure liability: it is slower per query than a prefix array, it is more code, and it is code with a silent failure mode. "This is O(log n)" is not an argument for anything by itself. The argument requires the constants, the actual n, and the actual operation mix.

The structures in this chapter deserve one specific piece of governance the table does not show. Their bugs do not announce themselves. A wrong push-down or a lost index 0 produces plausible numbers indefinitely. Anything from this chapter that reaches production needs a randomized differential test against a naive reference, checked in and running in CI, and if you are unwilling to pay for that, you should not adopt the structure.
