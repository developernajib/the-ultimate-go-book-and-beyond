# Chapter 79: Sorting and Selection

> *"I do not know how many times I have seen a program that sorts a list, then walks the sorted list to find one element."*
> - Rob Pike, Notes on Programming in C

Sorting is the algorithm you will almost never write and must completely understand. Every language ships a sort in its standard library, every database has an ORDER BY, and every reviewer will correctly reject your hand-rolled quicksort. Yet sorting remains the most-taught algorithm in computer science for a reason that has nothing to do with implementing it: it is the cleanest setting in which to reason about asymptotic lower bounds, stability, memory hierarchy, adversarial inputs, and the gap between what an algorithm costs in theory and what it costs on a machine with caches. An engineer who understands why Go replaced its introsort with pattern-defeating quicksort in 1.19 understands something durable about algorithm engineering. An engineer who has only memorized that quicksort is "O(n log n) average, O(n squared) worst" understands almost nothing.

The practical half of this chapter is selection, which is sorting's more useful sibling. Real systems rarely need a total order. They need the top 10 results, the median latency, the 99th percentile, the k nearest neighbors. Sorting to answer those questions costs O(n log n) when the answer is available in O(n) with quickselect or in O(n log k) with a bounded heap. The Pike epigraph above names the failure mode exactly: sorting is such a comfortable reflex that engineers reach for it when a linear scan, a heap of size k, or a single call to `slices.Max` would do. Recognizing when a problem needs order and when it merely needs a boundary is worth more in production and in interviews than any implementation detail.

This chapter builds sorting from the comparison lower bound up through the algorithms Go actually runs, then turns to selection, then to the cases where the data does not fit in memory at all. You will implement the classic sorts to understand their invariants, then spend most of your time on the questions that matter once you stop implementing them: which sort is stable and why you should care, when O(n) sorting is legal, what makes an input adversarial, why `sort.Slice` is slower than `slices.Sort`, and how a 10 TB sort works when your machine has 64 GB of RAM. By the end you should reach for the standard library by default, and know precisely which rare circumstances justify doing anything else.

**What you'll learn in this chapter:**

- Why comparison sorting cannot beat Omega(n log n), proved through the decision-tree argument, and exactly which assumption non-comparison sorts discard to escape it
- Implementing insertion, merge, heap, and quicksort in Go with correct invariants, and knowing which one each is a special case of
- How pattern-defeating quicksort works and why Go adopted it in 1.19: pivot selection, Hoare partitioning, the Dutch-national-flag three-way split, and the heapsort escape hatch
- Stability as an API contract: what `sort.Stable` guarantees, what `slices.Sort` does not, and why multi-key sorting depends on the difference
- Counting, radix, and bucket sort, and the narrow but real conditions under which O(n) sorting applies
- Selection and order statistics: quickselect, median-of-medians for worst-case O(n), and the bounded-heap top-k pattern that production code actually uses
- Go's sorting APIs in depth: `sort.Interface`, `sort.Slice`, `slices.Sort`, `slices.SortFunc`, `sort.Search`, and the measurable cost of the reflection-based path
- External and distributed sorting: k-way merge, external merge sort, and how a terabyte sort is structured across machines

**Why this matters in interviews:**

Sorting questions are rarely "implement quicksort." They are "you have 10 billion integers and 1 GB of RAM, sort them," or "return the k most frequent elements," or "sort this by two keys and explain what happens to ties." Each of these tests whether you understand a property of sorting rather than a procedure. Interviewers use the comparison lower bound to see whether you can recognize the one setting where it does not apply, and they use top-k problems to see whether you sort out of reflex. The single most common avoidable mistake in coding rounds is answering a top-k question with a full sort: it is not wrong, it is O(n log n) where O(n log k) was available, and the interviewer will note that you did not see it. The Go-specific material here also has direct interview value, because "why is `slices.Sort` faster than `sort.Slice`?" is a question with a precise answer that separates candidates who have profiled Go code from candidates who have not.

**Prerequisites:** Chapter 65 (Complexity Analysis), Chapter 71 (Heaps and Priority Queues) for the heapsort and top-k material, and Chapter 77 (Binary Search Variations) for `sort.Search`. Familiarity with Go generics (Chapter 8) helps with the `slices` package sections but is not required.

---

### Junior -> FAANG: Learn the Properties, Not the Procedures

The instinct when studying sorting is to memorize implementations. That instinct is misdirected. You will not be asked to write mergesort at work, and if you write it in an interview without being asked, you have spent ten minutes proving you can do something the standard library does better. What you are actually being tested on is whether you know the properties well enough to choose correctly.

Learn these four properties for every sort you study, and you can reconstruct the whole table from memory: is it stable, is it in-place, what is the worst case, and does it exploit existing order. Insertion sort is stable, in-place, O(n squared) worst, and adaptive (it is O(n) on sorted input, which is why every real quicksort falls back to it on small ranges). Mergesort is stable, not in-place, O(n log n) worst, and adaptive in its natural-run variants. Heapsort is unstable, in-place, O(n log n) worst, and not adaptive. Quicksort is unstable, in-place, O(n squared) worst, and not adaptive. Those four rows explain every design decision in every standard library sort you will ever read.

The entry-point habit to build: when a problem says "top k," "kth largest," "median," or "most frequent," stop before typing `sort`. Ask whether you need the full order or only a boundary. If only a boundary, a heap of size k or quickselect is the answer, and saying so out loud is worth real points. If you genuinely need the total order, say why, then call the library.

For the interview entry point: expect "sort these and explain your complexity," then a pivot to "now the array does not fit in memory" or "now sort by two fields." The second question is the real one. Know that ties are the whole reason stability exists, and be able to explain multi-key sorting both ways: one stable pass per key from least significant to most, or one comparison function that breaks ties explicitly. The second is usually better in Go, and knowing why is a senior signal arriving early.

### Senior @ FAANG: Sorting as a Systems Decision

At senior level, sorting questions stop being about algorithms and become about where the sort happens. The interesting decision in a real system is almost never quicksort versus mergesort. It is whether to sort in the database, in the application, or at the client; whether to maintain a sorted structure incrementally instead of re-sorting; and whether the sort is the bottleneck at all. A staff engineer who reflexively optimizes a sort that accounts for 3 percent of request latency has misread the profile.

The cases where sorting genuinely dominates share a shape: the dataset does not fit in the cache, or does not fit in memory, and the cost is therefore in the memory hierarchy rather than in the comparison count. This is why the theoretically-optimal comparison count is a poor predictor of real performance and why radix sort, whose asymptotics look unbeatable, frequently loses to a well-tuned quicksort on modern hardware. Comparison count is not the cost model. Cache lines and branch mispredictions are. Any candidate who can explain that pdqsort's branchless partitioning matters more than its comparison count is demonstrating that they have read a profile rather than a textbook.

The production discipline worth naming in a design review: prefer maintaining order to restoring it. A B-tree index, a sorted set in Redis, an LSM tree, or a heap that is kept small all replace a repeated O(n log n) sort with an amortized O(log n) insert. When you find a service sorting the same slice on every request, the fix is usually not a faster sort. It is a different data structure, or a cache of the sorted result keyed by a version stamp. That is the ADR-worthy decision, and it is where the actual latency lives.

Bar-raiser signal: an L6 candidate asked to sort 10 TB will not start with an algorithm. They will start by asking what the record size is, whether the keys are bounded, whether the output must be a single sorted stream or merely globally ordered across shards, and what the durability requirement is on intermediate spills. Those four questions determine whether the answer is an external merge sort on one machine, a distributed sample sort, or a partitioned sort where the merge never happens because the consumer reads shards in key order. The algorithm is the last decision, not the first.
