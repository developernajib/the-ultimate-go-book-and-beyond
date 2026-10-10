## 75.7 String Problems

Greedy string problems typically use a monotonic stack to build the lexicographically smallest (or largest) result. The idea is to process characters one by one: before pushing the current character onto the stack, pop any larger characters that still appear later in the string, because keeping them now would produce a worse result. This "remove and replace" logic is greedy because at each step you make the locally best choice for the next position in the output. The same stack-based pattern applies to removing duplicate letters (LeetCode 316) and removing k digits to form the smallest number (LeetCode 402).

```go
import "strings"

// RemoveDuplicateLetters keeps one copy of each distinct letter and returns the
// lexicographically smallest such result.
// LeetCode 316: Remove Duplicate Letters
// Time: O(n), Space: O(1) (both tables and the stack are bounded by the
// 26-letter alphabet).
func RemoveDuplicateLetters(s string) string {
    // Count remaining occurrences
    count := make([]int, 26)
    for i := 0; i < len(s); i++ {
        count[s[i]-'a']++
    }

    // Track which letters are in stack
    inStack := make([]bool, 26)
    stack := []byte{}

    for i := 0; i < len(s); i++ {
        c := s[i]
        count[c-'a']--

        if inStack[c-'a'] {
            continue
        }

        // Pop larger characters if they appear later
        for len(stack) > 0 && stack[len(stack)-1] > c && count[stack[len(stack)-1]-'a'] > 0 {
            inStack[stack[len(stack)-1]-'a'] = false
            stack = stack[:len(stack)-1]
        }

        stack = append(stack, c)
        inStack[c-'a'] = true
    }

    return string(stack)
}

// RemoveKDigits removes exactly k digits from num to leave the smallest
// possible number.
// LeetCode 402: Remove K Digits
// Time: O(n), Space: O(n)
func RemoveKDigits(num string, k int) string {
    if k >= len(num) {
        return "0"
    }

    stack := []byte{}

    for i := 0; i < len(num); i++ {
        // Remove larger digits from stack
        for k > 0 && len(stack) > 0 && stack[len(stack)-1] > num[i] {
            stack = stack[:len(stack)-1]
            k--
        }
        stack = append(stack, num[i])
    }

    // Remove remaining k digits from end
    stack = stack[:len(stack)-k]

    // Remove leading zeros
    result := string(stack)
    result = strings.TrimLeft(result, "0")

    if result == "" {
        return "0"
    }
    return result
}
```

### Junior → FAANG: Monotonic Stack as a Greedy Tool

The monotonic stack pattern is one of the most powerful tools in the greedy string toolkit, and it appears frequently in FAANG interviews. The core idea: maintain a stack where elements are in monotone order. When you encounter an element that breaks the order, pop elements from the stack until the order is restored (or until you cannot pop, for example because a character has no future occurrences).

For `RemoveDuplicateLetters`, the two auxiliary arrays (`count` and `inStack`) are both necessary and a common source of bugs. `count` tells you whether you can afford to pop a character (it will appear again later, so you have a chance to add it back). `inStack` prevents duplicate characters in the result. Practice this problem until you can write both auxiliary arrays from memory.

For `RemoveKDigits`, the greedy rule is simpler: pop any digit from the stack if it is greater than the current digit and you still have removals left. The cleanup at the end (remove trailing removals from the right, strip leading zeros) is where many candidates make mistakes. Write a test for `"10"` with `k=2` to catch the all-zeros edge case.

### Senior @ FAANG: Lexicographic Optimization in Data Systems

Monotonic stack greedy problems are a direct model for lexicographic optimization, which appears in query planning, log compaction, and key normalization in distributed systems.

**Query plan optimization.** Join ordering is the classic place where greedy is tempting and mostly rejected. The textbook planner, following System R, uses dynamic programming over subsets of relations precisely because a greedy pick of the cheapest next join is not optimal: the cheapest join now can produce an intermediate result whose size wrecks every later join. That is the greedy choice property failing, in a system you probably use daily. Greedy and randomized heuristics do get used, but only as an escape hatch once the DP becomes too expensive. PostgreSQL, for instance, switches to its genetic optimizer (GEQO) past a configurable threshold of relations in a query, trading the optimality guarantee for a tractable planning time. The lesson generalizes: when you see greedy in a mature system where DP is known to be correct, it is usually a deliberate purchase of speed with accuracy, and someone should be able to tell you the price.

**Log compaction in Kafka.** Kafka log compaction retains only the latest record per key, removing older records to save storage. The compaction algorithm scans the log and greedily discards older versions of each key, building a compact representation. This is analogous to `RemoveDuplicateLetters`: you want the smallest (most recent) log, and you can only drop a record if a newer one exists later in the log. The correctness invariant is the same: never drop the last occurrence.

**Key normalization for distributed caches.** A content-delivery system might normalize URL keys to remove redundant query parameters (analogous to `RemoveKDigits`). The greedy normalization rule is: drop parameters that can be reconstructed or are superseded by later parameters in the URL. The order of parameter removal affects the resulting key, so the greedy choice (which parameter to drop first) must be defined by a consistent policy (alphabetical, by parameter weight, by recency). Staff engineers define this policy as a formal specification, not a loose convention, to ensure cache key consistency across versions of the normalization code.
