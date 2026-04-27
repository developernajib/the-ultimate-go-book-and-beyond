export default `## 15.8 Parallel Algorithms

### Parallel Map

\`ParallelMap\` applies a function to each element of a slice concurrently, bounded to \`workers\` goroutines by a buffered channel semaphore. Writing results by index rather than appending to a shared slice makes the parallel writes race-free without a mutex, since each goroutine writes to a distinct index.

\`\`\`go
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
\`\`\`

### Parallel Reduce

\`ParallelReduce\` divides the input slice into equal chunks and reduces each chunk independently in its own goroutine, writing the partial result to a pre-allocated slice indexed by worker ID to avoid synchronization. Once all goroutines finish, the partial results are combined sequentially in a final serial reduction pass. This two-phase approach works correctly only when the combining function \`fn\` is associative, meaning the order in which partial results are combined does not affect the final answer.

\`\`\`go
func ParallelReduce[T any](items []T, fn func(T, T) T, workers int) T {
    if len(items) == 0 {
        var zero T
        return zero
    }
    if len(items) == 1 {
        return items[0]
    }

    chunkSize := (len(items) + workers - 1) / workers
    partials := make([]T, workers)
    var wg sync.WaitGroup

    for i := 0; i < workers; i++ {
        start := i * chunkSize
        end := start + chunkSize
        if end > len(items) {
            end = len(items)
        }
        if start >= len(items) {
            break
        }

        wg.Add(1)
        go func(i int, chunk []T) {
            defer wg.Done()
            result := chunk[0]
            for _, item := range chunk[1:] {
                result = fn(result, item)
            }
            partials[i] = result
        }(i, items[start:end])
    }

    wg.Wait()

    // Reduce partials
    result := partials[0]
    for _, p := range partials[1:] {
        result = fn(result, p)
    }
    return result
}
\`\`\`

### Parallel Sort

\`ParallelSort\` implements a parallel merge sort by recursively splitting the slice in half and sorting each half in a separate goroutine. Once both halves are sorted and the \`WaitGroup\` is done, the two sorted sub-slices are merged back into the original slice using a standard two-pointer merge. The \`threshold\` parameter controls when the recursion switches to Go's built-in sequential sort, preventing excessive goroutine creation on small sub-slices where parallelism overhead would outweigh the benefit.

\`\`\`go
func ParallelSort[T cmp.Ordered](items []T, threshold int) {
    if len(items) <= threshold {
        slices.Sort(items)
        return
    }

    mid := len(items) / 2

    var wg sync.WaitGroup
    wg.Add(2)

    go func() {
        defer wg.Done()
        ParallelSort(items[:mid], threshold)
    }()

    go func() {
        defer wg.Done()
        ParallelSort(items[mid:], threshold)
    }()

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
\`\`\`

### Staff Lens: Parallel Algorithm Tuning

The threshold for parallelising a recursive algorithm is workload-dependent. Too aggressive (small threshold) and goroutine overhead dominates; too conservative (large threshold) and you leave parallelism on the table. Benchmark on realistic data sizes. Typical threshold for CPU-bound divide-and-conquer: 10,000 to 100,000 elements.

For most Go services, parallel algorithms are not a bottleneck because I/O dominates. Reserve this work for data-processing tools, batch jobs, and the rare CPU-bound service. Profile before parallelising.

---
`;
