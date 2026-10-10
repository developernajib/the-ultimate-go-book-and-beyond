## 116.7 pgvector with PostgreSQL

pgvector adds vector search capabilities to PostgreSQL, combining traditional relational features with similarity search.

### Operator classes: the detail that silently ruins recall

Before any code, learn the one pgvector fact that costs teams the most time. The distance operator in your query **must match the operator class of your index**, or PostgreSQL will not use the index at all. It will not error and it will not warn. It will fall back to a sequential scan, return perfectly correct results, and get slower and slower as the table grows, which is why this usually presents as a mysterious performance regression rather than as a bug.

| Operator | Distance | Operator class | Use when |
|---|---|---|---|
| `<->` | L2 / Euclidean | `vector_l2_ops` | Model trained for Euclidean |
| `<=>` | Cosine | `vector_cosine_ops` | Text embeddings (the usual choice) |
| `<#>` | Negative inner product | `vector_ip_ops` | Normalized vectors, want the cheapest |

Two traps in that table.

`<#>` returns the **negative** inner product, not the inner product. pgvector negates it so that "smaller is better" holds uniformly across every operator, which lets `ORDER BY ... LIMIT` use the index the same way for all three. It also means the raw number is negative and a similarity of 0.9 arrives as `-0.9`. Flip the sign for display, and do not "fix" the ordering.

The index and the query must agree. Build with `vector_cosine_ops` and query with `<->` and you get a silent sequential scan. If you need to search the same column by two different metrics, you need two indexes.

Finally, recall the geometry: on normalized vectors, all three operators produce the **same ranking**, so `<#>` is the cheapest correct choice. Normalize at write time and this decision stops being a correctness question.

```go
// pkg/vectordb/pgvector/client.go
package pgvector

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	// lib/pq is used here because it is the most familiar database/sql driver.
	// It is in maintenance mode, and pgx is the actively developed choice for
	// new work: it has a native protocol path, better performance, and
	// first-class pgvector support via pgvector-go's pgx integration. The SQL
	// in this file is driver-agnostic; only the import and connection setup
	// change. The single import (not a named import plus a blank one, which is
	// what the driver-registration idiom looks like when you only need the
	// side effect) is enough here because we reference pq.Array directly.
	"github.com/lib/pq"
	"github.com/pgvector/pgvector-go"

	"github.com/yourusername/gobook/pkg/vectordb"
)

// Config configures pgvector client
type Config struct {
	Host       string
	Port       int
	User       string
	Password   string
	Database   string
	SSLMode    string
	TableName  string
	Dimensions int
}

// Client is a pgvector client
type Client struct {
	db        *sql.DB
	config    Config
	tableName string
}

// NewClient creates a new pgvector client
func NewClient(ctx context.Context, config Config) (*Client, error) {
	if config.Host == "" {
		config.Host = "localhost"
	}
	if config.Port == 0 {
		config.Port = 5432
	}
	if config.SSLMode == "" {
		config.SSLMode = "disable"
	}
	if config.TableName == "" {
		return nil, fmt.Errorf("table name required")
	}
	if config.Dimensions == 0 {
		return nil, fmt.Errorf("dimensions required")
	}

	// Build connection string
	connStr := fmt.Sprintf("host=%s port=%d user=%s password=%s dbname=%s sslmode=%s",
		config.Host, config.Port, config.User, config.Password, config.Database, config.SSLMode)

	// Connect
	db, err := sql.Open("postgres", connStr)
	if err != nil {
		return nil, fmt.Errorf("opening database: %w", err)
	}

	// Test connection
	if err := db.PingContext(ctx); err != nil {
		return nil, fmt.Errorf("pinging database: %w", err)
	}

	return &Client{
		db:        db,
		config:    config,
		tableName: config.TableName,
	}, nil
}

// CreateExtension enables the pgvector extension
func (c *Client) CreateExtension(ctx context.Context) error {
	_, err := c.db.ExecContext(ctx, "CREATE EXTENSION IF NOT EXISTS vector")
	if err != nil {
		return fmt.Errorf("creating vector extension: %w", err)
	}
	return nil
}

// CreateTable creates the vector table
func (c *Client) CreateTable(ctx context.Context) error {
	query := fmt.Sprintf(`
		CREATE TABLE IF NOT EXISTS %s (
			id TEXT PRIMARY KEY,
			text TEXT,
			embedding vector(%d),
			metadata JSONB,
			created_at TIMESTAMP DEFAULT NOW()
		)
	`, c.tableName, c.config.Dimensions)

	_, err := c.db.ExecContext(ctx, query)
	if err != nil {
		return fmt.Errorf("creating table: %w", err)
	}

	return nil
}

// CreateIndex creates an index for fast similarity search
func (c *Client) CreateIndex(ctx context.Context, indexType IndexType) error {
	var query string

	switch indexType {
	case IVFFlatIndex:
		// IVFFLAT: partitions vectors into `lists` clusters and probes only the
		// nearest ones at query time.
		//
		// CRITICAL: ivfflat is a TRAINED index. Building it runs k-means over
		// the rows that exist AT BUILD TIME, so creating it on an empty or
		// nearly-empty table produces degenerate clusters and permanently bad
		// recall. It does not fix itself as you insert. Load your data FIRST,
		// then create the index.
		//
		// pgvector does tell you, but quietly and through a channel most code
		// throws away. It raises a NOTICE, not an error:
		//
		//   NOTICE:  ivfflat index created with little data
		//   DETAIL:  This will cause low recall.
		//   HINT:    Drop the index until the table has more data.
		//
		// CREATE INDEX still reports success, and database/sql discards server
		// notices entirely, so from Go this genuinely is silent unless you
		// wire up your driver's notice handler (pgx exposes one - lib/pq has
		// pq.ConnectorWithNoticeHandler). Migration tooling swallows it too.
		// Worth doing: this NOTICE is free evidence of a real defect.
		//
		// HNSW has no such constraint. It builds incrementally, can be created
		// on an empty table, and does not go stale as the distribution drifts,
		// whereas ivfflat needs periodic REINDEX to re-cluster.
		//
		// `lists` is a build-time constant here only for illustration. The
		// usual guidance is rows/1000 up to about 1M rows, and sqrt(rows)
		// beyond that, so it must be computed from the actual row count.
		query = fmt.Sprintf(`
			CREATE INDEX IF NOT EXISTS %s_embedding_ivfflat_idx
			ON %s
			USING ivfflat (embedding vector_cosine_ops)
			WITH (lists = 100)
		`, c.tableName, c.tableName)

	case HNSWIndex:
		// HNSW: better recall/latency than ivfflat and no training step, at the
		// cost of a slower build and more memory.
		//
		// m and ef_construction are FIXED AT BUILD TIME: changing either means
		// rebuilding the whole index. m=16 / ef_construction=64 are pgvector's
		// defaults - raising ef_construction buys recall for build time only,
		// costing nothing per query, so it is usually the first thing to raise.
		query = fmt.Sprintf(`
			CREATE INDEX IF NOT EXISTS %s_embedding_hnsw_idx
			ON %s
			USING hnsw (embedding vector_cosine_ops)
			WITH (m = 16, ef_construction = 64)
		`, c.tableName, c.tableName)

	default:
		return fmt.Errorf("unknown index type: %v", indexType)
	}

	_, err := c.db.ExecContext(ctx, query)
	if err != nil {
		return fmt.Errorf("creating index: %w", err)
	}

	return nil
}

// IndexType represents different index types
type IndexType int

const (
	IVFFlatIndex IndexType = iota
	HNSWIndex
)

// SetEfSearch tunes HNSW recall at QUERY time.
//
// This is the knob that matters operationally, and the one most people miss.
// m and ef_construction are baked into the index - hnsw.ef_search is a session
// GUC you can raise per query to buy recall with latency, without rebuilding
// anything. It must be >= your LIMIT, or you cannot possibly get k results back.
//
// Note the scope: SET applies to the SESSION, and with database/sql you are
// handed an arbitrary pooled connection each time, so a bare SET may land on a
// different connection than the query that follows it. Either run both on the
// same *sql.Conn (as here), or use SET LOCAL inside an explicit transaction.
func (c *Client) SetEfSearch(ctx context.Context, conn *sql.Conn, efSearch int) error {
	_, err := conn.ExecContext(ctx, fmt.Sprintf("SET hnsw.ef_search = %d", efSearch))
	if err != nil {
		return fmt.Errorf("setting hnsw.ef_search: %w", err)
	}
	return nil
}

// SetProbes is the ivfflat equivalent: how many clusters to probe per query.
// Higher means better recall and more work. A common starting point is
// sqrt(lists), and probes = lists degenerates to an exact scan.
func (c *Client) SetProbes(ctx context.Context, conn *sql.Conn, probes int) error {
	_, err := conn.ExecContext(ctx, fmt.Sprintf("SET ivfflat.probes = %d", probes))
	if err != nil {
		return fmt.Errorf("setting ivfflat.probes: %w", err)
	}
	return nil
}

// Upsert inserts or updates documents
func (c *Client) Upsert(ctx context.Context, docs []vectordb.Document) error {
	if len(docs) == 0 {
		return nil
	}

	// Use transaction for atomicity
	tx, err := c.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("beginning transaction: %w", err)
	}
	defer tx.Rollback()

	// Prepare statement
	stmt, err := tx.PrepareContext(ctx, fmt.Sprintf(`
		INSERT INTO %s (id, text, embedding, metadata, created_at)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (id) DO UPDATE SET
			text = EXCLUDED.text,
			embedding = EXCLUDED.embedding,
			metadata = EXCLUDED.metadata
	`, c.tableName))
	if err != nil {
		return fmt.Errorf("preparing statement: %w", err)
	}
	defer stmt.Close()

	// Insert each document
	for _, doc := range docs {
		// pgvector.NewVector takes []float32, matching the pgvector extension's
		// on-disk element type. Do not round-trip through []float64: it is a
		// compile error against the real library, and conceptually backwards,
		// since the column stores float32 and the conversion would only add a
		// lossy widen-then-narrow.
		vec := pgvector.NewVector(doc.Vector)

		// Convert metadata to JSON
		metadata, err := metadataToJSON(doc.Metadata)
		if err != nil {
			return fmt.Errorf("converting metadata: %w", err)
		}

		_, err = stmt.ExecContext(ctx, doc.ID, doc.Text, vec, metadata, doc.CreatedAt)
		if err != nil {
			return fmt.Errorf("inserting document %s: %w", doc.ID, err)
		}
	}

	// Commit transaction
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("committing transaction: %w", err)
	}

	return nil
}

// Query performs similarity search
func (c *Client) Query(ctx context.Context, vector vectordb.Vector, topK int, filter vectordb.Metadata) (*vectordb.SearchResponse, error) {
	start := time.Now()

	// Build query
	query := fmt.Sprintf(`
		SELECT id, text, metadata, 1 - (embedding <=> $1) AS similarity
		FROM %s
	`, c.tableName)

	args := []any{pgvector.NewVector(vector)}
	argIndex := 2

	// Add metadata filter.
	//
	// SECURITY: the metadata KEY must be a bound parameter, not interpolated.
	// Writing fmt.Sprintf("metadata->>'%s' = $%d", key, argIndex) is a SQL
	// injection hole, and a real one: metadata keys come from documents, which
	// come from users. A key of  x' = '' OR '1' = '1  turns your filter into a
	// tautology and leaks the whole table - worse payloads terminate the
	// statement and append their own.
	//
	// Binding the value while interpolating the key is the trap, because it
	// LOOKS parameterized. The ->> operator accepts a parameter on its right
	// side, so bind both sides and there is nothing left to inject into.
	if len(filter) > 0 {
		var conditions []string
		for key, value := range filter {
			conditions = append(conditions,
				fmt.Sprintf("metadata->>$%d = $%d", argIndex, argIndex+1))
			args = append(args, key, fmt.Sprintf("%v", value))
			argIndex += 2
		}
		query += " WHERE " + strings.Join(conditions, " AND ")
	}

	// Order by distance and limit. topK is an int we control, so interpolating
	// it is safe, but binding it costs nothing and keeps the rule simple:
	// never build SQL with Sprintf from anything that touched user input.
	query += fmt.Sprintf(" ORDER BY embedding <=> $1 LIMIT $%d", argIndex)
	args = append(args, topK)

	// Execute query
	rows, err := c.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("querying: %w", err)
	}
	defer rows.Close()

	// Parse results
	var results []vectordb.SearchResult

	for rows.Next() {
		var id, text string
		var metadata []byte
		var similarity float32

		err := rows.Scan(&id, &text, &metadata, &similarity)
		if err != nil {
			return nil, fmt.Errorf("scanning row: %w", err)
		}

		meta, err := jsonToMetadata(metadata)
		if err != nil {
			return nil, fmt.Errorf("parsing metadata: %w", err)
		}

		results = append(results, vectordb.SearchResult{
			ID:       id,
			Score:    similarity,
			Metadata: meta,
			Text:     text,
		})
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterating rows: %w", err)
	}

	return &vectordb.SearchResponse{
		Results:   results,
		QueryTime: time.Since(start),
	}, nil
}

// Delete removes documents by ID
func (c *Client) Delete(ctx context.Context, ids []string) error {
	if len(ids) == 0 {
		return nil
	}

	query := fmt.Sprintf("DELETE FROM %s WHERE id = ANY($1)", c.tableName)
	_, err := c.db.ExecContext(ctx, query, pq.Array(ids))
	if err != nil {
		return fmt.Errorf("deleting: %w", err)
	}

	return nil
}

// Fetch retrieves documents by ID
func (c *Client) Fetch(ctx context.Context, ids []string) ([]vectordb.Document, error) {
	if len(ids) == 0 {
		return nil, nil
	}

	query := fmt.Sprintf(`
		SELECT id, text, embedding, metadata, created_at
		FROM %s
		WHERE id = ANY($1)
	`, c.tableName)

	rows, err := c.db.QueryContext(ctx, query, pq.Array(ids))
	if err != nil {
		return nil, fmt.Errorf("fetching: %w", err)
	}
	defer rows.Close()

	var docs []vectordb.Document

	for rows.Next() {
		var id, text string
		var embedding pgvector.Vector
		var metadata []byte
		var createdAt time.Time

		err := rows.Scan(&id, &text, &embedding, &metadata, &createdAt)
		if err != nil {
			return nil, fmt.Errorf("scanning row: %w", err)
		}

		meta, err := jsonToMetadata(metadata)
		if err != nil {
			return nil, fmt.Errorf("parsing metadata: %w", err)
		}

		docs = append(docs, vectordb.Document{
			ID:        id,
			Text:      text,
			Vector:    vectordb.Vector(embedding.Slice()),
			Metadata:  meta,
			CreatedAt: createdAt,
		})
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterating rows: %w", err)
	}

	return docs, nil
}

// Close closes the database connection
func (c *Client) Close() error {
	return c.db.Close()
}

// Helper functions

// metadataToJSON serializes metadata for the JSONB column.
//
// The version this replaced returned []byte("{}") unconditionally with a note
// saying "in production, use encoding/json". That is not a simplification, it
// is silent data loss: every document's metadata is written as an empty object,
// so every metadata filter matches nothing and every Fetch returns bare
// documents. Nothing errors. You would go looking for the bug in your filter
// syntax, your JSONB operators, and your index before suspecting the helper
// that "obviously" works. If a stub cannot do the job, it should return an
// error, not a plausible-looking wrong answer.
func metadataToJSON(m vectordb.Metadata) ([]byte, error) {
	if m == nil {
		return []byte("{}"), nil
	}
	b, err := json.Marshal(m)
	if err != nil {
		return nil, fmt.Errorf("marshaling metadata: %w", err)
	}
	return b, nil
}

// jsonToMetadata deserializes the JSONB column.
//
// Remember what comes back: encoding/json decodes every JSON number into a
// float64. Metadata that went in as an int comes out as a float64, so a
// downstream `.(int)` assertion panics. Assert on float64 and convert, or use
// json.Number if you need exact integers.
func jsonToMetadata(data []byte) (vectordb.Metadata, error) {
	if len(data) == 0 {
		return make(vectordb.Metadata), nil
	}
	m := make(vectordb.Metadata)
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, fmt.Errorf("unmarshaling metadata: %w", err)
	}
	return m, nil
}

// HybridSearch performs hybrid vector + full-text search using Reciprocal Rank
// Fusion over a UNION of the two result sets.
//
// The obvious implementation has two bugs that cancel out its entire purpose.
//
// Bug one is the WHERE clause. Filtering on
//
//	WHERE to_tsvector('english', text) @@ plainto_tsquery('english', $2)
//
// makes the query an INTERSECTION: a document must match the keywords to be
// considered at all, and its vector score merely re-ranks the survivors. That
// deletes the entire reason for hybrid search, since the semantic matches you
// wanted (the document that says "exception management" when the user asked
// about "error handling") share no keywords and are excluded before scoring.
// Hybrid search is a UNION of two retrievers, not a vector re-rank of BM25.
//
// Bug two is the weighted sum. ts_rank and cosine similarity are not
// commensurable: ts_rank is an unbounded, corpus- and length-dependent score
// that typically lands in a small fraction near zero, while (1 - cosine
// distance) clusters near 1. Adding them with weights means the cosine term
// dominates almost regardless of the weights you pass, so vectorWeight looks
// like a working knob while doing very little. RRF fuses on RANK, which needs
// no calibration precisely because it never compares the two scales.
func (c *Client) HybridSearch(ctx context.Context, queryText string, queryVector vectordb.Vector, topK int, rrfK int) (*vectordb.SearchResponse, error) {
	if rrfK <= 0 {
		rrfK = 60 // conventional RRF smoothing constant
	}

	// Each branch retrieves its own top-N independently, then we fuse by rank.
	// Over-fetch per branch (topK*4) so that a document ranked well by only one
	// retriever still has a chance to surface after fusion.
	query := fmt.Sprintf(`
		WITH vector_hits AS (
			SELECT id, text, metadata,
			       ROW_NUMBER() OVER (ORDER BY embedding <=> $1) AS rank
			FROM %[1]s
			ORDER BY embedding <=> $1
			LIMIT $3
		),
		keyword_hits AS (
			SELECT id, text, metadata,
			       ROW_NUMBER() OVER (
			           ORDER BY ts_rank(to_tsvector('english', text),
			                            plainto_tsquery('english', $2)) DESC
			       ) AS rank
			FROM %[1]s
			WHERE to_tsvector('english', text) @@ plainto_tsquery('english', $2)
			LIMIT $3
		)
		SELECT
			COALESCE(v.id, k.id)             AS id,
			COALESCE(v.text, k.text)         AS text,
			COALESCE(v.metadata, k.metadata) AS metadata,
			COALESCE(1.0 / ($4 + v.rank), 0.0) +
			COALESCE(1.0 / ($4 + k.rank), 0.0) AS score
		FROM vector_hits v
		FULL OUTER JOIN keyword_hits k ON v.id = k.id
		ORDER BY score DESC
		LIMIT $5
	`, c.tableName)

	vec := pgvector.NewVector(queryVector)

	rows, err := c.db.QueryContext(ctx, query, vec, queryText, topK*4, rrfK, topK)
	if err != nil {
		return nil, fmt.Errorf("hybrid search: %w", err)
	}
	defer rows.Close()

	var results []vectordb.SearchResult

	for rows.Next() {
		var id, text string
		var metadata []byte
		var score float32

		if err := rows.Scan(&id, &text, &metadata, &score); err != nil {
			return nil, fmt.Errorf("scanning row: %w", err)
		}

		meta, _ := jsonToMetadata(metadata)

		results = append(results, vectordb.SearchResult{
			ID:       id,
			Score:    score,
			Metadata: meta,
			Text:     text,
		})
	}

	return &vectordb.SearchResponse{
		Results: results,
	}, nil
}
```

### Junior → FAANG: pgvector as the Pragmatic Starting Point

pgvector is the pragmatic choice for teams that already operate PostgreSQL and want to add vector search capabilities without introducing a new database system. The operational overhead is minimal: add the pgvector extension to an existing PostgreSQL instance, create a vector column, build an IVF or HNSW index, and query with the `<=>` cosine distance operator. The integration with existing PostgreSQL features (transactions, foreign keys, joins, row-level security) is a significant advantage for use cases where vector search results need to be joined with relational data.

The pgvector HNSW index (added in pgvector 0.5.0) is now competitive with dedicated vector databases for moderate-scale workloads (up to tens of millions of vectors). The IVF_FLAT index is better suited for larger collections but requires the `lists` parameter to be tuned: a good starting point is `sqrt(count)` where count is the number of vectors, and the `probes` parameter during query controls the recall-latency tradeoff. Practice implementing these index configurations and benchmarking the recall versus latency tradeoff for your data distribution.

The Go integration uses the `pgvector-go` library, which supplies a `Vector` type implementing `sql.Scanner` and `driver.Valuer` so embeddings pass through `database/sql` like any other value. It works with either driver: the code above uses `lib/pq` for familiarity, but `pgx` is the better default for new work and `pgvector-go` ships a dedicated pgx integration. Note that `pgvector.NewVector` takes `[]float32`, matching the extension's element type, so converting to `[]float64` on the way in is both a compile error and a pointless lossy round trip. Implementing a RAG system backed by pgvector is an excellent portfolio project because it uses familiar Go and PostgreSQL skills while demonstrating vector search competence. A system that stores document embeddings in pgvector, retrieves similar documents using a parameterized SQL query, and assembles LLM prompts from the retrieved context is a complete and deployable demonstration of the RAG pattern.

### Senior @ FAANG: pgvector Scaling and the Specialization Decision

pgvector's production scaling characteristics differ from dedicated vector databases in one way that dominates all the others: the index lives in PostgreSQL's buffer cache and competes with everything else in the database for it. That is the whole story. As long as the HNSW index is resident, latency is fine for a broad range of production workloads. Once it does not fit, every query starts touching disk on random graph hops, which is the access pattern HNSW is worst at, and latency does not degrade gracefully, it falls off a cliff.

The consequence is a concrete capacity rule: size `shared_buffers` and total RAM against the index, and know the index's size rather than guessing. Compute it as vectors × dimensions × 4 bytes for the raw float32 data, then add the graph's own overhead on top. Measure the real figure with `pg_relation_size()` on the index rather than trusting an estimate, and alert on the ratio of index size to available cache, because that ratio is your leading indicator. Do not quote a latency number from a book, including this one: run the benchmark on your data, at your dimensionality, at your target recall, on your hardware.

The decision to migrate from pgvector to a dedicated vector database should be triggered by specific signals: query latency exceeding the SLO even with index and hardware tuning, collection growing beyond the memory capacity of a single PostgreSQL node, or ingestion throughput requirements exceeding what PostgreSQL can handle. This migration is expensive, so the decision should be made deliberately based on measured production data rather than anticipatory over-engineering.

At L6, pgvector's role in the vector infrastructure architecture is a strategic positioning decision. For organizations where PostgreSQL is the primary data store, pgvector enables a "single database" architecture where vector search and relational data coexist without cross-system joins. This simplifies the technology stack, reduces operational overhead, and lowers the architectural complexity for the engineering team. The decision to accept this tradeoff must be documented in an ADR with the scaling thresholds that would trigger a migration, giving the team a pre-agreed decision framework rather than having to make the migration decision under the pressure of an imminent scaling crisis.

---

### Production Case Study: Scaling 10M Embeddings in PostgreSQL (`halfvec` & Iterative Scan)

Production architectures often debate whether to deploy a specialized vector engine (e.g., Pinecone, Milvus, or Qdrant) or to keep embeddings within PostgreSQL. In [10M Embeddings: Postgres Was Slower, Cheaper, And Still The Right Call](https://medium.com/@threadwhisperer/10m-embeddings-postgres-was-slower-cheaper-and-still-the-right-call-5272a818304d), The Thread Whisperer documents how an engineering team evaluated this trade-off when scaling a corpus to 10 million 768-dimensional document embeddings.

#### 1. The Dual-System Synchronization Dilemma

Splitting data across PostgreSQL (for relational entities, user permissions, and transactional records) and an external vector engine creates architectural liabilities:

1. **Dual-Write Inconsistency & Race Windows**: When documents mutate or are deleted in PostgreSQL, updates must propagate to the vector database via Change Data Capture (CDC) or event queues. Network delays or worker crashes leave windows where vector search returns "phantom hits" - pointers to documents that have been hard-deleted or revoked in PostgreSQL.
2. **Two-Hop Authorization Penalties**: After the vector database returns top-k document IDs, the application must execute an additional `SELECT ... WHERE id IN (...)` query against PostgreSQL to check tenant isolation and row-level security (RLS). If 8 out of 10 returned vectors belong to unauthorized tenants, the system under-fetches and must perform repeated retrieval rounds.
3. **Operational Overhead**: Managing two distributed stateful systems increases deployment complexity and operational runbooks.

Keeping embeddings in PostgreSQL guarantees strict ACID consistency: a document deletion inside a transaction immediately removes the embedding from search results without synchronization lag.

#### 2. The 10M Memory Wall: Float32 vs. Halfvec (FP16)

The primary operational constraint of pgvector at scale is RAM residency. With 10 million vectors of 768 dimensions using standard 32-bit floating point (`vector(768)`):

```text
Raw Vectors = 10,000,000 × 768 × 4 bytes ≈ 30.72 GB
```

Adding HNSW graph edges (m = 16, ef_construction = 64) requires an additional 12-15 GB of index structures, pushing the working set above 45 GB. When the HNSW index exceeds `shared_buffers` and available operating system page cache, graph traversals trigger random read I/O against disk. Because HNSW relies on random neighbor hops across memory, disk thrashing degrades search latency from 25ms to over 2,500ms.

pgvector addresses this with 16-bit half-precision floating-point vectors (`halfvec`):

```text
Half-Precision Vectors = 10,000,000 × 768 × 2 bytes ≈ 15.36 GB
```

By reducing the vector footprint by 50%, the entire 10M HNSW index (approximately 23 GB total with graph edges) fits comfortably within a standard 32 GB or 64 GB database instance:

```sql
-- Convert or store as halfvec(768)
ALTER TABLE documents ADD COLUMN embedding_fp16 halfvec(768);
UPDATE documents SET embedding_fp16 = embedding::halfvec(768);

-- Build HNSW index using halfvec cosine operator class
CREATE INDEX idx_documents_halfvec_hnsw 
ON documents USING hnsw (embedding_fp16 halfvec_cosine_ops)
WITH (m = 16, ef_construction = 64);
```

Empirical recall testing on 768-dimension embeddings shows over 99% rank overlap between `halfvec` and full `float32`, making the precision loss negligible for semantic text retrieval while keeping the index entirely memory-resident.

#### 3. The Selective Filtering Trap & Iterative Scan

A common failure mode in multi-tenant RAG systems occurs when combining vector similarity with selective SQL predicates:

```sql
SELECT id, text, embedding_fp16 <=> $1 AS distance
FROM documents
WHERE tenant_id = $2 AND is_archived = FALSE
ORDER BY distance
LIMIT 10;
```

In standard HNSW execution (post-filtering), the planner queries the HNSW index for the nearest $ef\_search$ candidates across the entire dataset, then filters out rows that fail the `WHERE` clause. If `tenant_id = $2` matches only 0.1% of the database, all $ef\_search$ candidates may belong to other tenants. PostgreSQL exhausts the candidate list and returns an empty set or fewer than 10 rows, even though thousands of matching rows exist.

pgvector 0.7+ resolves this with **iterative index scanning**:

```sql
-- Enable iterative graph traversal for filtered queries
SET hnsw.iterative_scan = relaxed_order;
SET hnsw.max_scan_tuples = 20000;
```

With `hnsw.iterative_scan` enabled, if the initial search candidates do not satisfy the `WHERE` clause, the index scan continues expanding graph neighbors until the requested `LIMIT` of qualifying tuples is satisfied or `max_scan_tuples` is reached.

#### 4. Go Implementation: Half-Precision Querying

In Go applications using `github.com/pgvector/pgvector-go`, halfvec querying can be executed by passing raw float32 slices and casting at the SQL layer, or using pgvector's halfvec scanner:

```go
package pgvector

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/pgvector/pgvector-go"
)

type DocumentResult struct {
	ID       string
	Text     string
	Distance float32
}

// SearchTenantHalfvec performs similarity search with tenant filtering and iterative scan.
func (c *Client) SearchTenantHalfvec(
	ctx context.Context,
	tenantID string,
	queryVec []float32,
	limit int,
) ([]DocumentResult, error) {
	// Set iterative scan session knobs for filtered vector retrieval
	tx, err := c.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback()

	if _, err := tx.ExecContext(ctx, "SET LOCAL hnsw.iterative_scan = relaxed_order"); err != nil {
		return nil, fmt.Errorf("set iterative_scan: %w", err)
	}

	query := `
		SELECT id, text, embedding_fp16 <=> $1::halfvec AS distance
		FROM documents
		WHERE tenant_id = $2 AND is_archived = FALSE
		ORDER BY distance ASC
		LIMIT $3;
	`

	vecParam := pgvector.NewVector(queryVec)
	rows, err := tx.QueryContext(ctx, query, vecParam, tenantID, limit)
	if err != nil {
		return nil, fmt.Errorf("querying halfvec: %w", err)
	}
	defer rows.Close()

	var results []DocumentResult
	for rows.Next() {
		var r DocumentResult
		if err := rows.Scan(&r.ID, &r.Text, &r.Distance); err != nil {
			return nil, fmt.Errorf("scanning row: %w", err)
		}
		results = append(results, r)
	}

	return results, nil
}
```

#### 5. Architecture Decision Outcome

| Architecture Dimension | Dedicated Vector DB Cluster | PostgreSQL + pgvector (`halfvec`) |
|---|---|---|
| **Monthly Infrastructure Cost** | ~$2,900/mo (managed nodes + replication) | ~$640/mo (single scaled RDS/Aurora instance) |
| **Data Consistency** | Eventual consistency via CDC / async queue | Strict ACID in the same transactional commit |
| **Operational Stack** | 2 databases (PostgreSQL + Vector engine) | 1 database (PostgreSQL with extension) |
| **Filtered Search Strategy** | External pre-filtering or metadata payload | Native SQL joins, RLS, and iterative scan |
| **p95 Latency (10M scale)** | ~18ms | ~38ms |

For teams requiring sub-10ms latency at hundreds of millions of vectors, dedicated vector engines remain justified. However, for datasets up to 10M embeddings where relational consistency, tenant isolation, and operational simplicity take priority, PostgreSQL with `halfvec` delivers a 78% infrastructure cost reduction without the synchronization bugs of a split architecture.
