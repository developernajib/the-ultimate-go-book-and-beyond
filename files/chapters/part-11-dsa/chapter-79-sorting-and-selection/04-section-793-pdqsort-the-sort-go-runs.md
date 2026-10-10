## 79.3 pdqsort, the Sort Go Actually Runs

Since Go 1.19 the standard library's unstable sort is pattern-defeating quicksort. It is worth studying not because you will implement it, but because it is a compact catalogue of every lesson the previous section set up: the quadratic case is real, duplicates are a distinct failure mode, sorted input is common enough to special-case, and a good average needs a guaranteed fallback.

The algorithm comes from Orson Peters. The Go implementation cites the paper at arxiv.org/pdf/2106.05123.pdf and the reference C++ implementation at github.com/orlp/pdqsort, and it borrows several refinements from Rust's port. Go's version carries an explicit caveat in its own source comment: it is "based on pattern-defeating quicksort (pdqsort), but without the optimizations from BlockQuicksort." That matters, and we will come back to it.

The whole structure is one loop. In Go's source it reduces to this shape:

```go
func pdqsort(data lessSwap, a, b, limit int) {
    const maxInsertion = 12

    var (
        wasBalanced    = true // was the last partition reasonably balanced
        wasPartitioned = true // was the slice already partitioned
    )

    for {
        length := b - a

        if length <= maxInsertion {
            insertionSort(data, a, b)   // 1. small ranges
            return
        }
        if limit == 0 {
            heapSort(data, a, b)        // 2. the guarantee
            return
        }
        if !wasBalanced {
            breakPatterns(data, a, b)   // 3. defeat the pattern
            limit--
        }

        pivot, hint := choosePivot(data, a, b)
        if hint == decreasingHint {
            reverseRange(data, a, b)    // 4. reversed input is one swap away
            pivot = (b - 1) - (pivot - a)
            hint = increasingHint
        }
        if wasBalanced && wasPartitioned && hint == increasingHint {
            if partialInsertionSort(data, a, b) {
                return                  // 5. already sorted, bail out
            }
        }
        // 6. many duplicates: split into "equal" and "greater"
        // 7. otherwise partition and recurse on the smaller side
        ...
    }
}
```

Each numbered step answers a specific failure of the textbook quicksort.

**1. Small ranges go to insertion sort.** The constant is `maxInsertion = 12`. Below thirteen elements, insertion sort's tiny constant and sequential access beat quicksort's partitioning overhead outright. This is not a micro-optimization at the margins, it is where a large fraction of the total work happens, because recursion produces enormous numbers of small ranges.

**2. `limit` is the guarantee.** `limit` is initialized to `bits.Len(uint(n))`, which is floor(log2(n)) + 1, and it is decremented every time a partition comes out badly unbalanced. When it hits zero, the algorithm abandons quicksort and runs heapsort on the remaining range. This is introsort's idea and it converts quicksort's O(n squared) worst case into a hard O(n log n) worst case. The quadratic denial-of-service vector from the last section is closed structurally: an adversary can force bad pivots, but only about log n times before the algorithm stops playing along.

**3. `breakPatterns` scatters elements** when the previous partition was unbalanced, on the theory that a pattern in the data caused it. This is the "pattern-defeating" in the name.

**4. Reversed input is detected, not fought.** `choosePivot` returns a hint alongside the pivot. If the samples it examined were in strictly decreasing order, it returns `decreasingHint` and the algorithm simply reverses the whole range, turning the worst case for many quicksorts into a linear pass. The comment credits Rust's implementation for the idea.

**5. Sorted input exits early.** If the last partition was balanced, the slice was already partitioned, and the pivot samples look increasing, pdqsort tries `partialInsertionSort`, which sorts the range if it is nearly sorted and gives up quickly if it is not. Already-sorted input, the classic quadratic trap, becomes close to O(n).

**6. Duplicates get their own partition.** When the pivot equals the preceding element, the algorithm uses `partitionEqual` to split the range into "equal to pivot" and "greater than pivot," which collapses runs of duplicates in a single pass. An all-equal array, the other classic quadratic trap for Lomuto partitioning, becomes linear.

### How the Pivot Is Chosen

`choosePivot` is median-of-three for ranges of 8 or more, and for ranges of 50 or more it upgrades to the **Tukey ninther**: it takes the median of three medians, each computed from three adjacent elements sampled at the quarter points. Nine samples, three medians, one median of those.

It also counts the swaps it performed while computing those medians, and uses that count as a free signal about the data:

```go
switch swaps {
case 0:
    return j, increasingHint   // samples were already ordered
case maxSwaps:                 // maxSwaps = 4 * 3
    return j, decreasingHint   // samples were fully reversed
default:
    return j, unknownHint
}
```

This is an elegant piece of engineering worth appreciating: the sortedness hint costs nothing, because it is a byproduct of work the algorithm had to do anyway.

### What Go Left Out

The source comment is explicit that Go's pdqsort omits the BlockQuicksort optimizations. Those are the branchless partitioning techniques that the reference C++ pdqsort uses to avoid branch mispredictions in the partition loop, and they are a substantial part of why the C++ version is as fast as it is. Go's implementation keeps the algorithmic pattern-defeating structure and skips the low-level branchless machinery.

The reason to know this precisely: it is easy to read "Go uses pdqsort" and conclude Go's sort is branchless. It is not. If you are benchmarking Go's sort against C++'s `std::sort` and wondering where the gap comes from, this is a real part of the answer, alongside the interface call per comparison that section 79.7 covers.

### Junior -> FAANG: The Story to Tell

If an interviewer asks "how does Go sort?", the weak answer is "quicksort." The strong answer is a sentence with structure: "pdqsort since 1.19, which is quicksort with three defenses, insertion sort under 13 elements, a heapsort fallback after about log n bad pivots so the worst case is O(n log n) not O(n squared), and special handling for sorted and duplicate-heavy input."

That answer demonstrates you know the three things sorting interviews actually probe: the small-case optimization, the worst-case guarantee, and the adversarial input problem. It takes fifteen seconds and it is very hard to fake.

### Senior @ FAANG: Detector and Fallback as a Pattern

pdqsort's `limit` counter generalizes far beyond sorting, and it is the transferable idea in this section. When an algorithm has an excellent average case and an unacceptable worst case, the mature engineering answer is rarely to find an algorithm with a better average. It is to keep the fast path, add a cheap detector for the bad case, and fall back to something with a guarantee.

You have seen this shape before and will again: hash tables that degrade to trees when a bucket gets too deep, TCP that backs off when it detects loss, circuit breakers that trip after a threshold of failures, retries with a budget. In each case the fast path stays fast and the detector bounds the damage. pdqsort makes it concrete: `limit` is the budget, unbalanced partitions are the failure signal, and heapsort is the degraded mode.

The design review question this gives you: for any component with a good average and a bad tail, "what is the detector and what is the fallback?" If the answer is "there isn't one, the bad case is unlikely," you have found a latent availability risk. Unlikely is a statement about today's inputs, and inputs are frequently attacker-controlled.
