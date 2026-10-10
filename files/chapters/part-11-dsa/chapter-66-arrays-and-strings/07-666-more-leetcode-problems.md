## 66.6 More LeetCode Problems

### Merge Intervals (LeetCode 56)

The key insight is that overlapping intervals can only be identified reliably after the list is sorted by start time. Once sorted, a single linear pass suffices: for each interval, compare its start against the end of the last interval already added to the result, and extend that end if there is an overlap. This avoids an O(n²) pairwise comparison and achieves the problem in O(n log n) dominated by the sort.

```go
// Time: O(n log n), Space: O(n)
func merge(intervals [][]int) [][]int {
    if len(intervals) <= 1 {
        return intervals
    }

    // Sort by start time
    sort.Slice(intervals, func(i, j int) bool {
        return intervals[i][0] < intervals[j][0]
    })

    result := [][]int{intervals[0]}

    for i := 1; i < len(intervals); i++ {
        last := result[len(result)-1]

        if intervals[i][0] <= last[1] {
            // Overlapping - merge
            last[1] = max(last[1], intervals[i][1])
        } else {
            // Non-overlapping - add new interval
            result = append(result, intervals[i])
        }
    }
    return result
}
```

### Valid Parentheses (LeetCode 20)

A stack is the natural fit for this problem because it mirrors the LIFO structure of nested brackets. Every opening bracket pushed must be matched by the most recent unmatched closer. The pairs map inverts the relationship so that each closing bracket can look up its required opener in O(1), keeping the entire pass at O(n) time. The string is valid only when the stack is empty at the end, confirming that every opener was properly closed.

```go
// Time: O(n), Space: O(n)
func isValid(s string) bool {
    stack := []rune{}
    pairs := map[rune]rune{
        ')': '(',
        ']': '[',
        '}': '{',
    }

    for _, c := range s {
        if c == '(' || c == '[' || c == '{' {
            stack = append(stack, c)
        } else {
            if len(stack) == 0 || stack[len(stack)-1] != pairs[c] {
                return false
            }
            stack = stack[:len(stack)-1]
        }
    }
    return len(stack) == 0
}
```

### Longest Palindromic Substring (LeetCode 5)

Rather than checking every possible substring, the expand-around-center technique treats each character (and each gap between characters) as a potential palindrome center and grows outward as long as characters match. This handles both odd-length and even-length palindromes with two calls per index and runs in O(n²) time with O(1) space, significantly better than a dynamic programming table that costs O(n²) space as well.

```go
// Expand Around Center approach
// Time: O(n²), Space: O(1)
func longestPalindrome(s string) string {
    if len(s) < 2 {
        return s
    }

    start, maxLen := 0, 1

    expandAroundCenter := func(left, right int) {
        for left >= 0 && right < len(s) && s[left] == s[right] {
            if right-left+1 > maxLen {
                start = left
                maxLen = right - left + 1
            }
            left--
            right++
        }
    }

    for i := 0; i < len(s); i++ {
        expandAroundCenter(i, i)   // Odd length
        expandAroundCenter(i, i+1) // Even length
    }

    return s[start : start+maxLen]
}
```

### Rotate Array (LeetCode 189)

The three-reverse trick achieves an in-place O(n) rotation without allocating a second array. Reversing the entire array, then reversing the first k elements, and finally reversing the remainder repositions every element exactly where it belongs. Taking `k % n` first handles the case where k is larger than the array length, preventing unnecessary work.

```go
// Time: O(n), Space: O(1)
func rotate(nums []int, k int) {
    n := len(nums)
    k = k % n

    reverse := func(start, end int) {
        for start < end {
            nums[start], nums[end] = nums[end], nums[start]
            start++
            end--
        }
    }

    reverse(0, n-1)   // Reverse all
    reverse(0, k-1)   // Reverse first k
    reverse(k, n-1)   // Reverse remaining
}
```

### Next Permutation (LeetCode 31)

The algorithm exploits the observation that the next permutation requires the smallest possible increase, which means finding the rightmost position where the sequence first stops being non-increasing from the right. Swapping that element with the smallest element to its right that is still larger, then reversing the suffix, produces the lexicographically next arrangement in O(n) time without any extra memory.

```go
// Time: O(n), Space: O(1)
func nextPermutation(nums []int) {
    n := len(nums)

    // Find first decreasing element from right
    i := n - 2
    for i >= 0 && nums[i] >= nums[i+1] {
        i--
    }

    if i >= 0 {
        // Find smallest element larger than nums[i]
        j := n - 1
        for nums[j] <= nums[i] {
            j--
        }
        nums[i], nums[j] = nums[j], nums[i]
    }

    // Reverse suffix
    left, right := i+1, n-1
    for left < right {
        nums[left], nums[right] = nums[right], nums[left]
        left++
        right--
    }
}
```

### Junior → FAANG: Mastering the "Trick" Problems

The problems in this section share a characteristic: each has an obvious brute-force solution and a sharply better one that requires one specific non-obvious insight. Merge intervals requires sorting first. Valid parentheses requires using a stack to match openers and closers. Longest palindromic substring requires expanding from centers rather than checking all substrings. Rotate array requires the three-reverse trick. Next permutation requires finding the rightmost descent.

For each problem, practice explaining the insight, not just the code. "We sort first because overlapping intervals can only be detected reliably when they are in start-time order" is an explanation. "We sort and then merge" is a description. Interviewers want to hear explanations.

The three-reverse rotation trick is worth special attention because it generalizes. Any cyclic permutation can be achieved with three reverses of appropriate subarrays. Understanding why this works (each element ends up at its correct final position after three reverses) rather than just memorizing the sequence is what lets you apply it to novel variants like "rotate a 2D matrix 90 degrees."

### Senior @ FAANG: These Patterns in Real Engineering

Merge intervals appears directly in production systems: interval trees for scheduling, sweep-line algorithms for collision detection, and covered-range optimization for CDN cache invalidation. The key production concern is handling concurrent interval insertions, which requires either a thread-safe sorted data structure or a batch-and-merge approach for high write rates.

Valid parentheses is a simplification of balanced delimiter checking, which appears in every configuration parser, markup language processor, and programming language lexer. Production parsers typically use recursive descent, where the call stack plays the role of the explicit bracket stack, because it provides better error messages and recovery behavior.

Next permutation is used in combinatorial optimization systems that need to enumerate solutions in lexicographic order, which is useful for deterministic random sampling and for reporting results in a predictable order regardless of algorithm execution order. The in-place O(n) algorithm is important because generating the next permutation for billion-element sequences requires zero auxiliary allocation.

---
