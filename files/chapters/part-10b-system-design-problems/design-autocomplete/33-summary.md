## Summary

The table below maps each component in the autocomplete system to its technology choice and purpose. This gives you a quick reference for how all the pieces fit together, from the in-memory trie that handles the hot path to the Kafka-Flink pipeline that keeps term frequencies fresh.

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Trie (in-memory) | Go trie with top-K cache | L1 cache for hot prefixes |
| Prefix cache | Redis cluster | L2 cache for all prefixes |
| Term frequencies | PostgreSQL | Source of truth |
| Real-time updates | Kafka → Flink aggregator | Frequency counting |
| Trending detection | Redis sliding windows | Velocity-based boosting |
| Personalization | Redis sorted set per user | User history ranking |
| Scoring | log(freq) + recency decay | Relevance ranking |
| Serving SLA | < 20ms P99 (excl. network) | Fast enough for typing |


---
