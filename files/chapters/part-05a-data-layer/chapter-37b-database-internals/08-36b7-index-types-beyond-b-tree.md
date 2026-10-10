## 37B.7 Index Types Beyond B-Tree

### Hash Indexes

Hash indexes map a hash of the key directly to heap tuple locations. They support only equality comparisons and cannot help with range queries, ordering, or pattern matching.

```sql
-- Hash index: equality only, no ordering
CREATE INDEX idx_orders_uuid_hash ON orders USING HASH (external_uuid);

-- Supports: WHERE external_uuid = 'abc-123'
-- Does NOT support: range queries, ORDER BY, LIKE
```

Hash indexes store `hash(key) -> heap TID`. Lookups are O(1) for equality but cannot support range scans or ordering. In PostgreSQL 10+, hash indexes are WAL-logged and crash-safe (previously they were not). They are marginally smaller than B-tree indexes for equality-only workloads.

**When to use**: You have a long key (UUID, hash string) and only ever query by exact equality.

### GiST Indexes (Generalized Search Tree)

GiST is an extensible index framework that supports custom data types and operators:

```sql
-- Full-text search with GiST (usually prefer GIN for FTS)
CREATE INDEX idx_docs_fts_gist ON documents USING GIST (to_tsvector('english', body));

-- Geometric containment
CREATE INDEX idx_locations_point ON locations USING GIST (coordinates);
SELECT * FROM locations WHERE coordinates <@ circle '((0,0), 10)';

-- IP range containment (inet type)
CREATE INDEX idx_sessions_ip ON sessions USING GIST (ip_range inet_ops);

-- Exclusion constraints (only possible with GiST)
-- Prevent overlapping time reservations:
CREATE TABLE reservations (
    room_id   INT,
    during    TSTZRANGE,
    EXCLUDE USING GIST (room_id WITH =, during WITH &&)
);
```

GiST uses a balanced tree structure where each node stores a "bounding predicate" - a lossy summary of the keys beneath it. Searches use the predicate to prune branches.

### GIN Indexes (Generalized Inverted Index)

GIN is designed for composite values where a single indexed item can contain multiple keys:

```sql
-- Full-text search (preferred over GiST for FTS)
CREATE INDEX idx_docs_fts ON documents USING GIN (to_tsvector('english', body));
SELECT * FROM documents WHERE to_tsvector('english', body) @@ to_tsquery('golang & database');

-- JSONB containment and key existence
CREATE INDEX idx_orders_metadata ON orders USING GIN (metadata);
SELECT * FROM orders WHERE metadata @> '{"source": "mobile"}';
SELECT * FROM orders WHERE metadata ? 'promo_code';

-- Array containment
CREATE INDEX idx_products_tags ON products USING GIN (tags);
SELECT * FROM products WHERE tags @> '{golang, database}';
SELECT * FROM products WHERE tags && '{golang, python}'; -- overlap

-- GIN with jsonb_path_ops (smaller, faster for @>, slower for ? and @?)
CREATE INDEX idx_orders_meta_path ON orders USING GIN (metadata jsonb_path_ops);
```

**GIN internals**: Maps each key (e.g., each lexeme in a document, each element in an array) to a sorted list of heap TIDs that contain it (a "posting list"). Very fast for containment queries. Updates are expensive because they must update posting lists for each key.

**GIN pending list**: To speed up writes, GIN buffers new entries in a "pending list" and merges them lazily (`gin_pending_list_limit = 4MB` default). `fastupdate = on` (default) enables this. Set `fastupdate = off` for workloads where immediate consistency is more important than write speed.

### BRIN Indexes (Block Range Index)

BRIN indexes store summary information (min/max values) for ranges of heap pages:

```sql
-- Time-series table: rows are naturally ordered by created_at
CREATE INDEX idx_events_created_brin ON events USING BRIN (created_at)
    WITH (pages_per_range = 128);

-- Query: PostgreSQL reads only page ranges where min <= target <= max
SELECT * FROM events WHERE created_at > NOW() - INTERVAL '1 hour';
BRIN index structure for 10M row table:

Page 0-127:    min=2026-01-01, max=2026-01-15
Page 128-255:  min=2026-01-15, max=2026-01-31
Page 256-383:  min=2026-02-01, max=2026-02-14
...

Query: WHERE created_at > '2026-02-10'
-> Skip ranges 0-127, 128-255 (max < target)
-> Scan ranges 256+ (may overlap)
```

**BRIN characteristics**:
- Extremely small index (a few KB even for billion-row tables)
- Very fast to build and maintain
- Only useful when column values are **correlated with physical storage order**
- Low precision: may scan more pages than needed (lossy), re-checks in heap

**When to use BRIN**: Large append-only tables with time-based or sequential keys. Event logs, IoT sensor data, audit tables.

### HNSW Indexes (Vector Similarity)

Approximate nearest neighbor (ANN) search on high-dimensional vectors cannot be served by B-tree, GiST, or GIN. The standard answer in PostgreSQL (via the `pgvector` extension) is **HNSW** (Hierarchical Navigable Small World), a multi-layer proximity graph where upper layers have sparse long-range links and lower layers dense short-range links. Queries descend from the top layer, greedily following links toward the query vector, and the bottom layer is searched within a candidate set controlled by `ef_search`.

```sql
CREATE EXTENSION IF NOT EXISTS vector;

-- Column holding 1536-dim OpenAI embeddings
ALTER TABLE documents ADD COLUMN embedding vector(1536);

-- HNSW index (pgvector 0.5+; 0.6+ improves build speed with parallel workers)
CREATE INDEX idx_documents_embedding_hnsw
ON documents USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- Query: nearest 10 documents to query vector
SET hnsw.ef_search = 40; -- higher = better recall, slower
SELECT id, body FROM documents
ORDER BY embedding <=> '[0.1, 0.2, ...]'::vector
LIMIT 10;
```

**HNSW trade-offs vs IVFFlat** (the other pgvector option): HNSW has better speed/recall curves and does not require a training step, but builds slower and uses more memory. For production RAG workloads on Postgres 18, HNSW is the default choice. Oracle 23ai, SQL Server, and MongoDB Atlas all ship equivalent graph-based vector indexes.

> **Senior track**: HNSW is approximate. The recall vs latency curve is tuned by `ef_construction` (build time) and `ef_search` (query time). Benchmark both. For tenant-scoped queries, combine HNSW with a B-tree filter using pgvector's iterative index scan (0.8+) or by adding a `WHERE tenant_id = $1` partial HNSW index per tenant. A single global HNSW plus a post-filter often collapses recall to near zero for narrow tenants.

### Partial Indexes

A partial index includes only rows that satisfy a WHERE condition. This reduces index size and maintenance cost when you only query a subset of the table. The query must include conditions compatible with the partial index predicate for the planner to use it.

```sql
-- Index only active orders (not archived ones)
-- Reduces index size and maintenance overhead
CREATE INDEX idx_orders_active ON orders (user_id, created_at)
    WHERE status NOT IN ('archived', 'deleted');

-- Query must include the partial index condition to use it
SELECT * FROM orders WHERE user_id = 42 AND status = 'pending';
-- Uses idx_orders_active only if planner knows status != 'archived'/'deleted'

-- More precise: only index a specific value
CREATE INDEX idx_orders_processing ON orders (created_at)
    WHERE status = 'processing';

-- Index only non-null values (saves space for sparse columns)
CREATE INDEX idx_orders_promo ON orders (promo_code)
    WHERE promo_code IS NOT NULL;
```

### Expression Indexes

An expression index stores the result of a function or expression rather than the raw column value. The query must use the exact same expression in its WHERE or ORDER BY clause for the index to be used. This is the standard approach for case-insensitive searches, date truncation queries, and extracting fields from JSONB columns.

```sql
-- Index on lowercase email for case-insensitive search
CREATE INDEX idx_users_email_lower ON users (lower(email));

-- Query must use the same expression to use the index
SELECT * FROM users WHERE lower(email) = lower('User@Example.Com');

-- Index on date part for grouping by day
CREATE INDEX idx_events_day ON events (date_trunc('day', occurred_at));
SELECT date_trunc('day', occurred_at), count(*) FROM events
GROUP BY 1;

-- Index on JSONB field (alternative to GIN for specific key access)
CREATE INDEX idx_orders_source ON orders ((metadata->>'source'));
SELECT * FROM orders WHERE metadata->>'source' = 'mobile';
```

### Index Type Decision Matrix

| Access pattern | Index type | Notes |
|---|---|---|
| Equality on scalar | B-tree or Hash | Hash marginally better for pure equality |
| Range scan | B-tree | Only option with ordering support |
| Full-text search | GIN | GiST possible but GIN faster for FTS |
| JSONB containment | GIN | Essential for JSON filtering |
| Array containment | GIN | `@>`, `&&` operators |
| Geometric/spatial | GiST | PostGIS uses GiST |
| Exclusion constraints | GiST | Only GiST supports EXCLUDE |
| Time-series (append-only) | BRIN | Tiny size, correlated data only |
| Vector similarity (ANN) | HNSW (pgvector) | RAG, semantic search, recommendations |
| Sparse column (few non-null) | Partial B-tree | Filter `WHERE col IS NOT NULL` |
| Case-insensitive text | Expression B-tree | `lower(col)` expression |
| Low-selectivity column | Partial or none | Consider if selectivity < 5% |

### Junior to FAANG: Picking the Right Index the First Time

The gap between "I know B-tree" and "I can design indexes for a real app" is knowing which access pattern maps to which structure. Keep this reduction in your head: if the predicate is equality or range on a scalar, B-tree. If it asks "does this collection contain X", GIN. If it asks "is this point/range inside that point/range", GiST. If the data is append-only and the filter column grows monotonically, BRIN. If it compares vectors by cosine or L2 distance, HNSW. Nothing else to memorize at this stage.

Worked example. You are building a product search that filters by tags array and ranks by semantic similarity. Junior instinct is one compound index. The correct design is two: a GIN on tags for containment filtering, and an HNSW on the embedding column for ordering by distance. Postgres will BitmapAnd or apply the vector index after the GIN filter, depending on selectivity. Test both directions with EXPLAIN ANALYZE before committing.

Interview entry-points:
- Why does a B-tree not work for JSONB containment? Because B-tree orders whole values, and "contains key X" is not expressible as a range over ordered JSONB values.
- What breaks if you create a BRIN index on a column that is not correlated with physical order? Every query still has to scan most page ranges, so BRIN behaves like a bad sequential scan plus an index lookup overhead.
- When does a hash index beat a B-tree? Only when the values are long, queries are pure equality, you never need ordering, and write rate is modest. In practice, B-tree is almost always fine and hash indexes are rare.

### Senior at FAANG: Index Internals and Production Patterns

B-tree internals worth naming. Postgres uses Lehman-Yao B-link trees, meaning each page has a right-link pointer so concurrent readers can follow a split without holding latches on the parent. This is why Postgres B-tree indexes support high-concurrency reads without the latch escalation problems older engines faced. Deduplication (Postgres 13+) stores posting lists inside B-tree leaves for repeated keys, which matters for low-cardinality columns that you index anyway for sorting. INCLUDE columns (covering indexes) add payload columns that are not part of the key and enable Index Only Scans without widening the B-tree key comparison work.

GIN deep internals. Each indexed term points to a posting tree or posting list of TIDs. Posting trees are themselves B-trees, which is why GIN handles terms with millions of matching rows without the linear scan cost of a flat list. The fastupdate mechanism buffers writes in the pending list, and a SELECT that happens to overflow the pending list triggers a foreground merge. This produces unpredictable tail latency on read-heavy tables with fastupdate on. For search infrastructure where p99 read latency matters, set fastupdate = off on the GIN index and accept slower inserts. Autovacuum also merges the pending list, so autovacuum_vacuum_scale_factor tuning interacts with GIN behavior.

GiST internals. The structure is a balanced tree where each internal node stores a union predicate that covers its descendants. The extensibility comes from a set of support functions (consistent, union, compress, decompress, penalty, picksplit, same) that define how to compute unions and splits for a custom type. PostGIS implements these for R-tree semantics. SP-GiST is the space-partitioned sibling, useful for non-balanced decompositions like quad-trees, k-d trees, and radix tries. For IP prefix routing or phone number prefix matching, SP-GiST with text_ops on a prefix opclass outperforms B-tree.

BRIN beyond time-series. BRIN multi-minmax (Postgres 14+) stores multiple min/max pairs per range, handling data that is mostly correlated but has occasional outliers without destroying selectivity. BRIN bloom (Postgres 14+) stores a Bloom filter per range, giving equality lookups on uncorrelated data at BRIN-like storage cost. The tradeoff is false positives that force heap rechecks. Benchmark against a partial B-tree before choosing BRIN bloom in production.

Bloom indexes (contrib module) support multi-column equality lookups by building a signature per row. They shine when you have 5 to 10 low-selectivity columns and users filter by arbitrary combinations of them. The index is constant size regardless of which columns the query uses, which makes it attractive for "facet filter" UIs. The cost is false positives and no ordering.

pgvector internals. HNSW parameters: m controls the number of bi-directional links per node on the lower layers (higher m improves recall, costs memory linearly). ef_construction controls the search breadth during insertion (higher = better graph quality, linear build time cost). ef_search controls query-time breadth (higher = better recall, linear query time cost). The index is built in memory and persisted, so maintenance_work_mem must accommodate it during CREATE INDEX. For 10M vectors at 1536 dimensions with m=16, expect 80 to 100 GB of memory during build. pgvector 0.6 added parallel builds, and 0.7 added half-precision `halfvec` (halving index memory) plus binary quantization. pgvector 0.8+ added iterative index scan, which fixes the pathological low-recall case where a strict WHERE filter eliminates the top-k HNSW results and the planner never backtracks into the graph for more candidates.

IVFFlat vs HNSW as an engineering decision. IVFFlat partitions vectors into Voronoi cells and searches probes cells nearest to the query. It requires a training step (k-means on a sample) and degrades when the data distribution drifts. HNSW does not require training and has better recall at fixed latency but uses more memory and takes longer to build. For a growing corpus, HNSW wins. For a static catalog that fits in memory and where build time dominates, IVFFlat with careful probe tuning is still competitive.

Vector index pitfalls. Cosine distance operator <=> requires L2-normalized vectors for correctness on some opclasses. Mix up vector_l2_ops and vector_cosine_ops and recall will collapse silently. Always assert the operator class matches the distance function the application computes at query time. Monitor recall in production by sampling queries and comparing against brute-force scans of a subset.

Tenant-scoped vector search. The naive approach of WHERE tenant_id = $1 ORDER BY embedding <=> $2 LIMIT 10 with a global HNSW can return zero or very low-recall results for small tenants, because the HNSW graph returns the global top-k before the planner applies the tenant filter. Solutions: partial HNSW per tenant (scales up to hundreds of tenants), or per-tenant separate tables (scales up to thousands), or a hybrid where tenants above a size threshold get dedicated indexes and smaller tenants share an exact scan path. pgvector 0.8's iterative index scan also helps by fetching additional candidates when the filter eliminates too many.

Index bloat and REINDEX CONCURRENTLY. B-tree indexes bloat under updates because deleted entries leave page slots empty until a full page becomes empty and gets recycled. REINDEX INDEX CONCURRENTLY builds a new index alongside the old one and swaps, without taking exclusive locks. This is the staff-level maintenance pattern for any index over a few GB. For GIN, REINDEX is mandatory after heavy update workloads because the pending list merge can leave the posting trees fragmented. BRIN indexes effectively never need REINDEX because their storage is proportional to page ranges, not row count.

---
