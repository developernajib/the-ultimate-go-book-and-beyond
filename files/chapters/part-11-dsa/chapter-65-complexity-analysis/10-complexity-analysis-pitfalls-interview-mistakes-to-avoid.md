## Complexity Analysis Pitfalls: Interview Mistakes to Avoid

### Pitfall 1: Confusing Average Case with Worst Case

**Interview Mistake**: "QuickSort is O(n log n)" - without clarifying that this is average case, not worst case. Interviewers often ask about worst case, and QuickSort's worst case is O(n²).

```go
// WRONG: Assuming average case is always relevant
func quickSort(arr []int) {
    // "This is O(n log n)"
    // Reality: O(n²) worst case for sorted/nearly-sorted input
}

// CORRECT: Know both cases and when they occur
/*
Algorithm Comparison:
                    Average     Worst       When Worst Occurs
QuickSort           O(n log n)  O(n²)       Already sorted, bad pivot
MergeSort           O(n log n)  O(n log n)  Never (always consistent)
HashMap Get         O(1)        O(n)        All keys hash to same bucket
Binary Search Tree  O(log n)    O(n)        Unbalanced (linked list shape)

Interview Answer Format:
"QuickSort has O(n log n) average-case time complexity,
but O(n²) worst-case when the pivot choices are poor,
like when the array is already sorted and we pick first element as pivot.
That's why production implementations use randomized pivots or introsort."
*/

// Demonstrating worst case
func quickSortWorstCase() {
    // This will be O(n²) with naive first-element pivot
    sorted := []int{1, 2, 3, 4, 5, 6, 7, 8, 9, 10}
    // Each partition only removes 1 element
    // Partition 1: pivot=1, right side has 9 elements
    // Partition 2: pivot=2, right side has 8 elements
    // ... n partitions, each O(n) work = O(n²)
}
```

### Pitfall 2: Missing Hidden Complexity in Standard Library Operations

**Interview Mistake**: "My solution is O(n) because I just iterate once" - while using operations inside the loop that are themselves O(n).

```go
// WRONG: Thinking this is O(n)
func containsDuplicate(nums []int) bool {
    for i := 0; i < len(nums); i++ {
        // Problem: slices.Contains is O(n), making total O(n²)
        if slices.Contains(nums[i+1:], nums[i]) {
            return true
        }
    }
    return false
}

// WRONG: String concatenation in loop
func buildString(n int) string {
    result := ""
    for i := 0; i < n; i++ {
        result += "x"  // O(n) per concatenation = O(n²) total
    }
    return result
}

// CORRECT: Use appropriate data structures
func containsDuplicateCorrect(nums []int) bool {
    seen := make(map[int]struct{})  // O(1) lookup
    for _, num := range nums {
        if _, exists := seen[num]; exists {
            return true
        }
        seen[num] = struct{}{}
    }
    return false  // O(n) total
}

// CORRECT: Use strings.Builder
func buildStringCorrect(n int) string {
    var builder strings.Builder
    builder.Grow(n)  // Pre-allocate
    for i := 0; i < n; i++ {
        builder.WriteByte('x')  // O(1) amortized
    }
    return builder.String()  // O(n) total
}

// Common hidden non-constant operations in Go:
// - append() when capacity exceeded (amortized O(1), but O(n) per resize)
// - string concatenation (creates new string each time)
// - slice copying via [:]
// - map iteration (O(n) to iterate all keys)
// - slices.SortFunc (O(n log n))
```

### Pitfall 3: Forgetting Space Complexity from Recursion Stack

**Interview Mistake**: "Space is O(1), I'm not using any extra arrays" - while ignoring that recursion uses O(depth) stack space.

```go
// WRONG: Claiming O(1) space
func fibonacci(n int) int {
    // "O(1) space - no arrays!"
    if n <= 1 {
        return n
    }
    return fibonacci(n-1) + fibonacci(n-2)
    // Reality: O(n) space from call stack
    // Each recursive call adds a stack frame
}

// Correct analysis:
// Time: O(2^n) - branching factor of 2, depth of n
// Space: O(n) - max depth of recursion tree

// Even worse - this looks like O(n) but is O(n) space too
func factorial(n int) int {
    if n <= 1 {
        return 1
    }
    return n * factorial(n-1)
    // O(n) stack frames
}

// CORRECT: Tail recursion optimization (Go doesn't optimize, but shows understanding)
func factorialTailRecursive(n, acc int) int {
    if n <= 1 {
        return acc
    }
    return factorialTailRecursive(n-1, n*acc)
    // Still O(n) stack in Go (no TCO), but shows awareness
}

// BEST: Iterative for O(1) space
func factorialIterative(n int) int {
    result := 1
    for i := 2; i <= n; i++ {
        result *= i
    }
    return result  // O(1) space
}

// Space complexity cheat sheet:
// Recursive DFS on tree: O(height) = O(log n) balanced, O(n) worst
// Recursive DFS on graph: O(V) - could visit all vertices
// Iterative with stack: Same as recursive, but explicit
// BFS with queue: O(width) = O(n) for trees
// Dynamic programming: Usually O(n) or O(n*m) for memoization
```

### Pitfall 4: Incorrect Complexity for Nested Loops

**Interview Mistake**: "Nested loops so it must be O(n²)" - but the inner loop's iterations depend on outer loop variables.

```go
// WRONG: Thinking this is O(n²)
func twoPointers(nums []int) {
    left, right := 0, len(nums)-1
    for left < right {
        // "Two pointers moving, nested behavior"
        // ...
        left++
        // or
        right--
    }
    // Reality: O(n) - each element visited at most twice
}

// Example: This LOOKS like O(n²) but is O(n)
func removeDuplicates(nums []int) int {
    if len(nums) == 0 {
        return 0
    }
    slow := 0
    for fast := 1; fast < len(nums); fast++ {
        if nums[fast] != nums[slow] {
            slow++
            nums[slow] = nums[fast]
        }
    }
    // Both pointers traverse array once = O(n)
    return slow + 1
}

// This IS O(n²)
func findPairs(nums []int) {
    for i := 0; i < len(nums); i++ {
        for j := i + 1; j < len(nums); j++ {
            // Inner loop runs n-1, n-2, ..., 1 times
            // Sum = n(n-1)/2 = O(n²)
            process(nums[i], nums[j])
        }
    }
}

// Tricky: This is O(n log n), not O(n²)
func algorithm(n int) {
    for i := 1; i < n; i *= 2 {  // O(log n) outer iterations
        for j := 0; j < n; j++ {  // O(n) inner iterations
            // ...
        }
    }
    // Total: O(n log n)
}

// Also tricky: This is O(sqrt(n)), not O(n²)
func primeFactors(n int) []int {
    var factors []int
    d := 2
    for d*d <= n {        // Outer: O(sqrt(n)) at most
        for n%d == 0 {    // Inner: limited by how many times d divides n
            factors = append(factors, d)
            n /= d
        }
        d++
    }
    if n > 1 {
        factors = append(factors, n)
    }
    // Outer loop bounded by O(sqrt(n)), inner loop total iterations bounded by O(log n)
    // Overall: O(sqrt(n))
    return factors
}
```

### Quick Reference: Complexity Analysis Pitfalls

| Mistake | What You Said | Reality | Interview Impact |
|---------|--------------|---------|------------------|
| Average vs worst | "QuickSort is O(n log n)" | Worst case O(n²) | Shows incomplete understanding |
| Hidden operations | "O(n) with single loop" | O(n²) with Contains() inside | Algorithm is too slow |
| Recursion space | "O(1) space" | O(n) stack frames | Memory issues overlooked |
| Nested loop assumption | "Nested = O(n²)" | Depends on iteration counts | Overestimating complexity |

### Junior → FAANG: Inoculating Against These Pitfalls Before the Interview

Each pitfall in this section has a simple mental check that prevents it. For average-versus-worst: whenever you state a complexity, ask yourself "is this always true, or only usually true?" If only usually, state the worst case explicitly. For hidden operations: before finishing your analysis, scan every function call inside your loops and verify you know its complexity. For recursion space: whenever you write a recursive function, immediately count the maximum stack depth and state it as the space complexity. For nested loops: whenever you see two loops, verify that the inner loop count is not bounded by the outer variable before assuming O(n squared).

Drilling these checks during practice problems is the fastest way to make them automatic. Time yourself: after writing a solution, can you state the correct complexity with all four checks applied in under 30 seconds? That speed is what the interview requires.

### Senior @ FAANG: Pitfall Prevention at the Team Level

These pitfalls are not just interview mistakes: they are production bugs waiting to happen. The average-versus-worst distinction matters when a production system experiences tail latency spikes that are invisible in average latency metrics. If QuickSort is used on a code path that sometimes receives nearly-sorted input, the O(n squared) worst case is not a theoretical concern: it is an incident waiting to happen. Production sort implementations use introsort (hybrid of quicksort and heapsort) precisely to bound the worst case.

Hidden operation complexity is a structural code organization problem. When a function call's complexity is not visible at the call site, reviewers cannot reason about the caller's complexity without reading the callee's implementation. The senior engineering solution is to make complexity part of the function contract, either via documentation comments or via the naming convention ("LinearScan" versus "HashLookup" as function name prefixes for internal utilities).

Recursion space pitfalls manifest in production as stack overflow errors under heavy load, typically on paths that are only exercised at scale. Go goroutines start with a small stack (2 KB minimum) and grow dynamically, but deeply recursive functions on millions of concurrent goroutines create enormous aggregate memory pressure. Identifying recursion depth as a concern and converting to iterative implementations on critical paths is a standard senior engineering practice.

---
