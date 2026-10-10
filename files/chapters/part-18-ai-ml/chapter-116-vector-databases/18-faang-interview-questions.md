## 116.17 FAANG Interview Questions

**Q: Design a semantic search system over 500 million documents with p95 latency under 100 milliseconds.**

A: Use an approximate nearest neighbor index (HNSW or IVF-PQ) sharded by hash of the document ID so each shard holds a manageable working set. Put a routing layer in front that fans a query to all shards, merges top-k from each, and returns the global top-k. Cache hot queries by prompt embedding similarity. Separate the write path (ingestion, embedding, index build) from the read path, and rebuild indexes in the background to avoid write amplification on search nodes. Budget the latency: embedding, routing, shard search, merge, and re-ranking each get a slice.

**Q: Compare pgvector, Pinecone, Weaviate, and Milvus for a FAANG-scale RAG workload.**

A: pgvector is ideal when you already run Postgres and your corpus fits on a few large instances: transactional updates, simple ops, but weaker at very high recall and very high QPS. Pinecone is the easy choice for managed hosting with strong recall at high QPS, at a cost premium and vendor lock-in. Weaviate is strong when you want hybrid search (vector plus keyword) and module integrations out of the box. Milvus is the pick for massive self-hosted deployments with heterogeneous indexes and GPU acceleration. Benchmark on your data, your query shape, and your latency targets before deciding.

**Q: How do you keep a vector index consistent with a source-of-truth document store?**

A: Make the write path transactional at the logical level. Write the document to the primary store, emit a change event (CDC or outbox pattern), and have an ingestion worker pick it up, compute embeddings, and upsert into the vector index. Use an idempotent upsert keyed by document ID and version. Periodically reconcile by scanning the primary store and comparing versions to what is in the vector index, then repairing drift. Never trust eventual consistency to handle deletes. Propagate tombstones explicitly.

**Q: Your RAG system returns irrelevant passages. Walk through your debugging process.**

A: Start with eval data. Build a set of query-to-expected-passage pairs. Compute recall at k to localize the problem. If recall is low, the issue is retrieval: check chunking granularity, embedding model quality, and whether hybrid BM25 plus vector search would help. If recall is acceptable but the LLM picks the wrong passage, the issue is re-ranking: add a cross-encoder re-ranker and tune its k. If the model hallucinates despite correct retrieval, tighten the prompt with a grounding instruction, require citations, and lower temperature.

**Q: How would you design a vector database platform that multiple product teams share?**

A: Multi-tenancy at the namespace level with hard quotas on QPS, index size, and embedding model. Each team owns their namespace, schema, and embedding model choice through a declarative config. The platform owns the control plane (provisioning, upgrades, backups), the data plane (HNSW nodes, sharding), and a common SDK that handles embedding, retries, observability, and PII scrubbing. Charge teams back on storage and QPS to align incentives. Provide a shared eval harness so teams can regress their retrieval quality before shipping changes.

### Junior → FAANG: Mastering the Semantic Search System Design Question

The 500 million document semantic search system design question is the canonical vector search interview question. Prepare a 10-minute answer that covers: the ingestion pipeline (how documents flow from the source to the vector index), the index design (which vector database, which index algorithm, what shard count), the serving architecture (how queries are processed and results assembled), the quality assurance mechanism (how retrieval quality is measured and maintained), and the operational model (how failures are handled and what the on-call procedure is). Having a complete answer for all five areas is what passes this question at the senior level.

Pay particular attention to the numbers in the question: 500 million documents and P95 under 100 milliseconds. These constraints drive specific architectural decisions. At 500 million documents with 1536-dimensional float32 embeddings, the raw vector data is 3 TB. No single machine has 3 TB of RAM, so the index must be sharded. With P95 under 100 milliseconds, you have approximately 20-30 milliseconds for network overhead, leaving 70 milliseconds for the actual vector search. HNSW at those parameters can achieve this on well-provisioned hardware. Knowing these numbers and making them part of your answer demonstrates quantitative design thinking that FAANG interviewers look for.

### Senior @ FAANG: Bar-Raiser Questions in Vector Search

The multi-tenant platform question (how would you build a vector search platform for 50 teams?) is the highest-signal bar-raiser question in this set because it requires organizational thinking beyond individual system design. The expected answer at L6 covers: the shared data plane (HNSW cluster with tenant isolation via namespace), the self-service control plane (teams register their schemas and configure their indexes through a declarative API), the cost attribution model (teams are charged back for storage and QPS), and the quality assurance requirement (teams must pass the shared evaluation harness before their index goes live). This four-component answer demonstrates that you have thought about building infrastructure for multiple customers, not just for a single system.

The embedding model upgrade question (how do you migrate when the embedding model changes?) is a bar-raiser question that tests forward planning. The expected answer covers: the timeline (re-embedding 500 million documents at 1000 documents per second takes approximately 6 days), the dual-index strategy (run the old and new index in parallel during migration, route queries to the new index with automatic fallback to the old one), the validation step (compare quality metrics between old and new index on the evaluation harness before switching over), and the cost (re-embedding 500 million documents at $0.02 per million tokens for 200-token documents is approximately $2,000). The ability to produce this complete migration plan, with timeline and cost estimates, demonstrates the quantitative planning skills expected at L6 and above.

---
