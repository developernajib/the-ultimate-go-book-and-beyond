## 66.2 Sliding Window

### Fixed Size Window

A fixed-size window avoids recomputing the aggregate from scratch on every step by maintaining a running total: when the window advances one position, you add the incoming element and subtract the element that just fell off the left edge. This turns what would be an O(n·k) recomputation into a single O(1) update per step, reducing the overall algorithm to O(n) regardless of window size k. The anagram-detection variant exploits the same idea using two fixed-size frequency arrays instead of a numeric sum.

```go
// Maximum Sum Subarray of Size K
// Time: O(n), Space: O(1)
func maxSumSubarray(nums []int, k int) int {
    if len(nums) < k {
        return 0
    }

    // Calculate first window sum
    windowSum := 0
    for i := 0; i < k; i++ {
        windowSum += nums[i]
    }

    maxSum := windowSum

    // Slide window
    for i := k; i < len(nums); i++ {
        windowSum += nums[i] - nums[i-k]
        if windowSum > maxSum {
            maxSum = windowSum
        }
    }
    return maxSum
}

// Find All Anagrams in a String (LeetCode 438)
// Time: O(n), Space: O(1) - fixed 26 characters
func findAnagrams(s string, p string) []int {
    if len(s) < len(p) {
        return nil
    }

    result := []int{}
    pCount := [26]int{}
    sCount := [26]int{}

    // Count characters in pattern
    for _, c := range p {
        pCount[c-'a']++
    }

    // Initial window
    for i := 0; i < len(p); i++ {
        sCount[s[i]-'a']++
    }

    if sCount == pCount {
        result = append(result, 0)
    }

    // Slide window
    for i := len(p); i < len(s); i++ {
        sCount[s[i]-'a']++           // Add new char
        sCount[s[i-len(p)]-'a']--    // Remove old char

        if sCount == pCount {
            result = append(result, i-len(p)+1)
        }
    }
    return result
}
```

### Variable Size Window

A variable-size window expands the right boundary unconditionally on each step and shrinks the left boundary only when the window violates the required constraint. This expand-then-contract motion guarantees every valid subarray is considered exactly once without backtracking, achieving O(n) time even though the window length changes dynamically. The `formed` counter in `minWindow` is a concrete optimization of this idea: it tracks how many distinct required characters are fully satisfied, so the inner shrink loop triggers only when the full constraint is met rather than re-scanning the frequency map on every iteration.

```go
// Longest Substring Without Repeating Characters (LeetCode 3)
// Time: O(n), Space: O(min(m,n)) where m is charset size
func lengthOfLongestSubstring(s string) int {
    charIndex := make(map[byte]int)
    maxLen := 0
    left := 0

    for right := 0; right < len(s); right++ {
        if idx, found := charIndex[s[right]]; found && idx >= left {
            left = idx + 1
        }
        charIndex[s[right]] = right

        if right-left+1 > maxLen {
            maxLen = right - left + 1
        }
    }
    return maxLen
}

// Minimum Window Substring (LeetCode 76)
// Find minimum window in s containing all chars of t
// Time: O(n), Space: O(m) where m is charset size
func minWindow(s string, t string) string {
    if len(s) < len(t) {
        return ""
    }

    // Count characters needed
    need := make(map[byte]int)
    for i := 0; i < len(t); i++ {
        need[t[i]]++
    }

    have := make(map[byte]int)
    formed := 0
    required := len(need)

    left := 0
    minLen := len(s) + 1
    minStart := 0

    for right := 0; right < len(s); right++ {
        c := s[right]
        have[c]++

        if need[c] > 0 && have[c] == need[c] {
            formed++
        }

        // Try to shrink window
        for formed == required {
            if right-left+1 < minLen {
                minLen = right - left + 1
                minStart = left
            }

            leftChar := s[left]
            have[leftChar]--
            if need[leftChar] > 0 && have[leftChar] < need[leftChar] {
                formed--
            }
            left++
        }
    }

    if minLen > len(s) {
        return ""
    }
    return s[minStart : minStart+minLen]
}

// Longest Repeating Character Replacement (LeetCode 424)
// Time: O(n), Space: O(1)
func characterReplacement(s string, k int) int {
    count := [26]int{}
    maxCount := 0
    maxLen := 0
    left := 0

    for right := 0; right < len(s); right++ {
        count[s[right]-'A']++
        maxCount = max(maxCount, count[s[right]-'A'])

        // Window size - most frequent char count > k means invalid
        for right-left+1-maxCount > k {
            count[s[left]-'A']--
            left++
        }

        maxLen = max(maxLen, right-left+1)
    }
    return maxLen
}

// Subarray Sum Equals K (LeetCode 560)
// Count subarrays with sum equal to k
// Time: O(n), Space: O(n)
func subarraySum(nums []int, k int) int {
    count := 0
    prefixSum := 0
    prefixCount := map[int]int{0: 1}

    for _, num := range nums {
        prefixSum += num

        // If prefixSum - k exists, we found subarrays
        if cnt, found := prefixCount[prefixSum-k]; found {
            count += cnt
        }

        prefixCount[prefixSum]++
    }
    return count
}
```

### Junior → FAANG: Knowing When to Use Fixed vs Variable Windows

The fixed-window pattern applies when the problem specifies an exact window size k. The algorithm is: compute the first window, then slide by adding the new element and subtracting the element that fell off. This is almost always the complete solution.

The variable-window pattern applies when the window must satisfy a constraint that can be violated and restored. The algorithm is: expand right unconditionally, shrink left until the constraint holds, then record or update the answer. The key insight is that shrinking uses a `while` (in Go, `for`) loop, not an `if`, because the constraint may require shrinking multiple steps before being restored.

The Subarray Sum Equals K problem at the end of this section looks like a sliding window but is actually a prefix sum problem. Negative numbers prevent the sliding window from working because adding a negative element can restore a violated constraint without shrinking. Recognizing this is a common FAANG interview trap. If a problem involves negative numbers and "sum equals k," use the prefix sum hash map approach.

### Senior @ FAANG: Sliding Window as a Streaming Algorithm

The sliding window pattern is a special case of the general streaming algorithm design problem: maintain a data structure over a moving window of recent events with O(1) per-event update cost. This appears in real production systems as rate limiters (count events in the last 60 seconds), anomaly detectors (maintain a rolling average and standard deviation), and time-series aggregators (compute max, min, or sum over a moving window of time).

The `minWindow` algorithm's `formed` counter is an excellent example of the canonical streaming optimization: instead of recomputing a global property (all characters satisfied) from scratch on every step, maintain an incremental counter that is updated only when a relevant transition occurs. This reduces the per-step cost from O(alphabet size) to O(1). Production stream processing frameworks (Apache Flink, Kafka Streams) use this incremental state update pattern pervasively.

For a senior design interview, the Minimum Window Substring problem can be extended to: "Given a stream of characters that arrives one at a time, maintain the minimum window over the last n characters that contains all characters of pattern p." The answer requires a deque-based sliding window that tracks both the current window contents and the history needed to restore the formed count when the left boundary advances past a character that was satisfying one of the required counts. This extension demonstrates understanding of the streaming generalization of a batch algorithm, which is a staff-level system design skill.

---
