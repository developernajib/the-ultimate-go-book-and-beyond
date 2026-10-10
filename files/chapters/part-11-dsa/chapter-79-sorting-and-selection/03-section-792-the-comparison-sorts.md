## 79.2 The Comparison Sorts

You will not ship these. You implement them once so that the invariants become familiar, because those invariants reappear inside the algorithms you do ship.

### Insertion Sort

Maintain the invariant that `a[0:i]` is sorted, then insert `a[i]` into its place by shifting larger elements right.

```go
func insertionSort(a []int) {
    for i := 1; i < len(a); i++ {
        // Invariant: a[0:i] is sorted.
        v := a[i]
        j := i - 1
        for j >= 0 && a[j] > v {
            a[j+1] = a[j]
            j--
        }
        a[j+1] = v
    }
}
```

The strict `>` is what makes it stable: an element equal to `v` stops the shift, so `v` lands after its equal predecessor. Change it to `>=` and you have silently made the sort unstable while it still passes every test that does not inspect tie order. That is a real and hard-to-find bug class.

Insertion sort is O(n squared) in general and O(n) on sorted input, since the inner loop never runs. Its constant factor is tiny and its memory access is sequential, which is why every production quicksort in existence, Go's included, switches to it below some threshold (12 elements in Go's pdqsort). It is the fastest sort in the world for small n, and that fact is load-bearing rather than trivia.

### Mergesort

Split, sort each half, merge. The merge step is where stability is won or lost.

```go
func mergeSort(a []int) []int {
    if len(a) <= 1 {
        return a
    }
    mid := len(a) / 2
    left := mergeSort(a[:mid])
    right := mergeSort(a[mid:])
    return merge(left, right)
}

func merge(left, right []int) []int {
    out := make([]int, 0, len(left)+len(right))
    i, j := 0, 0
    for i < len(left) && j < len(right) {
        // <= keeps the sort stable: on a tie, the left element
        // (originally earlier) is emitted first.
        if left[i] <= right[j] {
            out = append(out, left[i])
            i++
        } else {
            out = append(out, right[j])
            j++
        }
    }
    out = append(out, left[i:]...)
    out = append(out, right[j:]...)
    return out
}
```

Again a single character carries the contract. `left[i] <= right[j]` is stable, `left[i] < right[j]` is not, and nothing else about the code changes.

Mergesort's O(n log n) is a worst case, not an average, which is its main advantage over quicksort. Its cost is the O(n) scratch space and the allocation traffic: the version above allocates at every level. A production mergesort allocates one buffer up front and merges into it, alternating direction between levels. Mergesort is also the natural algorithm when the data is a linked list (no random access needed) or when it does not fit in memory at all, which is the subject of section 79.8.

### Heapsort

Build a max-heap, then repeatedly swap the root to the end and sift down.

```go
func heapSort(a []int) {
    n := len(a)
    for i := n/2 - 1; i >= 0; i-- { // build heap, O(n)
        siftDown(a, i, n)
    }
    for end := n - 1; end > 0; end-- {
        a[0], a[end] = a[end], a[0]
        siftDown(a, 0, end)
    }
}

func siftDown(a []int, root, end int) {
    for {
        child := 2*root + 1
        if child >= end {
            return
        }
        if child+1 < end && a[child+1] > a[child] {
            child++
        }
        if a[root] >= a[child] {
            return
        }
        a[root], a[child] = a[child], a[root]
        root = child
    }
}
```

Heapsort is the only one of the four that is both in-place and O(n log n) in the worst case. That combination is exactly why it exists in practice: it is the fallback that rescues quicksort from its quadratic case. It is unstable, and it is slower than quicksort on typical input because its memory access jumps around the array, defeating the cache. Nobody chooses heapsort for speed. They choose it for the guarantee.

### Quicksort

Partition around a pivot, recurse on both sides. Everything interesting about quicksort is in the choice of pivot and the partition scheme, which is section 79.3.

```go
func quickSort(a []int) {
    if len(a) < 2 {
        return
    }
    p := partition(a)
    quickSort(a[:p])
    quickSort(a[p+1:])
}

// Lomuto partition: simple, but does 3x the swaps of Hoare
// and degrades badly on inputs with many duplicates.
func partition(a []int) int {
    pivot := a[len(a)-1]
    i := 0
    for j := 0; j < len(a)-1; j++ {
        if a[j] < pivot {
            a[i], a[j] = a[j], a[i]
            i++
        }
    }
    a[i], a[len(a)-1] = a[len(a)-1], a[i]
    return i
}
```

This is the textbook version and it is a trap. With the last element as pivot, sorted input produces maximally unbalanced partitions and the recursion goes O(n) deep with O(n squared) total work. On an all-duplicates array it is quadratic too. Both inputs are extremely common in the real world, which is the entire reason pdqsort exists.

### Junior -> FAANG: Trace the Invariant, Not the Code

The way to hold these four in memory is one sentence each. Insertion sort: `a[0:i]` is sorted, insert the next element. Mergesort: sort the halves, merge them. Heapsort: the heap's root is the max, move it to the end. Quicksort: everything left of the pivot is smaller, everything right is larger, the pivot is home.

If you can state the invariant you can rebuild the code. If you can only recall the code you will produce off-by-one errors under pressure. That is the same lesson as binary search in Chapter 77, and it is not a coincidence: both algorithms are short enough that the invariant is the whole difficulty.

Know that the `<=` versus `<` in merge and the `>` versus `>=` in insertion sort are what stability rests on. An interviewer who asks "is your mergesort stable?" is asking whether you know which comparison decides it.

### Senior @ FAANG: Why the Textbook Quicksort Is a Vulnerability

The Lomuto partition above, with a fixed pivot, is not merely slow on adversarial input. It has been a real availability vulnerability. If an attacker can influence the order of data your service sorts, and your sort has a deterministic pivot, they can drive it quadratic on demand. This is the same family as algorithmic-complexity attacks on hash tables, which is why Go randomizes map iteration order and hash seeds.

The mitigations, in ascending order of strength: randomize the pivot (an attacker cannot predict it, but a bad distribution can still hurt), use median-of-three or median-of-nine (better balance, still defeatable in principle), or bound the recursion depth and switch to heapsort when it is exceeded, which converts the quadratic case into a hard O(n log n) guarantee. That last one is introsort's core idea and Go's pdqsort keeps it. The pattern generalizes past sorting: when an algorithm has a good average case and a catastrophic worst case, the production answer is usually a detector and a fallback rather than a better average.
