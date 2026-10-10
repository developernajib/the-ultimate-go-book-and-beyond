## Summary

- **Binary search** achieves O(log n) by halving search space each step
- **Template 1** (left <= right): for finding exact match
- **Template 2** (left < right): for finding boundaries
- **Rotated array**: determine which half is sorted, then decide
- **Binary search on answer**: when optimizing a value within a range
- **Go's sort.Search**: returns smallest index where f(i) is true, and requires f to be monotone
- **Go's slices.BinarySearch** (since 1.21): returns `(index, found)` for a target value, and is the idiomatic choice when you are searching a sorted slice for a value rather than for a predicate boundary
- Always verify with edge cases: empty, single element, boundaries

Binary search is deceptively simple but requires careful attention to boundary conditions. Master the templates and practice variations to handle any binary search problem confidently.

### Junior -> FAANG: Consolidation and Next Steps

After this chapter, three things should be automatic: the overflow-safe midpoint `lo + (hi-lo)/2`, the two-template decision (exact match vs boundary finding), and the binary-search-on-answer shape recognition (monotone feasibility over a bounded answer range). Test yourself by solving LeetCode 704, 34, 33, 153, 875, and 4 from memory, in that order, within one hour total. If you succeed, you are ready for binary search questions at the FAANG phone-screen and onsite level.

The next topic to study is Chapter 79 (Sorting and Selection), which covers the merge sort and quicksort divide-and-conquer structure that underlies binary search, and which supplies the sorted input every technique in this chapter assumes. Two-pointer techniques are the other natural follow-on, extending the "eliminate part of the search space each step" idea to two moving boundaries. Understanding how these connect builds intuition for why binary search works rather than just that it does.

One habit to build immediately: whenever you write a linear scan in production code, pause and ask "is the input sorted or sortable? Could this be binary search?" For small inputs (under 20 elements) the answer is usually no. For large inputs or latency-sensitive paths, the O(log n) vs O(n) difference is worth the code complexity.

### Senior @ FAANG: Platform and Governance Summary

Binary search appears in Go's standard library in two families, and knowing which to reach for is the first governance decision. `slices.BinarySearch` and `slices.BinarySearchFunc`, added in Go 1.21, search a sorted slice for a value and return `(index, found)`. `sort.Search` takes a monotone predicate and returns the smallest index satisfying it, which is the more general lower-bound contract, and `sort.SearchInts` and friends are thin wrappers over it. Prefer `slices.BinarySearch` when you are looking for a value, `sort.Search` when you are looking for a boundary. Either beats a hand-rolled loop, and the exceptions require justification in review.

Both share a precondition that neither can enforce, and it is worth stating plainly because it is the failure mode teams actually hit. `slices.BinarySearch` requires the slice to be sorted, and `sort.Search` requires the predicate to be monotone. Violate either and you get no panic and no error, just a wrong answer delivered confidently. On the unsorted slice `[9, 1, 5, 3]`, `slices.BinarySearch` reports `found == false` for the value 9 that sits at index 0. Nothing in the type system catches this, which is why the precondition belongs in the constructor or the type that produces the ordered data, not in a comment at each call site.

One useful detail: on a run of equal elements, `slices.BinarySearch` returns the leftmost index, so it doubles as a lower-bound query without extra work.

The three production contexts where binary search matters most at FAANG scale are: log-structured storage (SSTable binary search for key lookup), inverted index intersection (posting list binary search), and capacity optimization (binary search on answer for fleet sizing, rate limiting, and work distribution). Each context has its own failure mode: SSTable search fails for non-monotone key comparators, posting list search fails for non-sorted lists, and capacity optimization fails for non-monotone feasibility functions. A senior engineer owns the documentation of these preconditions and the test suite that validates them.

The maturity model for binary search in a production codebase: Level 1 is using `sort.Search` correctly. Level 2 is using binary search on answer for optimization problems. Level 3 is writing a domain-specific binary search abstraction that eliminates the common pitfalls for your team's specific use cases. Level 4 is contributing that abstraction to a shared library with fuzz tests, linter rules, and documentation that prevents recurrence of the bug classes described in this chapter. The gap between Level 1 and Level 4 is the gap between an engineer who knows binary search and an engineer who makes their team better at it.
