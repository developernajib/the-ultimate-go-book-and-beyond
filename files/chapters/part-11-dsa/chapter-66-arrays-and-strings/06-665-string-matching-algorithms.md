## 66.5 String Matching Algorithms

### KMP Algorithm

The Knuth-Morris-Pratt algorithm avoids redundant character comparisons by precomputing a failure function (the LPS, or Longest Proper Prefix which is also Suffix, array) that tells the matcher how far to fall back in the pattern after a mismatch rather than restarting from the beginning. This preprocessing step runs in O(m) time, and the main search over the text runs in O(n), giving an overall O(n+m) guarantee regardless of input characteristics.

```go
// KMP (Knuth-Morris-Pratt) Pattern Matching
// Time: O(n+m), Space: O(m)
func kmpSearch(text, pattern string) []int {
    if len(pattern) == 0 {
        return []int{0}
    }

    // Build failure function (partial match table)
    lps := buildLPS(pattern)
    result := []int{}

    i, j := 0, 0 // i for text, j for pattern
    for i < len(text) {
        if text[i] == pattern[j] {
            i++
            j++
            if j == len(pattern) {
                result = append(result, i-j)
                j = lps[j-1]
            }
        } else {
            if j != 0 {
                j = lps[j-1]
            } else {
                i++
            }
        }
    }
    return result
}

// Build Longest Proper Prefix which is also Suffix
func buildLPS(pattern string) []int {
    lps := make([]int, len(pattern))
    length := 0
    i := 1

    for i < len(pattern) {
        if pattern[i] == pattern[length] {
            length++
            lps[i] = length
            i++
        } else {
            if length != 0 {
                length = lps[length-1]
            } else {
                lps[i] = 0
                i++
            }
        }
    }
    return lps
}

// Implement strStr() (LeetCode 28) using KMP
func strStr(haystack string, needle string) int {
    if len(needle) == 0 {
        return 0
    }

    matches := kmpSearch(haystack, needle)
    if len(matches) > 0 {
        return matches[0]
    }
    return -1
}
```

### Rabin-Karp Algorithm

Rabin-Karp uses a rolling hash to compare the pattern against each window of the text in O(1) time instead of O(m), sliding the hash forward by subtracting the outgoing character and adding the incoming one. When a hash collision occurs the algorithm falls back to a character-by-character verification, which keeps correctness intact at the cost of O(nm) in the degenerate worst case while achieving O(n+m) on average.

```go
// Rabin-Karp using rolling hash
// Time: O(n+m) average, O(nm) worst case
// Space: O(1)
func rabinKarp(text, pattern string) []int {
    if len(pattern) > len(text) {
        return nil
    }

    const base = 256
    const mod = 101 // Prime number

    result := []int{}
    m := len(pattern)
    n := len(text)

    // Calculate h = base^(m-1) % mod
    h := 1
    for i := 0; i < m-1; i++ {
        h = (h * base) % mod
    }

    // Calculate initial hashes
    patternHash := 0
    textHash := 0
    for i := 0; i < m; i++ {
        patternHash = (base*patternHash + int(pattern[i])) % mod
        textHash = (base*textHash + int(text[i])) % mod
    }

    // Slide pattern over text
    for i := 0; i <= n-m; i++ {
        if patternHash == textHash {
            // Verify match (handle hash collision)
            if text[i:i+m] == pattern {
                result = append(result, i)
            }
        }

        // Calculate hash for next window
        if i < n-m {
            textHash = (base*(textHash-int(text[i])*h) + int(text[i+m])) % mod
            if textHash < 0 {
                textHash += mod
            }
        }
    }
    return result
}
```

### Z-Algorithm

The Z-algorithm constructs a Z-array where Z[i] holds the length of the longest substring starting at position i that matches a prefix of the combined string. By concatenating the pattern, a sentinel character, and the text before building this array, every position in the text where Z[i] equals the pattern length marks an exact match, all in O(n+m) time and space.

```go
// Z-Algorithm: Find all occurrences of pattern in text
// Z[i] = length of longest substring starting at i that matches prefix
// Time: O(n+m), Space: O(n+m)
func zAlgorithm(text, pattern string) []int {
    // Concatenate: pattern + "$" + text
    concat := pattern + "$" + text
    n := len(concat)

    z := make([]int, n)
    left, right := 0, 0

    for i := 1; i < n; i++ {
        if i < right {
            z[i] = min(right-i, z[i-left])
        }

        for i+z[i] < n && concat[z[i]] == concat[i+z[i]] {
            z[i]++
        }

        if i+z[i] > right {
            left, right = i, i+z[i]
        }
    }

    // Find pattern matches
    result := []int{}
    patternLen := len(pattern)
    for i := patternLen + 1; i < n; i++ {
        if z[i] == patternLen {
            result = append(result, i-patternLen-1)
        }
    }
    return result
}
```

### Junior → FAANG: Knowing Which Algorithm to Reach For

In interviews, you are unlikely to be asked to implement KMP from scratch without access to references. What you are expected to know is: why is naive string search O(nm), why can we do better, and what guarantee does KMP provide? The answer is that KMP avoids backtracking in the text by using the failure function to skip ahead in the pattern, giving O(n+m) guaranteed. You should be able to explain the failure function concept (the LPS array encodes how far to fall back in the pattern after a mismatch) even if you cannot implement it under pressure.

For interviews that do ask for implementation, use KMP. Rabin-Karp is acceptable as an alternative approach to discuss but has a worse worst-case. Z-algorithm is less commonly expected in interviews but demonstrates deeper string algorithm knowledge if presented correctly.

Go's `strings.Index` uses `IndexByte`-accelerated brute force for short patterns and switches to Rabin-Karp mid-search when it detects too many false starts, which is why it outperforms a naive search even though the standard library does not expose KMP or Rabin-Karp as public API. Knowing this is a signal of production Go expertise.

### Senior @ FAANG: String Matching in Production Text Processing

Production string matching is significantly more complex than textbook algorithms. The choice of algorithm depends on the pattern length, text length, alphabet size, number of matches expected, and whether patterns change between searches.

For a single fixed pattern over large text (log file search, content filtering), Aho-Corasick is the production choice when there are multiple patterns. It builds a trie augmented with failure links (analogous to KMP's LPS array) and searches for all patterns simultaneously in O(n + sum of pattern lengths + number of matches). This is the algorithm underlying GNU grep's multi-pattern fixed-string mode, many intrusion detection systems, and content moderation filters.

For approximate matching (spell correction, DNA sequence alignment), edit distance algorithms and their variants (Smith-Waterman, Needleman-Wunsch) replace exact matching. The space-optimized two-row edit distance shown in the case studies section is the standard interview implementation, but production systems use SIMD-accelerated implementations in C with Go wrappers for the inner loop.

For the specific case of regular expression matching, Go's `regexp` package uses the RE2 algorithm, which guarantees O(nm) worst-case time with no backtracking, unlike PCRE-style engines that can exhibit catastrophic backtracking on pathological inputs. Understanding this distinction is critical when designing systems that process untrusted user-supplied patterns, because a PCRE engine exposed to adversarial patterns can be used to cause a denial-of-service attack (ReDoS). Go's RE2-based engine prevents this entire class of vulnerability.

---
