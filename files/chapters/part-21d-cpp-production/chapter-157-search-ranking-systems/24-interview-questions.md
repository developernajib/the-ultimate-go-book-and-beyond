## Interview Questions

Fifteen questions calibrated to the senior search-infrastructure bar at Google Search, Meta AI Infra, Bing, Pinecone, Weaviate, Vespa.ai, Elastic, and OpenSearch. Each question has a junior-acceptable answer, a senior answer, and the follow-up the interviewer will press on.

### 1. Walk through what happens when I type "machine learning books" into a Google-scale search box.

Junior: parse query, look up term postings, intersect, rank by relevance, return top 10.

Senior: parse and tokenize, language detect, spell correct, expand synonyms and possibly embeddings, rewrite to operator tree, compute query embedding, fan out to shards, each shard runs BM25 with BMW or MaxScore, dense ANN in parallel, fuses with RRF or weighted, selects top-K candidates, ranks with first-stage LambdaMART using cheap features, sends top-100 to a second-stage cross-encoder or larger model, applies diversification and personalization, applies business rules, returns top 10. Each stage has a latency budget summing to under the user-perceptible threshold (~100 ms).

Follow-up: walk through where the latency goes. Where would you look for 20 percent latency reduction?

### 2. Why is BM25 still the lexical baseline after thirty years?

Junior: it works.

Senior: BM25 is the analytic limit of the probabilistic relevance framework with a 2-Poisson assumption on TF. Its three components (IDF, TF saturation, length normalization) each have independent justification. The functional form is robust across domains. Variants (BM25+, BM25F, BM25L) handle specific weaknesses. Modern dense retrieval beats BM25 on some BEIR tasks but loses on others, and almost every production system runs BM25 alongside dense.

Follow-up: write BM25 from memory. Tune k1 and b for product search vs paper search.

### 3. Implement WAND on a whiteboard.

Junior: cannot.

Senior: cursors per term sorted by current docID. Per term upper bound. Pivot index = smallest i such that sum of UBs up to i is at least theta. If pivot doc matches all leading cursors, score it, else advance the leading cursor toward pivot. Update theta when heap fills.

Follow-up: how does Block-Max WAND improve the bound? Why does MaxScore beat WAND on long queries?

### 4. Compare HNSW and IVFPQ for a 1B-vector workload.

Junior: HNSW is faster.

Senior: HNSW gives recall in the high 90s with millisecond latency at 3.5 KB per vector at d=768, 3.5 TB total, sharded across many hosts. IVFPQ gives recall in the low 90s with similar latency at 96 bytes per vector, 100 GB total, single-host feasible. IVFPQ wins on memory cost. HNSW wins on quality at high recall targets. IVFPQ wins on disk-residency and update simplicity. For most production workloads, the answer is IVFPQ with rerank for cost-bound systems, HNSW (with PQ-compressed neighbors) for quality-bound systems. Hybrid (HNSW as IVF coarse quantizer) is often the right answer.

Follow-up: what does ScaNN's anisotropic quantization buy that PQ does not?

### 5. Why are search indexes built from immutable segments instead of in-place updates?

Junior: simpler to reason about.

Senior: four reasons combined: write throughput (no contention with reads), crash recovery (immutable means partial writes are detectable), compression (offline build sees the whole segment, beats incremental), parallelism (queries fan out across segments). Updates are append-and-tombstone, merge cleans up. The cost is latency (NRT instead of immediate visibility) and write amplification (rewrite during merge). The Lucene model from 2002 is still the standard.

Follow-up: how do you tune merge policy for write-heavy vs read-heavy workloads?

### 6. Tail-at-scale: what is the broker's p99 if shards have p99 of 30 ms and N=100?

Junior: 30 ms.

Senior: the broker's p99 is the p99 of the maximum over N shards. With independent shards, P(max > t) = 1 - (1 - P(shard > t))^N. For N=100 and per-shard P(>30ms) = 0.01, P(broker>30ms) = 1 - 0.99^100 ≈ 63 percent. So broker p99 is much higher than 30 ms, it might be 80-100 ms, dominated by a likely-slow tail. Mitigations: hedged requests, partial-result return, shrinking N (bigger shards).

Follow-up: hedged requests cost extra load. Quantify the tradeoff.

### 7. Train a LambdaMART model. What goes wrong in practice?

Junior: feature engineering.

Senior: three concrete pitfalls. Group ordering: rows for a query group must be contiguous, shuffled inputs silently produce nonsense. Feature leakage: click-through rate computed across the full dataset includes test-set clicks, leaking labels. Eval metric mismatch: training with NDCG@10 but production scores top-100 means model is not optimized for the right ranking depth. Beyond pitfalls: use proper time-based splits, hold out a clean test set, monitor offline-online correlation.

Follow-up: derive the LambdaRank "fake gradient" from RankNet's gradient times delta-NDCG.

### 8. What is the difference between a cross-encoder and a bi-encoder?

Junior: one is faster.

Senior: a bi-encoder produces (q_vec, d_vec) independently, similarity is `dot(q_vec, d_vec)`. Document vectors are pre-computed at index time, so query-time cost is one query encode plus an ANN lookup. Cross-encoder takes (q, d) as a single transformer input and outputs one score, query-time cost is one forward pass per pair, much higher quality but much slower. ColBERT is in between: per-token vectors with MaxSim, quality close to cross-encoder, query-time cost between the two. Production: bi-encoder for retrieval, cross-encoder for reranking the top 50-200.

Follow-up: how do you make a cross-encoder fit in a 50 ms budget?

### 9. How does Reciprocal Rank Fusion work and when does it fail?

Junior: it merges ranks.

Senior: score(d) = sum over lists L of `1 / (k + rank_L(d))`. k around 60. Treats each list as a black box rank source. Wins because it requires no calibration and is robust. Fails when the input lists have very different qualities (RRF gives equal weight per list) or when rank differences are very meaningful (RRF discounts heavily for low ranks). Weighted sum or learned fusion handles those cases at the cost of needing tuning.

Follow-up: when would you use weighted sum instead of RRF?

### 10. Design an embedding service for 1 billion documents.

Junior: run the model and store vectors.

Senior: offline batch encoder. Tokenizer pipeline pre-stage (CPU-bound). GPU encoder stage with fp16, batch size 256-1024. Cost estimate: 110M-param model on A100 does 5k docs/sec, 1B docs is 56 GPU-hours. Output written to a vector store (FAISS file, Pinecone, custom). Versioning: vectors tied to model version, reindex on model change. Monitoring: throughput, GPU use, NaN rate, OOM rate.

Follow-up: model just got retrained. How do you swap without downtime?

### 11. What is the segment merge problem and how do production systems solve it?

Junior: combine small segments into bigger ones.

Senior: many small segments hurt query latency (each query touches every segment). Merging is expensive (re-read input, build new combined segment, write, swap). Trade-offs: merge frequency (more merges = lower query cost but higher write cost), merge tier (which segments to merge together), merge concurrency (how many merges at once). Production: tiered merge policy (Lucene's TieredMergePolicy), level-based variants, time-based variants for time-series. Background thread doing merges with backpressure on writes.

Follow-up: a runaway merge has been holding a lock for 10 minutes. Diagnose.

### 12. NDCG vs MRR vs MAP. When to use each.

Junior: NDCG is the most common.

Senior: NDCG handles graded relevance and discounts position, the right metric when you have multi-level labels (1-5) and care about the entire top-K. MRR is for queries with one correct answer (Q&A, navigational), the rank of the first relevant. MAP averages precision at each relevant rank, useful when you want to penalize late-relevant docs without graded labels. Recall@k is for retrieval: did the candidate set contain the relevant doc? Each measures something different, pick by the labeling protocol and the use case.

Follow-up: NDCG@10 went up but NDCG@1 went down. What does this mean?

### 13. How does Vespa achieve real-time updates while still using immutable segments?

Junior: it uses NRT.

Senior: Vespa splits document data into two stores. Field data that needs in-place updates (price, stock, popularity) lives in **attribute** structures: in-memory column stores updated atomically. Lexical postings live in segments with the standard immutable-segment model. Queries combine both. The real-time fields contribute via attribute reads in the ranking expression, the lexical retrieval uses segments. The trick is that the most-update-sensitive fields (price changes constantly, document text rarely) are precisely the ones where attribute storage works.

Follow-up: when would this design break down?

### 14. Walk through ScaNN's anisotropic quantization.

Junior: PQ but better.

Senior: PQ minimizes reconstruction error `||x - x_q||^2` symmetrically across all directions. For inner-product search, error in the **parallel** direction (high-norm) hurts more than error in perpendicular directions, because high-norm directions dominate inner-product magnitudes. ScaNN's loss reweights: `h_par * ||x_par - x_par_q||^2 + h_perp * ||x_perp - x_perp_q||^2`, with `h_par >> h_perp`. Intuition: better preserve the dimensions queries are likely to look at. Result: 5-15 percent recall improvement at the same compression.

Follow-up: when does anisotropic quantization not help?

### 15. Design a vector database from scratch.

Junior: HNSW behind an HTTP server.

Senior: requirements drive design. Core: HNSW or IVFPQ for ANN. Persistence: immutable segments. Updates: writable buffer plus refresh. Replication: synchronous with tunable factor. Sharding: hash on docID for documents, optionally by tenant for multi-tenant. Query path: parse, fan out, score, merge, return. Reranking: optional second-stage. Filtering: integrate with ANN (filterable HNSW) or post-filter. Cost: memory dominates. PQ or scalar quantization to fit budget. Operations: liveness probes, segment health monitoring, drift alerts on recall, capacity planning by QPS targets. Discuss what you would skip in a v1 (replication, multi-region, complex filtering).

Follow-up: walk through how you would benchmark this against Pinecone or Weaviate.

---
