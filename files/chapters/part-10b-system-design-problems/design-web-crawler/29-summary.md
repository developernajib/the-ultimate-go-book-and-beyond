## Summary

The table below maps each component of the web crawler to the specific technology choice and its purpose. This serves as a quick reference for understanding the full system at a glance. In an interview, being able to articulate why each technology was chosen (for example, why Kafka instead of RabbitMQ for the frontier, or why a Bloom filter sits in front of the Redis seen-set rather than replacing it) demonstrates depth of understanding.

| Component | Technology | Purpose |
|-----------|-----------|---------|
| URL frontier | Kafka (partitioned by domain) | Priority queue at scale |
| URL dedup | Bloom filter (12GB, in worker RAM) + Redis seen-set (~1TB) | Skip seen URLs |
| Content dedup | SimHash + banding index | Near-duplicate detection |
| Politeness | Domain rate limiter (1 req/sec) | Avoid overloading sites |
| Robots.txt | In-memory cache, 24h TTL | Respect crawl rules (RFC 9309) |
| Workers | 200 machines x 50 goroutines | 10K pages/sec |
| HTML parsing | goquery | Link + text extraction |
| Storage | S3 (raw) + PostgreSQL (metadata) | Content + state |
| Recrawl scheduling | Adaptive (EWMA change rate) | Fresh index |

If one idea from this chapter survives the interview, make it this: **the crawler's throughput is a property of its politeness, not a constraint on it.** You do not reach 10K pages per second despite the 1 req/sec limit, you reach it by crawling 10,000 domains at once, and every structural decision follows from that. Kafka is partitioned by domain because a domain must have exactly one owner. The rate limiter can live in local memory only because that partitioning holds. The partition count, not the worker count, is what caps throughput. And the parts that are easiest to get wrong, the robots.txt precedence rules, the empty `Disallow:`, the 5xx-means-stop rule, are the parts that fail silently and in the direction of crawling more than you were allowed to. A crawler that is subtly wrong looks exactly like a crawler that works, right up until the bans arrive.


---
