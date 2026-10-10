## 15.8 Parallel Algorithms

### Parallel Map

`ParallelMap` applies a function to each element of a slice concurrently, bounded to `workers` goroutines by a buffered channel semaphore. Writing results by index rather than appending to a shared slice makes the parallel writes race-free without a mutex, since each goroutine writes to a distinct index. Distinct indices of a slice are distinct memory, so there is no race even though the slice is shared, and `wg.Wait` provides the happens-before edge the caller needs to read the results.

The `sem <- struct{}{}` sits on the calling goroutine, before the `go` statement, which is what bounds goroutine count rather than merely bounding concurrent work. One caveat to know: `fn` runs unguarded, so a panic in any element takes the process down. If `fn` is caller-supplied and may fail, `errgroup.Group` with `SetLimit` gives you the same bound plus error propagation and cancellation.

```go
func ParallelMap[T, R any](items []T, fn func(T) R, workers int) []R {
    results := make([]R, len(items))
    var wg sync.WaitGroup
    sem := make(chan struct{}, workers)

    for i, item := range items {
        wg.Add(1)
        sem <- struct{}{}

        go func(i int, item T) {
            defer func() {
                <-sem
                wg.Done()
            }()
            results[i] = fn(item)
        }(i, item)
    }

    wg.Wait()
    return results
}
```

### Parallel Reduce

`ParallelReduce` divides the input slice into equal chunks and reduces each chunk independently in its own goroutine, writing the partial result to a pre-allocated slice indexed by chunk number to avoid synchronization. Once all goroutines finish, the partial results are combined in a final serial pass. This two-phase approach works correctly only when the combining function `fn` is associative, meaning the order in which partial results are combined does not affect the final answer.

There is a trap in the bookkeeping that is worth studying, because it produces wrong answers rather than crashes. Size `partials` by `workers` and it is tempting to fold the whole slice at the end. But when there is less work than there are workers, some chunks are never produced, and those entries keep the zero value of `T`. Folding them in means folding a value that was never in the input.

The bug hides because of *which* reduction people test with. Reduce `[]int{5, 7}` over 8 workers:

```
min     = 0   want 5
product = 0   want 35
sum     = 12  want 12
```

Sum is correct, and sum is what everyone writes the test for. It is correct only because 0 happens to be the identity of addition. Minimum and product are silently, badly wrong, and a `min` reduction that returns 0 for a slice with no zeros in it is the kind of result that gets blamed on the data for a week. Reduce exactly the chunks you actually created and the class of bug disappears rather than being papered over with an identity value the caller never supplied.

```go
func ParallelReduce[T any](items []T, fn func(T, T) T, workers int) T {
    if len(items) == 0 {
        var zero T
        return zero
    }
    if len(items) == 1 {
        return items[0]
    }
    if workers < 1 {
        workers = 1
    }

    chunkSize := (len(items) + workers - 1) / workers

    // Size partials by the number of chunks that will really exist, not
    // by workers. With fewer items than workers these differ, and the
    // unwritten entries would be zero values folded into the answer.
    nChunks := (len(items) + chunkSize - 1) / chunkSize
    partials := make([]T, nChunks)

    var wg sync.WaitGroup
    for i := 0; i < nChunks; i++ {
        start := i * chunkSize
        end := min(start+chunkSize, len(items))

        wg.Add(1)
        go func(i int, chunk []T) {
            defer wg.Done()
            // Seed from the data, never from a zero value: T has no
            // identity element we are entitled to invent.
            result := chunk[0]
            for _, item := range chunk[1:] {
                result = fn(result, item)
            }
            partials[i] = result
        }(i, items[start:end])
    }

    wg.Wait()

    // Every entry here was written by a goroutine above.
    result := partials[0]
    for _, p := range partials[1:] {
        result = fn(result, p)
    }
    return result
}
```

### Parallel Sort

`ParallelSort` implements a parallel merge sort by recursively splitting the slice in half, sorting one half in a new goroutine and the other on the current goroutine, then merging the two sorted sub-slices back into the original with a standard two-pointer merge. The `threshold` parameter controls when the recursion switches to Go's built-in sequential sort, preventing excessive goroutine creation on small sub-slices where parallelism overhead would outweigh the benefit.

Sorting both halves in new goroutines and waiting on both is the more symmetrical-looking version, and it is worse. The parent goroutine has nothing to do but block, so it spawns twice the goroutines to get the same parallelism, and every recursion level pays for a goroutine that exists only to wait. Forking one half and recursing inline on the other is the standard shape for divide-and-conquer, and it also guarantees forward progress: the current goroutine is always doing real work rather than depending on a scheduler slot to become free.

Note the two halves write to disjoint sub-slices of the same backing array, which is what makes this safe without a lock. `wg.Wait` then establishes the happens-before edge that lets `merge` read both halves.

```go
func ParallelSort[T cmp.Ordered](items []T, threshold int) {
    if len(items) <= threshold {
        slices.Sort(items)
        return
    }

    mid := len(items) / 2

    var wg sync.WaitGroup
    wg.Add(1)

    go func() {
        defer wg.Done()
        ParallelSort(items[:mid], threshold)
    }()

    // Sort the other half here rather than idling in a wait.
    ParallelSort(items[mid:], threshold)

    wg.Wait()

    // Merge
    merged := make([]T, len(items))
    merge(items[:mid], items[mid:], merged)
    copy(items, merged)
}

func merge[T cmp.Ordered](left, right, result []T) {
    i, j, k := 0, 0, 0
    for i < len(left) && j < len(right) {
        if left[i] <= right[j] {
            result[k] = left[i]
            i++
        } else {
            result[k] = right[j]
            j++
        }
        k++
    }
    for i < len(left) {
        result[k] = left[i]
        i++
        k++
    }
    for j < len(right) {
        result[k] = right[j]
        j++
        k++
    }
}
```

### Staff Lens: Parallel Algorithm Tuning

The threshold for parallelizing a recursive algorithm is workload-dependent. Too aggressive (small threshold) and goroutine overhead dominates. Too conservative (large threshold) and you leave parallelism on the table. Benchmark on realistic data sizes. Typical threshold for CPU-bound divide-and-conquer: 10,000 to 100,000 elements.

For most Go services, parallel algorithms are not a bottleneck because I/O dominates. Reserve this work for data-processing tools, batch jobs, and the rare CPU-bound service. Profile before parallelizing.

---
