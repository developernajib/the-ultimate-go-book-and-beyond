## Interview Scoring Rubric

This rubric shows what interviewers expect at different seniority levels. An L4 candidate should cover the basic pipeline, while L5 and L6 candidates need to discuss progressively more advanced topics like scoring algorithms, sharding strategies, and personalization. Use this as a checklist to gauge the depth of your design.

**L4 (Mid-Level), Meets Bar:** The candidate draws the basic pipeline: crawler discovers pages, indexer builds an inverted index, query engine searches the index and returns results. Mentions PageRank as a ranking signal. Understands what an inverted index is (term -> list of documents). Gaps at this level: no discussion of sharding strategy, no distinction between recall and ranking phases, no freshness mechanism.

**L5 (Senior), Strong Hire:** Explains BM25 scoring for text relevance and how it differs from raw term frequency. Designs the scatter-gather query pattern across sharded index servers. Implements polite crawling with per-domain rate limits and robots.txt compliance. Includes a delta index for real-time freshness. Adds spell correction and basic autocomplete. Discusses index compression (VByte, delta encoding) and why it matters at 1PB scale. Gaps at this level: does not distinguish document-based vs term-based sharding, no personalization, no anti-spam (TrustRank).

**L6 (Staff), Exceptional:** Everything from L5 plus: articulates why document-based sharding is preferred over term-based sharding (avoids cross-shard joins for multi-term queries). Implements TrustRank or similar link-graph anti-spam. Designs a full autocomplete system with trie-based prefix lookup. Adds personalization via user click/dwell-time signals fed into the ranking model. Implements tiered result caching (query cache + snippet cache). Discusses Knowledge Graph integration for structured answers. Covers multi-region index replication with Kafka-based fan-out.

---
