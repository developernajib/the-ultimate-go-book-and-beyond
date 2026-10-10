## 79.5 Non-Comparison Sorts

These are the algorithms that escape the Omega(n log n) bound, and the interesting part is not how they work. It is what they demand in return.

### Counting Sort

If your keys are integers in a known, small range, you never need to compare them. Count how many of each value there are, then reconstruct.

```go
// countingSort sorts values in [0, k). It is O(n + k) time and O(n + k) space.
// It is stable, which is what makes it usable as a radix sort pass.
func countingSort(a []int, k int) []int {
    counts := make([]int, k)
    for _, v := range a {
        counts[v]++
    }
    // Prefix sums: counts[v] becomes the first output index for value v.
    sum := 0
    for v := 0; v < k; v++ {
        counts[v], sum = sum, sum+counts[v]
    }
    out := make([]int, len(a))
    for _, v := range a { // forward iteration + prefix sums = stable
        out[counts[v]] = v
        counts[v]++
    }
    return out
}
```

The cost is `O(n + k)`, and that `k` is the whole story. Sorting a million values in [0, 100) is wonderful. Sorting ten values in [0, 2^32) allocates a four-billion-entry array to sort ten elements. Counting sort is not "faster than quicksort," it is a completely different trade: it buys time with space, and it only exists when your keys are dense, bounded, and usable as indices.

### Radix Sort

Radix sort applies counting sort to one digit at a time. Least-significant-digit radix sort processes digits from the right, and it works *only* because each pass is stable: the ordering established by earlier (less significant) digits survives later passes. This is section 79.4's repeated-stable-passes technique, industrialized.

```go
// radixSortLSD sorts non-negative integers using 8-bit digits.
func radixSortLSD(a []uint32) {
    buf := make([]uint32, len(a))
    for shift := uint(0); shift < 32; shift += 8 {
        var counts [256]int
        for _, v := range a {
            counts[(v>>shift)&0xFF]++
        }
        sum := 0
        for i := range counts {
            counts[i], sum = sum, sum+counts[i]
        }
        for _, v := range a { // stable pass
            d := (v >> shift) & 0xFF
            buf[counts[d]] = v
            counts[d]++
        }
        copy(a, buf)
    }
}
```

Four passes for a 32-bit key, each O(n). So it is O(nk) with k=4, which reads as linear and looks unbeatable next to O(n log n).

It usually is not. This is the most instructive disappointment in the chapter. Radix sort makes k full passes over the array and each pass writes to scattered locations determined by the digit, which is close to the worst possible behavior for a cache. pdqsort makes log n passes but each one is largely sequential and the CPU prefetcher handles it well. On realistic data at realistic sizes, the sort with worse asymptotics frequently wins, because comparisons were never the bottleneck. Memory was.

Radix sort earns its keep in the specific conditions where its assumptions are free: large n, fixed-width keys you can extract digits from cheaply, and ideally a workload where you sort the same shape of data repeatedly and can tune the digit width. Sorting a billion fixed-width integers or a column of a columnar database is where it belongs. Sorting a slice of structs by a string field is not.

### Bucket Sort

Distribute elements into buckets by key range, sort each bucket, concatenate. It is O(n) *if* the keys are uniformly distributed, which is a much stronger precondition than it sounds. Under adversarial or merely skewed input every element lands in one bucket and you have paid for the distribution pass and still have to sort n elements. Bucket sort is best understood as the sequential ancestor of the distributed sample sort in section 79.7, where choosing good bucket boundaries is the entire problem.

### When O(n) Sorting Is Legal

The honest summary is a checklist. Reach for a non-comparison sort only when all of these hold:

1. Keys are integers, or map to integers cheaply and order-preservingly.
2. The key range k is bounded and comparable to n, not astronomically larger.
3. n is large enough that log n passes actually cost something.
4. You have measured, and the sort is genuinely the bottleneck.

If any one fails, call `slices.Sort` and move on.

### Junior -> FAANG: The Trap Question

"Can you sort faster than O(n log n)?" is a trap, and both obvious answers are wrong. "No, it's proven impossible" ignores counting sort. "Yes, radix sort is O(n)" ignores the preconditions and usually the reality.

The correct answer has two halves. First, the bound applies to comparison-based sorting, and counting and radix sort escape it by using keys as indices rather than comparing them. Second, escaping it requires bounded integer keys and costs O(k) space, and on real hardware the constant factors and cache behavior mean it often loses anyway. Saying both halves shows you know the theory *and* that you do not trust it blindly.

A concrete anchor to keep: sorting a million 32-bit integers, radix sort is genuinely competitive and often wins. Sorting a million structs by a string field, radix sort is not even applicable. The applicability question comes first.

### Senior @ FAANG: Where This Actually Ships

Non-comparison sorting is not exotic in systems work, it is just narrow. It ships in columnar analytics engines, where a column is a million fixed-width values with known range and the sort is the hot loop. It ships in GPU sorting, where radix sort's data-independent, branch-free structure maps onto SIMD and massive parallelism far better than quicksort's data-dependent recursion. It ships wherever keys are already dense integers, dictionary-encoded strings being the common case: encode strings to integer IDs once, sort the integers, decode at the end.

That last pattern is the transferable idea. Dictionary encoding turns an inapplicable radix sort into an applicable one by changing the *representation* rather than the algorithm. When a senior engineer is asked to make a sort faster, changing what is being sorted is usually a bigger lever than changing how it is sorted. Sort 8-byte (key, index) pairs instead of 200-byte structs and you have cut memory traffic by 25x while making every swap cheap - the sort algorithm never changed.
