## Scaling Strategy

Scaling a music streaming platform requires a different approach for each component because their access patterns vary dramatically. Audio delivery is read-heavy and latency-sensitive, so CDN caching is the primary scaling lever. Search needs fast index lookups across hundreds of millions of documents. Recommendations require massive batch computation but can tolerate staleness. The summary below shows how each layer scales independently to meet its specific demands.

```
S3: 80M songs x 4 qualities = 4.5PB, ~7.8B segment objects, Glacier for cold tracks
CDN: Top 1% = 80% streams, ~95% hit rate, 100+ edge cities, pre-warm new releases
Elasticsearch: ~30 nodes, 80M tracks, 46K QPS, <50ms P99, edge n-gram for typeahead
Recommendations: 100-node Spark nightly, 600M user vectors (300GB Redis), ANN via Annoy/FAISS <10ms
Play Events: 5B/day on Kafka (256 partitions), consumers: royalty calc, recs, analytics
```

The S3 storage tier uses lifecycle policies to move tracks that have not been played in 90 days to Glacier Instant Retrieval, which is roughly 80% cheaper per GB-month than S3 Standard while still serving reads in milliseconds. Watch the retrieval fee, though: Glacier Instant charges per GB retrieved where Standard does not, so a track that turns out to be less cold than the policy assumed can cost more in the cheap tier than it did in the expensive one. The 90-day threshold is a bet that anything untouched that long stays untouched.

New releases from major artists are pre-warmed on the CDN (pushed to all 100+ edge cities) on release day to avoid a stampede of origin-fetch cache misses. The Elasticsearch cluster shards the track index and keeps replicas of each shard, which is what spreads 46K searches/sec across nodes instead of hot-spotting one. The edge n-gram tokenizer pre-computes prefix matches at index time so typeahead queries hit the inverted index directly instead of running regex scans.

The recommendation pipeline is the most computationally expensive component but tolerates staleness well. Nightly taste vectors are enough, because music preference moves over weeks and nobody notices that today's Discover shelf was computed at 3am. That tolerance is what allows the whole model to live in a batch job instead of on the request path. The 600M user vectors hold 128 dimensions each, stored as float32 rather than the float64 the sample code uses: at serving time the extra precision buys nothing against an approximate index, and halving the width takes the working set from roughly 600GB to roughly 300GB in Redis, split across a cluster. The Annoy index is rebuilt nightly alongside the vectors and replicated to serving nodes. Kafka handles 5 billion play events per day across 256 partitions, with three independent consumer groups: royalty calculation (financial accuracy), recommendation feature extraction (ML training data), and real-time analytics dashboards.

---
