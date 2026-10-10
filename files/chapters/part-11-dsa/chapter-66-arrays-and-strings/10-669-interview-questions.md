## 66.9 Interview Questions

### Question 1: Find All Pairs with Given Sum

**Problem**: Given an array of integers and a target sum, find all unique pairs that add up to the target. The solution should be O(n) time.

**Follow-up**: What if the array is sorted? What if we need triplets instead of pairs?

```go
// Solution: Use hash map for O(n) time
func findPairs(nums []int, target int) [][]int {
    seen := make(map[int]int)  // value -> count
    used := make(map[[2]int]bool)  // Track used pairs
    var result [][]int

    for _, num := range nums {
        complement := target - num

        if seen[complement] > 0 {
            // Create sorted pair for deduplication
            pair := [2]int{min(num, complement), max(num, complement)}

            if !used[pair] {
                result = append(result, []int{pair[0], pair[1]})
                used[pair] = true
            }
        }
        seen[num]++
    }

    return result
}

// For sorted array: Two-pointer O(n) time, O(1) space
func findPairsSorted(nums []int, target int) [][]int {
    var result [][]int
    left, right := 0, len(nums)-1

    for left < right {
        sum := nums[left] + nums[right]

        if sum == target {
            result = append(result, []int{nums[left], nums[right]})

            // Skip duplicates
            for left < right && nums[left] == nums[left+1] {
                left++
            }
            for left < right && nums[right] == nums[right-1] {
                right--
            }
            left++
            right--
        } else if sum < target {
            left++
        } else {
            right--
        }
    }

    return result
}

// For triplets (3Sum): O(n²) time
func threeSum(nums []int, target int) [][]int {
    slices.Sort(nums)
    var result [][]int

    for i := 0; i < len(nums)-2; i++ {
        // Skip duplicates for first element
        if i > 0 && nums[i] == nums[i-1] {
            continue
        }

        // Two-pointer for remaining elements
        left, right := i+1, len(nums)-1
        remaining := target - nums[i]

        for left < right {
            sum := nums[left] + nums[right]

            if sum == remaining {
                result = append(result, []int{nums[i], nums[left], nums[right]})

                // Skip duplicates
                for left < right && nums[left] == nums[left+1] {
                    left++
                }
                for left < right && nums[right] == nums[right-1] {
                    right--
                }
                left++
                right--
            } else if sum < remaining {
                left++
            } else {
                right--
            }
        }
    }

    return result
}
```

**Key Points**:
- Hash map approach: O(n) time, O(n) space
- Two-pointer (sorted): O(n) time, O(1) space
- Need to handle duplicates carefully
- 3Sum reduces to 2Sum with outer loop

### Question 2: Longest Substring with At Most K Distinct Characters

**Problem**: Given a string and an integer k, find the length of the longest substring that contains at most k distinct characters.

```go
// Solution: Sliding window with character count
func lengthOfLongestSubstringKDistinct(s string, k int) int {
    if k == 0 || len(s) == 0 {
        return 0
    }

    charCount := make(map[byte]int)
    maxLen := 0
    left := 0

    for right := 0; right < len(s); right++ {
        // Expand window
        charCount[s[right]]++

        // Shrink window until we have at most k distinct chars
        for len(charCount) > k {
            charCount[s[left]]--
            if charCount[s[left]] == 0 {
                delete(charCount, s[left])
            }
            left++
        }

        // Update max length
        maxLen = max(maxLen, right-left+1)
    }

    return maxLen
}

// Optimized version using array for ASCII characters
func lengthOfLongestSubstringKDistinctOptimized(s string, k int) int {
    if k == 0 || len(s) == 0 {
        return 0
    }

    var charCount [128]int
    distinctCount := 0
    maxLen := 0
    left := 0

    for right := 0; right < len(s); right++ {
        // Add character to window
        if charCount[s[right]] == 0 {
            distinctCount++
        }
        charCount[s[right]]++

        // Shrink window if needed
        for distinctCount > k {
            charCount[s[left]]--
            if charCount[s[left]] == 0 {
                distinctCount--
            }
            left++
        }

        maxLen = max(maxLen, right-left+1)
    }

    return maxLen
}

// Test cases
func TestLongestSubstringKDistinct(t *testing.T) {
    tests := []struct {
        s        string
        k        int
        expected int
    }{
        {"eceba", 2, 3},           // "ece"
        {"aa", 1, 2},              // "aa"
        {"aabbcc", 2, 4},          // "aabb" or "bbcc"
        {"aabbcc", 3, 6},          // entire string
        {"", 2, 0},                // empty string
        {"abc", 0, 0},             // k=0
    }

    for _, tt := range tests {
        result := lengthOfLongestSubstringKDistinct(tt.s, tt.k)
        if result != tt.expected {
            t.Errorf("For s=%q, k=%d: expected %d, got %d",
                tt.s, tt.k, tt.expected, result)
        }
    }
}
```

**Key Points**:
- Classic sliding window problem
- Track count of distinct characters in window
- Shrink window when constraint violated
- Time: O(n), Space: O(k) or O(1) with array

### Question 3: String Compression

**Problem**: Implement basic string compression using counts of repeated characters. If the compressed string is not smaller, return the original string. Assume only a-zA-Z characters.

**Follow-up**: Do it in-place with O(1) extra space.

```go
// Solution 1: Using strings.Builder
func compress(s string) string {
    if len(s) <= 1 {
        return s
    }

    var builder strings.Builder
    count := 1

    for i := 1; i < len(s); i++ {
        if s[i] == s[i-1] {
            count++
        } else {
            builder.WriteByte(s[i-1])
            if count > 1 {
                builder.WriteString(strconv.Itoa(count))
            }
            count = 1
        }
    }

    // Don't forget last character group
    builder.WriteByte(s[len(s)-1])
    if count > 1 {
        builder.WriteString(strconv.Itoa(count))
    }

    result := builder.String()
    if len(result) >= len(s) {
        return s
    }
    return result
}

// Solution 2: In-place compression (modifies input slice)
// LeetCode 443 style - compress in-place, return new length
func compressInPlace(chars []byte) int {
    if len(chars) <= 1 {
        return len(chars)
    }

    write := 0  // Write pointer
    read := 0   // Read pointer

    for read < len(chars) {
        char := chars[read]
        count := 0

        // Count consecutive characters
        for read < len(chars) && chars[read] == char {
            read++
            count++
        }

        // Write character
        chars[write] = char
        write++

        // Write count if > 1
        if count > 1 {
            countStr := strconv.Itoa(count)
            for _, c := range countStr {
                chars[write] = byte(c)
                write++
            }
        }
    }

    return write
}

// Solution 3: Decompress compressed string
func decompress(compressed string) string {
    var builder strings.Builder
    i := 0

    for i < len(compressed) {
        char := compressed[i]
        i++

        // Parse count
        count := 0
        for i < len(compressed) && compressed[i] >= '0' && compressed[i] <= '9' {
            count = count*10 + int(compressed[i]-'0')
            i++
        }

        if count == 0 {
            count = 1
        }

        // Write character count times
        for j := 0; j < count; j++ {
            builder.WriteByte(char)
        }
    }

    return builder.String()
}

// Test
func TestCompression(t *testing.T) {
    tests := []struct {
        input    string
        expected string
    }{
        {"aabcccccaaa", "a2bc5a3"},
        {"abc", "abc"},              // No compression benefit
        {"aabbcc", "aabbcc"},        // Each char appears twice
        {"aaaaaaaaaa", "a10"},       // 10 a's
        {"", ""},
    }

    for _, tt := range tests {
        result := compress(tt.input)
        if result != tt.expected {
            t.Errorf("compress(%q) = %q, want %q", tt.input, result, tt.expected)
        }
    }
}
```

**Key Points**:
- Two-pointer technique for in-place compression
- Handle multi-digit counts carefully
- Remember to process the last group of characters
- Always check if compression actually saves space

### Junior → FAANG: Maximizing Your Score on These Interview Questions

Question 1 (find all pairs with given sum) is a discrimination problem: the hash map approach is O(n) time and O(n) space. The two-pointer approach on a sorted array is O(n) time and O(1) space but requires sorting first (adding O(n log n) to the total). The right answer depends on whether the array is already sorted and whether space is constrained. Present both approaches and let the interviewer choose, or ask which constraint they want to optimize for.

Question 2 (longest substring with at most k distinct characters) has a cleaner implementation using an array of size 128 (ASCII) than using a map, because array indexing avoids per-character map hashing overhead and an explicit distinct-count integer replaces the `len(map)` check. Practice the optimized version and explain why it is faster even though both are O(n).

Question 3 (string compression) is primarily a "handle all the edge cases" problem. The multi-digit count, the last group, and the "do not compress if no benefit" check are the three places candidates lose points. Solve them in order, out loud, so the interviewer can see your systematic thinking.

### Senior @ FAANG: What Bar-Raisers Ask After You Solve These

After a candidate solves Question 1 correctly, a bar-raiser asks: "If the input is a stream of integers arriving one at a time and you need to maintain all pairs that have ever summed to target, how would you modify your approach?" The answer is to maintain the same hash map incrementally: for each new number, check for its complement in the existing map, record any new pair found, then add the new number to the map. The pair storage grows with the number of pairs found, which in the worst case is O(n squared) but O(n) for typical inputs with few duplicates.

After Question 2, the bar-raiser asks: "How would you solve this for Unicode input where characters can be any code point, not just ASCII?" The correct answer switches from a fixed 128-slot array to a `map[rune]int`, iterates the string by rune rather than by byte, and accepts the higher constant factor. The follow-up is: "What is the space complexity now?" The answer is O(k) where k is the number of distinct code points in the current window, bounded by the window size.

After Question 3, the bar-raiser asks: "How does this interact with Go's string immutability?" The in-place solution requires `[]byte` input, not `string`, because strings cannot be modified in place. The interviewer is checking whether you understand that converting to `[]byte` is an O(n) allocation, which means the "in-place" solution is not actually zero-allocation if it starts from a `string`. A truly zero-allocation solution requires the input to already be a `[]byte`, which is an API design choice with implications for the caller.

---
