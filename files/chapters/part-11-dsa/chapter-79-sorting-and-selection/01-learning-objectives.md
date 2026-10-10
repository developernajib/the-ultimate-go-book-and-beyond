## Learning Objectives

By the end of this chapter, you will:
- Explain the Omega(n log n) comparison lower bound and identify when it does not apply
- Implement insertion, merge, heap, and quicksort in Go with correct invariants
- Describe how pdqsort works and why Go's standard library adopted it
- Choose between stable and unstable sorts based on the problem's tie semantics
- Apply counting, radix, and bucket sort under their real preconditions
- Solve selection problems with quickselect and bounded heaps instead of full sorts
- Use `slices.Sort`, `slices.SortFunc`, `sort.Slice`, and `sort.Stable` correctly and know their relative costs
- Structure an external or distributed sort for data that exceeds memory

### Junior -> FAANG: Converting Objectives into Measurable Benchmarks

Each objective has a benchmark you can test yourself against. "Explain the comparison lower bound" means you can sketch the decision-tree argument in three sentences and immediately name the assumption counting sort violates. "Choose between stable and unstable" means that given a two-key sorting problem you can state, without hesitation, whether the standard library call you are about to write preserves the first key's order.

For the selection objective the benchmark is the sharpest: given "find the kth largest of n elements," you can state three approaches with their complexities in under 60 seconds, sort at O(n log n), heap of size k at O(n log k), quickselect at O(n) average, and say which you would use for k=10 with n=10 million and why. Practice until the answer is reflexive, because this exact question appears constantly and the reflexive full-sort answer costs you points.

For the Go API objective: you should be able to explain, without looking it up, why `slices.Sort` outperforms `sort.Slice` on the same data. If you cannot yet, that is the single highest-value fact in this chapter for a Go interview.

### Senior @ FAANG: Elevating Objectives to Team Standards

For an individual these objectives define sorting literacy. For a team they translate into enforceable standards. New code sorting a slice of a concrete ordered type uses `slices.Sort`, not `sort.Slice`, because the generic path avoids the reflection-based swap and the interface call per comparison. Any use of `sort.Slice` on a hot path is a review comment with a benchmark attached. Any multi-key sort either uses one comparison function with explicit tie-breaking or documents why it relies on a sequence of stable passes, because the failure mode of getting this wrong is a nondeterministic output ordering that only reproduces under load.

The standard worth writing down: no service re-sorts the same data on every request. If a sorted view is read more often than the underlying data changes, the sorted order is a cached artifact with a version stamp or an incrementally maintained structure. That rule catches a recurring and expensive class of latency bug, and it is enforceable in review without any tooling.
