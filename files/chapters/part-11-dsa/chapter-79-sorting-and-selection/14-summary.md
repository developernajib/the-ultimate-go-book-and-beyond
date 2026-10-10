## Summary

Sorting is the algorithm you will almost never write and must completely understand. Core concepts include:

- **The comparison lower bound**: Omega(n log n) follows from the decision-tree argument, and it constrains only algorithms whose sole tool is comparison. Counting and radix sort escape it by using keys as indices, at the price of bounded integer keys and O(k) space.

- **The four classic sorts**: insertion (stable, adaptive, unbeatable at small n), merge (stable, O(n log n) worst, needs O(n) scratch), heap (in-place, O(n log n) worst, cache-hostile), and quick (in-place, fast on average, quadratic on adversarial input). Their four properties, stability, in-place, worst case, adaptivity, explain every library sort's design.

- **pdqsort**, Go's unstable sort since 1.19: insertion sort under 13 elements, a heapsort fallback after roughly log n bad pivots that converts the quadratic worst case into a guaranteed O(n log n), plus detection paths for sorted, reversed, and duplicate-heavy input. Go's implementation deliberately omits BlockQuicksort's branchless partitioning.

- **Stability** as a contract, not a nicety: it is what makes multi-key sorting by repeated passes work, and its absence is the source of nondeterministic output that only reproduces past the 12-element insertion-sort threshold. Prefer a total order with an explicit tie-break over depending on the guarantee.

- **Selection**: quickselect at O(n) average, median-of-medians at O(n) worst but with a constant nobody pays, and the bounded heap at O(n log k) that production actually uses because it is the only one that streams.

- **Go's APIs**: `slices.Sort` beats `sort.Slice` by roughly 1.7x on 10k ints because generics eliminate reflection-based swaps and the per-comparison indirect call. Same pdqsort, different overhead.

- **External and distributed sorting**: sort runs, k-way merge with a heap for O(k) memory and sequential I/O - sample sort across machines, where skew is the failure mode and the final merge disappears if consumers read partitions in order.

### Junior -> FAANG: What to Actually Remember

Three things survive contact with an interview.

First, **do not sort for top-k**. The words "top", "kth", "median", or "most frequent" mean stop and offer the menu: sort at O(n log n), heap at O(n log k), quickselect at O(n) average, and here is why I pick one. This single reflex is the highest-value item in the chapter.

Second, **know what Go runs**. "pdqsort since 1.19, insertion sort under 13, heapsort fallback after about log n bad pivots so the worst case is O(n log n)" is fifteen seconds that is very hard to fake.

Third, **ties are a decision you make**, not one the algorithm makes for you. Unstable sorts leave equal elements in arbitrary order, and the failure hides until a slice grows past 12 elements in production.

The mental model for your first year: sorting has properties, not just a complexity. When you meet a sort, ask is it stable, is it in-place, what is the worst case, does it exploit existing order. Those four answers reconstruct everything else.

### Senior @ FAANG: The Sort You Do Not Do

At staff scope the theme of this chapter is that every important sorting decision is a decision not to sort.

The query planner's biggest optimization is eliminating the sort with an index. The LSM tree's insight is keeping data sorted so it never re-sorts. Top-k fan-out sends k elements instead of n. Even pdqsort's largest wins are detecting input that is already ordered and declining to do the work. Only Go's own migration to pdqsort is genuinely about making a sort faster, and even that came from studying input shapes rather than algorithms.

The cost model is the other durable lesson. Comparison count is a teaching abstraction - runtime lives in cache lines and branch mispredictions. That is why radix sort's superior asymptotics routinely lose to pdqsort, and why the biggest lever on a real sort is usually changing what is sorted, (key, offset) pairs instead of 500-byte records, rather than how.

The design review questions worth carrying: what consumes this order, and can that consumer be satisfied without a total order? Is this data re-sorted more often than it changes? For any component with a good average and a catastrophic tail, what is the detector and what is the fallback? pdqsort's `limit` counter is that pattern in miniature, and it generalizes to hash tables, retries, and circuit breakers alike.

---

*Next: Chapter 80, Technical Interview Preparation, turns the algorithmic foundation from Part XI into interview performance: Go-specific questions, live coding under time pressure, and the mechanics of the FAANG loop.*
