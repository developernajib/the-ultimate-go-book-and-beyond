## Architecture Overview

The diagram below shows how all the components fit together in the crawl pipeline. URLs enter through the frontier, pass through the scheduler for politeness enforcement, get fetched by crawler workers, and then split into two parallel paths: link extraction (which feeds new URLs back into the frontier) and content processing (which sends parsed text to the search indexer). Notice that deduplication happens at two levels: URL dedup prevents re-fetching pages you have already visited, while content dedup catches mirror sites that serve identical content under different URLs.

```
┌─────────────────────────────────────────────────────────┐
│                   URL Frontier                          │
│  Priority Queue (Kafka partitioned by domain hash)      │
└──────────────────────┬──────────────────────────────────┘
                       │
            ┌──────────▼──────────┐
            │  Scheduler Service  │  (politeness enforcement)
            │  (1 req/sec/domain) │
            └──────────┬──────────┘
                       │
         ┌─────────────▼──────────────────┐
         │        Crawler Workers         │
         │  (200 workers x 50 goroutines) │
         └──────────┬─────────────────────┘
                    │
     ┌──────────────┴────────────────┐
     ▼                               ▼
URL Extractor                   Content Processor
(Link discovery)                (HTML parse, text extract)
     │                               │
     ▼                               ▼
URL Deduplicator               Content Deduplicator
(Bloom filter + Redis)          (SimHash fingerprint)
     │                               │
     ▼                               ▼
URL Frontier                    Index Pipeline
(if new URL)                    (Kafka → Indexer)
```

---
