## 79.6 Selection and Order Statistics

Selection is the question "what is the kth smallest element?" It is more common in real systems than sorting, and it is cheaper. Sorting to answer it is the single most frequent avoidable inefficiency in interview answers and in production code alike.

### Quickselect

Quicksort partitions and recurses on both sides. Quickselect partitions and recurses on **one** side, because after partitioning you know exactly which side the kth element is on.

```go
// quickSelect returns the k-th smallest element (0-indexed) of a.
// It reorders a in place. Average O(n), worst O(n^2).
func quickSelect(a []int, k int) int {
    lo, hi := 0, len(a)-1
    for lo < hi {
        p := partition(a, lo, hi)
        switch {
        case p == k:
            return a[k]
        case p < k:
            lo = p + 1 // the answer is to the right
        default:
            hi = p - 1 // the answer is to the left
        }
    }
    return a[lo]
}
```

The complexity argument is the memorable part. Quicksort does work n at the top level, then two halves each doing n/2, so every level costs n and there are log n levels: O(n log n). Quickselect does n, then n/2, then n/4, and that geometric series sums to 2n. Discarding half the work at each step instead of recursing into it turns O(n log n) into **O(n)**.

The worst case is still O(n squared) with bad pivots, for exactly the same reason quicksort's is, and the same mitigations apply: randomize the pivot, or use median-of-medians.

### Median of Medians

Median-of-medians chooses a pivot guaranteed to be reasonably central, which makes quickselect O(n) in the *worst* case, not just on average. It splits the input into groups of five, takes each group's median, then recursively selects the median of those medians as the pivot. That pivot is guaranteed to be greater than at least 30 percent and less than at least 30 percent of the elements, which bounds how unbalanced the partition can be.

It is a beautiful result and you should know it exists, know it gives worst-case linear selection, and know that essentially nobody uses it. Its constant factor is large enough that randomized quickselect beats it in practice on virtually all real input. Cite it in an interview as the theoretical answer to "what if the pivots are adversarial," then say you would ship randomized quickselect. Knowing when a theoretically superior algorithm is the wrong engineering choice is the point.

### Top-K With a Bounded Heap

Here is what production code usually wants. Not the kth element, but the k best, and often from a stream that does not fit in memory.

```go
// topK returns the k largest elements of a, using a min-heap of size k.
// O(n log k) time, O(k) space, and it never needs all of a in memory.
func topK(a []int, k int) []int {
    if k <= 0 {
        return nil
    }
    h := &intHeap{} // min-heap
    heap.Init(h)
    for _, v := range a {
        if h.Len() < k {
            heap.Push(h, v)
            continue
        }
        if v > (*h)[0] { // bigger than the smallest of our k best
            heap.Pop(h)
            heap.Push(h, v)
        }
    }
    return *h
}
```

The trick is that the heap is a **min**-heap of the k **largest** elements, which reads backwards until you see why: the root is the weakest member of the current best-k, so it is exactly the element to evict when a better one arrives, and comparing against it is an O(1) rejection test for the overwhelming majority of the stream.

### Choosing Between Them

| Approach | Time | Space | Streaming | Mutates input |
|----------|------|-------|-----------|---------------|
| Full sort | O(n log n) | O(1) | No | Yes |
| Bounded heap | O(n log k) | O(k) | Yes | No |
| Quickselect | O(n) average | O(1) | No | Yes |

The decision rule that covers nearly every case:

- **k is small relative to n** (top 10 of 10 million): bounded heap. O(n log k) is effectively O(n) for tiny k, memory is O(k), and it streams.
- **You need the kth element itself, not the top k**, and you have the whole array in memory and may reorder it: quickselect.
- **You need the k results in sorted order and k is close to n**: just sort.
- **The data does not fit in memory**: bounded heap, because it is the only one of the three that never needs the whole input at once.

That last row is why the heap wins in production so much more often than its complexity suggests. "Top 100 by score across a 500 GB dataset" has one answer, and it is a size-100 heap per shard plus a merge.

### Junior -> FAANG: Do Not Sort for Top-K

Internalize one reflex: the words "top k," "k largest," "kth smallest," "median," or "most frequent" mean **stop before typing sort**.

The interview script is reliable. You will be asked for the kth largest element. If you say "sort it and index," you have given a correct answer that costs you the question. The interviewer will ask "can you do better?", and now you are recovering rather than leading. Open with the menu instead: "Three options. Sort is O(n log n). A min-heap of size k is O(n log k) and streams. Quickselect is O(n) average. For k=10 and n=10 million I would use the heap, because log k is about 3 and it does not need the array in memory."

You just answered the question, the follow-up, and the follow-up's follow-up, in twenty seconds.

For "most frequent," the shape is: count with a map (O(n)), then top-k the counts with a heap (O(m log k) for m distinct keys). Not sort the counts.

### Senior @ FAANG: Selection Is a Distributed Problem

At scale, top-k stops being an algorithm and becomes a network question. The k largest across 100 shards is *not* the merge of each shard's local top-k in general, but for the specific case of top-k by a value each shard can evaluate independently, it is: each shard's k best are the only candidates that can be in the global k best, so each shard sends k elements and the coordinator merges 100k of them. Traffic is O(shards * k) rather than O(n), and that is the whole design.

Where it breaks is when the ranking function is not shard-local. If the global score depends on a global statistic (a document's IDF depends on corpus-wide term frequency), a shard cannot rank its own candidates correctly, and you get the two-phase architecture that search engines actually use: gather candidates and local statistics, compute global statistics, then rank. That is the real content behind "how does distributed search work," and it starts from the observation that local top-k is only valid when the score is local.

Approximate top-k is the other lever. Count-min sketch answers "heavy hitters" in sublinear space with bounded error, which is the right trade for a real-time analytics dashboard and the wrong trade for a billing system. Knowing which of your top-k queries can tolerate approximation, and saying so before someone asks, is the senior move.
