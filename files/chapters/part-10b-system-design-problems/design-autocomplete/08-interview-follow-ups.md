## Interview Follow-Ups

These are the three most commonly asked follow-up questions in autocomplete interviews. They test whether you have thought beyond the happy path into scale, freshness, and safety.

**Q: How do you handle billions of unique search queries?**

Raw search logs contain billions of unique queries, but most are one-off misspellings or nonsensical strings. The key insight is aggressive pruning: only keep terms with a count greater than or equal to a threshold (for example, 5 or more searches). This reduces 50 billion raw queries to approximately 50 million meaningful terms, which fits comfortably in a 15GB in-memory trie. A nightly batch job prunes terms that have decayed below the threshold. Long-tail queries that fall below the threshold are not shown in autocomplete but still work in full-text search, so no user-facing functionality is lost.

**Q: How do you update the trie when a query becomes trending?**

Search events flow from the Search Service into Kafka at the rate of the incoming queries. Flink consumes these events in sliding 1-minute windows and compares the current-minute count for each term against its rolling hourly average. When a term's velocity exceeds 2x its baseline (for example, 500 searches per minute versus a historical average of 200), Flink pushes it to a "trending boost" Redis set. The autocomplete service checks this set on each request and applies a score multiplier to trending terms. The boost decays exponentially over time so that a briefly viral term does not permanently dominate suggestions.

**Q: How do you prevent offensive/spam suggestions?**

A three-layer defense: (1) An in-memory blocklist of banned terms provides O(1) filtering at serve time, blocked terms never appear in suggestions regardless of their frequency. (2) An ML classifier scores incoming search events during ingestion. Terms flagged as offensive (score above 0.8) are excluded from frequency counting, which prevents them from ever entering the trie. (3) A human review queue handles borderline cases (score between 0.5 and 0.8), where a content moderator makes the final decision. The blocklist can be updated without redeploying code via an admin API, so new offensive terms can be suppressed within minutes of discovery.

---
