## 78B.2 The Sliding Window Pattern

```
┌─────────────────────────────────────────────────────────────────┐
│                 SLIDING WINDOW PATTERN                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Fixed Window (size k):                                         │
│  ┌───┬───┬───┬───┬───┬───┬───┬───┐                              │
│  │ 1 │ 3 │ 2 │ 6 │-1 │ 4 │ 1 │ 8 │                              │
│  └───┴───┴───┴───┴───┴───┴───┴───┘                              │
│  [=======]                         → slide right                │
│      [=======]                                                  │
│          [=======]                                              │
│                                                                 │
│  Variable Window:                                               │
│  ┌───┬───┬───┬───┬───┬───┬───┬───┐                              │
│  │ a │ b │ c │ a │ b │ c │ b │ b │                              │
│  └───┴───┴───┴───┴───┴───┴───┴───┘                              │
│  [===]         expand right →                                   │
│    [=========] shrink left →                                    │
│                                                                 │
│  Key insight: Maintain a window that satisfies constraints,     │
│  expanding/shrinking to optimize the objective function.        │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

The Sliding Window pattern maintains a contiguous subarray/substring and adjusts its boundaries to satisfy constraints. It converts O(n * k) brute force into O(n).

**When to use Sliding Window:**
- Finding max/min sum subarray of size k
- Longest/shortest substring with a condition
- String anagram or permutation matching
- Subarray problems where elements are contiguous

### Template: Fixed Size Window

A fixed-size window maintains a running aggregate by adding the incoming element and subtracting the outgoing element at each step, avoiding a full recomputation of the window contents. This reduces the per-step cost from O(k) to O(1), enabling O(n) solutions for problems like maximum subarray of length k.

```go
func fixedWindow(nums []int, k int) int {
    // Build the first window
    windowSum := 0
    for i := 0; i < k; i++ {
        windowSum += nums[i]
    }

    maxSum := windowSum

    // Slide the window
    for i := k; i < len(nums); i++ {
        windowSum += nums[i] - nums[i-k] // add new, remove old
        if windowSum > maxSum {
            maxSum = windowSum
        }
    }

    return maxSum
}
```

### Template: Variable Size Window

A variable-size window expands the right pointer unconditionally and contracts the left pointer only when the window violates the constraint. This two-phase approach ensures each element is added and removed at most once, keeping the amortized cost O(n) regardless of how many times the inner shrink loop executes.

```go
func variableWindow(s string) int {
    freq := make(map[byte]int)
    left := 0
    maxLen := 0

    for right := 0; right < len(s); right++ {
        freq[s[right]]++

        // Shrink window until constraint is satisfied
        for !isValid(freq) {
            freq[s[left]]--
            if freq[s[left]] == 0 {
                delete(freq, s[left])
            }
            left++
        }

        // Update answer
        if right-left+1 > maxLen {
            maxLen = right - left + 1
        }
    }

    return maxLen
}
```

---

### Problem 1: Maximum Average Subarray I (LC 643)

**Problem:** Given an integer array `nums` and an integer `k`, find a contiguous subarray of length `k` that has the maximum average value and return this value.

**Approach:** Fixed-size sliding window. Compute the sum of the first k elements, then slide by adding the new element and removing the old.

```go
func findMaxAverage(nums []int, k int) float64 {
    // Compute initial window sum
    windowSum := 0
    for i := 0; i < k; i++ {
        windowSum += nums[i]
    }

    maxSum := windowSum

    // Slide the window
    for i := k; i < len(nums); i++ {
        windowSum += nums[i] - nums[i-k]
        if windowSum > maxSum {
            maxSum = windowSum
        }
    }

    return float64(maxSum) / float64(k)
}
```

**Time Complexity:** O(n).
**Space Complexity:** O(1).

**Edge cases:**
- `k == len(nums)`: only one window, return the average of the entire array
- All same values: any window gives the same average
- Negative numbers: the algorithm handles them naturally. Note that `maxSum` is seeded with the first window rather than with zero, which is what makes an all-negative array work

---

### Problem 2: Longest Substring Without Repeating Characters (LC 3)

**Problem:** Given a string `s`, find the length of the longest substring without repeating characters.

**Approach:** Variable-size sliding window with a hash map tracking the last index of each character. When a repeat is found, jump the left pointer past the previous occurrence.

```go
func lengthOfLongestSubstring(s string) int {
    lastIndex := make(map[byte]int) // char -> last seen index
    maxLen := 0
    left := 0

    for right := 0; right < len(s); right++ {
        ch := s[right]
        if idx, exists := lastIndex[ch]; exists && idx >= left {
            left = idx + 1 // jump past the duplicate
        }
        lastIndex[ch] = right

        if right-left+1 > maxLen {
            maxLen = right - left + 1
        }
    }

    return maxLen
}
```

**Time Complexity:** O(n). Each character is processed once by the right pointer, and left only ever moves forward.
**Space Complexity:** O(min(n, m)) where m is the character set size (26 for lowercase, 128 for ASCII).

**Edge cases:**
- Empty string → 0
- All same characters → 1
- All unique characters → length of string
- String of length 1 → 1

---

### Problem 3: Minimum Window Substring (LC 76)

**Problem:** Given strings `s` and `t`, find the minimum window substring of `s` that contains all characters of `t` (including duplicates).

**Approach:** Variable-size sliding window. Expand right to include characters, track how many required characters are satisfied. When all are satisfied, shrink from left to minimize. This is the hardest sliding window variant.

```go
func minWindow(s string, t string) string {
    if len(s) < len(t) {
        return ""
    }

    // Count required characters
    need := make(map[byte]int)
    for i := 0; i < len(t); i++ {
        need[t[i]]++
    }

    have := make(map[byte]int)
    formed := 0       // number of unique chars in t that are fully matched
    required := len(need) // number of unique chars in t

    left := 0
    minLen := len(s) + 1
    minLeft := 0

    for right := 0; right < len(s); right++ {
        ch := s[right]
        have[ch]++

        // Check if current char's count matches the required count
        if need[ch] > 0 && have[ch] == need[ch] {
            formed++
        }

        // Try to shrink the window
        for formed == required {
            // Update minimum
            windowLen := right - left + 1
            if windowLen < minLen {
                minLen = windowLen
                minLeft = left
            }

            // Remove left character
            leftCh := s[left]
            have[leftCh]--
            if need[leftCh] > 0 && have[leftCh] < need[leftCh] {
                formed--
            }
            left++
        }
    }

    if minLen > len(s) {
        return ""
    }
    return s[minLeft : minLeft+minLen]
}
```

**Time Complexity:** O(|s| + |t|). Each pointer traverses s at most once, plus O(|t|) to build the frequency map.
**Space Complexity:** O(k) where k is the size of the alphabet, since both maps hold at most one entry per distinct character. Bounded by O(|s| + |t|) in the worst case.

**Edge cases:**
- `t` longer than `s` → return ""
- `t` is a single character → find its first occurrence
- `s == t` → return `s`
- No valid window exists → return ""
- Multiple valid windows of same length → return any (leftmost by this algorithm)

---

### Problem 4: Permutation in String (LC 567)

**Problem:** Given strings `s1` and `s2`, return true if `s2` contains a permutation of `s1`.

**Approach:** Fixed-size sliding window of length `len(s1)` over `s2`. Compare character frequency counts.

```go
func checkInclusion(s1 string, s2 string) bool {
    if len(s1) > len(s2) {
        return false
    }

    var s1Count, windowCount [26]int

    // Build frequency of s1 and initial window
    for i := 0; i < len(s1); i++ {
        s1Count[s1[i]-'a']++
        windowCount[s2[i]-'a']++
    }

    if s1Count == windowCount {
        return true
    }

    // Slide the window
    for i := len(s1); i < len(s2); i++ {
        windowCount[s2[i]-'a']++            // add new char
        windowCount[s2[i-len(s1)]-'a']--    // remove old char

        if s1Count == windowCount {
            return true
        }
    }

    return false
}
```

**Time Complexity:** O(n) where n = len(s2). Array comparison is O(26) = O(1).
**Space Complexity:** O(1). Fixed-size arrays.

Comparing `[26]int` values with `==` works because Go defines equality on arrays element by element. This is one of the places where Go is more convenient than languages where an array is a reference type.

**Edge cases:**
- `s1` longer than `s2` → false
- `s1` and `s2` identical → true
- Single character strings

---

### Problem 5: Longest Repeating Character Replacement (LC 424)

**Problem:** Given a string `s` and integer `k`, you can replace at most `k` characters. Return the length of the longest substring containing the same letter after replacements.

**Approach:** Variable-size sliding window. Track the count of the most frequent character in the window. If `window_size - max_freq > k`, the window is invalid, so shrink from the left.

```go
func characterReplacement(s string, k int) int {
    var count [26]int
    left := 0
    maxFreq := 0
    maxLen := 0

    for right := 0; right < len(s); right++ {
        count[s[right]-'A']++
        if count[s[right]-'A'] > maxFreq {
            maxFreq = count[s[right]-'A']
        }

        // Window is invalid: more chars to replace than k allows
        for (right-left+1)-maxFreq > k {
            count[s[left]-'A']--
            left++
            // Note: we don't need to update maxFreq downward.
            // A stale maxFreq only means we might not shrink when we could,
            // but we'll never miss a longer valid window.
        }

        if right-left+1 > maxLen {
            maxLen = right - left + 1
        }
    }

    return maxLen
}
```

**Time Complexity:** O(n).
**Space Complexity:** O(1). A fixed 26-element array.

The never-decrease-`maxFreq` trick is the part interviewers probe, because it looks like a bug. The argument that it is not: `maxFreq` is only ever an overestimate of the true maximum frequency in the current window, so the shrink test `(right-left+1)-maxFreq > k` can only under-trigger, never over-trigger. That means the window can carry a size that was justified by an earlier, better window. Since the answer only ever reads `right-left+1` and we only care about the maximum over all steps, an inflated window never produces a length that was not genuinely achievable at the moment `maxFreq` was set. The window size is monotone non-decreasing, which is exactly the invariant the answer depends on. Be ready to state this out loud. If you cannot defend it, use a version that recomputes the max over the 26 counts on each shrink. That is still O(26n) = O(n) and it is easier to prove.

**Edge cases:**
- `k >= len(s)` → entire string (all characters replaced to one)
- `k == 0` → longest run of a single character
- All same characters → length of string

---

### Junior → FAANG: The Two Window Templates and When Each Applies

Junior engineers commonly try to use the fixed-size window template for variable-size problems and then add awkward logic to resize the window. The mental model to lock in: fixed-size windows slide by simultaneously adding one element on the right and removing one on the left every iteration. Variable-size windows grow by advancing right and shrink by advancing left, but only when a validity condition is violated. These are different control flows, and conflating them produces bugs that are hard to spot in a 45-minute interview.

The variable-size template has one subtle correctness requirement: the validity condition must be monotone. If adding more elements to the window can only make it "more invalid" (never spontaneously valid), then shrinking from the left is always safe. This holds for "at most K distinct characters" because removing a character from the left can only reduce the distinct count. It breaks for constraints like "exactly K distinct," where a window can be invalid, become valid, and go invalid again, so there is no single point at which shrinking is the right move. For *counting* subarrays with exactly K distinct values the standard fix is `atMost(K) - atMost(K-1)`, since each term is monotone and therefore slidable. That subtraction does not carry over to *longest* or *shortest* variants, where you need a different decomposition. Reach for the trick because you checked the monotonicity, not because the phrase "exactly K" appeared.

First-job habit: always identify whether the window constraint is monotone before choosing the template. State it out loud in the interview: "The window stays valid as long as the character count map has at most K keys, and adding an element can only increase the key count, never decrease it, so the shrink logic is correct."

Entry-level signal: handling the character frequency map cleanup correctly. Forgetting to delete a key when its count reaches zero causes spurious "K+1 distinct characters" readings and is a common source of wrong answers on Longest Substring with At Most K Distinct Characters.

### Senior @ FAANG: Sliding Window in Stream Processing and Rate Limiting

The sliding window pattern is not confined to interview problems. In production systems it underlies rate limiting (sliding window counters for API throttling), network congestion control (TCP's congestion window), and time-series aggregation (rolling averages, P99 latency over a trailing 60-second window). When you recognize the pattern in a system design discussion you can immediately speak to its computational properties: O(1) per update for the fixed-size case, amortized O(1) per element for the variable-size case.

In a rate limiter implementation, the window is the time dimension rather than an array index. Redis's sliding window rate limiter uses a sorted set where members are timestamps and ZRANGEBYSCORE implements "remove elements outside the window." The correctness argument is identical to the interview template: elements outside the left boundary of the window are irrelevant and can be discarded. Understanding this connection lets you evaluate rate limiter design options with algorithmic grounding rather than cargo-culting a common pattern.

ADR consideration: fixed-size window is preferable when the window size is determined by business requirements (e.g., "last 5 minutes of data") because the memory footprint is bounded and predictable. Variable-size window is appropriate when the size is determined by a data-dependent constraint (e.g., "all requests from this user with no gap larger than 30 seconds"). Document this distinction explicitly: a variable-size window in a high-throughput system can grow arbitrarily large if the constraint is rarely violated, requiring explicit capacity guards.

Bar-raiser signal: the candidate observes that Minimum Window Substring is the same shape as finding the shortest span covering one occurrence of every query term, which is how proximity ranking works over positional posting lists in a full-text search engine. That connection shows the mental model generalizes past toy problems.
