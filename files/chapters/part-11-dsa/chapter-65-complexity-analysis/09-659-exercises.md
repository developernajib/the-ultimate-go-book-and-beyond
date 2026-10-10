## 65.8 Exercises

### Exercise 1: Complexity Analysis Practice

Determine the time and space complexity of each function:

**Solution:**

```go
// Function 1
func func1(n int) int {
    sum := 0
    for i := 1; i <= n; i *= 2 {
        for j := 1; j <= n; j++ {
            sum++
        }
    }
    return sum
}
// Time: O(n log n) - outer loop runs log(n) times, inner runs n times
// Space: O(1)

// Function 2
func func2(nums []int) [][]int {
    result := make([][]int, len(nums))
    for i := range nums {
        result[i] = make([]int, len(nums))
        for j := range nums {
            result[i][j] = nums[i] + nums[j]
        }
    }
    return result
}
// Time: O(n²)
// Space: O(n²) - creating n×n matrix

// Function 3
func func3(s string) bool {
    for i := 0; i < len(s)/2; i++ {
        if s[i] != s[len(s)-1-i] {
            return false
        }
    }
    return true
}
// Time: O(n) where n = len(s)
// Space: O(1)

// Function 4
func func4(n int) int {
    if n <= 2 {
        return 1
    }
    return func4(n-1) + func4(n-2) + func4(n-3)
}
// Time: O(3^n) - exponential (worse than Fibonacci)
// Space: O(n) - recursion depth

// Function 5
func func5(nums []int) {
    for i := 0; i < len(nums); i++ {
        minIdx := i
        for j := i + 1; j < len(nums); j++ {
            if nums[j] < nums[minIdx] {
                minIdx = j
            }
        }
        nums[i], nums[minIdx] = nums[minIdx], nums[i]
    }
}
// Time: O(n²) - Selection sort
// Space: O(1) - in-place
```

### Exercise 2: Optimize These Functions

Improve the time complexity while maintaining correctness:

**Solution:**

```go
// Original: O(n²) - Find if array has two numbers that sum to target
func originalTwoSum(nums []int, target int) bool {
    for i := 0; i < len(nums); i++ {
        for j := i + 1; j < len(nums); j++ {
            if nums[i]+nums[j] == target {
                return true
            }
        }
    }
    return false
}

// Optimized: O(n)
func optimizedTwoSum(nums []int, target int) bool {
    seen := make(map[int]bool)
    for _, num := range nums {
        if seen[target-num] {
            return true
        }
        seen[num] = true
    }
    return false
}

// Original: O(n²) - Find longest substring without repeating chars
func originalLongest(s string) int {
    maxLen := 0
    for i := 0; i < len(s); i++ {
        seen := make(map[byte]bool)
        for j := i; j < len(s); j++ {
            if seen[s[j]] {
                break
            }
            seen[s[j]] = true
            if j-i+1 > maxLen {
                maxLen = j - i + 1
            }
        }
    }
    return maxLen
}

// Optimized: O(n) - Sliding window
func optimizedLongest(s string) int {
    lastSeen := make(map[byte]int)
    maxLen, start := 0, 0

    for i := 0; i < len(s); i++ {
        if pos, ok := lastSeen[s[i]]; ok && pos >= start {
            start = pos + 1
        }
        lastSeen[s[i]] = i
        if i-start+1 > maxLen {
            maxLen = i - start + 1
        }
    }
    return maxLen
}

// Original: O(n²) - Check if string has all unique characters
func originalUnique(s string) bool {
    for i := 0; i < len(s); i++ {
        for j := i + 1; j < len(s); j++ {
            if s[i] == s[j] {
                return false
            }
        }
    }
    return true
}

// Optimized: O(n)
func optimizedUnique(s string) bool {
    seen := make(map[rune]bool)
    for _, char := range s {
        if seen[char] {
            return false
        }
        seen[char] = true
    }
    return true
}
```

### Junior → FAANG: Getting Value from Optimization Exercises

The optimization exercises in this section follow a template: here is an O(n squared) solution that is obviously correct, find the O(n) version. The technique is always the same: identify what information the inner loop is recomputing on every outer iteration, find a data structure that stores that information in O(1) retrievable form, and replace the inner loop with a single lookup.

For two-sum: the inner loop checks "does the array contain target minus nums[i]?" A hash set answers that question in O(1). For longest substring without repeating: the inner loop scans backward to find the last occurrence of the current character. A hash map from character to index answers that question in O(1). For unique characters: the inner loop checks "have I seen this character before?" A hash set answers in O(1).

Completing these exercises is not enough. After you find the optimized solution, write both versions side by side and run them against identical inputs to verify they produce the same output. This "test against brute force" habit is valuable both for interview practice and for production debugging.

### Senior @ FAANG: Optimization as a Code Review Discipline

The optimization pairs in this section represent exactly the kind of regression that slips through code review when reviewers focus on correctness rather than performance. A function that checks uniqueness with a nested loop is unambiguously correct. In a code review focused on business logic, it will pass without comment. Six months later, when the input size triples, it will appear in a latency incident post-mortem.

The senior engineer's code review checklist for performance includes: does every loop over n have an inner body that is O(1)? does every membership check use a map or set rather than a linear scan? does every string-building operation use `strings.Builder` rather than `+=`? These are mechanical checks that can be automated, but a human reviewer who habitually applies them catches regressions that tools miss.

A useful practice for senior engineers is to maintain a "complexity anti-patterns" section in the team's engineering standards document. Each entry lists the bad pattern, the good pattern, and a benchmark showing the performance difference at the team's typical input scale. This document serves as a training resource for new engineers and a reference for code reviewers. Updating it when a new anti-pattern appears in a production incident turns incidents into team learning rather than one-off fixes.

---
