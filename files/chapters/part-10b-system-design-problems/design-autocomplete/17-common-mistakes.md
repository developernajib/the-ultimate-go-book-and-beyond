## Common Mistakes and How to Avoid Them

These are the errors interviewers see most often in autocomplete designs. Each one reflects a gap in understanding that can shift the evaluation from "hire" to "no hire."

1. **Full trie traversal per query**: Not caching top-K at each node means every query is O(N) instead of O(prefix_length). At 100K QPS, this makes the system orders of magnitude too slow. Always precompute and cache the top-K suggestions at every trie node.

2. **Ignoring the write path**: Many candidates design a clean serving layer but never explain how term frequencies are collected and updated. The Kafka-to-Flink-to-Redis pipeline is half the system. Without it, your trie has no data.

3. **No personalization**: Returning the same suggestions for all users misses a major product requirement. Users expect to see their own recent searches prominently. The implementation is straightforward: a Redis sorted set per user, blended with global results.

4. **Single-language assumption**: Chinese and Japanese have no spaces between words, and Korean spacing does not line up with search units, so word-boundary tokenization does not work for CJK. You need character-level n-grams. Mentioning this unprompted demonstrates awareness of internationalization challenges.

5. **No content filtering**: Serving offensive autocomplete suggestions is a reputational and legal risk. A layered filter (blocklist, pattern matching, ML classifier) must run both at ingestion time and at serve time.

6. **Rebuilding trie per request**: The trie must be precomputed and swapped atomically. Any design that rebuilds or re-queries the frequency store on each request will not meet latency requirements.

---
