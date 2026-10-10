## 37F.10 Company Case Studies

### Wikipedia: Search at Global Scale

Wikipedia uses Elasticsearch to power search across 60+ million articles in 300+ languages. Key patterns:
- **Multi-language analyzers**: language-specific analyzers per index (English uses Porter stemmer, German uses German analyzer with compound word decomposition)
- **Cross-language search**: query expansion using Wikidata entity linking - search "car" also matches documents about "automobile" and "vehicle" via synonym graph
- **Index architecture**: separate index per language wiki (`enwiki`, `dewiki`), federated search via cross-cluster search
- **Scale**: 20+ billion tokens indexed, search queries answered in < 200ms at p95

### GitHub: Code Search (the Elasticsearch Era)

GitHub ran code search on Elasticsearch with specialized analyzers for source code for a decade before replacing it with the custom Blackbird engine in 2023, when trigram-level indexing needs outgrew what an inverted-index search engine should do. The Elasticsearch-era decisions remain the canonical playbook for code-aware search:
- **Custom tokenizer**: code-aware tokenizer splits on camelCase (`getUserName` → `get`, `user`, `name`), snake_case, and operators
- **Exact match vs fuzzy**: filename search uses `term` query (exact), content search uses `match` with code analyzer
- **Language boosting**: `function_score` boosts files in popular languages (Python > Shell scripts) for more relevant results
- **Scale**: 200+ million repositories, searched with sub-second latency

### Airbnb: Listing Search

Airbnb uses Elasticsearch for its listing discovery engine. Key patterns:
- **Geo + text hybrid**: `bool` query combining geo bounding box filter + text match for amenities/description
- **Dynamic pricing in score**: `function_score` incorporates real-time price (from Redis) and availability (from booking DB) into the Elasticsearch score
- **Personalization**: user's previous search behavior modifies `function_score` weights at query time
- **Machine learning to rank**: Elasticsearch's Learning to Rank plugin trains ranking models on booking conversion data

### Elastic (ELK Stack): Observability Platform

Elastic runs the world's largest Elasticsearch deployment for Elastic Cloud. Key operational patterns:
- **ILM**: hot-warm-cold-frozen-delete lifecycle automatically manages 100,000+ customer indices
- **Searchable snapshots**: cold-tier data stored in S3 but still searchable - 90% storage cost reduction
- **Cross-cluster replication (CCR)**: disaster recovery with data replicated across regions
- **Kibana dashboards**: real-time visualization built on ES aggregation queries

### Junior to FAANG: Reading Case Studies With an Engineer's Eye

When you read a case study as a junior, resist the urge to treat it as a recipe. The useful question is never "what did they use" but "what constraint forced that choice." Wikipedia uses one index per language because analyzer configuration is set at index creation time and cannot be changed without reindexing. GitHub tokenizes camelCase because a generic standard tokenizer would shred `getUserName` into one token and miss the developer's intent. Airbnb pushes pricing into `function_score` because Elasticsearch cannot join against a live pricing service during query execution.

Prerequisite gaps to close before interviews. First, know the difference between the inverted index (tokens to document postings) and `doc_values` (columnar per document values used for sorting and aggregations). Many juniors conflate them and get confused when a `text` field cannot be sorted. Second, understand that an Elasticsearch shard is a Lucene index and that primary shard count is immutable without reindex. Third, know why refresh interval exists (near real time search is a cost, not a free property).

Worked example, a first job ticket. Your manager says "search is slow on the product page, add Elasticsearch." The senior move is to first measure. Is slowness query latency, application latency, or network? Run the query with `?pretty&explain=true` and `profile: true`. If a terms aggregation fans out to 10,000 buckets the fix is `execution_hint: map` or `composite` aggregations, not more hardware. The "why did this fail" reflex is always three questions. What did the cluster actually do, which shards were hot, and was the query cacheable.

Interview entry point. When asked "design search for a marketplace with 100M items," start by clarifying write rate, query rate, update freshness SLA, and relevance signals. Then sketch the index template, shard count calculation (aim for 20 to 50 GB per shard), and the ingestion pipeline. Mention aliases so you can reindex without downtime. Mention `_source` filtering so you do not ship full documents over the wire. This is the L3 to L4 bar.

### Senior at FAANG: Case Studies as Architecture Decision Records

Read each of the following as an ADR you could have written, not as a story. The decision, the constraints, the alternatives rejected, and the revisit trigger.

Uber Maps Search. Geo search at dispatch scale forced Uber to layer H3 hex tiling in front of Elasticsearch rather than rely on `geo_shape`. Query latency at p99 was dominated by geo filter expansion. The revisit trigger was sharding hot cells during surge events. The alternative, a custom Lucene geo codec, was rejected because operational cost of a fork exceeded the benefit.

Shopify Storefront Search. Per merchant multi tenancy with wildly skewed corpus sizes (some shops have 10 items, some have 2M). Shopify uses routing keys so a merchant's data lives on a known shard, plus adaptive replica count for whales. The ADR explicitly rejected per merchant index because template sprawl exceeded cluster metadata limits at about 50K indices.

GitHub Code Search, then Blackbird. The 2023 rewrite replaced Elasticsearch with Blackbird, a purpose built trigram index in Rust, because sharded Lucene could not hold all public code at the required latency. The staff lesson, general purpose search engines are a starting point, not an endpoint, once corpus specificity dominates.

Netflix Content Search. Catalog search is small (about 20K titles) but personalization is enormous. Netflix uses Elasticsearch only for the lexical stage and layers a vector reranker via Cassandra backed embeddings. The ADR rejected storing embeddings inside Elasticsearch because model refresh cadence (weekly) forced full reindex and disrupted the lexical path.

Slack Message Search at PB scale. Per workspace index with hot, warm, and frozen tiers. The governance lesson, enterprise customers demand legal hold and point in time immutability, which drives searchable snapshots plus audit of every query that touches frozen data.

Stripe Sigma. Not search per se but OLAP over an Elasticsearch-like store. Stripe chose Presto on Iceberg over pushing analytics into their search tier because search cluster blast radius was too high. Shared infrastructure is only acceptable when workloads have compatible failure modes.

Ranking-native engines versus Elasticsearch LTR. Teams whose relevance is dominated by learned ranking with many features per document sometimes choose a ranking-native engine such as Vespa over Elasticsearch, because Vespa's first class ranking expressions and tensor framework make learning to rank a native operation rather than a plugin. The recurring ADR driver is Elasticsearch LTR plugin lag during model updates.

Wikipedia CirrusSearch. Cross wiki federation uses cross cluster search rather than a single global index because per language governance (admins, legal) is language local, and each language's analyzer configuration is set at index creation and cannot be changed without a reindex.

Bloomberg Terminals. The terminal's search is custom, not Elasticsearch, because deterministic latency at p99.99 is the SLA and garbage collection pauses on the JVM are disqualifying. Consider this whenever you hear "just use Elasticsearch."

Vespa at Yahoo, Spotify, Pinterest. Common thread, ranking complexity beyond what function_score can express cleanly. Spotify's podcast search and Pinterest's visual search both needed multi vector ranking with business logic interleaved.

Algolia as Hosted Alternative. Staff decision point, if your team is fewer than three engineers and your data fits comfortably in Algolia's pricing model, operating your own Elasticsearch is usually wrong. The break even is roughly when you exceed 100M operations per month or need custom analyzers Algolia does not support.

Glassdoor Reviews. Moderation plus search. The governance layer is richer than the search layer. Every index write flows through a moderation pipeline and every query respects a per document ACL in `has_parent` style joins. The lesson, search governance is 60 percent of the work at enterprises with user generated content.

Maturity model for your own search platform. L1 one index, dynamic mapping, no ownership. L2 index templates reviewed in PR, shard sizing documented. L3 ILM in place, SLOs defined, on call rota. L4 relevance evaluation harness in CI, ranking model registry, cross cluster replication for DR. L5 multi region active active, ranking as a product with LTR pipelines, platform API abstracting Elasticsearch from tenant teams.

---
