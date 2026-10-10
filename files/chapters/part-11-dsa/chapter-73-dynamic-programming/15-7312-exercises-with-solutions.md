## 73.13 Exercises with Solutions

### Exercise 1: Word Break

The word break problem asks whether a string can be segmented into a sequence of dictionary words. A naive recursive approach revisits the same suffix repeatedly, so the DP solution defines `dp[i]` as true when `s[0:i]` is fully segmentable. For each position `i`, it scans all split points `j < i` and succeeds as soon as it finds a valid prefix (`dp[j] == true`) whose remaining suffix (`s[j:i]`) exists in the word set, turning an exponential search into an O(n²) scan.

```go
func wordBreak(s string, wordDict []string) bool {
    wordSet := make(map[string]bool)
    for _, w := range wordDict {
        wordSet[w] = true
    }

    dp := make([]bool, len(s)+1)
    dp[0] = true

    for i := 1; i <= len(s); i++ {
        for j := 0; j < i; j++ {
            if dp[j] && wordSet[s[j:i]] {
                dp[i] = true
                break
            }
        }
    }

    return dp[len(s)]
}
```

### Junior → FAANG: Word Break as a Template for Segmentation Problems

The word break solution demonstrates the canonical segmentation DP template: `dp[i]` means the first `i` characters are achievable, and for each `i` you scan all possible split points `j` to check whether `dp[j]` is true and `s[j:i]` is in the dictionary. This template applies directly to other segmentation problems: sentence segmentation in NLP, token segmentation in compilers, and IP address restoration.

The hash set for the dictionary (`map[string]bool`) is the correct data structure for this problem. A common mistake is to use a sorted slice with binary search, which is harder to implement correctly and provides no benefit when string hashing is O(k) for key length k. Another common mistake is to check `s[j:i]` against the dictionary using a linear scan, which is O(|dict|) per check instead of O(1).

A useful follow-up to practice: "return the list of all valid sentences" (LeetCode 140, Word Break II). This changes the problem from boolean to enumeration, requiring backtracking with memoization rather than pure DP. Knowing both variants and being able to describe the structural difference (boolean DP for existence, memoized backtracking for enumeration) is a signal of genuine depth.

### Senior @ FAANG: Word Segmentation in Production NLP Pipelines

Word break is the core of tokenization in natural language processing. A tokenizer must segment an unsegmented character stream (Chinese, Japanese, and Korean text has no word boundaries) into words, and the DP approach with a lexicon is the standard algorithm. Production tokenizers add several layers on top of the basic DP: multiple lexicons (common words, named entities, specialized domain terms), contextual scoring (a word's likelihood given its neighbors), and lattice pruning (eliminating low-probability paths before computing the full DP) to maintain acceptable latency on large input texts.

At scale, the dictionary lookup is not a hash map but a trie or Aho-Corasick automaton, which allows all dictionary words that are prefixes or substrings of the current position to be found in a single pass through the text rather than O(n) separate hash lookups. This reduces the overall complexity from O(n^2) hash lookups to O(n * L) where L is the length of the longest dictionary word, a significant improvement for long texts.

Staff engineers designing tokenization systems must also reason about the dictionary update pipeline: how are new words added to the lexicon without restarting the service, how is the trie or automaton rebuilt and hot-swapped in production, and how are lexicon-dependent DP results invalidated in any downstream cache when the lexicon changes.

### Junior → FAANG: Word Break as a Template Drill

Word break is the single best problem to use as a template drill because it combines two patterns: the segmentation DP outer loop (iterate `i` from 1 to n) and the split-point inner loop (iterate `j` from 0 to i-1). Both loops have clear purpose and clear termination, making the structure easy to reason about under interview pressure.

Practice this specific variant: "implement word break where the dictionary words have a maximum length `maxLen`." The only change is the inner loop bound: instead of iterating `j` from 0 to i-1, iterate from max(0, i-maxLen) to i-1. This single-line change represents a meaningful optimization (from O(n^2) to O(n * maxLen) inner iterations) that interviewers reward. Being able to make this modification in under 60 seconds demonstrates structural understanding, not memorization.

The hash set for dictionary lookup (`map[string]bool`) uses O(1) amortized lookup but O(k) time for hashing each key of length k. For very long dictionary words, the total hashing time dominates. In production, this is mitigated by the trie or Aho-Corasick automaton, which processes the input character by character rather than substring by substring.

### Senior @ FAANG: Word Segmentation in Multilingual and Domain-Specific NLP

Word break at scale is not a single algorithm but a pipeline that adapts to different languages and domains. For English text, a hash set of common English words with a maximum word length of 20-25 characters suffices. For Chinese text (no word boundaries in the written form), the lexicon must include multi-character words and the DP runs over characters rather than bytes. For domain-specific text (medical, legal, financial), the dictionary must include specialized vocabulary that is not in general-purpose lexicons.

The latency budget for word segmentation in production NLP pipelines is typically 1-5ms per sentence. For a standard sentence of 20-30 words (100-200 characters), the O(n^2) DP with hash lookup runs in well under 1ms. The bottleneck is usually the lexicon lookup, not the DP table fill. Staff engineers who instrument the per-step time distribution can identify whether the bottleneck is at the DP layer (indicating a state definition that can be simplified) or at the lookup layer (indicating that a trie or automaton would help).

---
