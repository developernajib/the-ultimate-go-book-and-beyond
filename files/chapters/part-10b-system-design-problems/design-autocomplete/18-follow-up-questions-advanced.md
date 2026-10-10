## Follow-up Questions, Advanced

These questions probe edge cases and advanced topics that separate strong answers from exceptional ones. Having concise answers ready for even two or three of these demonstrates deep familiarity with the problem space.

**Q: How do you handle typo correction?**
Edit distance: search prefixes within Levenshtein distance 1 (swap, insert, delete one character). This is computationally expensive at query time because it multiplies the search space by roughly 26x per edit. The practical approach is to precompute edit-distance-1 variants for the top 100K most popular prefixes and store them as aliases in the trie. For less common prefixes, phonetic matching (Soundex or Metaphone) provides a cheaper alternative that catches sound-alike misspellings such as "kubernetis" matching "kubernetes." Note that phonetic matching does not catch fat-finger typos like "golanf", those need the edit-distance path.

**Q: How do you handle multi-word queries?**
The trie treats the full query as a single string with spaces included, so "how to" and "how to learn" are different prefixes with their own top-K caches. This works well for short multi-word queries. For long prefixes (more than 6 characters), the system falls back to on-demand prefix queries against the term frequency store, because the number of distinct prefixes to precompute balloons with length and long prefixes are queried infrequently enough that the added latency is acceptable.

**Q: How would you A/B test ranking algorithms?**
Route 5% of traffic to the variant using consistent hashing on user_id (so a given user always sees the same variant within a session). Compare four metrics: click-through rate on suggestions, average position of the clicked suggestion, time from first keystroke to final search submission, and abandonment rate (typed but never searched). Run for at least 2 weeks to capture weekly patterns. Statistical significance requires at least 10,000 users per variant.

**Q: What happens when a major event breaks?**
The normal pipeline has approximately 10-minute latency from search event to trie inclusion. For breaking news, the trending detector provides a fast path: when it detects a 2x velocity spike for a term, it pushes the term directly to the serving layer via a Redis "trending boost" set, bypassing the batch trie rebuild. Fast path latency is approximately 30 seconds. The trade-off is that fast-path terms may include noise (short-lived spikes that fade within minutes), which is why the boost decays automatically.


---
