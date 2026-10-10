## Summary

Elasticsearch's inverted index and distributed architecture make it the primary platform for full-text search, log analytics, and hybrid search. Core capabilities include:

- **Architecture**: Lucene segments, refresh/flush cycle, NRT search, shard routing, cluster consensus
- **Mapping**: production mappings with custom analyzers, field types, synonyms, edge ngram, dense_vector
- **CRUD**: index, bulk index, partial update with retry, delete
- **Search**: bool query, filter vs query context, function_score relevance tuning, highlighting
- **Advanced search**: autocomplete, phrase suggestion ("did you mean?"), nested queries, geo search, kNN vector search, hybrid RRF
- **Aggregations**: date histogram, terms, range, percentiles, moving averages, geo heatmap
- **ILM**: hot-warm-cold-frozen-delete lifecycle, data streams, index templates, rollover
- **PIT + search_after**: efficient large dataset processing without scroll degradation
- **Percolator**: real-time query matching for price alerts and notifications
- **Case studies**: Wikipedia multilingual search, GitHub code search, Airbnb listing discovery, Elastic Cloud

### Junior to FAANG: Consolidating This Chapter Into Interview Ready Knowledge

Work the chapter in three passes, not one. First pass read for vocabulary, segments, refresh, flush, shards, BM25, RRF, ELSER, HNSW. You cannot reason about a system whose words you do not own. Second pass, read for mechanisms. How does a refresh turn a buffer into a segment? How does BM25 weight a term? How does HNSW build layers? Third pass, read for tradeoffs. When does BM25 beat vector search, when does it lose, why is `function_score` a hammer.

Prerequisite gaps to close before the next interview. Lucene segment immutability, the translog as durability contract, the difference between `text` and `keyword`, multi field mappings, filter context bitset caching, shard routing math, aliases as the indirection layer, ILM phase transitions, and the retriever DSL introduced in Elasticsearch 8.14 and matured in 9.0.

Worked self test. Without looking at the chapter, write a one page Elasticsearch design for "search for 10M job postings with faceted filters and autocomplete." If you can produce the index template, the bool query, the ILM policy, and the shard count with justification, you are at the L4 bar. If you can also describe the evaluation harness and the migration plan, you are at L5.

"Why did this fail" reflex. Every symptom in Elasticsearch has a layer. Mapping, analyzer, query, cluster, hardware. Diagnose top down. Wrong results are usually mapping or analyzer. Slow queries are usually query shape or shard skew. Timeouts are usually node hot threads or disk watermarks.

Interview entry point. This chapter equips you to answer "what is Elasticsearch good at" without vague words. Good at, tokenized full text search with BM25, high cardinality aggregations, time series log analytics with ILM, geo search, and increasingly hybrid retrieval. Bad at, joins, transactional consistency with source of truth, workloads under 10M documents where Postgres is simpler, sub millisecond deterministic latency where Bloomberg style terminals need custom engines.

### Senior at FAANG: Platform Maturity and the Elasticsearch Portfolio Decision

Use this summary as a checklist for your own search platform's maturity. A staff engineer does not chase every feature in the chapter. A staff engineer chooses features that move the platform up the maturity model without increasing blast radius.

Maturity model recap for a search platform.

L1 ad hoc. One index per team, dynamic mapping, no shared ownership, no SLOs. Incidents are reactive. Reindexing is manual and scary.

L2 standardized. Index templates in version control. Shard sizing documented. ILM policies for log workloads. On call rota exists. Runbooks for the top 5 alerts.

L3 governed. Mapping review ADR. Query gateway enforcing bounds on terms aggregations and pagination depth. Cluster sizing ADR. Cross cluster replication for DR. Dashboards before alerts.

L4 evaluated. Relevance evaluation harness in CI. Shadow traffic for query changes. Canary deploys for mapping changes. Blue green reindex orchestrator. Platform API abstracts Elasticsearch from tenant teams.

L5 productized. Search as a product with a PM. LTR pipelines with model registry. Multi region active active. Published SLOs and error budgets. Cost attribution per tenant. Build vs buy revisited quarterly (Elasticsearch vs OpenSearch vs Vespa vs Algolia).

Portfolio decision ADR template. Every two years, revisit your search engine choice. The decision matrix has six axes. Corpus size and growth rate. Ranking sophistication (BM25 only, hybrid, LTR, neural rerank). Team size (under 3, Algolia. 3 to 15, Elasticsearch or OpenSearch. 15 plus with relevance engineers, Vespa becomes viable). Operational model (managed, self hosted on Kubernetes, bare metal). Compliance and data residency. Cost envelope.

Governance artifacts every mature platform produces. Index template registry. Mapping review ADR log. Shard rebalance policy. Cluster sizing ADR. kNN profile registry. Script catalog. Relevance baseline. Rebuild playbook. Migration playbook. These artifacts are the difference between a team that owns Elasticsearch and a team that is owned by Elasticsearch.

Revisit triggers. Retention exceeds 3x planned. Query rate exceeds 2x planned. p99 latency exceeds SLO for two consecutive weeks. Cost per query exceeds budget for a quarter. A new engine (Quickwit, Turbopuffer, LanceDB) demonstrates an order of magnitude improvement on a dimension that matters. Any of these triggers an ADR review, not a panic migration.

Closing frame. Elasticsearch in 2026 is not the only answer, but it remains the default answer for general purpose search. Use this chapter to own the default, then use the case studies to know when to leave it.

---
