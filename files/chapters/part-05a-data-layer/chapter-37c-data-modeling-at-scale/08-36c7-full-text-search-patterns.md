## 37C.7 Full-Text Search Patterns

### PostgreSQL tsvector/tsquery

PostgreSQL's built-in full-text search:

```sql
-- Add tsvector column
ALTER TABLE products
    ADD COLUMN search_vector tsvector
        GENERATED ALWAYS AS (
            setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
            setweight(to_tsvector('english', coalesce(description, '')), 'B') ||
            setweight(to_tsvector('english', coalesce(brand, '')), 'C')
        ) STORED;

-- GIN index for fast full-text search
CREATE INDEX idx_products_search ON products USING GIN (search_vector);

-- Search query
SELECT id, name, price_cents,
       ts_rank(search_vector, query) AS rank
FROM products,
     to_tsquery('english', 'wireless & headphones') AS query
WHERE search_vector @@ query
ORDER BY rank DESC
LIMIT 20;
```

In Go, use `plainto_tsquery` instead of `to_tsquery` for user-supplied search input. `plainto_tsquery` treats the input as plain text and will not raise a syntax error on characters like `&`, `|`, or unmatched parentheses that have special meaning in tsquery syntax.

```go
func (r *ProductRepo) Search(ctx context.Context, q string, limit int) ([]Product, error) {
    // Convert user query to tsquery safely
    // plainto_tsquery handles arbitrary user input (no syntax errors)
    rows, err := r.db.Query(ctx, `
        SELECT id, name, price_cents, brand,
               ts_rank(search_vector, plainto_tsquery('english', $1)) AS rank
        FROM products
        WHERE search_vector @@ plainto_tsquery('english', $1)
          AND is_active = true
        ORDER BY rank DESC
        LIMIT $2
    `, q, limit)
    if err != nil {
        return nil, fmt.Errorf("search query: %w", err)
    }
    defer rows.Close()

    var products []Product
    for rows.Next() {
        var p Product
        var rank float32
        if err := rows.Scan(&p.ID, &p.Name, &p.PriceCents, &p.Brand, &rank); err != nil {
            return nil, err
        }
        products = append(products, p)
    }
    return products, rows.Err()
}
```

### Fuzzy Matching with pg_trgm

`tsvector` is built for linguistic search (stemming, stop words) but handles typos poorly - a search for "iphon" does not match "iphone". For fuzzy/typo-tolerant matching, PostgreSQL's `pg_trgm` extension indexes trigrams (3-character substrings) and supports similarity ranking and `LIKE '%pattern%'` queries at indexed speed:

```sql
CREATE EXTENSION pg_trgm;

-- GIN trigram index
CREATE INDEX idx_products_name_trgm ON products USING GIN (name gin_trgm_ops);

-- Similarity search (0.0 = unrelated, 1.0 = identical)
SELECT id, name, similarity(name, 'iphne') AS sim
FROM products
WHERE name % 'iphne'          -- % operator uses pg_trgm.similarity_threshold
ORDER BY sim DESC
LIMIT 10;

-- Fast LIKE '%...%' queries (usually unindexable)
SELECT id, name FROM products WHERE name ILIKE '%phone%';
```

Use `tsvector` for linguistic search (stemming "running" to "run"), `pg_trgm` for fuzzy/typo matching, and combine them when both are needed.

### PostgreSQL FTS vs Elasticsearch Trade-offs

**PostgreSQL FTS - use when**:
- Search is not your primary product feature
- Dataset is under ~10 million documents
- You need transactional consistency (search results must be consistent with database state)
- You want minimal operational complexity
- ACID requirements on search (search index in same transaction as data write)

**Elasticsearch - use when**:
- Search is a primary product feature (relevance tuning matters)
- Complex search requirements: fuzzy matching, faceted search, aggregations
- Dataset is very large (100M+ documents)
- You need advanced analyzers (stemming, synonyms, phonetic)
- Real-time analytics on search queries

### Search Index Patterns: Sync vs Async

**Synchronous**: Update search index in the same transaction as the data write.

```go
func (s *ProductService) Create(ctx context.Context, p CreateProductParams) (*Product, error) {
    product, err := s.repo.Create(ctx, p)
    if err != nil {
        return nil, err
    }

    // Synchronous: index update in same request
    if err := s.search.Index(ctx, product); err != nil {
        // Log but don't fail - search will catch up
        s.logger.Error("failed to index product", "error", err, "product_id", product.ID)
    }

    return product, nil
}
```

**Asynchronous via outbox pattern**: Publish an event, consumer updates search index.

```sql
-- Outbox table: events to be published
CREATE TABLE search_index_events (
    id          bigserial PRIMARY KEY,
    entity_type text NOT NULL,
    entity_id   uuid NOT NULL,
    operation   text NOT NULL,  -- 'upsert', 'delete'
    created_at  timestamptz NOT NULL DEFAULT now(),
    processed_at timestamptz
);

-- Trigger populates outbox on data changes
CREATE OR REPLACE FUNCTION queue_product_for_indexing()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO search_index_events (entity_type, entity_id, operation)
    VALUES ('product', COALESCE(NEW.id, OLD.id),
            CASE WHEN TG_OP = 'DELETE' THEN 'delete' ELSE 'upsert' END);
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER index_products
    AFTER INSERT OR UPDATE OR DELETE ON products
    FOR EACH ROW EXECUTE FUNCTION queue_product_for_indexing();
```

A background worker polls the outbox table, processes each event by indexing or deleting the corresponding document in the search engine, and marks the event as processed. This decouples the write path from search indexing latency.

```go
// Background worker processes outbox
func (w *SearchIndexWorker) Run(ctx context.Context) error {
    for {
        events, err := w.db.GetUnprocessedEvents(ctx, 100)
        if err != nil {
            return err
        }

        if len(events) == 0 {
            select {
            case <-ctx.Done():
                return ctx.Err()
            case <-time.After(1 * time.Second):
                continue
            }
        }

        for _, event := range events {
            if err := w.processEvent(ctx, event); err != nil {
                w.logger.Error("failed to process search event", "error", err, "event_id", event.ID)
                continue
            }
            w.db.MarkProcessed(ctx, event.ID)
        }
    }
}
```

### Junior → FAANG: Prerequisite Gaps and First-Job Context

Search is the feature where naive implementations fail quietly. The query returns results, they just are not the *right* results, and nobody notices until customer complaints pile up. The first distinction to internalize. "Full-text search" is not the same as `WHERE description ILIKE '%phone%'`. `ILIKE` is a substring match on raw bytes. Full-text search tokenizes, normalizes (lowercase, strip accents), stems (reduces "running" to "run"), removes stop words (a, the, of), and indexes an inverted map from tokens to documents. That is why "Wireless Headphones" matches a query for "wireless headphone," but `ILIKE '%wireless headphone%'` does not.

Worked example for a first job. You are adding product search to an e-commerce app. The junior trap is `WHERE name ILIKE '%' || $1 || '%' OR description ILIKE '%' || $1 || '%'`. This works for the demo and dies in production because (a) no index can help, (b) it misses stemming so "shoes" does not match "shoe," (c) multi-word queries match nothing because you concatenated the whole phrase. The right answer is a generated `tsvector` column with weighted fields (name weight A, description weight B, brand weight C), a GIN index on it, and `plainto_tsquery` wrapping the user input. Rank with `ts_rank` so that matches in the name float above matches in the description. At this point you have a 95th-percentile-acceptable product search in 30 lines of SQL.

Interview entry-point question. "A user types 'iphon 15 pro' into your search box. What happens?" A FAANG-ready answer walks the stages: tokenize, handle the typo on 'iphon' (pg_trgm similarity, or Elasticsearch fuzzy match with edit distance), detect the multi-word phrase, rank across matching fields, handle synonyms (Apple vs iPhone), filter by availability and active status, apply user-specific signals (past purchases, locale), paginate. Then mention that for a real product search you would A/B test ranking changes, log queries and click-throughs, and build a tuning loop. The difference between a junior and senior answer is that the senior answer treats search as a *product*, not a feature.

One more prerequisite. Know when Postgres FTS is enough. For under roughly 10M documents with straightforward search needs, Postgres tsvector plus pg_trgm with a good GIN index and weighted ranking is enough. You get transactional consistency (search is never stale relative to writes), one operational system, and no dual-write complexity. Graduate to a dedicated search engine when you hit one of: dataset above 50M docs, complex analyzers (phonetic, custom stemmers, CJK tokenization), heavy faceted aggregations, or when relevance tuning becomes a full-time product concern.

### Senior @ FAANG: Staff and Principal Material

The 2026 search architecture decision matrix has more options than it did three years ago. The contenders:

Postgres-native: tsvector + GIN, pg_trgm for fuzzy, pgvector for semantic embeddings, ParadeDB's `pg_search` extension for BM25 and Tantivy-backed search inside Postgres, ZomboDB for Elasticsearch-as-a-Postgres-index. ParadeDB as of 2026 is the serious "stay in Postgres" answer for BM25 relevance with real performance, and it fills the gap between native tsvector (simple, limited relevance tuning) and a separate search cluster. Use ParadeDB when you want BM25 scoring, phrase search, and fast facets without moving to Elasticsearch.

Elasticsearch / OpenSearch: still the default for large-scale search. OpenSearch diverged from Elasticsearch after the license change in 2021 and is the safer choice for anyone allergic to Elastic's SSPL. Both support BM25, vector search (HNSW, BM25+vector hybrid), aggregations, and geo queries. Operational cost is real. Multi-node clusters with proper sharding, replication, and shard rebalancing are a full-time operational workload. Index lifecycle management (ILM) for time-based indices, snapshot to S3 for backup, and careful heap tuning are non-negotiable.

Typesense: open-source, fast, developer-friendly, built for instant-search UX. Typo tolerance is first-class. Small footprint, good for product catalogs up to 100M docs. Limits on aggregation complexity. Use when search UX matters more than analytical search.

MeiliSearch: similar niche to Typesense, Rust-based, extremely fast for small-to-medium catalogs. v1.x maturity is fine. Less operationally battle-tested than Elasticsearch at huge scale but easier to run.

Qdrant, Weaviate, Pinecone, Milvus, LanceDB, Vespa: vector-first databases for semantic search with embeddings. Qdrant is Rust, open-source, strong filtered vector search. Weaviate is Go, has GraphQL API, built-in vectorizer modules. Pinecone is managed-only, and the pricing at scale bites. Vespa is the Yahoo/Verizon-origin search engine that supports both text and vectors with complex ranking phases, and is the right answer for very large hybrid search at FAANG scale. LanceDB is the new Arrow-native columnar vector store that colocates embeddings with your data lake in Parquet/Lance format.

Hybrid search is now the standard. Pure keyword search misses semantic matches ("car" vs "automobile"). Pure vector search misses exact matches ("iPhone 15 Pro" vs "iPhone 14 Pro" embeddings are close but you asked for 15). The production pattern in 2026 is to run both and fuse results with Reciprocal Rank Fusion (RRF). `score = sum(1 / (k + rank_in_list_i))` over keyword and vector result lists with k=60 is the starting point. Tune from there. Elasticsearch 8.x, OpenSearch 2.x, Vespa, and Weaviate all support hybrid with RRF natively. In Postgres, you can implement RRF in SQL by combining tsvector ranks with pgvector cosine distance rankings.

pgvector at FAANG scale. pgvector 0.7+ with HNSW indexes handles tens of millions of vectors in a single Postgres. Performance characteristics. HNSW build is slow (minutes to hours for 10M vectors) but query is fast (sub-10ms for k=10 on million-scale). IVFFlat builds faster but queries slower. For write-heavy embedding workloads, IVFFlat with periodic reindex. For read-heavy, HNSW. Half-precision (halfvec) and binary quantization (bit) in pgvector 0.7 cut storage 2x to 32x with modest recall loss, which is usually worth it for first-stage retrieval followed by re-ranking with full-precision vectors on the top 100 candidates. Pair with bm25 via ParadeDB or tsvector for hybrid.

Faceted search modeling. Facets are aggregations on filterable fields. Postgres can do this with GROUP BY on filtered results, but performance craters when you have 20 facets each with thousands of values. Elasticsearch and OpenSearch aggregations are purpose-built for this and scale fine. Typesense and MeiliSearch handle faceting natively. For Postgres-based faceting, materialize facet counts per common filter combination in a separate table, refreshed on write. Or use ClickHouse for the faceted analytics side and keep Postgres for transactional. For e-commerce with hundreds of categories and dozens of filter dimensions, Elasticsearch or Vespa is usually the right answer.

Synonym management. This is where search engineering becomes a product skill. Synonyms are rarely symmetric. "iphone" should match "apple phone" but not vice versa. Synonyms drift (brand renames, product launches). The infrastructure: a managed synonym file (Elasticsearch synonym analyzer, OpenSearch solr_synonyms), reloadable without reindex (Elasticsearch 8.x has `synonyms_set` API for dynamic updates), logged so you can A/B test synonym changes. For Postgres, use `ts_lexize` with a custom dictionary file in `$SHAREDIR/tsearch_data/`. Synonym curation requires human review of search logs, particularly the zero-result queries. If 5% of queries return zero results, there is low-hanging synonym fruit.

Typo tolerance design. Edit distance (Levenshtein) 1 for short words, 2 for longer words is the standard. Elasticsearch fuzzy query supports this with `fuzziness: AUTO`. Typesense and MeiliSearch have it built into every query. For Postgres, pg_trgm with similarity threshold gets you typo tolerance on short queries but is not as sophisticated. The gotcha: typo tolerance blows up relevance if applied too aggressively. Always prefer exact matches, then prefix matches, then fuzzy matches in your ranking. Also, disable typo tolerance for short queries under 3 characters because "is" matches too many tokens at edit distance 1.

Indexing strategy and freshness. Synchronous indexing in the request path is fine for low write rates and small documents. For high write rates, use the outbox pattern shown above with a consumer that batches writes to the search engine. Elasticsearch prefers bulk indexing in batches of 5-15 MB. Single-document indexing destroys throughput. For near-real-time requirements (results visible within 1 second), Elasticsearch refresh_interval defaults to 1s but you can tune it. For relaxed freshness (results visible within 1 minute), refresh_interval of 30s cuts indexing cost significantly. OpenSearch 2.x added segment replication which reduces the ingest load on replicas.

Zero-downtime reindex. You will need to reindex. Schema changes, analyzer changes, synonym changes, new fields. The pattern: alias indirection. Clients read from `products` alias pointing at `products_v1`. Build `products_v2` in parallel, backfill, switch the alias atomically. For Elasticsearch, this is `POST /_aliases` with remove-old-add-new in one call. For Postgres with tsvector, generated columns make schema changes cheap but dictionary changes require `UPDATE products SET search_vector = search_vector` (forces recomputation). For ParadeDB, `CREATE INDEX CONCURRENTLY` the new version and drop the old. Always have a kill-switch to route traffic back to the old index if the new one regresses relevance.

Relevance as a product feature. At FAANG scale, search relevance is measured, not assumed. The minimum setup: log every query, log every click with position, compute Mean Reciprocal Rank (MRR), Normalized Discounted Cumulative Gain (NDCG), and click-through rate (CTR) at position 1-3. A/B test every ranking change. Have a relevance review board that reviews zero-click queries, zero-result queries, and over-clicked low-position results (signal of ranking failure). Learning-to-rank (LTR) with XGBoost or similar, trained on click data, is the next step up from BM25+rules. Elasticsearch LTR plugin and Vespa native LTR are the production paths.

When to own search yourself. Managed search (Algolia, Pinecone, Elastic Cloud, OpenSearch Serverless) is great up to a few million queries per day. Above that, costs scale linearly and you will be paying seven figures annually for what is effectively a shard of search traffic. At that scale, owning the cluster is cheaper and gives you control over tuning and indexing. Make the TCO calculation explicit: cluster cost plus 1 SRE FTE plus data transfer plus backup versus managed-per-query-cost times expected query volume. The crossover is typically around 50 to 100 million queries per month.

What to push back on. "Let's just put everything in Elasticsearch as our primary database." No. Elasticsearch is not your source of truth. It loses data under split-brain scenarios (less so since 7.x with the newer cluster coordination layer, but still not the same guarantees as Postgres). Use Postgres or DynamoDB or Spanner as the source of truth, index into Elasticsearch via CDC or outbox, and be willing to rebuild the search index from scratch. If your search engine ever becomes authoritative, you will discover this during a recovery scenario when it is too late. "Let's use a vector database as the primary search." No again. Vector search is a complement to keyword search, not a replacement, and customers will type exact SKUs and product names that vector search handles poorly without a BM25 stage.

---
