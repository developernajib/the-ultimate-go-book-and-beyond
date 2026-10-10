## 118C.5 In-Memory Vector Store & Production pgvector

The in-memory vector store uses a `sync.RWMutex`-protected slice for development and testing, while the pgvector production variant delegates to PostgreSQL's `<=>` cosine distance operator via a parameterized SQL query. Both implementations satisfy the same `VectorStore` interface, so the application switches from in-memory to pgvector by swapping the constructor, no other code changes required.

That last sentence is the promise, and it is also the risk. Two implementations of one interface have to agree about behaviour, not just about method signatures, and the compiler checks only the signatures. Watch for where the two stores below could drift apart: the filter argument, and how metadata values compare after a round trip through JSONB. Both are commented in place, because both are the kind of divergence that passes every test written against the in-memory store.

```go
package vectorstore

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"math"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/lib/pq"
	"github.com/yourorg/rag"
)

// InMemoryVectorStore for testing and small datasets
type InMemoryVectorStore struct {
	mu   sync.RWMutex
	docs []rag.Document
}

func NewInMemoryVectorStore() *InMemoryVectorStore {
	return &InMemoryVectorStore{}
}

func (s *InMemoryVectorStore) Upsert(ctx context.Context, docs []rag.Document) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Index by ID for update
	idx := make(map[string]int)
	for i, d := range s.docs {
		idx[d.ID] = i
	}

	for _, doc := range docs {
		if i, ok := idx[doc.ID]; ok {
			s.docs[i] = doc
			continue
		}
		// Record the new position too. Without this, a batch containing the
		// same ID twice appends it twice: the second occurrence misses the
		// stale index and the store quietly holds a duplicate, which then
		// returns the same chunk twice in one retrieval.
		idx[doc.ID] = len(s.docs)
		s.docs = append(s.docs, doc)
	}
	return nil
}

func (s *InMemoryVectorStore) Search(ctx context.Context, embedding []float32, topK int, filter map[string]any) ([]rag.SearchResult, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	type scored struct {
		doc   rag.Document
		score float64
	}

	var results []scored
	for _, doc := range s.docs {
		if !matchesFilter(doc.Metadata, filter) {
			continue
		}
		score := cosineSimilarity(embedding, doc.Embedding)
		results = append(results, scored{doc, score})
	}

	sort.Slice(results, func(i, j int) bool {
		return results[i].score > results[j].score
	})

	if topK > len(results) {
		topK = len(results)
	}

	searchResults := make([]rag.SearchResult, topK)
	for i := 0; i < topK; i++ {
		searchResults[i] = rag.SearchResult{
			Document: results[i].doc,
			Score:    results[i].score,
		}
	}
	return searchResults, nil
}

func (s *InMemoryVectorStore) Delete(ctx context.Context, ids []string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	idSet := make(map[string]bool)
	for _, id := range ids {
		idSet[id] = true
	}

	filtered := s.docs[:0]
	for _, doc := range s.docs {
		if !idSet[doc.ID] {
			filtered = append(filtered, doc)
		}
	}
	s.docs = filtered
	return nil
}

// PgVectorStore uses PostgreSQL + pgvector for production
type PgVectorStore struct {
	db         *sql.DB
	table      string
	dimensions int
}

// identifierRe bounds what may be used as a table name.
//
// SQL identifiers cannot be bound as parameters: there is no $1 that can stand
// in for a table name, so the name has to be interpolated. That makes it the one
// place string-building is unavoidable, and therefore the one place to be strict.
// Validate against an allowlist pattern at construction, and quote at use.
var identifierRe = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]*$`)

func NewPgVectorStore(db *sql.DB, table string, dimensions int) (*PgVectorStore, error) {
	if !identifierRe.MatchString(table) {
		return nil, fmt.Errorf("invalid table name %q", table)
	}
	if dimensions <= 0 {
		return nil, fmt.Errorf("dimensions must be positive, got %d", dimensions)
	}
	store := &PgVectorStore{db: db, table: table, dimensions: dimensions}
	if err := store.initialize(context.Background()); err != nil {
		return nil, err
	}
	return store, nil
}

func (s *PgVectorStore) initialize(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `CREATE EXTENSION IF NOT EXISTS vector`)
	if err != nil {
		return err
	}

	quoted := pq.QuoteIdentifier(s.table)

	_, err = s.db.ExecContext(ctx, fmt.Sprintf(`
		CREATE TABLE IF NOT EXISTS %s (
			id TEXT PRIMARY KEY,
			content TEXT NOT NULL,
			embedding vector(%d),
			metadata JSONB,
			source TEXT,
			created_at TIMESTAMPTZ DEFAULT NOW()
		)
	`, quoted, s.dimensions))
	if err != nil {
		return err
	}

	// HNSW index for fast approximate nearest neighbour search.
	//
	// The operator class must match the operator used at query time.
	// vector_cosine_ops pairs with <=>. Build the index with vector_l2_ops and
	// then query with <=> and Postgres simply will not use the index: the query
	// still returns correct rows, by sequential scan, so the only symptom is
	// that it gets slower and slower as the table grows.
	_, err = s.db.ExecContext(ctx, fmt.Sprintf(`
		CREATE INDEX IF NOT EXISTS %s
		ON %s USING hnsw (embedding vector_cosine_ops)
		WITH (m = 16, ef_construction = 64)
	`, pq.QuoteIdentifier(s.table+"_embedding_idx"), quoted))
	if err != nil {
		return err
	}

	// GIN index backing the metadata @> filter in Search.
	_, err = s.db.ExecContext(ctx, fmt.Sprintf(`
		CREATE INDEX IF NOT EXISTS %s ON %s USING gin (metadata)
	`, pq.QuoteIdentifier(s.table+"_metadata_idx"), quoted))
	return err
}

func (s *PgVectorStore) Upsert(ctx context.Context, docs []rag.Document) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	stmt, err := tx.PrepareContext(ctx, fmt.Sprintf(`
		INSERT INTO %s (id, content, embedding, metadata, source)
		VALUES ($1, $2, $3::vector, $4::jsonb, $5)
		ON CONFLICT (id) DO UPDATE
		SET content = EXCLUDED.content,
			embedding = EXCLUDED.embedding,
			metadata = EXCLUDED.metadata
	`, pq.QuoteIdentifier(s.table)))
	if err != nil {
		return err
	}
	defer stmt.Close()

	for _, doc := range docs {
		if len(doc.Embedding) != s.dimensions {
			// Postgres would reject this anyway, but the error it returns names
			// no document. Failing here says which one.
			return fmt.Errorf("doc %s: embedding has %d dimensions, store expects %d",
				doc.ID, len(doc.Embedding), s.dimensions)
		}

		metadata, err := json.Marshal(doc.Metadata)
		if err != nil {
			return fmt.Errorf("doc %s: marshal metadata: %w", doc.ID, err)
		}

		// Convert []float32 to pgvector's text format, bound as a parameter.
		embStr := vectorToString(doc.Embedding)
		if _, err := stmt.ExecContext(ctx, doc.ID, doc.Content, embStr, string(metadata), doc.Source); err != nil {
			return fmt.Errorf("doc %s: upsert: %w", doc.ID, err)
		}
	}

	return tx.Commit()
}

// Search returns the topK nearest documents, honouring filter.
//
// Two things here were wrong in an earlier draft and are worth calling out,
// because both failures are silent.
//
// First, the vector was interpolated into the SQL with fmt.Sprintf rather than
// bound as a parameter. Formatted floats happen not to be exploitable, which is
// exactly why this survives review: it is the pattern that is wrong, not this
// particular string. The moment anything with a quote in it reaches a Sprintf'd
// query, it is an injection. Bind values as parameters, always, and let the
// identifier be the only thing you interpolate (validated, below).
//
// Second, filter was accepted and then ignored, while the in-memory store
// honoured it. Two implementations of one interface disagreeing about whether a
// parameter does anything is bad on its own. It is a vulnerability when filter
// is what scopes retrieval to a tenant or to documents the caller may read: the
// tests pass against the in-memory store, and production returns everyone's
// documents to everyone. If an argument narrows what a caller is allowed to
// see, every implementation must enforce it or refuse to run.
func (s *PgVectorStore) Search(ctx context.Context, embedding []float32, topK int, filter map[string]any) ([]rag.SearchResult, error) {
	args := []any{vectorToString(embedding)}

	where := ""
	if len(filter) > 0 {
		filterJSON, err := json.Marshal(filter)
		if err != nil {
			return nil, fmt.Errorf("marshal filter: %w", err)
		}
		args = append(args, string(filterJSON))
		// @> is JSONB containment: rows whose metadata contains every key/value
		// in the filter. Indexable with a GIN index on metadata.
		where = fmt.Sprintf("WHERE metadata @> $%d::jsonb", len(args))
	}

	args = append(args, topK)

	query := fmt.Sprintf(`
		SELECT id, content, metadata, source,
			   1 - (embedding <=> $1::vector) AS score
		FROM %s
		%s
		ORDER BY embedding <=> $1::vector
		LIMIT $%d
	`, pq.QuoteIdentifier(s.table), where, len(args))

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var results []rag.SearchResult
	for rows.Next() {
		var (
			id, content  string
			source       sql.NullString
			metadataJSON []byte
			score        float64
		)
		if err := rows.Scan(&id, &content, &metadataJSON, &source, &score); err != nil {
			return nil, err
		}

		var metadata map[string]any
		if err := json.Unmarshal(metadataJSON, &metadata); err != nil {
			return nil, fmt.Errorf("decode metadata for %s: %w", id, err)
		}

		results = append(results, rag.SearchResult{
			Document: rag.Document{
				ID:       id,
				Content:  content,
				Metadata: metadata,
				// source is nullable in the schema - scanning a NULL into a
				// plain string errors at runtime.
				Source: source.String,
			},
			Score: score,
		})
	}

	// rows.Err reports an error that ended iteration early. Skip it and a
	// connection failure mid-scan looks like a short but successful result set.
	if err := rows.Err(); err != nil {
		return nil, err
	}

	return results, nil
}

func (s *PgVectorStore) Delete(ctx context.Context, ids []string) error {
	_, err := s.db.ExecContext(ctx,
		fmt.Sprintf("DELETE FROM %s WHERE id = ANY($1)", pq.QuoteIdentifier(s.table)),
		pq.Array(ids))
	return err
}

func vectorToString(v []float32) string {
	parts := make([]string, len(v))
	for i, f := range v {
		// 'g' with -1 precision round-trips a float32 exactly and stays compact.
		// "%f" fixes six decimal places, which both loses precision on small
		// components and wastes bytes on every vector you ever send.
		parts[i] = strconv.FormatFloat(float64(f), 'g', -1, 32)
	}
	return "[" + strings.Join(parts, ",") + "]"
}

// cosineSimilarity returns the cosine of the angle between a and b, in [-1, 1].
//
// The subtlety worth internalising: cosine similarity equals the dot product
// ONLY when both vectors are unit length. Cosine divides the dot product by both
// magnitudes, which is what makes it a measure of direction alone.
//
// This trips people up in both directions. Skip the normalisation because "the
// embeddings are normalised anyway" and you are relying on a property of the
// provider that a model upgrade can quietly revoke. Conversely, if your vectors
// really are unit length, the divisions are wasted work, and pre-normalising at
// ingest so you can use a plain dot product is a standard and worthwhile
// optimisation. What you must not do is assume normalisation without checking
// and then use dot product: unnormalised, the dot product rewards long vectors,
// so retrieval starts preferring whichever chunks happen to have large
// magnitude rather than whichever ones are actually relevant. That failure is
// invisible in unit tests and shows up as "retrieval quality is mediocre".
func cosineSimilarity(a, b []float32) float64 {
	if len(a) != len(b) {
		return 0
	}
	var dot, normA, normB float64
	for i := range a {
		dot += float64(a[i]) * float64(b[i])
		normA += float64(a[i]) * float64(a[i])
		normB += float64(b[i]) * float64(b[i])
	}
	if normA == 0 || normB == 0 {
		return 0
	}
	return dot / (math.Sqrt(normA) * math.Sqrt(normB))
}

// matchesFilter reports whether metadata satisfies every key/value in filter.
//
// Two traps live in the one-line version of this function (`metadata[k] != v`).
//
// The first is a panic: == on interface values panics at runtime if the dynamic
// type is uncomparable (a slice or a map). A filter value arriving from decoded
// JSON can be a []any, so this is reachable from user input.
//
// The second is the float64 trap. Metadata that has round-tripped through JSON
// has numbers decoded as float64, always: JSON has one number type. So a filter
// of map[string]any{"year": 2024} (an int) never matches metadata holding
// float64(2024), because interface equality compares dynamic *type* first. The
// in-memory store, fed structs directly, would match on int and the pgvector
// store, fed through JSONB, would not. Normalising numerics to float64 before
// comparing keeps the two implementations honest.
func matchesFilter(metadata, filter map[string]any) bool {
	for k, want := range filter {
		got, ok := metadata[k]
		if !ok {
			return false
		}
		if !valueEqual(got, want) {
			return false
		}
	}
	return true
}

func valueEqual(a, b any) bool {
	if an, ok := toFloat(a); ok {
		if bn, ok := toFloat(b); ok {
			return an == bn
		}
		return false
	}
	// reflect.DeepEqual rather than ==: never panics, and handles the
	// uncomparable dynamic types that == would blow up on.
	return reflect.DeepEqual(a, b)
}

// toFloat normalises every numeric kind to float64 so an int filter matches a
// JSON-decoded float64 value.
func toFloat(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case float32:
		return float64(n), true
	case int:
		return float64(n), true
	case int32:
		return float64(n), true
	case int64:
		return float64(n), true
	case json.Number:
		f, err := n.Float64()
		return f, err == nil
	default:
		return 0, false
	}
}
```

---

### Junior → FAANG: Vector Store Interface as Dependency Inversion Interview Topic

The in-memory vector store and pgvector production implementation both satisfying the same VectorStore interface is the Dependency Inversion Principle applied concretely. The application code depends on the VectorStore abstraction, not on a specific vector database implementation. This enables: fast unit tests with the in-memory store (no database required), easy switching to a different production store (swap the constructor), and mock-based testing for performance-sensitive code paths. This pattern is the same one used for any persistence layer in Go and is a standard interview topic under the heading of "how do you make your Go services testable?"

The `sync.RWMutex`-protected slice for the in-memory store demonstrates the Go concurrency primitive that allows concurrent readers and exclusive writers. For a vector store, readers (similarity search) are much more frequent than writers (inserting new documents), making RWMutex more efficient than Mutex: multiple goroutines can search simultaneously without blocking each other, and only the insert operation requires an exclusive lock. Understanding the performance difference between Mutex and RWMutex, and knowing which to use based on read/write ratio, is Go concurrency fluency.

The `<=>` cosine distance operator in pgvector is the SQL expression that replaces the similarity loop in the in-memory implementation with a database-accelerated operation using HNSW or IVFFlat indexes. Knowing that pgvector requires an explicit index creation step (`CREATE INDEX ... USING hnsw ...`) for efficient similarity search, and that without an index the query performs a linear scan that degrades as O(n) with the number of vectors, is production vector database knowledge that FAANG AI infrastructure interviews test.

Two follow-ups reliably separate people who have run this from people who have read about it. First, the index's operator class has to match the query's operator: `vector_cosine_ops` goes with `<=>`, `vector_l2_ops` with `<->`. Mismatch them and Postgres silently declines to use the index, so the results stay correct and the latency quietly becomes linear, which is the worst possible way to be wrong. Second, HNSW is an *approximate* index: it trades recall for speed, `ef_search` tunes that trade at query time, and the honest answer to "did we lose anything by adding the index?" is that you measure recall against an exact scan rather than assume. An ANN index does not return the same rows as the loop it replaced, and a chapter that shows both implementations behind one interface owes you that caveat.

### Senior @ FAANG: Vector Store Selection as Infrastructure Architecture Decision

At senior level, the choice between pgvector and a dedicated vector database (Pinecone, Weaviate, Milvus) is an architecture decision with long-term operational implications. pgvector is operationally simpler (runs in the existing PostgreSQL database, no additional service to operate or pay for) but has performance limits at large scale (tens of millions of vectors at high query rates). Dedicated vector databases offer better performance at scale but add operational complexity (additional service, separate backup strategy, additional cost). The senior engineer's contribution is defining the scale threshold at which the migration from pgvector to a dedicated store is warranted, monitoring the key metrics (index size, query latency at P99, index build time), and planning the migration before it becomes urgent.
