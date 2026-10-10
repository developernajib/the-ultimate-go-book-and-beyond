## Interview Scoring Rubric

This rubric reflects what interviewers expect at each engineering level. Use it to calibrate how deep to go during your preparation. An L4 candidate should cover the core data structure and basic serving. L5 candidates must demonstrate understanding of distributed caching, real-time updates, and scaling. L6 candidates need to show mastery of probabilistic techniques, operational safety, and the full data pipeline.

### L4, Expected
- Trie data structure for prefix matching
- Basic search with traversal
- Single server, mentions caching
- Returns top-N results sorted by some score

### L5, Strong Hire
- Trie with cached top-K at each node (avoids O(N) traversal)
- Redis for distributed caching with appropriate TTLs
- Frequency counting from search events via a streaming pipeline
- Tiered caching: memory for short prefixes, Redis for medium, on-demand for long
- Personalization with user history blended into global results
- Horizontal scaling via prefix sharding with deterministic routing

### L6, Exceptional
- All L5 plus:
- Sampled counting at high QPS (law of large numbers, 10% sample rate)
- Trending detection with velocity scoring (current-minute count versus hourly average)
- Score formula: log10(freq) + recency decay with exponential falloff
- Multi-language support including CJK character-level n-grams
- Content filtering pipeline: blocklist, pattern match, and ML classifier
- Graceful degradation with a three-layer fallback chain (trie, Redis, static cache)
- Full data pipeline: Kafka events, Flink aggregation windows, Redis frequency store, trie rebuild
- CDN caching for single-character prefixes achieving approximately 60% hit rate
- Trie health check: reject rebuild if term count drops more than 10% or baseline queries return empty

---
