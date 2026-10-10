## 79.1 The Sorting Landscape

Before any implementation, fix the vocabulary. Four properties describe every sorting algorithm, and together they explain every design decision in every standard library.

**Stability.** A sort is stable if elements comparing equal keep their original relative order. Sort employees by department with a stable sort and employees within a department stay in whatever order they arrived. Use an unstable sort and that order is arbitrary. Stability is not a nicety, it is the mechanism that makes multi-key sorting work by repeated passes.

**In-place.** A sort is in-place if it needs only O(1) or O(log n) auxiliary memory beyond the input. Quicksort's O(log n) comes from recursion depth, not from copying data. Mergesort's standard form needs O(n) scratch space, which is why it loses to quicksort in memory-constrained settings despite a better worst case.

**Worst case.** The bound that matters when an adversary, or an unlucky input distribution, controls your data. Quicksort's O(n squared) worst case is not theoretical: it was a real denial-of-service vector against language runtimes whose sorts had predictable pivots.

**Adaptivity.** An adaptive sort runs faster on partially ordered input. Insertion sort is O(n) on already-sorted data, which is why it is the base case inside almost every production quicksort. Real data is very often partially sorted, so this property earns more than its reputation suggests.

Here is the table those properties produce. Memorize this and you can reconstruct the reasoning behind any library sort.

| Algorithm | Stable | In-place | Best | Average | Worst | Adaptive |
|-----------|--------|----------|------|---------|-------|----------|
| Insertion | Yes | Yes | O(n) | O(n^2) | O(n^2) | Yes |
| Selection | No | Yes | O(n^2) | O(n^2) | O(n^2) | No |
| Merge | Yes | No, O(n) | O(n log n) | O(n log n) | O(n log n) | In run-based variants |
| Heap | No | Yes | O(n log n) | O(n log n) | O(n log n) | No |
| Quick | No | Yes, O(log n) stack | O(n log n) | O(n log n) | O(n^2) | No |
| Counting | Yes | No, O(n+k) | O(n+k) | O(n+k) | O(n+k) | No |
| Radix (LSD) | Yes | No, O(n+k) | O(nk) | O(nk) | O(nk) | No |

### The Comparison Lower Bound

Any sort that learns about its input only by comparing pairs of elements requires Omega(n log n) comparisons in the worst case. The proof is short enough to reconstruct in an interview and is worth being able to give.

Model the algorithm as a decision tree. Each internal node is a comparison, each of the two edges below it is an outcome, and each leaf is a final permutation the algorithm can output. To sort correctly, the tree must have a distinct leaf for every one of the n! possible input permutations, because an algorithm that reached the same leaf for two different permutations would have to output the same answer for both, and it cannot be right in both cases. A binary tree with n! leaves has height at least log2(n!). By Stirling's approximation, log2(n!) is Theta(n log n). The height of the tree is the number of comparisons on the worst-case path, so that path is Omega(n log n).

The assumption the proof leans on is the entire escape route: **the algorithm's only way to learn about the data is comparison**. Counting sort does not compare elements at all. It uses each key directly as an array index, which is a different and stronger operation than comparison, so the theorem simply does not apply to it. This is the point candidates most often miss. Counting sort is not a clever way to beat an impossibility proof. It plays a different game by requiring something the proof never assumed you have: keys that are bounded integers you can index with.

```go
// The lower bound is about comparisons, not about time.
// This is legal and it is O(n), because it never compares two elements.
func sortBoolean(flags []bool) {
    trueCount := 0
    for _, f := range flags {
        if f {
            trueCount++
        }
    }
    falseCount := len(flags) - trueCount
    for i := range flags {
        flags[i] = i >= falseCount
    }
}
```

### Which Sort Does Go Actually Run

Since Go 1.19 the standard library's unstable sort is **pdqsort**, pattern-defeating quicksort, an algorithm published by Orson Peters. Before 1.19 it was a quicksort with a heapsort fallback in the introsort style. `sort.Stable` and `slices.SortStableFunc` use a different algorithm entirely: insertion sort on small blocks followed by an in-place symmerge, which trades speed for the stability guarantee and O(1) extra space.

That split is the practical takeaway of this section. Go gives you two sorts with different contracts, and choosing between them is the only sorting decision most engineers will ever legitimately make.

```go
s := []int{5, 2, 8, 1}

slices.Sort(s)        // pdqsort, unstable, fastest, ordered types only
sort.Slice(s, less)   // pdqsort, unstable, reflect-based swaps, slower
sort.SliceStable(s, less) // stable, slower still, preserves tie order
```

### Junior -> FAANG: The Four Questions

When you meet an unfamiliar sort, ask the four property questions rather than tracing the code. Is it stable, is it in-place, what is the worst case, does it exploit existing order. Those four answers tell you where the algorithm belongs and what it costs, and they are what an interviewer is probing when they ask you to compare two sorts. "Mergesort is stable and quicksort is not, so mergesort is what you want for multi-key passes, but it costs O(n) extra memory" is a complete and senior-sounding answer built entirely from the table above.

The lower-bound proof is worth being able to sketch because interviewers use it as a probe. The follow-up is always some version of "so how does counting sort get O(n)?" The answer they want is not a description of counting sort. It is the recognition that the theorem constrains comparison-based algorithms and counting sort is not one.

### Senior @ FAANG: The Cost Model Is Not Comparisons

The comparison count is a teaching abstraction, and at senior level it is the wrong cost model. On current hardware a sort's runtime is dominated by cache behavior and branch prediction, not by how many times it evaluated `a < b`. This is why radix sort, with its seductive O(nk) and no comparisons at all, routinely loses to pdqsort on realistic data: it makes multiple passes over the array with scattered writes, and the memory system punishes that far more than the comparisons it saved. Section 79.5 makes that case concretely.

It is also why pdqsort's most important properties are not asymptotic. Its wins come from detecting the shape of the input, already-sorted, reversed, duplicate-heavy, and handling each in a pass that touches memory sequentially, plus an insertion sort for small ranges whose access pattern the cache loves. Notably, Go's implementation deliberately stops short of the branchless partitioning that the reference C++ pdqsort uses, a point section 79.3 covers precisely. An engineer who can say that out loud is describing a profile rather than reciting a table, and that is the difference the question is designed to find.
