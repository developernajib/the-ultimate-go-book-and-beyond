## 37F.3 Document CRUD Operations

### Indexing and Retrieval

Elasticsearch CRUD operations use the REST API: `PUT /<index>/_doc/<id>` for upserts, `GET` for retrieval, `POST /_update` for partial updates, and `DELETE` for removal. The `_bulk` API batches these operations into a single HTTP request, dramatically reducing round-trip overhead when indexing large datasets.

```go
package elasticsearch

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/elastic/go-elasticsearch/v9"
)

// Product domain model
type Product struct {
	ID           string      `json:"id"`
	Name         string      `json:"name"`
	Description  string      `json:"description"`
	Category     string      `json:"category"`
	Brand        string      `json:"brand"`
	Price        float64     `json:"price"`
	DiscountPrice *float64   `json:"discount_price,omitempty"`
	Stock        int         `json:"stock"`
	Rating       float32     `json:"rating"`
	ReviewCount  int         `json:"review_count"`
	Tags         []string    `json:"tags"`
	Attributes   []Attribute `json:"attributes,omitempty"`
	Images       []string    `json:"images,omitempty"`
	Location     *GeoPoint   `json:"location,omitempty"`
	Embedding    []float32   `json:"embedding,omitempty"`
	Active       bool        `json:"active"`
	CreatedAt    time.Time   `json:"created_at"`
	UpdatedAt    time.Time   `json:"updated_at"`
}

type Attribute struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

type GeoPoint struct {
	Lat float64 `json:"lat"`
	Lon float64 `json:"lon"`
}

// ProductRepository handles Elasticsearch operations for products
type ProductRepository struct {
	client *elasticsearch.Client
	index  string
}

func NewProductRepository(client *elasticsearch.Client, index string) *ProductRepository {
	return &ProductRepository{client: client, index: index}
}

// Index creates or updates a product document
func (r *ProductRepository) Index(ctx context.Context, product Product) error {
	product.UpdatedAt = time.Now().UTC()

	body, err := json.Marshal(product)
	if err != nil {
		return fmt.Errorf("marshal product: %w", err)
	}

	res, err := r.client.Index(
		r.index,
		bytes.NewReader(body),
		r.client.Index.WithDocumentID(product.ID),
		r.client.Index.WithContext(ctx),
		r.client.Index.WithRefresh("false"), // async for performance
	)
	if err != nil {
		return fmt.Errorf("index product: %w", err)
	}
	defer res.Body.Close()

	if res.IsError() {
		return fmt.Errorf("index error [%s]: %s", product.ID, res.String())
	}
	return nil
}

// BulkIndex indexes multiple products efficiently
func (r *ProductRepository) BulkIndex(ctx context.Context, products []Product) (*BulkResult, error) {
	var buf bytes.Buffer

	for _, p := range products {
		p.UpdatedAt = time.Now().UTC()

		// Action line
		meta := map[string]any{
			"index": map[string]any{
				"_index": r.index,
				"_id":    p.ID,
			},
		}
		metaLine, _ := json.Marshal(meta)
		buf.Write(metaLine)
		buf.WriteByte('\n')

		// Document line
		docLine, _ := json.Marshal(p)
		buf.Write(docLine)
		buf.WriteByte('\n')
	}

	res, err := r.client.Bulk(
		bytes.NewReader(buf.Bytes()),
		r.client.Bulk.WithContext(ctx),
		r.client.Bulk.WithRefresh("false"),
	)
	if err != nil {
		return nil, fmt.Errorf("bulk index: %w", err)
	}
	defer res.Body.Close()

	var bulkResp BulkResponse
	if err := json.NewDecoder(res.Body).Decode(&bulkResp); err != nil {
		return nil, err
	}

	result := &BulkResult{Total: len(products)}
	for _, item := range bulkResp.Items {
		if item.Index.Error != nil {
			result.Errors = append(result.Errors, BulkError{
				ID:    item.Index.ID,
				Cause: item.Index.Error.Reason,
			})
		} else {
			result.Succeeded++
		}
	}
	return result, nil
}

// PartialUpdate updates specific fields without re-indexing
func (r *ProductRepository) PartialUpdate(ctx context.Context, id string, updates map[string]any) error {
	updates["updated_at"] = time.Now().UTC()
	body, _ := json.Marshal(map[string]any{"doc": updates})

	res, err := r.client.Update(
		r.index, id,
		bytes.NewReader(body),
		r.client.Update.WithContext(ctx),
		r.client.Update.WithRetryOnConflict(3),
	)
	if err != nil {
		return fmt.Errorf("update: %w", err)
	}
	defer res.Body.Close()

	if res.IsError() {
		if res.StatusCode == 404 {
			return ErrNotFound
		}
		return fmt.Errorf("update error: %s", res.String())
	}
	return nil
}

// GetByID retrieves a product by ID
func (r *ProductRepository) GetByID(ctx context.Context, id string) (*Product, error) {
	res, err := r.client.Get(
		r.index, id,
		r.client.Get.WithContext(ctx),
	)
	if err != nil {
		return nil, fmt.Errorf("get: %w", err)
	}
	defer res.Body.Close()

	if res.StatusCode == 404 {
		return nil, ErrNotFound
	}
	if res.IsError() {
		return nil, fmt.Errorf("get error: %s", res.String())
	}

	var result struct {
		Source  Product `json:"_source"`
		Found   bool    `json:"found"`
	}
	if err := json.NewDecoder(res.Body).Decode(&result); err != nil {
		return nil, err
	}
	return &result.Source, nil
}

// Delete removes a product
func (r *ProductRepository) Delete(ctx context.Context, id string) error {
	res, err := r.client.Delete(
		r.index, id,
		r.client.Delete.WithContext(ctx),
		r.client.Delete.WithRefresh("false"),
	)
	if err != nil {
		return err
	}
	defer res.Body.Close()

	if res.StatusCode == 404 {
		return ErrNotFound
	}
	if res.IsError() {
		return fmt.Errorf("delete error: %s", res.String())
	}
	return nil
}

// Response types
type BulkResponse struct {
	Errors bool `json:"errors"`
	Items  []struct {
		Index struct {
			ID     string `json:"_id"`
			Result string `json:"result"`
			Error  *struct {
				Type   string `json:"type"`
				Reason string `json:"reason"`
			} `json:"error"`
		} `json:"index"`
	} `json:"items"`
}

type BulkResult struct {
	Total     int
	Succeeded int
	Errors    []BulkError
}

type BulkError struct {
	ID    string
	Cause string
}

var ErrNotFound = errors.New("document not found")
```

### Junior → FAANG: CRUD semantics, versioning, and the bulk pattern

The first thing to internalise about Elasticsearch CRUD is that a `PUT /_doc/<id>` is not a SQL UPDATE. It is an upsert that replaces the entire document. If you GET the old document, mutate one field, and PUT it back, that is a read-modify-write with a race condition baked in. The correct pattern for partial updates is the `POST /_update` endpoint with a `doc` payload, which the server applies atomically. The `retry_on_conflict` parameter (as shown in `PartialUpdate` above with value 3) tells Elasticsearch to re-fetch and re-apply the partial update if a concurrent write bumped the version. Without retry-on-conflict, concurrent partial updates produce 409 errors that most junior clients swallow.

Versioning is the concurrency control primitive to learn on day one. Every document has an `_seq_no` and `_primary_term` stamp that together form an optimistic lock. When you GET a document, you receive those values. When you PUT or UPDATE, you can pass `if_seq_no` and `if_primary_term` to require that the document has not changed since you read it. If another writer won the race, you get a 409 and decide whether to retry, merge, or surface to the user. The older `version` and `version_type=external` scheme is still used for external version control when an authoritative source like a CDC stream provides monotonically increasing versions, in which case `version_type=external_gte` is the idiomatic choice for backfills because replays are safe.

The bulk pattern above is the single most important performance lever for ingestion. The NDJSON format is two lines per operation: an action line and a document line, separated by newlines, terminated with a newline. Miss the terminating newline and the request fails with a parse error. The non-obvious lesson is that a bulk response with HTTP 200 can still contain per-item failures. The `Errors` top-level boolean tells you whether any item failed, but you must iterate `Items` to find out which ones. Juniors who log the top-level status and call it a day are silently dropping writes. The repository above does this correctly by walking `Items` and collecting per-document errors.

Interview entry-point: "A write to Elasticsearch returned success but the document does not appear in search. Why?" The answer is the refresh interval. `refresh=false` (the default, and the correct default for throughput) means the document is durable but not yet in a searchable segment. It becomes searchable on the next refresh (default every 1 second). `refresh=wait_for` blocks the response until the next scheduled refresh, which is the right choice for a test that reads-its-own-write without burning cycles on `refresh=true` which forces an immediate refresh and is a known way to crater indexing throughput if wired into a hot path.

### Senior @ FAANG: High-throughput ingestion, idempotency, and the typed API

The bulk indexer above is a teaching implementation. A production bulk indexer uses the `esutil.BulkIndexer` helper in go-elasticsearch v9, which adds: per-document callbacks for success and failure, in-flight batch size and worker concurrency limits, automatic batching with size and interval triggers, and a graceful `Close()` that flushes pending work. A reasonable default configuration is 4 to 8 workers, a flush interval of 1 second, a flush size of 5 MB per batch, and a per-document `OnFailure` callback that distinguishes transient errors (routing, 429, 503) that go back to the retry queue from poison errors (400 mapping parse, 413 document too large) that route to a dead-letter index with the original document plus the failure reason and a timestamp. The number one failure mode of naive bulk implementations is infinite retry loops on poison documents that eventually exhaust memory.

Backpressure. Elasticsearch returns 429 when a queue is full. A senior implementation surfaces 429 as a signal to back off the producer, not as a transient error to silently retry. The typical pattern wires a token-bucket rate limiter in front of the bulk indexer, sized by observed 429 rate, with the limiter driven by a feedback loop: increase concurrency while 429 rate is below threshold, halve concurrency on sustained 429s, probe upward again after a cooldown. Pair this with a batch size splitter that halves a batch on 413 rather than retrying with the same size, because large documents are almost always the root cause of 413 and the index-level `http.max_content_length` can be below your default batch.

Idempotency. Every bulk write that can be retried must be idempotent. With auto-generated IDs, retries create duplicates because the new ID is unique. The correct pattern is deterministic IDs derived from a business key, or external versioning where the producer supplies both `_id` and a monotonically increasing `version`. For event streams, the natural choice is `_id = hash(topic, partition, offset)` with `version = offset` and `version_type = external_gte`. This makes the whole pipeline replay-safe: re-processing a Kafka partition re-writes the same documents with the same versions, Elasticsearch rejects stale versions with 409, and new versions win. The anti-pattern is setting `op_type: create` for at-least-once semantics because it rejects every replay as a duplicate and produces noisy 409s that are hard to distinguish from real conflicts.

The typed API. `github.com/elastic/go-elasticsearch/v9/typedapi` offers strongly-typed request and response structs that compile-check the query shape. A typed `search.New()` builder with `Query(...)` chain methods catches the "I misspelled `must` as `musts` in a `map[string]any` and got zero results with a 200" failure at compile time. The cost is verbosity and a higher learning curve. The pragma is to use typed API for production query paths and raw bodies for one-off scripts, admin tooling, or cases where the feature is new enough that the typed API has not caught up. Build a thin repository layer that exposes typed builders to callers so misuse is blocked by the type system rather than discovered in production.

Update-by-query and delete-by-query. These are Elasticsearch's equivalent of SQL bulk DML. They are not transactions. They scan, they update in batches, they take minutes to hours on large indices, and they can be canceled by task ID. They respect document versioning so concurrent writes during the operation either win (via `conflicts: proceed`) or abort it (via the default `conflicts: abort`). The senior discipline is to treat UBQ and DBQ as migrations. Write them as code in a changelog, include the expected document count and a time budget, dry-run on a snapshot, execute via a runbook that records the task ID, monitor progress through `_tasks/<id>`, and have a documented cancellation path. Never let an on-call engineer paste a DBQ into Dev Tools under pressure. Every production incident where data disappeared from Elasticsearch and no one can explain why traces back to exactly that scenario.

Data streams, rollover, and time-series retention. For any append-mostly time-series workload (logs, metrics, events), the correct primitive is a data stream backed by automatically rolled-over hidden indices. ILM or ISM drives the rollover on size, age, and doc count thresholds, then promotes indices through hot, warm, cold, and frozen tiers before deletion. The Go client indexes into the data stream alias, and Elasticsearch routes to the current write-index. The single biggest operational win over manually managed monthly indices is that rollover decouples index size from retention, so a burst day does not produce a giant shard and a quiet day does not produce a tiny one. Pair this with a primary-shard count that targets the post-rollover size, not the lifetime size, and the shard economics stay healthy for years.

---
