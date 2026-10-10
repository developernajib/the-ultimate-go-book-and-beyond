## 65.3 Analyzing Go Code

### Loop Analysis

The structure of a loop's iteration variable directly reveals its time complexity: an index that increments by one on each step produces O(n) iterations, two nested such loops produce O(n²), and an index that doubles on each step produces O(log n) because the number of iterations is the number of times n can be halved. When the inner loop's bound depends on the outer index (as in the triangular loop where `j` starts at `i`), the total iteration count is the sum of an arithmetic series, which simplifies to O(n²) after dropping the constant factor. Recognizing these patterns by inspecting only the loop header, without tracing the body, is a practical skill for rapid complexity estimation during code review.

```go
// Single loop: O(n)
func singleLoop(n int) int {
    sum := 0
    for i := 0; i < n; i++ {
        sum += i
    }
    return sum
}

// Nested loops: O(n²)
func nestedLoops(n int) int {
    count := 0
    for i := 0; i < n; i++ {
        for j := 0; j < n; j++ {
            count++
        }
    }
    return count
}

// Nested with different bounds: O(n*m)
func differentBounds(n, m int) int {
    count := 0
    for i := 0; i < n; i++ {
        for j := 0; j < m; j++ {
            count++
        }
    }
    return count
}

// Triangular loop: O(n²/2) = O(n²)
func triangularLoop(n int) int {
    count := 0
    for i := 0; i < n; i++ {
        for j := i; j < n; j++ {
            count++
        }
    }
    return count
    // Iterations: n + (n-1) + (n-2) + ... + 1 = n(n+1)/2 = O(n²)
}

// Logarithmic loop: O(log n)
func logLoop(n int) int {
    count := 0
    for i := 1; i < n; i *= 2 {
        count++
    }
    return count
}

// Nested with log inner: O(n log n)
func nLogN(n int) int {
    count := 0
    for i := 0; i < n; i++ {
        for j := 1; j < n; j *= 2 {
            count++
        }
    }
    return count
}
```

### Recursion Analysis

Recursive time complexity is determined by counting how many times the function is called and how much work each call does: linear recursion that shrinks the problem by one unit per call gives O(n), while binary recursion that makes two calls without memoization gives O(2^n) because the call tree doubles at every level. The Master Theorem provides a systematic formula for divide-and-conquer recurrences of the form T(n) = aT(n/b) + O(n^d), resolving the three cases by comparing d to log_b(a). Note that Go does not perform tail-call optimization, so even a structurally tail-recursive function consumes O(n) stack space at runtime and an iterative rewrite is needed when stack depth is a concern.

```go
// Linear recursion: O(n) time, O(n) space
func linearRecursion(n int) int {
    if n <= 0 {
        return 0
    }
    return 1 + linearRecursion(n-1)
}

// Binary recursion: O(2^n) time, O(n) space
func binaryRecursion(n int) int {
    if n <= 1 {
        return n
    }
    return binaryRecursion(n-1) + binaryRecursion(n-2)
}

// Divide and conquer: O(n log n) time
// Example: Merge sort
// T(n) = 2T(n/2) + O(n)
// Using Master Theorem: O(n log n)

// Tail recursion (can be optimized to O(1) space)
func tailFactorial(n, acc int) int {
    if n <= 1 {
        return acc
    }
    return tailFactorial(n-1, n*acc) // Go doesn't optimize this, but concept remains
}

// Master Theorem Summary:
// T(n) = aT(n/b) + O(n^d)
// - If d < log_b(a): O(n^(log_b(a)))
// - If d = log_b(a): O(n^d * log n)
// - If d > log_b(a): O(n^d)
```

### Go Built-in Operations Complexity

Go's runtime provides O(1) guarantees for the most common collection operations (index access, map lookup, channel send/receive, and `len`/`cap`), but several operations that look cheap are actually O(n), and confusing the two is a common source of unexpected performance regressions. Slice append is amortized O(1) but triggers an O(n) copy when the backing array must grow, `strings.Contains` can be O(n*m) in the worst case, and converting a string to `[]rune` is O(n) because it must decode every UTF-8 code point. The annotated examples below serve as a quick reference for the complexity of each built-in operation across slices, maps, strings, and channels, making it straightforward to reason about the overall complexity of any function that combines them.

```go
// ===== Slice Operations =====

func sliceComplexity() {
    s := make([]int, 100)

    // Access by index: O(1)
    _ = s[50]

    // Append (amortized): O(1)
    s = append(s, 1)

    // Append with reallocation: O(n)
    // Happens when capacity is exceeded

    // Copy: O(n) where n = min(len(dst), len(src))
    dst := make([]int, 50)
    copy(dst, s)

    // Slicing: O(1) - just creates new header
    _ = s[10:20]

    // len(), cap(): O(1)
    _ = len(s)
    _ = cap(s)
}

// ===== Map Operations =====

func mapComplexity() {
    m := make(map[string]int)

    // Insert: O(1) average, O(n) worst case
    m["key"] = 1

    // Lookup: O(1) average, O(n) worst case
    _ = m["key"]

    // Delete: O(1) average
    delete(m, "key")

    // len(): O(1)
    _ = len(m)

    // Iteration: O(n)
    for k, v := range m {
        _, _ = k, v
    }
}

// ===== String Operations =====

func stringComplexity() {
    s := "hello world"

    // Length: O(1) - stored in string header
    _ = len(s)

    // Index access (byte): O(1)
    _ = s[0]

    // Concatenation: O(n+m)
    s2 := s + " more"

    // Substring: O(1) - shares backing array
    _ = s[0:5]

    // Conversion to []rune: O(n)
    _ = []rune(s)

    // strings.Contains: O(n*m) worst case
    _ = strings.Contains(s, "world")

    // strings.Builder - efficient concatenation
    var builder strings.Builder
    for i := 0; i < 1000; i++ {
        builder.WriteString(s2) // Amortized O(1)
    }
    _ = builder.String() // O(n)
}

// ===== Channel Operations =====

func channelComplexity() {
    // Unbuffered channel
    ch := make(chan int)

    // Send/Receive: O(1) but may block
    go func() { ch <- 1 }()
    _ = <-ch

    // Buffered channel
    bufCh := make(chan int, 100)

    // Send to buffered (not full): O(1)
    bufCh <- 1

    // Receive from buffered: O(1)
    _ = <-bufCh

    // len() on channel: O(1)
    _ = len(bufCh)

    // close(): O(1)
    close(bufCh)
}
```

### Analyzing Real Code

Finding a duplicate number in an array is a concrete example that illustrates how the choice of data structure can trade space for time: the brute-force O(n²) nested scan needs no extra memory, sorting reduces comparisons to O(n log n) at the cost of an O(n) copy, and a hash set achieves O(n) time by accepting O(n) auxiliary space. Floyd's cycle-detection algorithm achieves O(n) time and O(1) space by exploiting the mathematical property that treating array values as next-pointer links creates a cycle whenever a duplicate exists, but this approach only works when all values lie in the range [1, n]. The summary table at the end of the snippet is a useful habit when presenting multiple solutions: it makes the trade-offs explicit and helps an interviewer or reviewer quickly select the appropriate approach given the constraints.

```go
// Example: Finding duplicate in array

// Approach 1: Brute force - O(n²) time, O(1) space
func findDuplicateBrute(nums []int) int {
    for i := 0; i < len(nums); i++ {
        for j := i + 1; j < len(nums); j++ {
            if nums[i] == nums[j] {
                return nums[i]
            }
        }
    }
    return -1
}

// Approach 2: Sorting - O(n log n) time, O(1) or O(n) space
func findDuplicateSort(nums []int) int {
    sorted := make([]int, len(nums))
    copy(sorted, nums)
    slices.Sort(sorted) // O(n log n)

    for i := 1; i < len(sorted); i++ {
        if sorted[i] == sorted[i-1] {
            return sorted[i]
        }
    }
    return -1
}

// Approach 3: Hash set - O(n) time, O(n) space
func findDuplicateHash(nums []int) int {
    seen := make(map[int]bool)
    for _, num := range nums {
        if seen[num] {
            return num
        }
        seen[num] = true
    }
    return -1
}

// Approach 4: Floyd's cycle detection - O(n) time, O(1) space
// (Only works when nums[i] are in range [1, n])
func findDuplicateFloyd(nums []int) int {
    slow, fast := nums[0], nums[nums[0]]

    // Find intersection point
    for slow != fast {
        slow = nums[slow]
        fast = nums[nums[fast]]
    }

    // Find cycle entrance
    slow = 0
    for slow != fast {
        slow = nums[slow]
        fast = nums[fast]
    }

    return slow
}

// Analysis Summary:
// | Approach     | Time       | Space  |
// |--------------|------------|--------|
// | Brute Force  | O(n²)      | O(1)   |
// | Sorting      | O(n log n) | O(n)   |
// | Hash Set     | O(n)       | O(n)   |
// | Floyd's      | O(n)       | O(1)   |
```

### Junior → FAANG: Reading Go Code for Hidden Complexity

The analysis summary table above is the format interviewers expect. When you present multiple approaches, always conclude with a table that makes trade-offs explicit. This communicates that you are aware of the design space, not just the first solution you found.

For Go specifically, these are the built-in operations that most frequently surprise junior developers. `strings.Contains` is O(n times m) in the worst case, not O(1). Converting a string to `[]rune` is O(n) because it must decode every UTF-8 code point. Ranging over a string with `for _, r := range s` is also O(n) for the same reason. Slicing a string with `s[i:j]` is O(1) because it creates a new header pointing into the same backing memory, but any subsequent modification requires a copy.

When analyzing a function for an interviewer, talk through the loop structure layer by layer. "The outer loop runs n times. Inside, we call `strings.Contains`, which is O(n) in the worst case. So the total is O(n squared)." Identifying the hidden O(n) inside the loop is the insight that distinguishes a careful analyst from a careless one.

### Senior @ FAANG: Code Review as Complexity Enforcement

Senior engineers use code review as the primary gate for complexity regressions. The patterns in this section are exactly what to look for: loops that call functions whose complexity is not immediately obvious, recursive functions that lack memoization, and data structure choices that create O(n) lookup paths on hot call sites.

An effective code review comment for a complexity issue includes three elements: the current complexity, why it matters at expected scale, and a concrete alternative. "This function calls `slices.Contains` inside a loop, making it O(n squared). At our current data size of 50k records that is 2.5 billion operations per request, which will miss our 100ms SLA. Replace the slice with a map for O(n) total." That comment is actionable and provides the reviewer with everything needed to fix the issue without a follow-up conversation.

For Floyd's cycle detection specifically: this algorithm is a bar-raiser signal because it requires understanding a non-obvious mathematical invariant, not just applying a standard pattern. If a candidate reaches for Floyd's unprompted and can explain why the slow and fast pointers must meet at a cycle and why resetting one pointer to the start finds the cycle entrance, that is an L5-equivalent signal on algorithm knowledge. At senior levels, you should be able to explain the proof sketch, not just the code.

---
