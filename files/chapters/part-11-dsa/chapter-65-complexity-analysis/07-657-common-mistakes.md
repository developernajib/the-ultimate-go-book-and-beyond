## 65.6 Common Mistakes

### Mistake 1: Ignoring Hidden Complexity in Built-in Operations

Go's built-in operations look syntactically cheap but can carry hidden O(n) costs that compound inside loops. String concatenation with `+=` allocates and copies the entire string on every iteration because strings are immutable, turning an apparent O(n) loop into O(n²). Similarly, `append` without a pre-allocated capacity triggers periodic O(n) copies when the underlying array is exhausted, introducing unpredictable latency spikes.

```go
// BAD: Assumes string concatenation is O(1)
func badBuildString(words []string) string {
    result := ""
    for _, word := range words {
        result += word // O(n) per operation due to string immutability
    }
    return result // Total: O(n²) where n is total characters
}

// GOOD: Use strings.Builder for O(n) total
func goodBuildString(words []string) string {
    var builder strings.Builder
    for _, word := range words {
        builder.WriteString(word) // Amortized O(1)
    }
    return builder.String() // Total: O(n)
}

// BAD: Assumes append is always O(1)
func badAppendLoop(n int) []int {
    var result []int
    for i := 0; i < n; i++ {
        result = append(result, i) // May trigger O(n) copy
    }
    return result // Total: O(n) amortized, but with hidden constant
}

// GOOD: Pre-allocate when size is known
func goodAppendLoop(n int) []int {
    result := make([]int, 0, n) // Pre-allocate
    for i := 0; i < n; i++ {
        result = append(result, i) // Always O(1)
    }
    return result
}
```

### Mistake 2: Not Recognizing Nested Loop Complexity

Nested loops are an obvious O(n²) source, but the pattern is easy to miss when the inner loop is hidden inside a helper function. In the bad example below, each outer iteration calls `contains`, which is itself a linear scan. The overall complexity is O(n²) even though the code reads like two simple loops. Replacing membership checks with a hash map lookup collapses both the outer duplicate scan and the contains call to O(1), reducing total complexity to O(n).

```go
// BAD: O(n²) hidden in innocent-looking code
func badFindDuplicates(nums []int) []int {
    var duplicates []int
    for i, num := range nums {
        // This creates O(n²) behavior
        for j := i + 1; j < len(nums); j++ {
            if nums[j] == num && !contains(duplicates, num) {
                duplicates = append(duplicates, num)
            }
        }
    }
    return duplicates
}

func contains(slice []int, val int) bool {
    for _, v := range slice {
        if v == val {
            return true
        }
    }
    return false // O(n) per call!
}

// GOOD: O(n) using hash map
func goodFindDuplicates(nums []int) []int {
    seen := make(map[int]bool)
    added := make(map[int]bool)
    var duplicates []int

    for _, num := range nums {
        if seen[num] {
            if !added[num] {
                duplicates = append(duplicates, num)
                added[num] = true
            }
        }
        seen[num] = true
    }
    return duplicates
}
```

### Mistake 3: Recursion Without Memoization

Naive recursive implementations of problems with overlapping subproblems (like Fibonacci) recompute the same values exponentially many times. `badFibonacci(50)` spawns tens of billions of calls (the call count grows as φⁿ, about 1.618ⁿ) because each call branches into two without checking whether the result is already known. Adding a memoization map cuts this to O(n) unique calls, and converting to an iterative approach eliminates the call-stack overhead entirely while keeping space usage at O(1).

```go
// BAD: O(2^n) exponential - recalculates same subproblems
func badFibonacci(n int) int {
    if n <= 1 {
        return n
    }
    return badFibonacci(n-1) + badFibonacci(n-2)
}
// fib(50) takes minutes, fib(90) would take centuries

// GOOD: O(n) with memoization
func goodFibonacci(n int) int {
    memo := make(map[int]int)
    var fib func(int) int
    fib = func(n int) int {
        if n <= 1 {
            return n
        }
        if v, ok := memo[n]; ok {
            return v
        }
        memo[n] = fib(n-1) + fib(n-2)
        return memo[n]
    }
    return fib(n)
}

// BEST: O(n) time, O(1) space - iterative
func bestFibonacci(n int) int {
    if n <= 1 {
        return n
    }
    prev, curr := 0, 1
    for i := 2; i <= n; i++ {
        prev, curr = curr, prev+curr
    }
    return curr
}
```

### Mistake 4: Using Wrong Data Structure

Reaching for a slice when the dominant operation is membership testing is a common source of avoidable O(n) overhead. Scanning the slice on every query is natural to write but produces O(n × m) total work for n items and m queries. Converting the item collection into a map at the start of the function makes each subsequent lookup O(1) and reduces total work to O(n + m), which is a significant win when both n and m are large.

```go
// BAD: O(n) lookups in slice when O(1) is possible
func badFrequentLookup(items []string, queries []string) []bool {
    var results []bool
    for _, query := range queries {
        found := false
        for _, item := range items { // O(n) per query
            if item == query {
                found = true
                break
            }
        }
        results = append(results, found)
    }
    return results // Total: O(n * m) where n=items, m=queries
}

// GOOD: O(1) lookups with set
func goodFrequentLookup(items []string, queries []string) []bool {
    itemSet := make(map[string]bool)
    for _, item := range items { // O(n)
        itemSet[item] = true
    }

    results := make([]bool, len(queries))
    for i, query := range queries {
        results[i] = itemSet[query] // O(1) per query
    }
    return results // Total: O(n + m)
}
```

### Mistake 5: Unnecessary Sorting

Sorting a slice just to retrieve the k-th largest element pays an O(n log n) cost when the problem only requires O(n) average time. Full sorting establishes a complete ordering that is never used. Only the rank of one element matters. The quickselect algorithm achieves this by partitioning around a pivot and recursing only into the side that contains the target index, giving O(n) average time. The recursive form shown uses O(log n) average stack space, and an iterative rewrite brings that to O(1).

```go
// BAD: O(n log n) when O(n) is sufficient
func badFindKthLargest(nums []int, k int) int {
    slices.Sort(nums) // O(n log n)
    return nums[len(nums)-k]
}

// GOOD: O(n) average using quickselect
func goodFindKthLargest(nums []int, k int) int {
    return quickselect(nums, 0, len(nums)-1, len(nums)-k)
}

func quickselect(nums []int, left, right, k int) int {
    if left == right {
        return nums[left]
    }

    pivotIdx := partition(nums, left, right)

    if k == pivotIdx {
        return nums[k]
    } else if k < pivotIdx {
        return quickselect(nums, left, pivotIdx-1, k)
    } else {
        return quickselect(nums, pivotIdx+1, right, k)
    }
}

func partition(nums []int, left, right int) int {
    pivot := nums[right]
    i := left
    for j := left; j < right; j++ {
        if nums[j] <= pivot {
            nums[i], nums[j] = nums[j], nums[i]
            i++
        }
    }
    nums[i], nums[right] = nums[right], nums[i]
    return i
}
```

### Junior → FAANG: Making These Mistakes Visible Before They Ship

Each mistake in this section has a predictable trigger. String concatenation with `+=` in a loop appears whenever a developer treats Go strings like mutable byte buffers. Hidden O(n) inside loops appears whenever a developer calls a helper function without checking its complexity. Recursion without memoization appears whenever a developer writes a recursive solution for a problem with overlapping subproblems and does not notice the repeated work. Wrong data structure appears whenever a developer defaults to a slice for every collection without asking whether lookup is the dominant operation.

The corrective habit is simple: before you write the body of any loop, ask "does anything in this body have a cost that depends on n?" If yes, the loop is at least O(n squared). Write that estimate down. If it is worse than you want, restructure before writing the body.

For interviews, the interviewers are specifically watching for these mistakes because they are the most common source of "correct but too slow" solutions. Practice catching them in your own code during warm-up problems before the real interview.

### Senior @ FAANG: Making These Mistakes Detectable in CI

Individual vigilance does not scale. A team of 20 engineers cannot rely on every person remembering to check for string concatenation in loops. The senior engineer's job is to make these mistakes detectable automatically.

**Linting for string concatenation.** Static analysis tools can flag `+= ` on string variables inside loops. A custom `go vet` analyzer or a golangci-lint rule can block this pattern at the PR stage before a reviewer ever reads the code.

**Benchmark gates in CI.** For functions that are known to be on hot paths, add benchmark tests that measure execution time at fixed input sizes. If a refactor accidentally reintroduces an O(n squared) loop, the benchmark at n=10000 will show a 10,000x regression compared to the O(n) baseline, and the CI gate will fail the build.

**Memoization enforcement via interfaces.** For recursive algorithms used across a codebase, define an interface that requires a cache parameter. Any call site that passes `nil` will fail at compile time or panic immediately on the first cache miss, making the mistake loud rather than silent.

**Wrong data structure detection.** Profile production services periodically for functions that spend high proportions of their runtime in `slices.Index` or manual `for _, v := range` membership checks. These appear in flame graphs as wide flat bars. Any function that shows this pattern in profiling is a candidate for a data structure upgrade from slice to map.

The goal is to push complexity mistake detection as far left as possible in the development lifecycle: from production incidents to profiling, from profiling to CI, from CI to pre-commit hooks, and ideally into the editor via language server warnings.

---
