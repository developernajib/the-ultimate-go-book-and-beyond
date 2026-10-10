## 37F.12 Interview Questions & Answers

**Q1: How does Elasticsearch achieve near real-time (NRT) search?**

A: Elasticsearch uses Lucene's segment architecture. When you index a document, it is written to an in-memory buffer and the translog. A `refresh` operation (default every 1 second) flushes the buffer to a new, searchable segment. Documents are not visible before this refresh. `fsync`/`flush` persists segments to disk and checkpoints the translog every 30 minutes or when the translog gets too large. You can call `refresh=true` on indexing to make a document immediately searchable, but at significant performance cost because it forces an extra segment per call. Production writers use `refresh=false` and rely on the 1 s interval, or raise `refresh_interval` to `30s`/`-1` during bulk loads.

**What FAANG expects:** Name the three durability layers (buffer, translog, segments) and explain who guarantees what. Know that the translog is the durability contract, not segments, a document is recoverable on crash once in the translog, searchable only after refresh. Mention that `wait_for` is the production-safe middle ground between `refresh=false` and `refresh=true`.

Follow-ups:
- Why does forcing `refresh=true` on every write destroy throughput, and what actually happens at the Lucene level? (Answer: each refresh creates a tiny segment. You then pay merge cost exponentially, and the segment cache is invalidated.)
- If the node crashes after a `refresh` but before a `flush`, is the document lost? (Answer: no, the translog is `fsync`ed on every index by default, recovery replays it.)
- How would you change this story for a write-once log pipeline where query latency does not matter?

**Q2: Explain the difference between `query` context and `filter` context.**

A: **Query context**: clauses in `must` and `should` compute a relevance score (`_score`) for each matching document using BM25 (or the configured similarity), used for full-text search. **Filter context**: clauses in `filter` and `must_not` only check yes/no match without scoring. Filter results are cacheable as roaring bitsets on each segment and are reused across queries, making repeated filters orders of magnitude cheaper than `must` clauses. Rule of thumb: use `filter` for anything an exact-value predicate (term, terms, range, exists, geo_distance), and reserve `must`/`should` for true full-text relevance.

**What FAANG expects:** Explain *why* filter is faster, not just that it is. The bitset caching mechanism, per-segment reuse, and the fact that BM25 scoring walks postings lists with norms are the load-bearing facts. Know that sorting by `_score` on a pure filter query returns `_score = 0` for every doc.

Follow-ups:
- What happens if you put an expensive `term` query in `must` for a boolean field like `active: true`, measure the cost.
- When would you deliberately put a clause in `must` that doesn't need scoring? (Answer: almost never. Edge case is when you want the clause to participate in `_score` via a constant via `constant_score` wrapper.)
- How does the filter cache interact with segment merges?

**Q3: How does Elasticsearch handle shard routing?**

A: By default, document routing uses `shard_num = hash(_id) % num_primary_shards`. This deterministic mapping means any node can locate a document by ID without broadcasting. Custom routing via the `routing` parameter co-locates related documents on the same shard, useful for tenant isolation (query only one shard) or to localize joins and aggregations. Changing `number_of_primary_shards` is not allowed on an existing index. You must reindex or use the `split`/`shrink` APIs, which is why primary-shard sizing is a design-time decision.

**What FAANG expects:** Know the math exactly, and know the failure modes of custom routing: a hot tenant with 1000× more data than others creates a hot shard that cannot be rebalanced because every one of its documents hashes to the same shard. The fix is index-per-tenant or routing + `index.routing_partition_size` to spread a single tenant across multiple shards.

Follow-ups:
- Your biggest customer is 40% of total data volume and their queries are slow. Walk me through the diagnosis.
- Why does `split` require the target shard count to be a multiple of the source? (Answer: to keep `hash(_id) % n` consistent so existing docs land on the right new shard.)
- How does custom routing interact with `_id` uniqueness?

**Q4: What is the difference between `text` and `keyword` field types?**

A: **text**: analyzed, the string is tokenized, lowercased, stemmed, and otherwise transformed by the configured analyzer before indexing. Used for full-text search. Not aggregatable or sortable by default because doc values are disabled. **keyword**: not analyzed, stored as a single opaque token. Used for exact matching, aggregations, sorting, and filtering. For a field you need both full-text search AND aggregation (product name, email), use a multi-field: `{"type": "text", "fields": {"keyword": {"type": "keyword", "ignore_above": 256}}}`. The `ignore_above` avoids accidentally indexing unbounded keywords like a full article body.

**What FAANG expects:** Be able to reason about disk cost and query patterns for a mixed workload. A multi-field duplicates storage. If you never aggregate on that field, don't add `.keyword`. Know that `wildcard` and `constant_keyword` are specialized types that beat raw keyword for specific workloads (wildcard fields for log messages, constant_keyword for tenant markers).

Follow-ups:
- Why does sorting by a `text` field return an error by default, and how do you fix it?
- When would you use `match_only_text` instead of `text`? (Answer: when you don't need BM25 scoring, logs, where the filter dominates, to save on norms storage.)
- What's the risk of a very large `ignore_above`, say 32768?

**Q5: How would you implement Elasticsearch in a microservices architecture?**

A: Use the **event-driven CDC approach**: services publish domain events (OrderCreated, ProductUpdated) to Kafka. An Elasticsearch projection consumer subscribes, applies the event to a read model, and bulk-indexes into ES. The primary DB remains the source of truth. ES is a derived, read-optimized projection. Alternatively, use Debezium to capture DB changes at the WAL level and publish them as Kafka events without application changes. Services query ES directly for search and analytics, but never write to it from business code. This decouples services, isolates ES outages from writes, and lets you reindex by replaying Kafka from a snapshot.

**What FAANG expects:** The anti-pattern answer, dual-writes from application code to DB and ES, must be rejected explicitly, with the consistency failure mode named: DB commits, ES write fails, the data diverges forever. Know the outbox pattern as the production answer when you cannot add Debezium. Mention versioning (`external_gte`) so out-of-order Kafka events don't overwrite newer state.

Follow-ups:
- Walk me through how you'd handle a consumer lag of 6 hours on Black Friday.
- How do you do zero-downtime reindexing when the mapping changes? (Answer: dual-write via aliases, index v2 gets new mapping, backfill from Kafka replay or reindex API, atomically swap alias.)
- What if an event says "OrderDeleted" but arrives before "OrderCreated"?

**Q6: Explain Elasticsearch's split-brain problem and how it is prevented.**

A: Split-brain: if a master node becomes unreachable, multiple nodes might each elect themselves as master, producing conflicting cluster states and data loss on merge. Prevention pre-7.x: `discovery.zen.minimum_master_nodes = (N/2) + 1` where N is the number of master-eligible nodes. Modern ES (7.x and 8.x/9.x) replaced Zen with a Raft-like consensus algorithm. `cluster.initial_master_nodes` bootstraps the first voting configuration, after which voting-config exclusions manage membership automatically. The quorum guarantee is enforced by the voting configuration, not by a configurable minimum, which eliminates the historical misconfiguration class.

**What FAANG expects:** Do not describe split-brain in pre-7.x terms only, that is dated. Name the Raft-inspired consensus model, the voting configuration, and the fact that an even number of master-eligible nodes is still a bad idea (a 2-node split produces two 1-node clusters, neither of which has quorum). Three or five dedicated master-eligible nodes is the standard topology.

Follow-ups:
- Why should master-eligible nodes be dedicated (not also data nodes) in clusters above a certain size?
- What happens during a rolling restart if you restart two of three masters simultaneously?
- How does cross-cluster replication (CCR) interact with quorum on the follower cluster?

**Q7: How does `function_score` work?**

A: `function_score` modifies the relevance score from a base query by applying mathematical functions: `field_value_factor` (multiply score by a field value, with `log1p`/`sqrt`/`none` modifiers), `gauss`/`linear`/`exp` (decay functions based on distance from an origin, useful for recency or geo proximity), `random_score` (stable random ordering per seed, A/B testing), and `script_score` (arbitrary Painless). Multiple functions combine via `score_mode` (multiply, sum, avg, first, min, max). The final combination with the base query score is controlled by `boost_mode` (multiply, replace, sum, avg, min, max). In ES 8/9 the newer `script_score` query and `rank_feature` / `rank_features` field types are often cheaper alternatives for common cases.

**What FAANG expects:** Recognize that `function_score` is a hammer that makes every query look like a nail, it is expensive because it scores every candidate. Name the cheaper alternatives: `rank_feature` fields for pre-computed static boosts (e.g., product popularity), the `rank_features` query for sparse feature vectors, Learning-to-Rank for model-driven relevance.

Follow-ups:
- Why is `script_score` in a function_score clause often a performance disaster, and what's the fix?
- Compare `gauss(created_at, 30d)` vs multiplying by a pre-computed `recency_score` field. Tradeoffs?
- How does Learning-to-Rank integrate here? (Answer: LTR is a rescorer applied to top-N from the base query, not a function_score clause.)

**Q8: How would you handle Elasticsearch for multi-tenancy?**

A: Three patterns: (1) **Index per tenant**, strongest isolation, trivial tenant deletion, but shard count equals tenant count times shards-per-tenant, which blows past the 1000-shards-per-node guideline at ~500 tenants. (2) **Shared index with routing**, all tenants in one index, documents routed by `tenant_id`, and every query filters on `tenant_id`. Cheap but exposes you to noisy-neighbor queries and tenant-level data deletion becomes a delete-by-query. (3) **Filtered aliases**, one index, per-tenant alias with a term filter on `tenant_id`, applications query the alias and cannot see other tenants' data even if they try. The right answer depends on tenant count, data skew, and isolation requirements. Large SaaS often combine patterns (index per large tenant, shared index for long tail).

**What FAANG expects:** Reason about the tradeoffs quantitatively, not just list options. "500 tenants × 3 shards × 2 replicas = 3000 shards. A 3-node cluster with 31GB heap supports roughly 600 shards, you'd need 5 nodes minimum just for shard overhead." Know the shard-explosion failure mode and the `_routing` + `routing_partition_size` trick that splits a single tenant across multiple shards.

Follow-ups:
- Your 10 biggest tenants generate 80% of traffic. How do you layout indices?
- How do you enforce that tenant A cannot query tenant B's data when using pattern 2?
- What's your backup and restore story per-tenant for each pattern?

**Q9: What is the cardinality aggregation and when should you use it?**

A: Cardinality aggregation counts approximate unique values using the HyperLogLog++ algorithm. It uses fixed memory regardless of cardinality, `precision_threshold` controls the accuracy/memory trade-off (default 3000 ≈ 1-2% error in ~20KB per shard. 40,000 ≈ 0.5% error in ~128KB). Use it for unique users, sessions, distinct IPs, any "count distinct" where approximate is acceptable. Do NOT use a `terms` aggregation with unbounded `size` to count uniques. That builds a priority queue proportional to cardinality and OOMs the coordinating node. For exact counts on small cardinalities (under a few thousand), bounded `terms` with `size` is fine and gives you the values too.

**What FAANG expects:** Know HLL is probabilistic and that the same document can contribute twice across shards before the coordinator deduplicates via sketch merge, but the sketch is mergeable, which is why HLL works distributed. Mention `cardinality_aggregation_execution_hint` (`map`, `global_ordinals`, `segment_ordinals`) as a tuning knob for high-cardinality keyword fields.

Follow-ups:
- Two `cardinality` aggregations on the same query with different precision, what happens?
- When would you prefer a `composite` aggregation to `cardinality`? (Answer: when you need to enumerate the distinct values, not just count them, paginated across millions.)
- How accurate is HLL at cardinality 10 billion?

**Q10: How do you optimize an Elasticsearch cluster for heavy write throughput?**

A: (1) Set `refresh_interval` to `30s` or `-1` during bulk loads, reduces segment churn. (2) Set `index.number_of_replicas` to 0 during initial bulk ingest, then restore to 1+ and let replication run, avoids replicating every doc twice. (3) Use the bulk API with batches of 5-15MB per request. (4) JVM heap at 50% of RAM, capped around 30GB to stay inside compressed OOPs. (5) SSDs, ideally NVMe, with `mmapfs`/`hybridfs` store type. (6) Pre-compute routing to spread writes across all shards evenly. (7) `index.codec: best_compression` for ingest-heavy, query-light log workloads. (8) Dedicated ingest and coordinating nodes so data nodes are not interrupted by pipeline execution. (9) Disable `_source` only if you never need to reindex or return full docs, usually not worth it.

**What FAANG expects:** Prioritize correctly, refresh_interval and replicas-during-ingest are the first levers. bigger heap is the most often-misused one. Know that `index.translog.durability: async` trades durability for throughput and should be considered deliberately. Recognize that write throughput is ultimately bottlenecked by fsync on the translog, then by segment merging.

Follow-ups:
- Your indexing throughput plateaus at 50k docs/sec even though CPU is at 40%. Where do you look first?
- Explain the merge scheduler and how it can be tuned.
- When would `index.translog.durability: async` be acceptable? When would it be reckless?

**Q11: Explain Elasticsearch cross-cluster search.**

A: Cross-cluster search (CCS) queries indices on remote clusters from a local cluster. Remote clusters are configured in `cluster.remote` settings and addressed as `remote-cluster:index-pattern` in queries. Use cases: querying multiple DCs from a single coordinator, keeping hot data local and cold/historical data on a separate cluster, and per-customer cluster isolation with a central search plane. The coordinating node on the local cluster talks to remote gateway nodes. Each remote cluster independently reduces its shards and returns top-K, and the local coordinator merges. This adds 1-2 RTTs per remote cluster, and slow remotes slow the whole query, so set `ccs.skip_unavailable: true` for non-critical remotes and use `ccs_minimize_roundtrips: true` (default) to batch phases.

**What FAANG expects:** Know CCS vs cross-cluster replication (CCR, async replication, not search). Know that CCS scoring is per-cluster unless you enable `ccs_minimize_roundtrips: false`, which does a two-phase query across clusters for globally-consistent scoring at a latency cost. Mention that CCS is the standard architecture for long-term log retention (hot cluster + warm CCS target with searchable snapshots on S3).

Follow-ups:
- Scores from two clusters aren't directly comparable. Why, and how do you fix it?
- How does CCS interact with security, does the remote cluster trust the local cluster's auth?
- At what point would you split one cluster into two + CCS instead of growing it?

**Q12: How does vector search work in Elasticsearch 9, and when should you use it?**

A: Elasticsearch indexes dense vectors with the HNSW (Hierarchical Navigable Small World) graph algorithm, giving approximate k-nearest-neighbor search in sub-logarithmic time. You declare a field as `dense_vector` with `dims`, `similarity` (`cosine`, `dot_product`, `l2_norm`, `max_inner_product`), and `index: true`. Queries use the `knn` clause (top-level in ES 8.4+) with `k` (final results), `num_candidates` (per-shard candidate pool. Typically 10×k), and optional pre-filters. ES 9 added Better Binary Quantization (BBQ), which compresses vectors to 1 bit per dimension with rescoring, cutting memory 32× for limited recall loss. ELSER is Elastic's sparse-vector semantic model that encodes text into weighted terms without requiring you to generate embeddings, useful when you want semantic search without an embedding pipeline. Production retrieval is usually **hybrid**: BM25 + dense/sparse vector combined via the `retriever` RRF construct, because lexical and semantic signals catch different failure modes.

**What FAANG expects:** Don't confuse exact kNN (brute force, accurate, slow) with approximate HNSW kNN (fast, tunable recall). Know that vector search is memory-bound: 1M vectors × 1536 dims × 4 bytes = 6 GB heap before BBQ. Name the failure modes of pure vector search (surface form queries like error codes don't semantically cluster) and of pure BM25 (synonym drift). Mention that dimensions > 2048 hurt more than they help in most cases.

Follow-ups:
- Your recall on semantic search is 95% against a brute-force baseline. How do you push it to 99%, and what's the cost?
- Compare ELSER to dense embeddings (e.g. OpenAI text-embedding-3). When would you pick ELSER?
- RRF combines ranked lists without score normalization. Why is that better than weighted score fusion in most cases?

**Q13: Scroll vs Point-in-Time vs search_after, when do you use each?**

A: **`from`/`size`**: user-facing pagination up to `index.max_result_window` (10,000 default). Do not use for deep pagination. **`search_after`**: stateless cursor pagination using sort values from the last hit as the cursor. Requires a stable sort (include `_id` as tiebreaker). Use for deep user-facing pagination. **PIT + `search_after`**: adds a consistent point-in-time snapshot so pagination sees a frozen view of the index even as it's being written. Use for exports, batch jobs, reindexing, and any multi-request pagination that must be consistent. **Scroll**: legacy, deprecated for pagination since 7.10. Pins a search context per cursor, doesn't scale to concurrent cursors, and has been superseded by PIT for every valid use case. Use only for compatibility with existing tools.

**What FAANG expects:** State the deprecation bluntly. Explain why PIT is strictly better: cheaper to open, doesn't pin per-cursor state, can be opened in parallel, integrates with `search_after`. Know that `track_total_hits: false` is a major latency win for PIT-based iteration because the coordinator short-circuits counting after the first batch.

Follow-ups:
- Your export job iterates 100M docs with PIT + search_after. After 10 minutes it fails, what's the likely cause? (Answer: PIT `keep_alive` expired. Extend or refresh it.)
- How do you parallelize a PIT-based export across workers? (Answer: `slice` parameter, same as scroll sliced.)
- Why include `_id` in the sort tiebreaker even when sorting by `created_at`?

### Junior to FAANG: Turning Answers Into Interview Signal

Memorizing answers fails at FAANG. The 13 questions above are openings, not endpoints. Every question has a ladder of depth. Interviewers escalate until they find the edge of your knowledge and then judge how you reason at that edge. Your job is to climb the ladder visibly.

Structure every answer as a four part response. Clarify the scenario, state the core mechanism in one sentence, name the failure mode, describe the production guardrail. For Q1 that looks like "You mean user facing search, not bulk ingest, correct? Elasticsearch achieves NRT through periodic refresh into a new Lucene segment. The failure mode is refresh storm from small writes. Production uses `wait_for` plus a raised `refresh_interval` during bulk loads." That is a 30 second answer that lands at L4.

Prerequisite reading. Before an interview, understand BM25 (the math, not just the name), know that Lucene segments are write once, know that the translog is `fsync` on every operation by default, and know that `_score` is a float computed per document from term statistics. These four facts unlock most follow ups.

Worked example. Q5 on microservices is the most commonly botched question. Juniors describe dual writes and move on. The FAANG answer explicitly rejects dual writes on the ground that they create a consistency hole (DB commit succeeds, ES write fails, drift is permanent). Offer the outbox pattern or Debezium. Mention external versioning (`version_type=external_gte`) so Kafka reprocessing is idempotent. Mention the reindex alias swap pattern for mapping changes. This is an L5 signal on a question juniors fumble.

"Why did this fail" reflex in interviews. When the interviewer says "that answer is wrong," do not defend. Ask "what case am I missing?" Then reason aloud from first principles. Interviewers grade recovery more than initial correctness.

Interview entry point by level. L3 can name the feature. L4 can explain the mechanism. L5 can name the failure mode and the guardrail. L6 can reason about the tradeoff space and pick based on constraints. L7 can design the platform that makes the guardrail automatic.

### Senior at FAANG: Signal Ladders, Bar Raiser Questions, and Scoring Rubrics

Calibrate answers by level before you answer. Staff and principal interviews use the same 13 questions but grade on different axes.

Signal ladder L3 to L7 for "design search for a marketplace with 100M items."

L3 signal. Names Elasticsearch, describes documents and queries, suggests a BM25 base query. Cannot estimate shard count. Cannot describe ingestion pipeline.

L4 signal. Estimates data size (say 100M documents at 2 KB equals 200 GB, times replica equals 400 GB, plus indexing overhead 1.3x equals 520 GB). Targets 30 GB per shard giving 12 to 20 primary shards. Describes alias based reindex. Mentions BM25 plus filters. Writes a coherent bool query.

L5 signal. Adds hybrid retrieval (BM25 plus kNN with RRF). Reasons about relevance metrics (NDCG at 10, MRR) and evaluation harness. Describes CDC ingestion via Kafka. Names failure modes (mapping explosion, deep pagination) and preventions. Discusses ranking features beyond score (popularity, freshness, availability).

L6 signal. Frames the problem as a search platform, not a single index. Designs multi tenancy (routing, aliases, or index per big tenant). Plans for cross cluster search across regions. Defines SLOs (p95 under 200 ms, p99 under 500 ms, indexing lag under 5 s at p95). Describes cost model (instance type, node count, per query cost). Argues Elasticsearch vs Vespa vs Algolia based on ranking complexity and team size.

L7 signal. Treats search as a product with a lifecycle. Relevance evaluation in CI with pytrec_eval. Feature flag driven ranking experiments. Dedicated relevance engineer role. Governance (mapping review ADR, shard rebalance policy, cluster sizing ADR). Blast radius isolation. Migration ADR for when the decision must be revisited. Discusses build vs buy vs outsource (Algolia) quantitatively.

Bar raiser questions that separate L5 from L6.

Migrate Elasticsearch 7 to OpenSearch 3. Elasticsearch and OpenSearch diverged after 7.10. License change (SSPL for Elasticsearch, Apache 2 for OpenSearch). API compatibility is high but not complete. The migration plan is, stand up OpenSearch alongside, replicate via cross cluster replication or logstash pipeline, run shadow traffic, compare relevance at query level with a diff harness, cutover by alias swap at the client library layer. Risks are plugin compatibility (the ingest pipeline catalog), query DSL drift (kNN API surface differs), and operational tooling (Kibana vs OpenSearch Dashboards). Rollback plan must be documented. A senior answer names the 6 to 12 month program timeline and a dedicated migration crew.

Design hybrid search with pgvector. The interviewer is testing whether you recognize that Postgres plus pgvector can replace Elasticsearch for corpora under roughly 10M documents with moderate query rates. Your answer should cover, when to choose Postgres (operational simplicity, transactional consistency with the system of record, team already runs Postgres), when Elasticsearch wins (analyzer sophistication, aggregation performance, scale beyond a single primary). Describe the hybrid query with `WHERE tsvector @@ query AND embedding <=> vec` and RRF fusion in application code. Name the downside, pgvector lacks learning to rank, relevance tuning surface is thin.

Rebuild Slack's search for 10B messages. This is a scale question. 10B messages at 1 KB equals 10 TB, times replica and indexing overhead equals about 30 TB. Per workspace indexing with hot, warm, and frozen tiers. Searchable snapshots on S3 for messages older than 90 days. Per workspace routing. Query level ACL enforcement. The bar raiser watches for, do you mention legal hold, do you mention GDPR delete propagation, do you mention tombstone semantics, do you mention the cost of full text search on encrypted at rest fields.

Implement LTR pipeline. Offline feature extraction from query logs and click through data. Feature store (Feast or homegrown). Training a gradient boosted ranker (XGBoost, LightGBM) on NDCG objective. Model registry with versioned artifacts. Online rescore over top N from BM25 (typically N equals 100 or 200). A/B experimentation framework with interleaving for relevance comparison. Shadow serving before canary. Rollback on metric regression. The senior signal is treating the model as an artifact with a lifecycle, not a one off.

Scoring rubric for your own team. When interviewing candidates, grade on four axes. Depth of mechanism, awareness of failure modes, quality of tradeoff reasoning, ability to articulate governance. A candidate strong in mechanism but weak in governance is L5 ceiling. Strong in all four is L6.

Maturity model for your interview loop itself. L1 ad hoc questions per interviewer. L2 shared question bank. L3 calibrated rubric per level. L4 interviewer calibration sessions, shadow interviews. L5 bar raiser program with veto authority.

---
