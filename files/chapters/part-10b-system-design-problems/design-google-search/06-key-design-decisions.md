## Key Design Decisions

Each decision below addresses a specific scalability or quality challenge. Understanding the alternatives and trade-offs for each one is what separates a solid design from a superficial one.

**Index Sharding:** The index is partitioned by URL hash (document-based sharding), not by term. Each shard holds roughly 1/1000th of the index (50M pages). Every query fans out to all shards in parallel, each shard returns its top-100 results, and the coordinator merges them into a final ranked list. This "scatter-gather" pattern is preferred over term-based sharding because term-based sharding requires cross-shard joins for multi-word queries. The downside of document-based sharding is that every query touches every shard, but the consistent per-shard workload and embarrassingly parallel execution make this manageable.

**Two-Phase Ranking:** Phase 1 runs in each shard: a fast BM25 retrieval scans the inverted index and returns the top-100 candidate documents per shard. Phase 2 runs on a central coordinator: an ML model re-ranks the merged candidates (up to 100K from 1000 shards) using richer signals, PageRank, content freshness, click-through rate, dwell time, and personalization features. This separation is essential because running the full ML model on every document in every shard would be prohibitively expensive. Phase 1 maximizes recall (find all potentially relevant documents). Phase 2 maximizes precision (rank the best ones to the top).

**Inverted Index Format:** Each term maps to a posting list (sorted list of document IDs containing that term, along with position and frequency data). Document IDs are delta-encoded and compressed with VByte encoding, reducing storage by 4-5x compared to raw 64-bit IDs. Skip pointers (every 128th entry) enable efficient intersection of long posting lists for multi-term queries. The index is stored as immutable SSTable segments, similar to LevelDB/RocksDB, which allows lock-free reads and efficient merge-based compaction.

**Real-time Updates:** A separate "delta index" holds recently crawled pages (last 24 hours). Queries search both the main index and the delta index, merging results. The delta index is much smaller (millions of pages vs billions), so it can be rebuilt and updated quickly. Periodically (every few hours), the delta index is compacted into the main index using a merge operation similar to LSM tree compaction. This gives near-real-time freshness for breaking news without the cost of continuously rebuilding the entire main index.

---
