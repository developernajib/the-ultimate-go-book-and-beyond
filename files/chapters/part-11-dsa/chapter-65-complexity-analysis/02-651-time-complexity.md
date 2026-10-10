## 65.1 Time Complexity

### Big O Notation

Big O describes the upper bound of an algorithm's growth rate - the worst-case scenario.

```go
// O(1) - Constant Time
func getFirst(arr []int) int {
    if len(arr) == 0 {
        return 0
    }
    return arr[0] // Always one operation
}

// O(log n) - Logarithmic Time
func binarySearch(arr []int, target int) int {
    left, right := 0, len(arr)-1

    for left <= right {
        mid := left + (right-left)/2
        if arr[mid] == target {
            return mid
        }
        if arr[mid] < target {
            left = mid + 1
        } else {
            right = mid - 1
        }
    }
    return -1 // Each iteration halves the search space
}

// O(n) - Linear Time
func sum(arr []int) int {
    total := 0
    for _, v := range arr {
        total += v // Visit each element once
    }
    return total
}

// O(n log n) - Linearithmic Time
func mergeSort(arr []int) []int {
    if len(arr) <= 1 {
        return arr
    }

    mid := len(arr) / 2
    left := mergeSort(arr[:mid])   // T(n/2)
    right := mergeSort(arr[mid:])  // T(n/2)

    return merge(left, right)       // O(n)
    // Total: O(n log n)
}

func merge(left, right []int) []int {
    result := make([]int, 0, len(left)+len(right))
    i, j := 0, 0

    for i < len(left) && j < len(right) {
        if left[i] < right[j] {
            result = append(result, left[i])
            i++
        } else {
            result = append(result, right[j])
            j++
        }
    }

    result = append(result, left[i:]...)
    result = append(result, right[j:]...)
    return result
}

// O(n²) - Quadratic Time
func bubbleSort(arr []int) {
    n := len(arr)
    for i := 0; i < n; i++ {
        for j := 0; j < n-i-1; j++ {
            if arr[j] > arr[j+1] {
                arr[j], arr[j+1] = arr[j+1], arr[j]
            }
        }
    }
    // Nested loops: n * n = n²
}

// O(2^n) - Exponential Time
func fibonacci(n int) int {
    if n <= 1 {
        return n
    }
    return fibonacci(n-1) + fibonacci(n-2)
    // Two recursive calls for each n
}

// O(n!) - Factorial Time
func permutations(arr []int) [][]int {
    result := [][]int{}
    if len(arr) == 1 {
        return [][]int{{arr[0]}}
    }

    for i, v := range arr {
        rest := make([]int, 0, len(arr)-1)
        rest = append(rest, arr[:i]...)
        rest = append(rest, arr[i+1:]...)

        for _, perm := range permutations(rest) {
            result = append(result, append([]int{v}, perm...))
        }
    }
    return result
}
```

### Complexity Comparison Chart

```
| Complexity | Name          | n=10    | n=100      | n=1000        |
|------------|---------------|---------|------------|---------------|
| O(1)       | Constant      | 1       | 1          | 1             |
| O(log n)   | Logarithmic   | 3       | 7          | 10            |
| O(n)       | Linear        | 10      | 100        | 1000          |
| O(n log n) | Linearithmic  | 33      | 664        | 9966          |
| O(n²)      | Quadratic     | 100     | 10000      | 1000000       |
| O(2^n)     | Exponential   | 1024    | 1.27e30    | Infeasible    |
| O(n!)      | Factorial     | 3628800 | Infeasible | Infeasible    |
```

### Big Omega (Ω) - Lower Bound

Big Omega describes the asymptotic lower bound of an algorithm's growth rate - the minimum rate at which the runtime grows.

```go
// Best case O(1) - element at first position
// Worst case O(n) - element not found
func linearSearch(arr []int, target int) int {
    for i, v := range arr {
        if v == target {
            return i // Could return immediately
        }
    }
    return -1
}

// Even in best case, we need to touch all elements
// Ω(n) for summing an array
func mustSumAll(arr []int) int {
    total := 0
    for _, v := range arr {
        total += v
    }
    return total
}
```

### Big Theta (Θ) - Tight Bound

Big Theta describes when best and worst cases have the same complexity.

```go
// Θ(n) - Always visits every element exactly once
func countElements(arr []int) int {
    count := 0
    for range arr {
        count++
    }
    return count
}

// Θ(n²) - Always n² iterations regardless of input
func matrixTraversal(matrix [][]int) int {
    n := len(matrix)
    sum := 0
    for i := 0; i < n; i++ {
        for j := 0; j < n; j++ {
            sum += matrix[i][j]
        }
    }
    return sum
}
```

### Amortized Analysis

Amortized analysis considers the average performance over a sequence of operations.

```go
// Dynamic Array (slice) append operation
// Individual operation: O(1) amortized, O(n) worst case
// Sequence of n appends: O(n) total

func demonstrateAmortized() {
    arr := make([]int, 0)

    // Append 1000 elements
    // Most appends are O(1)
    // Occasional resizing is O(n)
    // Total: O(n) for n appends = O(1) amortized per append
    for i := 0; i < 1000; i++ {
        arr = append(arr, i)
    }
}

// Stack with multiPop
type AmortizedStack struct {
    items []int
}

func (s *AmortizedStack) Push(item int) {
    s.items = append(s.items, item)
}

// O(min(k, len(items))) per call
func (s *AmortizedStack) MultiPop(k int) []int {
    if k > len(s.items) {
        k = len(s.items)
    }
    popped := s.items[len(s.items)-k:]
    s.items = s.items[:len(s.items)-k]
    return popped
}

// Analysis:
// - Each element can only be popped once per push
// - n pushes + n pops = O(n) total
// - Amortized: O(1) per operation
```

### Junior → FAANG: Reading the Complexity of Unfamiliar Code

The practical skill tested in interviews is not deriving Big-O for textbook examples. It is reading a function you have never seen and stating its complexity within 30 seconds. The technique is to look at the loop structure first, ignore the loop body unless it contains a function call, and then check every function call inside the body for hidden cost.

For amortized analysis, the key analogy is the bank account model: each cheap operation deposits a "credit" that pays for the occasional expensive operation. For Go slices, every O(1) append deposits a credit that covers the eventual O(n) copy when the backing array grows. The total debt never exceeds 2n, so the average cost per operation is constant. Being able to explain this clearly, with a concrete example, is what separates a candidate who "knows Big-O" from one who "understands complexity."

In interviews, always state both time and space complexity. "O(n log n) time and O(1) extra space using in-place sort" is a complete answer. "O(n log n)" alone is not.

### Senior @ FAANG: Complexity in System Design and Capacity Planning

Senior engineers use time complexity as an input to capacity planning models. If a ranking function is O(n log n) in the number of candidate documents and the corpus grows 40% per year, you can project when the current fleet becomes insufficient and plan hardware procurement or algorithmic improvement accordingly.

Amortized complexity appears in system design when discussing write-ahead logs, compaction in LSM-tree databases, and garbage collection pauses. In each case, the system performs occasional expensive batch operations so that the common-case operation remains cheap. The design question is not just "what is the amortized cost?" but "what is the tail latency of the expensive operation, and does it violate any SLA?" A compaction that takes 200ms on average is fine for a background job but unacceptable on a request path with a 50ms p99 target. Senior engineers model both the amortized average and the worst-case spike.

For Go-specific production concerns: the garbage collector interacts with allocation rate, which is a function of how many O(n) copies your hot paths trigger. A codebase that creates large intermediate slices in every request pays a hidden tax in GC pressure. Reducing allocations on hot paths, by reusing buffers or pre-allocating with known capacity, is an O(1) space improvement that also reduces GC pauses, improving p99 latency without changing algorithmic complexity class.

---
