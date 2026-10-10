## 66.10 Exercises

### Exercise 1: Implement Text Justification

Implement a function that formats text with full justification. Given an array of words and a maximum width, format the text such that each line has exactly maxWidth characters and is fully justified.

**Requirements**:
- Extra spaces should be distributed as evenly as possible
- If uneven, left slots get more spaces than right
- Last line should be left-justified with no extra spaces between words

```go
// Solution
func fullJustify(words []string, maxWidth int) []string {
    var result []string
    var line []string
    lineLength := 0

    for _, word := range words {
        // Check if word fits in current line
        // +1 for space between words
        if lineLength + len(line) + len(word) > maxWidth {
            // Justify and add current line
            result = append(result, justify(line, lineLength, maxWidth, false))
            line = nil
            lineLength = 0
        }

        line = append(line, word)
        lineLength += len(word)
    }

    // Handle last line (left-justified)
    if len(line) > 0 {
        result = append(result, justify(line, lineLength, maxWidth, true))
    }

    return result
}

func justify(words []string, wordsLength, maxWidth int, isLastLine bool) string {
    if len(words) == 1 || isLastLine {
        // Left justify: single word or last line
        line := strings.Join(words, " ")
        return line + strings.Repeat(" ", maxWidth-len(line))
    }

    // Calculate spaces
    totalSpaces := maxWidth - wordsLength
    gaps := len(words) - 1

    baseSpaces := totalSpaces / gaps
    extraSpaces := totalSpaces % gaps

    var builder strings.Builder
    for i, word := range words {
        builder.WriteString(word)

        if i < len(words)-1 {
            // Add spaces between words
            spaces := baseSpaces
            if i < extraSpaces {
                spaces++
            }
            builder.WriteString(strings.Repeat(" ", spaces))
        }
    }

    return builder.String()
}

// Test cases
func TestFullJustify(t *testing.T) {
    words := []string{"This", "is", "an", "example", "of", "text", "justification."}
    maxWidth := 16

    expected := []string{
        "This    is    an",
        "example  of text",
        "justification.  ",
    }

    result := fullJustify(words, maxWidth)

    for i, line := range result {
        if line != expected[i] {
            t.Errorf("Line %d: expected %q, got %q", i, expected[i], line)
        }
        if len(line) != maxWidth {
            t.Errorf("Line %d: expected width %d, got %d", i, maxWidth, len(line))
        }
    }
}
```

### Exercise 2: Implement Substring Search with Wildcards

Implement a function that searches for a pattern in text where '?' matches any single character and '*' matches zero or more characters.

```go
// Solution using dynamic programming
func wildcardMatch(text, pattern string) bool {
    m, n := len(text), len(pattern)

    // dp[i][j] = true if text[0:i] matches pattern[0:j]
    dp := make([][]bool, m+1)
    for i := range dp {
        dp[i] = make([]bool, n+1)
    }

    // Empty pattern matches empty text
    dp[0][0] = true

    // Pattern with only '*' can match empty text
    for j := 1; j <= n; j++ {
        if pattern[j-1] == '*' {
            dp[0][j] = dp[0][j-1]
        }
    }

    for i := 1; i <= m; i++ {
        for j := 1; j <= n; j++ {
            if pattern[j-1] == '*' {
                // '*' matches zero chars (dp[i][j-1]) or one+ chars (dp[i-1][j])
                dp[i][j] = dp[i][j-1] || dp[i-1][j]
            } else if pattern[j-1] == '?' || text[i-1] == pattern[j-1] {
                // '?' matches any single char, or exact match
                dp[i][j] = dp[i-1][j-1]
            }
        }
    }

    return dp[m][n]
}

// Space-optimized version O(n)
func wildcardMatchOptimized(text, pattern string) bool {
    m, n := len(text), len(pattern)

    // Only need two rows
    prev := make([]bool, n+1)
    curr := make([]bool, n+1)

    prev[0] = true
    for j := 1; j <= n; j++ {
        if pattern[j-1] == '*' {
            prev[j] = prev[j-1]
        }
    }

    for i := 1; i <= m; i++ {
        curr[0] = false
        for j := 1; j <= n; j++ {
            if pattern[j-1] == '*' {
                curr[j] = curr[j-1] || prev[j]
            } else if pattern[j-1] == '?' || text[i-1] == pattern[j-1] {
                curr[j] = prev[j-1]
            } else {
                curr[j] = false
            }
        }
        prev, curr = curr, prev
    }

    return prev[n]
}

// Find all matches in text
func findWildcardMatches(text, pattern string) []int {
    var matches []int

    // Try matching at each position
    for i := 0; i <= len(text)-minPatternLength(pattern); i++ {
        // Find the first end position that matches
        for j := i; j <= len(text); j++ {
            if wildcardMatch(text[i:j], pattern) {
                matches = append(matches, i)
                break
            }
        }
    }

    return matches
}

// Calculate minimum text length needed for pattern
func minPatternLength(pattern string) int {
    length := 0
    for _, c := range pattern {
        if c != '*' {
            length++
        }
    }
    return length
}

// Test cases
func TestWildcardMatch(t *testing.T) {
    tests := []struct {
        text     string
        pattern  string
        expected bool
    }{
        {"aa", "a", false},
        {"aa", "*", true},
        {"cb", "?a", false},
        {"adceb", "*a*b", true},
        {"acdcb", "a*c?b", false},
        {"", "*", true},
        {"", "?", false},
        {"abc", "a?c", true},
        {"abcd", "a*d", true},
        {"abcd", "a*?d", true},
    }

    for _, tt := range tests {
        result := wildcardMatch(tt.text, tt.pattern)
        if result != tt.expected {
            t.Errorf("wildcardMatch(%q, %q) = %v, want %v",
                tt.text, tt.pattern, result, tt.expected)
        }

        // Also test optimized version
        resultOpt := wildcardMatchOptimized(tt.text, tt.pattern)
        if resultOpt != tt.expected {
            t.Errorf("wildcardMatchOptimized(%q, %q) = %v, want %v",
                tt.text, tt.pattern, resultOpt, tt.expected)
        }
    }
}
```

### Junior → FAANG: Getting Compound Value from These Exercises

These two exercises are intentionally harder than the examples in the chapter. Text justification requires balancing multiple correctness conditions simultaneously: exact line width, even space distribution, left-justification of the last line. Wildcard matching requires choosing between recursive DP and the space-optimized two-row approach. Both require the same discipline: write tests first, implement one case at a time, verify after each case.

For text justification, the key decomposition is: solve the easy cases first (single-word lines, last lines), then handle the general case (multiple words, even spacing with remainder distribution). The remainder distribution is where most candidates make mistakes: `extraSpaces = totalSpaces % gaps` gives the number of gaps that get one extra space, and it is the leftmost gaps that get them.

For wildcard matching, implement the naive recursive solution first (exponential time), verify it is correct, then add memoization to get O(nm) time. Only then optimize to the two-row approach. This sequence ensures you have a reference implementation to validate against and builds confidence that your optimization is correct.

### Senior @ FAANG: Production-Grade Versions of These Problems

Text justification at production scale is a text layout engine, used in typesetting systems (LaTeX, PDF rendering), e-readers, and terminal emulators. Production implementations must handle: Unicode bidirectional text (right-to-left languages), ligatures and kerning, hyphenation, and minimum raggedness optimization using dynamic programming rather than greedy line breaking. The TeX paragraph layout algorithm uses DP to minimize total "badness" across all line breaks simultaneously, which produces better output than greedy justification at the cost of O(n squared) preprocessing per paragraph.

Wildcard matching is a simplified form of regular expression matching. The O(nm) DP solution is correct for simple wildcards but does not generalize to full regex. For production regex, Go's `regexp` package implements the RE2 algorithm, which converts the regex to a finite automaton and simulates it in O(nm) time with the linear time guarantee. The space-optimized two-row DP approach shown here is the standard interview implementation but should not be used in production when a regular expression library is available: it does not support lookaheads, backreferences, or Unicode property classes, and any custom implementation of these features is likely to introduce security vulnerabilities.

The wildcard matching DP table has a natural parallelization: the cells along each anti-diagonal depend only on earlier diagonals and can be computed in parallel. This observation underlies parallel string matching algorithms used in bioinformatics for DNA sequence alignment, where aligning long sequences efficiently requires distributing the DP table computation across a GPU or cluster.

---
