## Capacity Estimation

Before diving into architecture, you need to understand the scale of the problem. These back-of-the-envelope calculations help you choose the right storage technologies, determine how many servers you need, and identify the hardest bottlenecks. In an interview, showing these numbers early proves you think about feasibility before jumping to design.

```
Pages indexed:      50B pages × 100KB avg = 5PB raw content
Inverted index:     ~20% of raw = 1PB
Queries/day:        8.5B → ~100K QPS average, 2-3x that at peak
Query latency:      < 200ms P99
Crawl rate:         Need to recrawl every 2 weeks
                    50B / (14 × 86400) = 41K pages/sec
Index updates:      ~1B new/changed pages/day
```

The inverted index is roughly 20% of the raw content size because it stores only terms, document IDs, and positions, not the full page text. Even at 1PB, this index must be sharded across roughly 1,000 servers (1TB per shard), each serving a subset of the full document space. The 100K QPS figure is the daily average (8.5 billion divided by 86,400 seconds), so the serving tier must be provisioned for two to three times that, and breaking news events can spike query volume further still.

The crawl rate of 41K pages per second is necessary to keep the index fresh (re-crawling the entire web every two weeks). In practice, not all pages need the same refresh frequency: news sites might be re-crawled every hour, while stable reference pages need it only monthly. The 1 billion new or changed pages per day feed into the delta index, which is compacted into the main index periodically. This is the pipeline that keeps search results fresh without rebuilding the entire 1PB index from scratch.

---
