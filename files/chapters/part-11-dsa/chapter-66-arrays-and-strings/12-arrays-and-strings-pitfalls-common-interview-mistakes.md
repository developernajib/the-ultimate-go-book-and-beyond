## Arrays and Strings Pitfalls: Common Interview Mistakes

### Pitfall 1: Off-By-One Errors in Sliding Window

**Interview Mistake**: Window size is wrong, boundaries are incorrect, or the shrink condition is off.

```go
// WRONG: Off-by-one in window size
func maxSumSubarray(nums []int, k int) int {
    if len(nums) < k {
        return 0
    }

    sum := 0
    for i := 0; i < k; i++ {
        sum += nums[i]
    }

    maxSum := sum
    for i := k; i <= len(nums); i++ {  // BUG: should be i < len(nums)
        sum += nums[i] - nums[i-k]     // Will panic on last iteration
        if sum > maxSum {
            maxSum = sum
        }
    }
    return maxSum
}

// CORRECT: Proper boundaries
func maxSumSubarrayCorrect(nums []int, k int) int {
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
        if sum > maxSum {
            maxSum = sum
        }
    }
    return maxSum
}

// WRONG: Variable window shrink condition
func minWindowSubstring(s, t string) string {
    need := make(map[byte]int)
    for i := 0; i < len(t); i++ {
        need[t[i]]++
    }

    have := make(map[byte]int)
    formed := 0
    left := 0
    result := ""

    for right := 0; right < len(s); right++ {
        c := s[right]
        have[c]++

        if have[c] == need[c] {
            formed++
        }

        // BUG: Should shrink while valid, not if valid once
        if formed == len(need) {
            // Only shrinks once, misses optimal window
            if result == "" || right-left+1 < len(result) {
                result = s[left : right+1]
            }
            have[s[left]]--
            left++
            if have[s[left-1]] < need[s[left-1]] {
                formed--
            }
        }
    }
    return result
}

// CORRECT: Shrink while valid
func minWindowSubstringCorrect(s, t string) string {
    need := make(map[byte]int)
    for i := 0; i < len(t); i++ {
        need[t[i]]++
    }

    have := make(map[byte]int)
    formed := 0
    left := 0
    result := ""

    for right := 0; right < len(s); right++ {
        c := s[right]
        have[c]++

        if need[c] > 0 && have[c] == need[c] {
            formed++
        }

        // Keep shrinking while window is valid
        for formed == len(need) {
            if result == "" || right-left+1 < len(result) {
                result = s[left : right+1]
            }
            leftChar := s[left]
            have[leftChar]--
            if need[leftChar] > 0 && have[leftChar] < need[leftChar] {
                formed--
            }
            left++
        }
    }
    return result
}
```

### Pitfall 2: Modifying Array While Iterating

**Interview Mistake**: Using range loop index after modifying slice, or removing elements mid-iteration.

```go
// WRONG: Using index after append may cause issues
func removeDuplicates(nums []int) []int {
    result := []int{}
    for i := range nums {
        if i == 0 || nums[i] != nums[i-1] {
            result = append(result, nums[i])
        }
    }
    return result
    // This works, but common mistake is trying to modify nums in-place incorrectly
}

// WRONG: Skipping elements when removing
func removeElement(nums []int, val int) int {
    for i := 0; i < len(nums); i++ {
        if nums[i] == val {
            // Remove by shifting
            nums = append(nums[:i], nums[i+1:]...)
            // BUG: Don't increment i, but loop does automatically
            // We skip the element that moved into position i
        }
    }
    return len(nums)
}

// CORRECT: Two-pointer approach for in-place modification
func removeElementCorrect(nums []int, val int) int {
    slow := 0
    for fast := 0; fast < len(nums); fast++ {
        if nums[fast] != val {
            nums[slow] = nums[fast]
            slow++
        }
    }
    return slow
}

// CORRECT: If you must remove, iterate backwards
func removeElementBackwards(nums *[]int, val int) {
    for i := len(*nums) - 1; i >= 0; i-- {
        if (*nums)[i] == val {
            *nums = append((*nums)[:i], (*nums)[i+1:]...)
        }
    }
}
```

### Pitfall 3: String Immutability and Inefficient Operations

**Interview Mistake**: Treating strings like mutable arrays, leading to O(n²) solutions.

```go
// WRONG: O(n²) due to string immutability
func reverseString(s string) string {
    result := ""
    for i := len(s) - 1; i >= 0; i-- {
        result += string(s[i])  // Creates new string each time!
    }
    return result
}

// WRONG: Can't modify string directly
func reverseStringInPlace(s string) {
    // s[0] = s[len(s)-1]  // Compile error: cannot assign to s[0]
}

// CORRECT: Use []byte or []rune for in-place modification
func reverseStringCorrect(s string) string {
    bytes := []byte(s)
    left, right := 0, len(bytes)-1
    for left < right {
        bytes[left], bytes[right] = bytes[right], bytes[left]
        left++
        right--
    }
    return string(bytes)
}

// CORRECT: Use strings.Builder for concatenation
func reverseStringBuilder(s string) string {
    var builder strings.Builder
    builder.Grow(len(s))
    for i := len(s) - 1; i >= 0; i-- {
        builder.WriteByte(s[i])
    }
    return builder.String()
}

// WRONG: Unicode handling
func reverseWithUnicode(s string) string {
    bytes := []byte(s)
    // This corrupts multi-byte UTF-8 characters!
    for i, j := 0, len(bytes)-1; i < j; i, j = i+1, j-1 {
        bytes[i], bytes[j] = bytes[j], bytes[i]
    }
    return string(bytes)
}

// CORRECT: Use []rune for Unicode
func reverseWithUnicodeCorrect(s string) string {
    runes := []rune(s)
    for i, j := 0, len(runes)-1; i < j; i, j = i+1, j-1 {
        runes[i], runes[j] = runes[j], runes[i]
    }
    return string(runes)
}
```

### Pitfall 4: Two Pointers Edge Cases

**Interview Mistake**: Not handling empty arrays, single elements, or duplicate elements.

```go
// WRONG: Missing edge cases
func twoSum(nums []int, target int) []int {
    left, right := 0, len(nums)-1
    for left < right {  // Survives empty input only by accident of the loop condition
        sum := nums[left] + nums[right]
        if sum == target {
            return []int{left, right}
        } else if sum < target {
            left++
        } else {
            right--
        }
    }
    return nil  // Returns nil but should maybe return empty slice
}

// WRONG: Not skipping duplicates in 3Sum
func threeSum(nums []int) [][]int {
    slices.Sort(nums)
    var result [][]int

    for i := 0; i < len(nums)-2; i++ {
        // BUG: Missing duplicate skip for i
        left, right := i+1, len(nums)-1
        for left < right {
            sum := nums[i] + nums[left] + nums[right]
            if sum == 0 {
                result = append(result, []int{nums[i], nums[left], nums[right]})
                left++
                right--
                // BUG: Missing duplicate skip for left and right
            } else if sum < 0 {
                left++
            } else {
                right--
            }
        }
    }
    return result  // Will have duplicates like [-1,-1,2], [-1,-1,2]
}

// CORRECT: Handle all edge cases and duplicates
func threeSumCorrect(nums []int) [][]int {
    if len(nums) < 3 {
        return [][]int{}
    }

    slices.Sort(nums)
    var result [][]int

    for i := 0; i < len(nums)-2; i++ {
        // Skip duplicate i values
        if i > 0 && nums[i] == nums[i-1] {
            continue
        }

        // Early termination: if smallest is positive, no solution
        if nums[i] > 0 {
            break
        }

        left, right := i+1, len(nums)-1
        for left < right {
            sum := nums[i] + nums[left] + nums[right]
            if sum == 0 {
                result = append(result, []int{nums[i], nums[left], nums[right]})

                // Skip duplicates for left
                for left < right && nums[left] == nums[left+1] {
                    left++
                }
                // Skip duplicates for right
                for left < right && nums[right] == nums[right-1] {
                    right--
                }

                left++
                right--
            } else if sum < 0 {
                left++
            } else {
                right--
            }
        }
    }
    return result
}
```

### Quick Reference: Array/String Pitfalls

| Pitfall | Symptom | Fix |
|---------|---------|-----|
| Off-by-one | Index out of bounds | Check `<` vs `<=` carefully |
| Modify while iterate | Skip elements or panic | Use two pointers or iterate backwards |
| String concatenation | TLE (O(n²)) | Use strings.Builder or []byte |
| Missing edge cases | Wrong answer on empty/single input | Add explicit checks at start |
| Unicode handling | Corrupted characters | Use []rune instead of []byte |

### Junior → FAANG: Turning Pitfall Awareness into Interview Discipline

Each pitfall in this section has caused candidates to fail interviews they otherwise could have passed. The off-by-one error causes a runtime panic. The modification-while-iterating bug causes silently wrong output. String concatenation causes a time limit exceeded verdict. Missing edge cases causes wrong answer on the judge. Unicode mishandling causes subtle test failures only on non-ASCII inputs.

Before submitting any solution in an interview, run through the pitfall table row by row. This takes less than 30 seconds and catches the most common failure modes. Build the habit during practice problems so it becomes automatic.

The most important pitfall to internalize is string concatenation. In Go, every `result += word` in a loop creates a new string and copies all previous content. For a string built from n words, this is O(total length squared). The fix is always `strings.Builder`. Make it a reflex: whenever you see yourself writing string concatenation inside a loop, immediately reach for `strings.Builder`.

### Senior @ FAANG: Pitfall Prevention at Architecture Level

These pitfalls are not just interview mistakes: they are the most common source of production bugs in Go services that process text and collections.

String concatenation in loops is endemic in Go codebases written by developers who come from Python or JavaScript, where string builders are less prominent. A static analysis pass using `go vet` extended with a custom analyzer can catch `+=` on string variables inside loops with zero false positives. Adding this rule to a team's CI pipeline is a one-time investment that prevents the bug indefinitely.

Unicode mishandling is more subtle. A service that accepts UTF-8 input from international users and reverses strings using `[]byte` instead of `[]rune` will produce corrupted output only for users with non-ASCII characters in their data. This is both a correctness bug and potentially a security issue if the corrupted output is used in a security-sensitive context (URL construction, authentication token generation). A code review checklist item "does this code iterate over strings using bytes or runes? if the domain is user-supplied text, it must use runes" prevents this class of bug.

The modification-while-iterating bug is particularly dangerous in concurrent code where the modification happens in a different goroutine. Go's race detector catches this, but only when the race actually occurs during a test run. Fuzz testing with the race detector enabled provides better coverage than unit tests alone for this class of bug. Adding fuzz tests to any function that modifies a slice in place is a senior engineering practice that reduces the risk of production incidents from this pitfall.

---
