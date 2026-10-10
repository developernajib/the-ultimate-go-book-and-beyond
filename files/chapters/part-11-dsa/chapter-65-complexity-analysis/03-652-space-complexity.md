## 65.2 Space Complexity

### Memory Usage

Space complexity measures how much additional memory an algorithm requires relative to the size of its input. The examples below contrast O(1) constant-space solutions (which reuse a fixed number of variables) against O(n) solutions that allocate new data structures proportional to the input, as well as O(n) recursive call stacks that grow with each nested call and O(n²) two-dimensional matrices.

```go
// O(1) space - only uses fixed variables
func findMax(arr []int) int {
    if len(arr) == 0 {
        return 0
    }
    max := arr[0]
    for _, v := range arr {
        if v > max {
            max = v
        }
    }
    return max
}

// O(n) space - creates new array of same size
func reverse(arr []int) []int {
    n := len(arr)
    result := make([]int, n)
    for i := 0; i < n; i++ {
        result[n-1-i] = arr[i]
    }
    return result
}

// O(n) space - recursive call stack
func factorialRecursive(n int) int {
    if n <= 1 {
        return 1
    }
    return n * factorialRecursive(n-1)
    // Call stack: n frames
}

// O(1) space - iterative version
func factorialIterative(n int) int {
    result := 1
    for i := 2; i <= n; i++ {
        result *= i
    }
    return result
}

// O(n²) space - 2D matrix
func createMatrix(n int) [][]int {
    matrix := make([][]int, n)
    for i := range matrix {
        matrix[i] = make([]int, n)
    }
    return matrix
}
```

### In-Place Algorithms

In-place algorithms mutate the input array directly instead of allocating a new one, keeping extra space usage at O(1). The three examples below demonstrate this principle through array reversal using two-pointer swapping, rotation via the triple-reverse trick, and duplicate removal with a write-index cursor on a sorted array.

```go
// In-place reversal - O(1) extra space
func reverseInPlace(arr []int) {
    left, right := 0, len(arr)-1
    for left < right {
        arr[left], arr[right] = arr[right], arr[left]
        left++
        right--
    }
}

// In-place rotation by k positions
func rotate(arr []int, k int) {
    n := len(arr)
    if n == 0 {
        return
    }
    k = k % n

    // Reverse all
    reverse := func(start, end int) {
        for start < end {
            arr[start], arr[end] = arr[end], arr[start]
            start++
            end--
        }
    }

    reverse(0, n-1)
    reverse(0, k-1)
    reverse(k, n-1)
}

// In-place deduplication (sorted array)
func removeDuplicates(arr []int) int {
    if len(arr) == 0 {
        return 0
    }

    writeIdx := 1
    for i := 1; i < len(arr); i++ {
        if arr[i] != arr[i-1] {
            arr[writeIdx] = arr[i]
            writeIdx++
        }
    }
    return writeIdx
}
```

### Space-Time Trade-offs

Many algorithms can be tuned to spend more memory in exchange for faster execution, or vice versa. The anagram examples below show a sorting approach that trades O(n log n) time for minimal extra allocation versus a hash-map approach that runs in O(n) time by spending O(k) space on a character-count table. The memoized Fibonacci and precomputed squares table further illustrate how caching intermediate results can slash time complexity from exponential to linear at the cost of additional memory.

```go
// Problem: Find if two strings are anagrams

// Time O(n log n), Space O(n) - sorting approach
func isAnagramSort(s1, s2 string) bool {
    if len(s1) != len(s2) {
        return false
    }

    r1 := []rune(s1)
    r2 := []rune(s2)

    slices.Sort(r1)
    slices.Sort(r2)

    return string(r1) == string(r2)
}

// Time O(n), Space O(k) where k = alphabet size - hash map approach
func isAnagramHash(s1, s2 string) bool {
    if len(s1) != len(s2) {
        return false
    }

    count := make(map[rune]int)

    for _, c := range s1 {
        count[c]++
    }

    for _, c := range s2 {
        count[c]--
        if count[c] < 0 {
            return false
        }
    }

    return true
}

// Trading space for time: Memoization
// Without memo: O(2^n) time, O(n) space (call stack)
// With memo: O(n) time, O(n) space (cache + call stack)

func fibMemo(n int, memo map[int]int) int {
    if n <= 1 {
        return n
    }
    if val, ok := memo[n]; ok {
        return val
    }
    memo[n] = fibMemo(n-1, memo) + fibMemo(n-2, memo)
    return memo[n]
}

// Trading time for space: Computing vs Storing
// Precompute all squares up to n: O(n) space
var squares = func() []int {
    s := make([]int, 1000)
    for i := range s {
        s[i] = i * i
    }
    return s
}()

// Compute on demand: O(1) space
func square(n int) int {
    return n * n
}
```

### Junior → FAANG: Distinguishing Auxiliary Space from Total Space

A common interview mistake is conflating input space with auxiliary space. When an interviewer asks for space complexity, they almost always mean auxiliary space: the extra memory your algorithm allocates beyond the input itself. In-place algorithms are O(1) auxiliary space even though the input occupies O(n) bytes.

The recursion stack is the most frequently missed source of space consumption. A recursive depth-first search on a tree of height h uses O(h) stack frames, each holding the local variables of one call. For a balanced tree that is O(log n). For a degenerate linked-list-shaped tree it is O(n). Go does not perform tail-call optimization, so even a structurally tail-recursive function uses O(depth) stack space at runtime.

For interviews, practice verifying space claims by tracing the maximum amount of live memory at any single point during execution, not just the final state.

### Senior @ FAANG: Memory Models, Heap Fragmentation, and Production Space Budgets

At production scale, space complexity is a multi-layered concern. The theoretical O(n) bound tells you the asymptotic growth rate, but the constant factor and allocation pattern determine whether the service fits within its memory limit and whether the garbage collector can keep up.

**Heap fragmentation.** An algorithm that makes many small allocations can use more resident memory than one that makes a single large allocation, even if both are theoretically O(n), because the allocator cannot reclaim fragmented pages. In Go, using `sync.Pool` for frequently allocated objects of known size can dramatically reduce fragmentation on hot paths.

**Memory pressure and GC interaction.** The Go garbage collector is triggered by heap size growth relative to the previous GC cycle target. A function that allocates O(n) objects per request, even if each is small, drives up allocation rate, increases GC frequency, and raises p99 latency. Profiling with `go tool pprof -alloc_space` reveals which call sites are responsible for the majority of allocation volume.

**Space budgets in architecture decisions.** A senior engineer designing a new cache tier must bound its memory usage explicitly: "This in-process cache holds at most K items, each of bounded size S, so total memory is O(K times S), which at K=1M and S=256 bytes is 256 MB per instance." That calculation drives instance sizing in the capacity plan. If the math shows the cache exceeds the per-host memory budget, the design must change before code is written, not after the first load test.

**Space-time trade-offs in ADRs.** When proposing to add a precomputed index, the ADR should state both the space cost and the query-time benefit, along with the break-even point. "This index costs 4 GB of RAM but reduces p99 query latency from 80ms to 4ms. At our current query volume the CPU savings alone pay back the memory cost within two weeks, and the latency improvement directly reduces user abandonment rate." This kind of quantified argument is what staff-level engineers are expected to produce.

---
