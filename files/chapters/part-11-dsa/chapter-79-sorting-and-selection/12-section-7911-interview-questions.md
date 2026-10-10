## 79.11 Interview Questions

**Q1: Can you sort faster than O(n log n)?**

Yes, but only by changing the game. The Omega(n log n) bound applies to **comparison-based** sorting and follows from the decision-tree argument: a correct sort needs a distinct leaf for each of the n! permutations, and a binary tree with n! leaves has height at least log2(n!) = Theta(n log n).

Counting and radix sort escape it because they never compare elements. They use the key directly as an array index, which is a strictly stronger operation than comparison, so the theorem does not apply. The price is real: keys must be bounded integers, and you pay O(k) space for the key range.

In practice, escaping the bound often does not help. Radix sort makes k passes with scattered writes, and on modern hardware that cache behaviour frequently costs more than the comparisons it saved. It wins on large volumes of fixed-width keys, which is why it shows up in columnar databases and on GPUs, and loses on a slice of structs.

---

**Q2: Find the kth largest element in an array.**

Three approaches, and naming all three is the answer:

1. **Sort and index**: O(n log n) time, O(1) space. Correct, and the answer they hope you improve on.
2. **Min-heap of size k**: O(n log k) time, O(k) space. Streams, never needs the array in memory.
3. **Quickselect**: O(n) average, O(1) space, mutates the input, O(n squared) worst case unless the pivot is randomized.

For k=10 and n=10 million, the heap: log k is about 3, so it is effectively a linear pass, and it does not need to hold the input. For k close to n, just sort. If you must have the exact kth element and can reorder the array, quickselect.

The reasoning is what is being graded, not the code.

---

**Q3: Why is `slices.Sort` faster than `sort.Slice`?**

Same algorithm, different overhead. Both run pdqsort. `sort.Slice` receives a `less` function over indices and has no static type information, so it builds a swapper via reflection and pays an indirect call for every comparison. `slices.Sort` is generic, so the element type is known at compile time, swaps are direct assignments, and comparisons on ordered types inline into the sort loop.

Measured on Go 1.27.1 with 10,000 ints, `sort.Slice` runs about 1.7x the time of `slices.Sort`, and `sort.SliceStable` about 4.1x. The exact ratio moves with element size and comparison cost, but the direction never does, because it follows from reflection versus monomorphisation.

---

**Q4: Sort 10 TB of records on a machine with 64 GB of RAM.**

Ask first: record size, key size, are keys bounded, must the output be a single stream, one machine or many.

Single machine, external merge sort in two phases. Phase 1: read chunks that fit in memory, sort each, spill to a temp file. Phase 2: k-way merge the runs with a heap holding one record per run, so merge memory is O(k) and all I/O is sequential. Roughly two reads and two writes of the dataset for a single-pass merge.

The optimization to volunteer: sort (key, offset) pairs rather than whole records. If records are 500 bytes and keys are 8, you cut bytes moved by more than 30x and materialize full records once at the end.

Many machines: sample sort. Sample to pick splitters, shuffle each partition to its owner, sort locally. If consumers can read partitions in order, there is no final merge. The failure mode is key skew making one node a straggler.

---

**Q5: Sort employees by department, then by name within department.**

Two ways. One comparison with an explicit tie-break:

```go
slices.SortFunc(people, func(a, b Employee) int {
    if c := strings.Compare(a.Dept, b.Dept); c != 0 {
        return c
    }
    return strings.Compare(a.Name, b.Name)
})
```

Or two stable passes, least significant key first:

```go
slices.SortStableFunc(people, byName) // secondary first
slices.SortStableFunc(people, byDept) // then primary, stably
```

Prefer the first: one pass, the faster unstable sort is safe because the comparison is now a total order, and the tie-break rule is visible in the code. The second depends on call order and on stability, both invisible to a casual reader. It earns its place only when the keys are not available at the same time or the sorts happen in different layers.

---

**Q6: What is stability and when does it matter?**

A stable sort preserves the input order of elements that compare equal. It matters whenever ties exist and their order is observable: multi-key sorting by repeated passes depends on it entirely, and any output that is serialized, cached, diffed, or compared to a golden file needs a deterministic order.

`slices.Sort`, `slices.SortFunc`, and `sort.Slice` are unstable. `slices.SortStableFunc` and `sort.SliceStable` are stable and measurably slower.

The senior answer adds: rather than depending on stability, prefer making the comparison a total order by breaking ties on a unique field. Then the output is a function of the data alone and does not depend on the algorithm, the input order, or the Go version. That is strictly more reliable than relying on a stability guarantee.

---

**Q7: Given a stream you cannot fit in memory, find the median.**

Exactly, in one pass, in sublinear space: impossible. Any exact median requires either storing the data or multiple passes.

Practical answers, and picking correctly is the point:

- **Two heaps** (max-heap of the lower half, min-heap of the upper half, kept balanced): exact, one pass, but O(n) memory. Good when the data fits, which is the usual "median of a stream" interview question.
- **t-digest or DDSketch**: approximate, O(1)-ish memory, with bounded relative error and strong accuracy at the tails. This is what real monitoring systems use for p50 and p99, per Chapter 104.
- **Two passes with a histogram**: bucket by value range on pass one, then pass two over the bucket containing the median. Exact, bounded memory, needs two passes.

The follow-up is always "what error can you tolerate?" A latency dashboard tolerates approximation. A billing system does not.

---

**Q8: Why does Go's sort use insertion sort for small slices?**

Because asymptotics do not describe small n. Insertion sort is O(n squared), but its constant factor is tiny, it touches memory sequentially, it branches predictably, and it needs no recursion or partitioning setup. Below Go's threshold of 12 elements it simply beats quicksort.

This matters more than it sounds, because recursion generates an enormous number of small ranges. The base case is where a large share of the total work in any quicksort actually happens, so its constant factor is not a detail.

The general lesson: complexity classes describe growth, not cost at a given size. An O(n squared) algorithm with a small constant beats an O(n log n) one with a large constant for every n below the crossover, and knowing where crossovers live is what separates measurement from recitation.
