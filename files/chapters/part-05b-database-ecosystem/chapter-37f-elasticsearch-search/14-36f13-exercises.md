## 37F.13 Exercises

**Exercise 1: E-Commerce Search Engine**

Build a complete product search engine:
- Indexing pipeline: consume products from Kafka → enrich with category taxonomy → index to ES
- Search API: full-text + filters + facets + sorting + pagination
- Autocomplete: edge ngram with completion suggester
- Relevance tuning: function_score with A/B testing framework
- Analytics: track search queries, zero-result queries, click-through rates

Requirements: 10M products, < 50ms p99 search latency, 1000 concurrent users.

**Exercise 2: Log Analytics Platform**

Build an observability platform using Elasticsearch:
- Data streams with ILM (hot-warm-cold-delete)
- Structured log ingestion via custom Go log handler
- Kibana-compatible aggregations for dashboards
- Alert rules using percolator
- Anomaly detection with ML jobs

Requirements: 100K events/second ingestion, 90-day retention, < 2s dashboard refresh.

**Exercise 3: Semantic Product Recommendation**

Build a hybrid search system combining BM25 + vector search:
- Generate embeddings using sentence-transformers for product descriptions
- Store 1536-dim vectors in dense_vector fields
- Implement RRF hybrid search combining keyword + semantic results
- A/B test: compare pure BM25 vs hybrid vs pure vector search
- Evaluate using NDCG@10 metric on test queries

### Junior to FAANG: Doing These Exercises The Right Way

Exercises reward depth over breadth. Pick one and do it completely rather than partially attempting all three. A complete Exercise 1 demonstrates more signal than three half finished projects.

Prerequisite scaffolding before coding. Create a local Elasticsearch 9 cluster via Docker compose with one coordinating, one ingest, and three data nodes. Enable security (xpack.security.enabled is default now). Do not disable TLS. Most tutorials skip security and then production becomes confusing. Learn the real surface from day one.

Worked approach for Exercise 1. Start with a schema ADR. What is a product document? What fields are filtered, sorted, aggregated, retrieved? Draft the index template first, not the code. Then the ingestion pipeline. Validate with 1000 synthetic products before scaling to 10M. Measure at each step, indexing throughput, search latency at p50 and p99, index size on disk. A junior ships the code. A mid level engineer ships with measurements.

"Why did this fail" reflex. When autocomplete returns odd results, check the analyzer at index time versus query time. Asymmetric analyzers are the most common autocomplete bug. Use `GET _analyze` to see exactly what tokens a field produces.

Interview entry point. "Walk me through a search system you built." Juniors describe features. The L4 answer describes the schema decision, the shard sizing, the relevance evaluation method, and one thing that went wrong and how you caught it.

### Senior at FAANG: Staff Extensions for Each Exercise

Treat each exercise as the L4 baseline and add the staff extension as the L5 to L6 scope.

Staff extension one, zero downtime reindex pipeline via aliases. Add to Exercise 1. Build a reindex orchestrator that, creates `products_v2` from a new template, kicks off `_reindex` from `products_v1` with `slices: auto`, tracks task progress via the tasks API, diffs a sample of documents for parity, atomically swaps the `products` alias, keeps `v1` for 72 hours as rollback, then deletes. Add dual writes during the reindex window so the new index stays current. The deliverable is a runnable Go CLI plus a runbook. The staff signal is treating the reindex as a product with safety rails, not a one off script.

Staff extension two, search relevance evaluation harness with pytrec_eval. Add to Exercise 3. Curate 500 graded judgments (query, document, relevance grade from 0 to 3). Wrap your search service in a harness that runs all judgments and emits NDCG at 10, MRR, and precision at 5 per model variant. Gate every PR on a regression threshold. Store results in a time series store. Plot trends per model version. The extension deliverable is a CI job that blocks merge on relevance regression exceeding 2 percent. The staff signal is making relevance a first class engineering metric.

Staff extension three, semantic first search with ELSER plus rerank. Add to Exercise 3. Replace the lexical first retriever with an ELSER sparse encoder as the primary retriever. Add a cross encoder reranker (bge reranker v2 or cohere rerank v3) over the top 50 candidates. Compare against BM25 plus RRF baseline on the evaluation harness. Document query latency budget breakdown, ELSER retrieval 40 ms, rerank 80 ms, other 30 ms. Deploy the reranker as a sidecar service and benchmark batching. The staff signal is making explicit where ML latency goes and why.

ADR requirements for each extension. Every extension must produce an ADR with, context, decision, consequences, revisit trigger, rollback procedure. The ADR is graded as heavily as the code.

Governance output. Each extension must update, the index template registry, the shard budget document, the relevance evaluation baseline. If you produce code without updating governance artifacts you are operating at L4, not L5.

Maturity model for the exercises themselves. L1 code runs locally. L2 code is tested with unit tests. L3 code has integration tests against a real ES container. L4 code has load tests and documented SLOs. L5 code has relevance evaluation in CI and a migration plan. The exercise progression in this chapter is designed to walk you from L1 to L5.

Bar raiser challenge. Pick Exercise 2 and add a multi tenant isolation layer where each tenant's logs can be queried only by that tenant, with per tenant rate limits, per tenant retention policies, and per tenant cost accounting. This is a two week staff project. If you can do it cleanly, you are ready for an L6 search platform interview.

---
