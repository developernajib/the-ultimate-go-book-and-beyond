## Summary

This table maps every major component of the search engine to its implementation technology and performance target. Use it as a quick reference during interviews to confirm you have covered all the essential pieces. If your design is missing any row from this table, it likely has a significant gap.

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Web crawler | Distributed crawlers + Redis frontier | 41K pages/sec |
| URL dedup | Redis SET + content hash | Skip re-crawls |
| Inverted index | Custom SSTable shards (1000+) | Term → doc lookup |
| PageRank | Distributed graph computation | Link authority signal |
| Query processing | Scatter-gather (fan-out to shards) | < 200ms response |
| Ranking | BM25 + PageRank + ML model | Relevance scoring |
| Spell correction | Edit distance + corpus frequency | Query repair |
| Snippet generation | Dynamic excerpt extraction | Result display |
| Freshness | Hot delta index + merge | Near-real-time updates |


---
