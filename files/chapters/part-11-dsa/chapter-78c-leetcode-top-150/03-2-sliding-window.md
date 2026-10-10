## 78C.2 Sliding Window

The sliding window technique maintains a window (subarray/substring) that expands or contracts based on a condition. It transforms brute-force O(n²) approaches into O(n) by reusing computation from the previous window position.

---
### LC 3 - Longest Substring Without Repeating Characters 🟡

**Key Insight**: Expand the window right. When a duplicate is found, shrink from the left past the previous occurrence.

```go
func lengthOfLongestSubstring(s string) int {
    lastSeen := make(map[byte]int) // char -> last index
    best := 0
    left := 0

    for right := 0; right < len(s); right++ {
        if idx, ok := lastSeen[s[right]]; ok && idx >= left {
            left = idx + 1
        }
        lastSeen[s[right]] = right
        if right-left+1 > best {
            best = right - left + 1
        }
    }
    return best
}
```
**Time**: O(n).
**Space**: O(min(n, charset)) - at most 128 entries for ASCII.

---
### LC 76 - Minimum Window Substring 🔴

**Key Insight**: Expand right to satisfy the requirement, then shrink left to minimize. Track character counts and a "formed" counter.

```go
func minWindow(s string, t string) string {
    if len(s) == 0 || len(t) == 0 {
        return ""
    }

    need := make(map[byte]int)
    for i := 0; i < len(t); i++ {
        need[t[i]]++
    }

    required := len(need)
    formed := 0
    windowCounts := make(map[byte]int)

    left := 0
    bestLen := len(s) + 1
    bestLeft := 0

    for right := 0; right < len(s); right++ {
        c := s[right]
        windowCounts[c]++
        if windowCounts[c] == need[c] {
            formed++
        }

        for formed == required {
            if right-left+1 < bestLen {
                bestLen = right - left + 1
                bestLeft = left
            }
            lc := s[left]
            windowCounts[lc]--
            if windowCounts[lc] < need[lc] {
                formed--
            }
            left++
        }
    }

    if bestLen > len(s) {
        return ""
    }
    return s[bestLeft : bestLeft+bestLen]
}
```
**Time**: O(|s| + |t|).
**Space**: O(|s| + |t|).

---
### LC 209 - Minimum Size Subarray Sum 🟡

**Key Insight**: Expand right to reach the target sum, then shrink left to find the minimum length.

```go
func minSubArrayLen(target int, nums []int) int {
    left := 0
    sum := 0
    best := len(nums) + 1

    for right := 0; right < len(nums); right++ {
        sum += nums[right]
        for sum >= target {
            if right-left+1 < best {
                best = right - left + 1
            }
            sum -= nums[left]
            left++
        }
    }

    if best > len(nums) {
        return 0
    }
    return best
}
```
**Time**: O(n).
**Space**: O(1).

---
### LC 424 - Longest Repeating Character Replacement 🟡

**Key Insight**: The window is valid when `windowSize - maxFreq <= k`. Track the max frequency character and expand/shrink accordingly.

```go
func characterReplacement(s string, k int) int {
    var count [26]int
    left := 0
    maxFreq := 0
    best := 0

    for right := 0; right < len(s); right++ {
        count[s[right]-'A']++
        if count[s[right]-'A'] > maxFreq {
            maxFreq = count[s[right]-'A']
        }

        for (right-left+1)-maxFreq > k {
            count[s[left]-'A']--
            left++
        }

        if right-left+1 > best {
            best = right - left + 1
        }
    }
    return best
}
```
**Time**: O(n).
**Space**: O(1) - fixed 26-element array.

---
### LC 567 - Permutation in String 🟡

**Key Insight**: Use a fixed-size sliding window equal to len(s1). Compare character frequency counts.

```go
func checkInclusion(s1 string, s2 string) bool {
    if len(s1) > len(s2) {
        return false
    }

    var s1Count, windowCount [26]int
    for i := 0; i < len(s1); i++ {
        s1Count[s1[i]-'a']++
        windowCount[s2[i]-'a']++
    }

    if s1Count == windowCount {
        return true
    }

    for i := len(s1); i < len(s2); i++ {
        windowCount[s2[i]-'a']++
        windowCount[s2[i-len(s1)]-'a']--
        if s1Count == windowCount {
            return true
        }
    }
    return false
}
```
**Time**: O(n) where n = len(s2).
**Space**: O(1) - two fixed arrays.

---
### LC 438 - Find All Anagrams in a String 🟡

**Key Insight**: Same as permutation check but collect all starting indices where the window matches.

```go
func findAnagrams(s string, p string) []int {
    if len(p) > len(s) {
        return nil
    }

    var pCount, windowCount [26]int
    for i := 0; i < len(p); i++ {
        pCount[p[i]-'a']++
        windowCount[s[i]-'a']++
    }

    var result []int
    if pCount == windowCount {
        result = append(result, 0)
    }

    for i := len(p); i < len(s); i++ {
        windowCount[s[i]-'a']++
        windowCount[s[i-len(p)]-'a']--
        if pCount == windowCount {
            result = append(result, i-len(p)+1)
        }
    }
    return result
}
```
**Time**: O(n).
**Space**: O(1).

---
### LC 239 - Sliding Window Maximum 🔴

**Key Insight**: Use a monotonic decreasing deque. The front always holds the current window's maximum index.

```go
func maxSlidingWindow(nums []int, k int) []int {
    var deque []int // indices, front is max
    var result []int

    for i := 0; i < len(nums); i++ {
        // Remove elements outside the window
        for len(deque) > 0 && deque[0] <= i-k {
            deque = deque[1:]
        }
        // Remove smaller elements from back
        for len(deque) > 0 && nums[deque[len(deque)-1]] <= nums[i] {
            deque = deque[:len(deque)-1]
        }
        deque = append(deque, i)

        if i >= k-1 {
            result = append(result, nums[deque[0]])
        }
    }
    return result
}
```
**Time**: O(n) - each element enters and leaves the deque once.
**Space**: O(k) - deque size.

---
### LC 904 - Fruit Into Baskets 🟡

**Key Insight**: Longest subarray with at most 2 distinct elements, a classic sliding window with a frequency map.

```go
func totalFruit(fruits []int) int {
    count := make(map[int]int)
    left := 0
    best := 0

    for right := 0; right < len(fruits); right++ {
        count[fruits[right]]++
        for len(count) > 2 {
            count[fruits[left]]--
            if count[fruits[left]] == 0 {
                delete(count, fruits[left])
            }
            left++
        }
        if right-left+1 > best {
            best = right - left + 1
        }
    }
    return best
}
```
**Time**: O(n).
**Space**: O(1) - map has at most 3 entries.

---
### LC 1004 - Max Consecutive Ones III 🟡

**Key Insight**: Sliding window where flipping a 0 costs 1 from budget k. Shrink when budget exhausted.

```go
func longestOnes(nums []int, k int) int {
    left := 0
    zeros := 0
    best := 0

    for right := 0; right < len(nums); right++ {
        if nums[right] == 0 {
            zeros++
        }
        for zeros > k {
            if nums[left] == 0 {
                zeros--
            }
            left++
        }
        if right-left+1 > best {
            best = right - left + 1
        }
    }
    return best
}
```
**Time**: O(n).
**Space**: O(1).

---
### LC 30 - Substring with Concatenation of All Words 🔴

**Key Insight**: Since all words have the same length, slide a window of `totalWords * wordLen` and use frequency maps to check validity across all starting offsets.

```go
func findSubstring(s string, words []string) []int {
    if len(s) == 0 || len(words) == 0 {
        return nil
    }

    wordLen := len(words[0])
    totalWords := len(words)
    windowLen := wordLen * totalWords

    wordCount := make(map[string]int)
    for _, w := range words {
        wordCount[w]++
    }

    var result []int

    for offset := 0; offset < wordLen; offset++ {
        left := offset
        matched := 0
        seen := make(map[string]int)

        for right := offset; right+wordLen <= len(s); right += wordLen {
            word := s[right : right+wordLen]
            if cnt, ok := wordCount[word]; ok {
                seen[word]++
                matched++

                for seen[word] > cnt {
                    leftWord := s[left : left+wordLen]
                    seen[leftWord]--
                    matched--
                    left += wordLen
                }

                if matched == totalWords {
                    result = append(result, left)
                    leftWord := s[left : left+wordLen]
                    seen[leftWord]--
                    matched--
                    left += wordLen
                }
            } else {
                seen = make(map[string]int)
                matched = 0
                left = right + wordLen
            }
        }
    }
    return result
}
```
**Time**: O(n × wordLen) where n = len(s).
**Space**: O(totalWords).

---

### Junior → FAANG: Recognizing the Constraint Type Before Choosing the Template

Sliding window problems in this section split into two categories: "at most K" constraints (use variable-size window with a shrink condition) and "exactly K" constraints (use "at most K" minus "at most K-1"). Recognizing this split before coding prevents the common mistake of trying to shrink the window on an "exactly" constraint, which requires shrinking on two different conditions and produces incorrect logic.

Substring with Concatenation of All Words is the hardest problem in this section. The key insight is treating each word-length segment as a single unit and applying a sliding window over segments rather than characters. Junior candidates who approach this as a character-by-character sliding window spend the full interview time debugging. Read the constraint carefully: all words have the same length, and this is the exact property that makes segment-by-segment sliding possible.

Practice timing for this section: Minimum Window Substring should take 20-25 minutes including edge case handling. If it takes more than 30 minutes, the bottleneck is likely the character count map management, which is worth isolating and drilling separately.

### Senior @ FAANG: Sliding Window in Real-Time Aggregation Systems

Variable-size sliding windows over time series are the core primitive in stream processing systems. When you design a real-time metrics dashboard that shows "error rate over the last 5 minutes," the implementation is a sliding window over a time-ordered event stream. The constraint is time-based rather than count-based, and "shrinking" means evicting events older than the window boundary.

In Go, implementing a time-based sliding window correctly requires careful handling of monotonic time (using `time.Now().UnixNano()` rather than wall clock time to avoid daylight saving jumps) and concurrent access to the window state. The sliding window's amortized O(1) per event guarantee is the property that makes high-throughput metrics systems feasible. When this property is broken by incorrect implementation (e.g., using a sorted slice and binary searching on every event), the system's throughput ceiling drops by orders of magnitude under load.
