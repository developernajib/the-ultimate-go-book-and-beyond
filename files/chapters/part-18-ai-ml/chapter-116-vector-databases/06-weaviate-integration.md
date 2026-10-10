## 116.5 Weaviate Integration

Weaviate offers hybrid search, GraphQL queries, and built-in vectorization modules.

```go
// pkg/vectordb/weaviate/client.go
package weaviate

import (
	"context"
	"fmt"

	"github.com/go-openapi/strfmt"
	"github.com/google/uuid"
	"github.com/weaviate/weaviate-go-client/v4/weaviate"
	"github.com/weaviate/weaviate-go-client/v4/weaviate/auth"
	"github.com/weaviate/weaviate-go-client/v4/weaviate/filters"
	"github.com/weaviate/weaviate-go-client/v4/weaviate/graphql"
	"github.com/weaviate/weaviate/entities/models"

	"github.com/yourusername/gobook/pkg/vectordb"
)

// Config configures Weaviate client
type Config struct {
	Host      string // e.g., "localhost:8080"
	Scheme    string // "http" or "https"
	APIKey    string // Optional: for Weaviate Cloud Services
	ClassName string // Weaviate class name
}

// Client is a Weaviate client
type Client struct {
	client    *weaviate.Client
	config    Config
	className string
}

// NewClient creates a new Weaviate client
func NewClient(config Config) (*Client, error) {
	if config.Host == "" {
		return nil, fmt.Errorf("host required")
	}
	if config.ClassName == "" {
		return nil, fmt.Errorf("class name required")
	}
	if config.Scheme == "" {
		config.Scheme = "http"
	}

	cfg := weaviate.Config{
		Host:   config.Host,
		Scheme: config.Scheme,
	}

	if config.APIKey != "" {
		cfg.AuthConfig = auth.ApiKey{Value: config.APIKey}
	}

	client, err := weaviate.NewClient(cfg)
	if err != nil {
		return nil, fmt.Errorf("creating Weaviate client: %w", err)
	}

	return &Client{
		client:    client,
		config:    config,
		className: config.ClassName,
	}, nil
}

// CreateSchema creates the Weaviate schema
func (c *Client) CreateSchema(ctx context.Context, dimensions int, properties []Property) error {
	// Define properties
	props := []*models.Property{
		{
			Name:     "text",
			DataType: []string{"text"},
		},
	}

	// Add custom properties
	for _, prop := range properties {
		props = append(props, &models.Property{
			Name:     prop.Name,
			DataType: []string{prop.DataType},
		})
	}

	// Create class
	classObj := &models.Class{
		Class:      c.className,
		Properties: props,
		VectorIndexConfig: map[string]any{
			"distance": "cosine", // or "dot", "l2-squared", "hamming", "manhattan"
		},
	}

	err := c.client.Schema().ClassCreator().WithClass(classObj).Do(ctx)
	if err != nil {
		return fmt.Errorf("creating schema: %w", err)
	}

	return nil
}

// Property represents a custom property
type Property struct {
	Name     string
	DataType string // "string", "text", "int", "number", "boolean", "date"
}

// Upsert inserts or updates documents.
//
// Note the ID type. models.Object.ID is a strfmt.UUID, not a string, and
// Weaviate genuinely requires object IDs to be valid UUIDs. Your application's
// natural IDs (paths, slugs, database keys) will not satisfy that. The two
// workable strategies are to mint a deterministic UUIDv5 from your natural key
// (so re-ingesting the same document updates rather than duplicates it), or to
// store the natural ID as an ordinary property and keep a mapping. Assigning a
// raw string here is a compile error, and coercing one with strfmt.UUID(id) is
// worse: it compiles and then fails at the server with a validation error.
func (c *Client) Upsert(ctx context.Context, docs []vectordb.Document) error {
	// Weaviate uses batch operations for efficiency
	batcher := c.client.Batch().ObjectsBatcher()

	for _, doc := range docs {
		// Convert metadata to properties
		properties := map[string]any{
			"text": doc.Text,
		}
		for k, v := range doc.Metadata {
			properties[k] = v
		}

		obj := &models.Object{
			Class:      c.className,
			ID:         toUUID(doc.ID),
			Properties: properties,
			Vector:     models.C11yVector(doc.Vector),
		}

		batcher = batcher.WithObjects(obj)
	}

	// Execute batch. Note the discarded first return value: Weaviate's batch
	// API reports PER-OBJECT errors in that response, and err is non-nil only
	// for a transport-level failure. Discarding it means a batch where every
	// single object was rejected returns nil here and reports success. Always
	// walk the response and inspect each object's Result.Errors.
	resp, err := batcher.Do(ctx)
	if err != nil {
		return fmt.Errorf("batch upsert: %w", err)
	}
	for _, r := range resp {
		if r.Result != nil && r.Result.Errors != nil && len(r.Result.Errors.Error) > 0 {
			return fmt.Errorf("object %s rejected: %s", r.ID, r.Result.Errors.Error[0].Message)
		}
	}

	return nil
}

// toUUID derives a stable UUIDv5 from an arbitrary application ID, so that
// re-ingesting the same document overwrites it instead of creating a duplicate.
func toUUID(id string) strfmt.UUID {
	return strfmt.UUID(uuid.NewSHA1(uuid.NameSpaceURL, []byte(id)).String())
}

// Query performs vector similarity search
func (c *Client) Query(ctx context.Context, vector vectordb.Vector, topK int, filter vectordb.Metadata) (*vectordb.SearchResponse, error) {
	nearVector := c.client.GraphQL().NearVectorArgBuilder().
		WithVector(convertToFloat32Slice(vector))

	// WithFields takes []graphql.Field, not strings. Nested selections such as
	// _additional { id distance } are expressed structurally via Field.Fields
	// rather than as a raw GraphQL fragment in a string.
	fields := []graphql.Field{
		{Name: "text"},
		{Name: "_additional", Fields: []graphql.Field{
			{Name: "id"},
			{Name: "distance"},
		}},
	}

	// Request the metadata properties we filtered on so they come back too.
	for key := range filter {
		fields = append(fields, graphql.Field{Name: key})
	}

	// Build query
	query := c.client.GraphQL().Get().
		WithClassName(c.className).
		WithNearVector(nearVector).
		WithLimit(topK).
		WithFields(fields...)

	// Add where filter if metadata provided
	if len(filter) > 0 {
		where := buildWhereFilter(filter)
		query = query.WithWhere(where)
	}

	result, err := query.Do(ctx)
	if err != nil {
		return nil, fmt.Errorf("query: %w", err)
	}

	return parseQueryResult(result)
}

// HybridSearch performs hybrid vector + keyword search
func (c *Client) HybridSearch(ctx context.Context, query string, vector vectordb.Vector, topK int, alpha float64) (*vectordb.SearchResponse, error) {
	// alpha: 0 = pure keyword, 1 = pure vector, 0.5 = balanced
	hybrid := c.client.GraphQL().HybridArgumentBuilder().
		WithQuery(query).
		WithVector(convertToFloat32Slice(vector)).
		WithAlpha(float32(alpha))

	// Note "score" rather than "distance": hybrid results are fused scores, not
	// vector distances, and they run in the opposite direction (higher is
	// better). Asking for the wrong one gives you nulls, and sorting a fused
	// score as if it were a distance reverses your ranking.
	fields := []graphql.Field{
		{Name: "text"},
		{Name: "_additional", Fields: []graphql.Field{
			{Name: "id"},
			{Name: "score"},
		}},
	}

	result, err := c.client.GraphQL().Get().
		WithClassName(c.className).
		WithHybrid(hybrid).
		WithLimit(topK).
		WithFields(fields...).
		Do(ctx)

	if err != nil {
		return nil, fmt.Errorf("hybrid search: %w", err)
	}

	return parseQueryResult(result)
}

// Delete removes objects by ID
func (c *Client) Delete(ctx context.Context, ids []string) error {
	for _, id := range ids {
		err := c.client.Data().Deleter().
			WithClassName(c.className).
			WithID(string(toUUID(id))).
			Do(ctx)

		if err != nil {
			return fmt.Errorf("deleting %s: %w", id, err)
		}
	}

	return nil
}

// Fetch retrieves objects by ID
func (c *Client) Fetch(ctx context.Context, ids []string) ([]vectordb.Document, error) {
	docs := make([]vectordb.Document, 0, len(ids))

	for _, id := range ids {
		objects, err := c.client.Data().ObjectsGetter().
			WithClassName(c.className).
			WithID(string(toUUID(id))).
			WithVector().
			Do(ctx)

		if err != nil {
			return nil, fmt.Errorf("fetching %s: %w", id, err)
		}

		if len(objects) == 0 {
			continue
		}

		obj := objects[0]
		doc := vectordb.Document{
			// obj.ID is a strfmt.UUID and obj.Vector a models.C11yVector - 			// both need an explicit conversion back to our own types.
			ID:     string(obj.ID),
			Vector: vectordb.Vector(obj.Vector),
		}

		if props, ok := obj.Properties.(map[string]any); ok {
			if text, ok := props["text"].(string); ok {
				doc.Text = text
			}
			doc.Metadata = props
		}

		docs = append(docs, doc)
	}

	return docs, nil
}

// Close closes the client
func (c *Client) Close() error {
	return nil
}

// Helper functions

func convertToFloat32Slice(v vectordb.Vector) []float32 {
	return []float32(v)
}

// buildWhereFilter builds a Weaviate where filter from metadata.
//
// Use the filters.Where() BUILDER, not a hand-constructed models.WhereFilter.
// The query API takes *filters.WhereBuilder, so a raw *models.WhereFilter does
// not even compile there, and the builder's typed WithValue* methods hide the
// fact that every underlying Value* field is a pointer (Weaviate's way of
// distinguishing "match the empty string" from "unset").
//
// The subtler bug the builder does NOT save you from is stringifying every
// value through %v. Text sent against an int property matches nothing and
// returns an empty result set with no error at all. Dispatch on the Go type
// and call the matching WithValue* method.
func buildWhereFilter(filter vectordb.Metadata) *filters.WhereBuilder {
	var operands []*filters.WhereBuilder

	for key, value := range filter {
		b := filters.Where().
			WithPath([]string{key}).
			WithOperator(filters.Equal)

		switch v := value.(type) {
		case string:
			b = b.WithValueText(v)
		case bool:
			b = b.WithValueBoolean(v)
		case int:
			b = b.WithValueInt(int64(v))
		case int64:
			b = b.WithValueInt(v)
		case float64:
			// JSON decodes every number to float64. If the schema declares the
			// property as an int, WithValueNumber silently matches nothing:
			// carry the schema's type, not the decoder's.
			b = b.WithValueNumber(v)
		default:
			b = b.WithValueText(fmt.Sprintf("%v", v))
		}

		operands = append(operands, b)
	}

	if len(operands) == 1 {
		return operands[0]
	}

	return filters.Where().
		WithOperator(filters.And).
		WithOperands(operands)
}

// parseQueryResult unpacks Weaviate's GraphQL response.
//
// NOT IMPLEMENTED. It is left as an explicit error rather than as a stub that
// returns an empty result set, because those two failures are very different
// to debug. A stub returning zero results looks exactly like a search that ran
// correctly and found nothing, so you would go hunting through your index, your
// embeddings, and your distance metric before suspecting the parser. Fail
// loudly instead: an unimplemented function should say so.
//
// The response arrives as nested map[string]any under Data["Get"][className],
// with the requested properties at the top level of each object and the id and
// distance (or score, for hybrid) nested under "_additional". Note that every
// number in it decodes to float64, so type-assert accordingly: a `.(int)` here
// panics, which is the same trap as in the metadata filter earlier.
func parseQueryResult(result *models.GraphQLResponse) (*vectordb.SearchResponse, error) {
	if len(result.Errors) > 0 {
		return nil, fmt.Errorf("GraphQL errors: %v", result.Errors)
	}
	return nil, fmt.Errorf("parseQueryResult: not implemented")
}
```

### Junior → FAANG: Weaviate's Hybrid Search as the Production Standard

Weaviate's built-in hybrid search (combining BM25 keyword search with vector similarity search) is the pattern that most production search systems need but many junior engineers are unaware of. Pure vector search fails on queries containing rare, exact tokens: a version string, an error code like `ERR_CONN_4021`, a part number, a person's surname. The embedding model either never saw the token in training or has no meaningful representation for it, so it returns things that are *sort of* about the topic while the document containing the exact string sits unretrieved. Pure keyword search fails on the mirror-image case, a semantic query such as "best practices for handling errors", where the relevant document says "exception management guidelines" and shares almost no vocabulary with the query.

The two failure modes are complementary, which is exactly why fusing them beats either alone. That is also the mental model to carry into an interview: hybrid search is not "better search", it is coverage of two different, well-characterized blind spots.

Weaviate's schema definition is more explicit than Pinecone's schema-free approach. You define classes with typed properties, vectorization modules, and indexing configuration before inserting any data. This schema-first approach catches data quality issues early and makes the data model explicit to all consumers. For junior engineers building their first production system, Weaviate's schema-first approach is a good forcing function for careful data modeling.

For interview prep, know how to explain reciprocal rank fusion, and know *why* it exists. BM25 scores are unbounded and corpus-dependent - cosine similarities live in a narrow band near 1. Adding or averaging them is meaningless, because a BM25 of 14.2 and a cosine of 0.83 are not commensurable quantities, and whichever list happens to have the larger numbers dominates the blend for no principled reason.

RRF sidesteps the problem by throwing the scores away and keeping only the ranks: each document scores `1/(k + rank)` in each list, and the two are summed, with `k` a smoothing constant conventionally set to 60. Because it consumes only ordering, it needs no calibration, no normalization, and no per-corpus tuning, which is what makes it such a strong default. The tradeoff is that discarding the scores discards real information: a document that BM25 considered a runaway best match ranks 1 exactly like one that barely edged out second place. When you have labelled relevance data, a tuned weighted combination of *normalized* scores can beat RRF. Without that data, RRF is the honest choice.

Weaviate's `alpha` parameter is a different mechanism worth distinguishing: it is a weighted blend between the keyword and vector components (0 is pure keyword, 1 is pure vector), not RRF. Knowing that a system offers a weighting knob *and* a fusion strategy, and that they are different answers to the same problem, is the level of precision that separates a studied answer from a memorized one.

### Senior @ FAANG: Self-Hosted Weaviate Operational Considerations

Self-hosting Weaviate at production scale requires understanding its architecture: a Weaviate node runs as a single Go process that manages both the inverted index (for BM25 search) and the HNSW index (for vector search). Horizontal scaling is achieved through sharding: the data is partitioned across multiple Weaviate nodes, each responsible for a subset of the vectors. The query is broadcast to all shards, each shard returns its top-k results, and the coordinator merges and re-ranks the results. Understanding this distributed query execution model is necessary for tuning the shard count, the replication factor, and the query timeout.

Weaviate's memory requirements are a capacity planning concern. The HNSW index for a collection of 10 million 1536-dimensional float32 vectors requires approximately 60 GB for the raw vectors, plus approximately 30% overhead for the HNSW graph structure, totaling approximately 80 GB. Weaviate must hold this entire index in memory for optimal performance, making memory capacity the primary scaling constraint. Designing the shard topology to stay within the memory capacity of each node, and planning the memory growth as the collection grows, is a senior-level capacity planning task.

At L6, Weaviate infrastructure governance includes backup and disaster recovery. Weaviate's backup mechanism exports the HNSW index and object data to object storage, which can be used to restore the database after a failure. The backup process is not instant (it may take hours for large collections), and it impacts query latency while running, so backup scheduling must account for peak traffic hours. Defining the RPO and RTO for the vector database and designing the backup schedule and restoration procedure to meet these objectives is a standard staff-level infrastructure planning responsibility.
