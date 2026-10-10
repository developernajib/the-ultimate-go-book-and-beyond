## Architecture Overview

This diagram shows the two major pipelines in a search engine. The query path (top) handles user searches in real time: it parses the query, fans out to index shards, ranks the results, and generates snippets, all within 200ms. The crawl path (bottom) runs continuously in the background, discovering new pages and feeding them into the index. Understanding this separation is key because the query path must be extremely fast, while the crawl path prioritizes throughput and completeness.

```
User Query
    │
    ▼
┌──────────────────────────────────────────────────┐
│              Query Processing Layer              │
│   Spell Check → Query Parsing → Query Expansion  │
└──────────────────────┬───────────────────────────┘
                       │
    ┌──────────────────┴────────────────────┐
    ▼                                       ▼
Index Servers                        Ranking Service
(Inverted index shards)              (PageRank + ML)
    │                                       │
    └─────────────────┬─────────────────────┘
                      ▼
              Result Aggregation
              (Merge + Deduplicate)
                      │
                      ▼
              Snippet Generation
              (Extract relevant text)
                      │
                      ▼
                Final Results

Separate Pipeline:
URL Frontier → Crawlers → Parser → Indexer → Index Shards
```

---
