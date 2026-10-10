## 66.8 Common Mistakes

### Mistake 1: Off-by-One Errors in Two Pointers

Sliding-window loops are one of the most common sites for off-by-one bugs because the boundary condition shifts between `<` and `<=` depending on whether the index accesses an element directly or acts as a size. Using `i <= len(nums)` instead of `i < len(nums)` is silent at compile time but causes a panic at runtime when the index equals the slice length. Always derive the loop bound from the last valid index, not the length, to prevent this class of error.

```go
// ❌ BAD: Off-by-one in window bounds
func maxSumBad(nums []int, k int) int {
    if len(nums) < k {
        return 0
    }

    sum := 0
    for i := 0; i < k; i++ {
        sum += nums[i]
    }

    maxSum := sum
    // Bug: should be i < len(nums), not i <= len(nums)
    for i := k; i <= len(nums); i++ {  // PANIC: index out of range
        sum += nums[i] - nums[i-k]
        maxSum = max(maxSum, sum)
    }
    return maxSum
}

// ✅ GOOD: Correct bounds checking
func maxSumGood(nums []int, k int) int {
    if len(nums) < k {
        return 0
    }

    sum := 0
    for i := 0; i < k; i++ {
        sum += nums[i]
    }

    maxSum := sum
    for i := k; i < len(nums); i++ {  // Correct: i < len(nums)
        sum += nums[i] - nums[i-k]
        maxSum = max(maxSum, sum)
    }
    return maxSum
}
```

### Mistake 2: Not Handling Empty or Single-Element Arrays

Two-pointer techniques initialize `right` to `len(nums) - 1`, which evaluates to `-1` for an empty slice. Attempting to dereference an index derived from that value causes a panic, but the bug is invisible during development if tests never exercise the empty input. Adding an explicit length guard as the first statement makes the edge case deliberate and keeps the main loop logic free of defensive conditionals.

```go
// ❌ BAD: Crashes on empty array
func findPairsBad(nums []int) [][]int {
    left, right := 0, len(nums)-1  // right = -1 for empty array!

    var result [][]int
    for left < right {
        // ... logic
    }
    return result
}

// ✅ GOOD: Handle edge cases first
func findPairsGood(nums []int) [][]int {
    if len(nums) < 2 {
        return nil
    }

    left, right := 0, len(nums)-1
    var result [][]int

    for left < right {
        // ... logic
    }
    return result
}
```

### Mistake 3: Modifying Slice While Iterating

Splicing elements out of a slice with `append(nums[:i], nums[i+1:]...)` while a `range` loop is still advancing `i` corrupts the iteration: after the splice, every subsequent index is off by one, causing elements to be skipped or visited twice. The safe pattern is to decouple reading from writing by maintaining separate read and write indices so the original positions are never shifted under the iteration cursor.

```go
// ❌ BAD: Modifying slice during iteration
func removeDuplicatesBad(nums []int) []int {
    seen := make(map[int]bool)

    for i, num := range nums {
        if seen[num] {
            // Modifying slice while iterating - unpredictable behavior
            nums = append(nums[:i], nums[i+1:]...)
        }
        seen[num] = true
    }
    return nums
}

// ✅ GOOD: Use two-pointer approach for in-place removal
func removeDuplicatesGood(nums []int) []int {
    if len(nums) == 0 {
        return nums
    }

    seen := make(map[int]bool)
    writeIdx := 0

    for readIdx := 0; readIdx < len(nums); readIdx++ {
        if !seen[nums[readIdx]] {
            seen[nums[readIdx]] = true
            nums[writeIdx] = nums[readIdx]
            writeIdx++
        }
    }

    return nums[:writeIdx]
}
```

### Mistake 4: Incorrect Sliding Window State Updates

When a map is used to track character counts in a sliding window, decrementing a count to zero leaves a zero-valued key in the map. A subsequent equality check between that map and a reference map will fail because one has a key with value `0` while the other has no key at all. Using fixed-size arrays instead of maps sidesteps this problem entirely: array comparison in Go is value-based, so `sCount == pCount` is a correct O(1) check with no stale-key risk.

```go
// ❌ BAD: Not properly maintaining window state
func findAnagramsBad(s string, p string) []int {
    pCount := make(map[byte]int)
    for i := 0; i < len(p); i++ {
        pCount[p[i]]++
    }

    var result []int
    windowCount := make(map[byte]int)

    for i := 0; i < len(s); i++ {
        windowCount[s[i]]++

        if i >= len(p) {
            // Bug: Not removing count properly
            windowCount[s[i-len(p)]]--  // Leaves count at 0, not removed
        }

        // This comparison fails because maps have different keys
        // (one has 0-count keys, other doesn't)
        if mapsEqual(windowCount, pCount) {
            result = append(result, i-len(p)+1)
        }
    }
    return result
}

// ✅ GOOD: Properly maintain window state
func findAnagramsGood(s string, p string) []int {
    if len(s) < len(p) {
        return nil
    }

    // Use fixed-size arrays for comparison
    var pCount, sCount [26]int
    for i := 0; i < len(p); i++ {
        pCount[p[i]-'a']++
        sCount[s[i]-'a']++
    }

    var result []int
    if sCount == pCount {
        result = append(result, 0)
    }

    for i := len(p); i < len(s); i++ {
        sCount[s[i]-'a']++
        sCount[s[i-len(p)]-'a']--

        // Direct array comparison works correctly
        if sCount == pCount {
            result = append(result, i-len(p)+1)
        }
    }
    return result
}

func mapsEqual(a, b map[byte]int) bool {
    if len(a) != len(b) {
        return false
    }
    for k, v := range a {
        if b[k] != v {
            return false
        }
    }
    return true
}
```

### Mistake 5: Integer Overflow in Prefix Sum

Prefix sums accumulate values across the entire array, so even moderate element sizes can push the running total past the maximum value of `int32` when the array is long. On 32-bit platforms Go's `int` is also 32 bits, making this a silent data corruption rather than a compile-time error. Widening the accumulator to `int64` prevents overflow for all practical inputs, and adding an explicit overflow check allows callers to handle pathological datasets safely.

```go
// ❌ BAD: Potential integer overflow
func prefixSumBad(nums []int) []int {
    prefix := make([]int, len(nums)+1)
    for i, num := range nums {
        // Can overflow for large arrays with large values
        prefix[i+1] = prefix[i] + num
    }
    return prefix
}

// ✅ GOOD: Use int64 or check for overflow
func prefixSumGood(nums []int) []int64 {
    prefix := make([]int64, len(nums)+1)
    for i, num := range nums {
        prefix[i+1] = prefix[i] + int64(num)
    }
    return prefix
}

// Alternative: Check for overflow
func prefixSumWithCheck(nums []int) ([]int, error) {
    prefix := make([]int, len(nums)+1)
    for i, num := range nums {
        // Check for overflow before adding
        if num > 0 && prefix[i] > math.MaxInt-num {
            return nil, errors.New("integer overflow")
        }
        if num < 0 && prefix[i] < math.MinInt-num {
            return nil, errors.New("integer underflow")
        }
        prefix[i+1] = prefix[i] + num
    }
    return prefix, nil
}
```

### Junior → FAANG: Building a Personal Bug Checklist

Every mistake in this section represents a category of bug that is quick to write and painful to debug. Before submitting any array or string solution in an interview, apply this five-point checklist: Is the loop bound `<` rather than `<=`? Does the function handle empty and single-element inputs? Does the code modify a data structure it is also iterating over? Does the sliding window state remain consistent after each step? Do accumulating sums use a wide enough integer type?

Off-by-one errors and empty input panics are the most common reasons a correct algorithm produces a wrong answer. Interviewers at FAANG companies differentiate candidates not by whether they can solve the problem but by whether they write correct, well-written code that handles edge cases on the first attempt. Practice catching these on your own before the interviewer has to point them out.

For the sliding window state mistake (Mistake 4), the specific fix of using fixed-size arrays instead of maps for character frequency comparison is a Go idiom worth memorizing. `var sCount [26]int` with direct array comparison is cleaner, faster, and immune to the stale-zero-key problem than using `map[byte]int` with manual zero-value cleanup.

### Senior @ FAANG: Making These Mistakes Impossible

At senior level, the goal is to make entire categories of mistakes impossible, not just to catch them in review.

Integer overflow in prefix sums is preventable at the type level by using `int64` as the default accumulator type in any function that sums over a large array. A team-wide linting rule that flags `int` accumulators in sum functions would catch this class of bug automatically. The rule is cheap to implement and essentially zero false-positive rate.

Off-by-one errors in sliding window code are significantly reduced by adopting a consistent convention: always use half-open intervals `[left, right)` rather than closed intervals `[left, right]`. Half-open intervals compose naturally (concatenating `[a,b)` and `[b,c)` gives `[a,c)`) and align with Go's slice indexing semantics. Documenting this convention in the team's style guide turns an individual habit into a team standard.

Modification-during-iteration bugs are detectable by static analysis tools in many cases. The Go race detector catches data races from concurrent modification, but same-goroutine modification-while-iterating bugs are harder to detect automatically. Code review training that specifically flags `append(nums[:i], nums[i+1:]...)` patterns inside range loops is the most reliable prevention mechanism.

---
