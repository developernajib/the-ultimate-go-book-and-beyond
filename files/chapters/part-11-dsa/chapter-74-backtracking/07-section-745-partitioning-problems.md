## 74.5 Partitioning Problems

### Palindrome Partitioning

Palindrome partitioning explores all ways to split a string into substrings, pruning any branch where the current prefix is not a palindrome. At each position, every suffix of the remaining string is tried as the next partition element, and only palindromes pass the constraint check before recursing deeper.

```go
// Partition finds all palindrome partitions
// LeetCode 131: Palindrome Partitioning
// Time: O(n * 2^n). A string of n identical characters has 2^(n-1)
// partitions, every one of them valid, and each costs O(n) to copy out.
// Space: O(n^2) for the isPalin table, plus O(n) recursion depth,
// not counting the output itself.
func Partition(s string) [][]string {
    result := [][]string{}
    n := len(s)

    // Precompute palindrome table
    isPalin := make([][]bool, n)
    for i := range isPalin {
        isPalin[i] = make([]bool, n)
    }

    for i := n - 1; i >= 0; i-- {
        for j := i; j < n; j++ {
            if s[i] == s[j] && (j-i < 2 || isPalin[i+1][j-1]) {
                isPalin[i][j] = true
            }
        }
    }

    var backtrack func(start int, path []string)
    backtrack = func(start int, path []string) {
        if start == n {
            part := make([]string, len(path))
            copy(part, path)
            result = append(result, part)
            return
        }

        for end := start; end < n; end++ {
            if isPalin[start][end] {
                path = append(path, s[start:end+1])
                backtrack(end+1, path)
                path = path[:len(path)-1]
            }
        }
    }

    backtrack(0, []string{})
    return result
}
```

### Word Break II

Unlike the DP boolean version, Word Break II must enumerate every valid sentence, making pure backtracking unavoidable. But without memoization its worst-case cost is exponential. The key insight is that the set of valid sentences starting at any given index is fixed regardless of how we arrived there, so `memo[start]` caches the list of completions for each suffix. When the same suffix is revisited, the cached slice is returned immediately instead of re-expanding the entire subtree.

```go
// WordBreak finds all word break combinations
// LeetCode 140: Word Break II
func WordBreak(s string, wordDict []string) []string {
    wordSet := make(map[string]bool)
    for _, word := range wordDict {
        wordSet[word] = true
    }

    memo := make(map[int][]string)

    var backtrack func(start int) []string
    backtrack = func(start int) []string {
        if start == len(s) {
            return []string{""}
        }

        if result, ok := memo[start]; ok {
            return result
        }

        result := []string{}
        for end := start + 1; end <= len(s); end++ {
            word := s[start:end]
            if wordSet[word] {
                suffixes := backtrack(end)
                for _, suffix := range suffixes {
                    if suffix == "" {
                        result = append(result, word)
                    } else {
                        result = append(result, word+" "+suffix)
                    }
                }
            }
        }

        memo[start] = result
        return result
    }

    return backtrack(0)
}
```

### Junior → FAANG: Partitioning as Constrained Segmentation

Palindrome partitioning and word break II represent the two ends of the partitioning spectrum. In palindrome partitioning, the constraint (each segment must be a palindrome) is checked via a precomputed 2D boolean table, which is the correct approach for interviews because it avoids O(n) per-segment checks. Without precomputation, each palindrome check costs O(k) for a segment of length k, pushing the total to O(n^2 * 2^n) instead of O(n^2 + n * 2^n). Note that the enumeration is exponential either way. Precomputing does not rescue the complexity class, it removes a factor of n from inside it, and the exponential is irreducible because the output itself is exponential: `"aaaa"` has 8 valid partitions and n identical characters have 2^(n-1).

The precomputed `isPalin` table uses an interesting iteration order: it fills from the bottom-right corner upward and leftward, because `isPalin[i][j]` depends on `isPalin[i+1][j-1]`. Alternatively, you can precompute by expanding around each center (the expand-around-center approach), which is O(n^2) time and O(n^2) space. Both are correct interview approaches.

Word Break II is the harder variant because it must return all sentences, not just check existence. The `memo[start]` cache stores the list of valid sentences starting from index `start`, avoiding recomputation of the same suffix. Without memoization, the worst case is exponential: a string like "aaaa...a" with a dictionary containing "a", "aa", "aaa" has exponentially many valid segmentations and would be recomputed many times without caching.

### Senior @ FAANG: Partitioning in Compiler and Text Processing Pipelines

Palindromic structure matters in computational biology, where reverse-complement palindromes mark restriction enzyme recognition sites. The minimum-cut variant (LeetCode 132) is the one with production relevance, and it is worth stating precisely: minimizing cuts is exactly minimizing the number of segments, since k segments require k-1 cuts. It is not "maximizing segment length," which is not even well defined for a partition where the lengths must sum to n. That same minimize-the-number-of-pieces shape, with a different validity predicate and a different cost, is what text layout engines solve when breaking a paragraph into lines.

Word Break II with memoization is the production pattern for sentence segmentation in NLP. The `memo` map stores the complete list of sentences for each suffix, which can be very large (exponential in the worst case) and should be memory-bounded in production. A practical mitigation is to limit the depth of memoized results: if the number of valid sentences for a suffix exceeds a threshold (say, 10,000), cap the result and surface a "too many results" error to the caller. This prevents memory exhaustion on adversarial inputs (strings with exponentially many valid segmentations) while preserving useful behavior for typical inputs.

The production design for a word segmentation system also requires handling the case where the dictionary itself is dynamic (words are added and removed by editors). Dynamic dictionary updates invalidate cached memoization results that depended on words that were removed. A complete production system invalidates affected cache entries on dictionary updates, either eagerly (clear all cached entries for suffixes that contained the removed word) or lazily (include a version number in cache keys and invalidate on version mismatch).

### Junior → FAANG: Palindrome Partitioning as a Precomputation Template

The palindrome partitioning problem introduces a production habit that applies broadly: precompute expensive checks before the backtracking loop, not inside it. The `isPalin` table takes O(n^2) time and space to build, but each lookup during backtracking is O(1). Without precomputation, each palindrome check during backtracking costs O(k) for a substring of length k, and the total becomes O(n^2 * 2^n) instead of O(n^2 + n * 2^n).

The precomputation pattern: before writing the backtrack function, identify any check that will be called repeatedly on the same inputs and precompute it into a table. For palindrome partitioning, the check is `isPalindrome(s, i, j)`. For word break, the check is `wordSet[s[j:i]]` (already O(1) via hash map). For N-Queens, the check is `isConflict(row, col, placed)` (O(1) via hash maps or bitsets). The rule: if a check is called more than once on the same input during the search, precompute it.

The `isPalin` table iteration order (bottom-right to top-left, filling by decreasing `i` and increasing `j`) is determined by the dependency: `isPalin[i][j]` requires `isPalin[i+1][j-1]`. Whenever you derive a 2D DP table, draw the dependency arrow and use it to determine the fill order. This habit prevents the subtle bug of reading `isPalin[i+1][j-1]` before it has been computed.

### Senior @ FAANG: Memoized Backtracking in Content Generation Systems

Word Break II with memoization is the pattern for NLP content generation where the output space is exponential but the search must be bounded. In dialogue systems, generating all valid sentence completions for a partial utterance uses the same structure: the suffix `memo` maps to a list of completions, and the search backtracks when a completion is invalid (does not match a grammar rule). The memoization prevents re-expanding the same suffix subtree when it appears in multiple paths through the partial utterance.

The memory bound for Word Break II memoization is the sum over all suffixes of the number of valid sentences starting from that suffix. In adversarial inputs (strings with exponentially many valid segmentations), this can be exponential in n. Production systems that expose word break to external input must either cap the number of results returned per suffix (returning at most k sentences per suffix, discarding the rest) or cap the total number of results returned globally. Both caps should be configurable and monitored. Alerting on requests that hit the cap is important: it indicates either an adversarial input or an unusual input pattern that may need special handling in the application layer.
