## Interview Questions: Ranking and Query Understanding

**Q: Explain BM25 and why it outperforms TF-IDF.**

A: BM25 adds two key improvements over TF-IDF: (1) Term frequency saturation - `k1` controls how much additional occurrences of a term improve the score. In TF-IDF, 100 occurrences is 100× better than 1, but in BM25, the benefit saturates. (2) Document length normalization - `b` penalizes longer documents so that a term in a short document scores higher than the same term in a verbose document.

**Q: How do you build autocomplete that handles typos?**

A: Combine a prefix trie for exact-prefix matching with Levenshtein/edit distance fuzzy search. For production scale: (1) Indexed trigrams for typo tolerance - `"hello"` → `["hel", "ell", "llo"]` - then find docs sharing ≥2 trigrams. (2) Elasticsearch `fuzzy` or `match` with `fuzziness: AUTO`. (3) Record user query clickthrough to score suggestions by popularity. The trie handles real-time suggestions, and trigrams handle typo correction.

**Q: How do you measure search quality?**

A: NDCG (Normalized DCG) is the primary metric - it accounts for graded relevance and rank position. MRR (Mean Reciprocal Rank) measures how quickly the first relevant result appears. Collect human relevance judgments (0-2 scale) for a set of test queries, run your ranker, and compute NDCG@10. For online evaluation, use A/B testing with click-through rate and session success rate as proxies.
