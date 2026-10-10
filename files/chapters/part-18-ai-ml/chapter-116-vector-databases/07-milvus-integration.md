## 116.6 Milvus Integration

Milvus is an open-source vector database designed for billion-scale similarity search.

```go
// pkg/vectordb/milvus/client.go
package milvus

import (
	"context"
	"fmt"
	"strings"
	"time"

	// NOTE: milvus-sdk-go/v2 is the older client. Milvus has since published a
	// successor Go client, and new work should start there. The concepts below
	// (collections, partitions, schema, index params, the mandatory
	// LoadCollection before search) carry over unchanged - the type names do not.
	"github.com/milvus-io/milvus-sdk-go/v2/client"
	"github.com/milvus-io/milvus-sdk-go/v2/entity"

	"github.com/yourusername/gobook/pkg/vectordb"
)

// Config configures Milvus client
type Config struct {
	Host           string
	Port           string
	Username       string
	Password       string
	Database       string
	CollectionName string
	Dimension      int
	IndexType      entity.IndexType // IVF_FLAT, IVF_SQ8, IVF_PQ, HNSW, etc.
	MetricType     entity.MetricType // L2, IP, COSINE
}

// Client is a Milvus client
type Client struct {
	client         client.Client
	config         Config
	collectionName string
}

// NewClient creates a new Milvus client
func NewClient(ctx context.Context, config Config) (*Client, error) {
	if config.Host == "" {
		config.Host = "localhost"
	}
	if config.Port == "" {
		config.Port = "19530"
	}
	if config.CollectionName == "" {
		return nil, fmt.Errorf("collection name required")
	}
	if config.Dimension == 0 {
		return nil, fmt.Errorf("dimension required")
	}

	// Set defaults
	if config.IndexType == "" {
		config.IndexType = entity.HNSW
	}
	if config.MetricType == "" {
		config.MetricType = entity.COSINE
	}

	// Connect to Milvus
	milvusClient, err := client.NewGrpcClient(ctx, fmt.Sprintf("%s:%s", config.Host, config.Port))
	if err != nil {
		return nil, fmt.Errorf("connecting to Milvus: %w", err)
	}

	// Authenticate if credentials provided
	if config.Username != "" {
		// Milvus 2.x authentication
		// Note: exact auth method depends on Milvus version and setup
	}

	c := &Client{
		client:         milvusClient,
		config:         config,
		collectionName: config.CollectionName,
	}

	return c, nil
}

// CreateCollection creates a Milvus collection with schema
func (c *Client) CreateCollection(ctx context.Context) error {
	// Check if collection exists
	has, err := c.client.HasCollection(ctx, c.collectionName)
	if err != nil {
		return fmt.Errorf("checking collection: %w", err)
	}
	if has {
		return nil // Already exists
	}

	// Define schema
	schema := &entity.Schema{
		CollectionName: c.collectionName,
		Description:    "Vector database collection",
		AutoID:         false,
		Fields: []*entity.Field{
			{
				Name:       "id",
				DataType:   entity.FieldTypeVarChar,
				PrimaryKey: true,
				AutoID:     false,
				TypeParams: map[string]string{
					"max_length": "256",
				},
			},
			{
				Name:     "text",
				DataType: entity.FieldTypeVarChar,
				TypeParams: map[string]string{
					"max_length": "65535",
				},
			},
			{
				Name:     "embedding",
				DataType: entity.FieldTypeFloatVector,
				TypeParams: map[string]string{
					"dim": fmt.Sprintf("%d", c.config.Dimension),
				},
			},
			{
				Name:     "metadata",
				DataType: entity.FieldTypeJSON,
			},
		},
	}

	// Create collection
	err = c.client.CreateCollection(ctx, schema, entity.DefaultShardNumber)
	if err != nil {
		return fmt.Errorf("creating collection: %w", err)
	}

	return nil
}

// CreateIndex creates an index on the vector field
func (c *Client) CreateIndex(ctx context.Context) error {
	// Index parameters depend on index type
	_ = getIndexParams(c.config.IndexType)

	idx, err := entity.NewIndexHNSW(c.config.MetricType, 16, 256)
	if err != nil {
		return fmt.Errorf("creating index: %w", err)
	}

	err = c.client.CreateIndex(ctx, c.collectionName, "embedding", idx, false)
	if err != nil {
		return fmt.Errorf("creating index: %w", err)
	}

	// Load collection into memory for search
	err = c.client.LoadCollection(ctx, c.collectionName, false)
	if err != nil {
		return fmt.Errorf("loading collection: %w", err)
	}

	return nil
}

// getIndexParams returns index parameters based on type
func getIndexParams(indexType entity.IndexType) map[string]string {
	switch indexType {
	case entity.HNSW:
		return map[string]string{
			"M":              "16",
			"efConstruction": "256",
		}
	case entity.IVF_FLAT:
		return map[string]string{
			"nlist": "1024",
		}
	case entity.IVF_PQ:
		return map[string]string{
			"nlist": "1024",
			"m":     "8",
			"nbits": "8",
		}
	default:
		return map[string]string{}
	}
}

// Upsert inserts or updates documents
func (c *Client) Upsert(ctx context.Context, docs []vectordb.Document) error {
	if len(docs) == 0 {
		return nil
	}

	// Prepare columns
	ids := make([]string, len(docs))
	texts := make([]string, len(docs))
	vectors := make([][]float32, len(docs))
	metadatas := make([][]byte, len(docs))

	for i, doc := range docs {
		ids[i] = doc.ID
		texts[i] = doc.Text
		vectors[i] = doc.Vector

		// Serialize metadata to JSON
		// (Simplified - production should handle JSON marshaling)
		metadatas[i] = []byte("{}")
	}

	// Create columns
	idColumn := entity.NewColumnVarChar("id", ids)
	textColumn := entity.NewColumnVarChar("text", texts)
	vectorColumn := entity.NewColumnFloatVector("embedding", c.config.Dimension, vectors)
	metadataColumn := entity.NewColumnJSONBytes("metadata", metadatas)

	// Insert
	_, err := c.client.Insert(ctx, c.collectionName, "", idColumn, textColumn, vectorColumn, metadataColumn)
	if err != nil {
		return fmt.Errorf("inserting documents: %w", err)
	}

	// Flush to ensure data is persisted
	err = c.client.Flush(ctx, c.collectionName, false)
	if err != nil {
		return fmt.Errorf("flushing: %w", err)
	}

	return nil
}

// Query performs similarity search
func (c *Client) Query(ctx context.Context, vector vectordb.Vector, topK int, filter vectordb.Metadata) (*vectordb.SearchResponse, error) {
	start := time.Now()

	// Search parameters. Do NOT discard this error with `sp, _ :=`: on failure
	// sp is nil, and a nil search param reaches the server as a request with no
	// ef at all, which silently searches at the default and quietly returns
	// worse recall than you configured.
	//
	// Note also that the search param must match the INDEX type. An HNSW search
	// param against an IVF index is meaningless. Since c.config.IndexType is
	// known here, derive the param from it rather than hardcoding HNSW.
	sp, err := searchParamFor(c.config.IndexType)
	if err != nil {
		return nil, err
	}

	// Build filter expression
	expr, err := buildFilterExpression(filter)
	if err != nil {
		return nil, err
	}

	// Perform search
	results, err := c.client.Search(
		ctx,
		c.collectionName,
		[]string{}, // partitions
		expr,
		[]string{"id", "text", "metadata"},
		[]entity.Vector{entity.FloatVector(vector)},
		"embedding",
		c.config.MetricType,
		topK,
		sp,
	)

	if err != nil {
		return nil, fmt.Errorf("searching: %w", err)
	}

	// Parse results
	searchResults := make([]vectordb.SearchResult, 0)

	if len(results) > 0 {
		for i := 0; i < results[0].ResultCount; i++ {
			id, _ := results[0].IDs.Get(i)
			score := results[0].Scores[i]

			// Extract fields
			var text string
			var metadata vectordb.Metadata

			for _, field := range results[0].Fields {
				switch field.Name() {
				case "text":
					if data, ok := field.GetAsString(i); ok {
						text = data
					}
				case "metadata":
					// Parse JSON metadata
					// (Simplified - production should handle JSON unmarshaling)
					metadata = make(vectordb.Metadata)
				}
			}

			searchResults = append(searchResults, vectordb.SearchResult{
				ID:       fmt.Sprintf("%v", id),
				Score:    score,
				Metadata: metadata,
				Text:     text,
			})
		}
	}

	return &vectordb.SearchResponse{
		Results:   searchResults,
		QueryTime: time.Since(start),
	}, nil
}

// buildFilterExpression builds Milvus filter expression from metadata
// searchParamFor returns a search parameter matching the index type.
func searchParamFor(indexType entity.IndexType) (entity.SearchParam, error) {
	switch indexType {
	case entity.HNSW:
		return entity.NewIndexHNSWSearchParam(200) // ef
	case entity.IVF_FLAT:
		return entity.NewIndexIvfFlatSearchParam(16) // nprobe
	case entity.IVF_SQ8:
		return entity.NewIndexIvfSQ8SearchParam(16) // nprobe
	case entity.FLAT:
		return entity.NewIndexFlatSearchParam()
	default:
		return nil, fmt.Errorf("no search param configured for index type %q", indexType)
	}
}

// buildFilterExpression renders a Milvus boolean expression from metadata.
//
// SECURITY: Milvus expressions are a parsed language, and this function builds
// one out of strings. Interpolating a raw value with %v is injection, the same
// class of bug as string-concatenated SQL, just against a different parser: a
// value containing a double quote terminates the literal and everything after
// it is interpreted as expression syntax. A crafted value turns
//
//	metadata["tenant"] == "acme"
//
// into
//
//	metadata["tenant"] == "" or "1" == "1"
//
// and your per-tenant filter now matches every tenant. In a multi-tenant
// system that is a cross-customer data leak, not a malformed query.
//
// Milvus supports parameterized expressions via placeholders and a params map,
// which is what production code should use. Where you must build the string,
// validate keys against an allowlist of known schema fields and escape values
// rigorously. The conservative version below rejects anything it cannot prove
// safe rather than emitting an expression it cannot vouch for.
func buildFilterExpression(filter vectordb.Metadata) (string, error) {
	if len(filter) == 0 {
		return "", nil
	}

	var parts []string
	for key, value := range filter {
		if !isSafeFieldName(key) {
			return "", fmt.Errorf("unsafe metadata key %q: keys must match [A-Za-z_][A-Za-z0-9_]*", key)
		}

		switch v := value.(type) {
		case string:
			if strings.ContainsAny(v, `"\`) {
				return "", fmt.Errorf("metadata value for %q contains quote or backslash; use parameterized expressions", key)
			}
			parts = append(parts, fmt.Sprintf(`metadata["%s"] == "%s"`, key, v))
		case bool:
			parts = append(parts, fmt.Sprintf(`metadata["%s"] == %t`, key, v))
		case int, int32, int64:
			parts = append(parts, fmt.Sprintf(`metadata["%s"] == %d`, key, v))
		case float32, float64:
			// Numbers must not be quoted, or they compare as strings and match
			// nothing (silently, with no error).
			parts = append(parts, fmt.Sprintf(`metadata["%s"] == %v`, key, v))
		default:
			return "", fmt.Errorf("unsupported filter value type %T for key %q", value, key)
		}
	}

	return strings.Join(parts, " and "), nil
}

func isSafeFieldName(s string) bool {
	if s == "" {
		return false
	}
	for i, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r == '_':
		case i > 0 && r >= '0' && r <= '9':
		default:
			return false
		}
	}
	return true
}

// Delete removes documents by ID
func (c *Client) Delete(ctx context.Context, ids []string) error {
	if len(ids) == 0 {
		return nil
	}

	// Build delete expression
	expr := fmt.Sprintf("id in [%s]", joinQuoted(ids))

	err := c.client.Delete(ctx, c.collectionName, "", expr)
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

	// Build query expression
	expr := fmt.Sprintf("id in [%s]", joinQuoted(ids))

	// Query
	results, err := c.client.Query(ctx, c.collectionName, []string{}, expr, []string{"id", "text", "embedding", "metadata"})
	if err != nil {
		return nil, fmt.Errorf("querying: %w", err)
	}

	docs := make([]vectordb.Document, 0)
	if len(results) == 0 {
		return docs, nil
	}

	// Parse results
	rowCount := results[0].Len()
	for i := 0; i < rowCount; i++ {
		doc := vectordb.Document{
			Metadata: make(vectordb.Metadata),
		}

		for _, field := range results {
			switch field.Name() {
			case "id":
				if id, ok := field.GetAsString(i); ok {
					doc.ID = id
				}
			case "text":
				if text, ok := field.GetAsString(i); ok {
					doc.Text = text
				}
			case "embedding":
				if vec, ok := field.(entity.FloatVectorFieldData); ok {
					doc.Vector = vec.Data()[i]
				}
			case "metadata":
				// Parse JSON metadata
			}
		}

		docs = append(docs, doc)
	}

	return docs, nil
}

// Close closes the client connection
func (c *Client) Close() error {
	return c.client.Close()
}

// Helper functions

func joinQuoted(strs []string) string {
	result := ""
	for i, s := range strs {
		if i > 0 {
			result += ", "
		}
		result += fmt.Sprintf(`"%s"`, s)
	}
	return result
}

// CreatePartition creates a partition for data organization
func (c *Client) CreatePartition(ctx context.Context, partitionName string) error {
	return c.client.CreatePartition(ctx, c.collectionName, partitionName)
}

// LoadPartition loads a specific partition into memory
func (c *Client) LoadPartition(ctx context.Context, partitionNames []string) error {
	return c.client.LoadPartitions(ctx, c.collectionName, partitionNames, false)
}
```

### Junior → FAANG: Milvus for Billion-Scale Vector Search

Milvus is designed for the scale that exceeds what single-node solutions can handle: billions of vectors across a distributed cluster. For junior engineers, the key Milvus concept to understand is its separation of storage and compute: data is persisted in object storage (S3 or MinIO), and the compute nodes (query nodes) load data into memory on demand. This architecture allows the storage to be larger than any single node's memory, at the cost of higher latency when loading data that is not currently cached.

The partition concept in Milvus is the primary mechanism for multi-tenancy and query optimization. A collection can be divided into partitions (for example, one partition per customer in a multi-tenant system), and queries can be scoped to a specific partition to reduce the search space and improve latency. Understanding when to use partitions versus separate collections (partitions for data that is searched together, separate collections for data that is always searched independently) is a design decision that affects both query latency and operational complexity.

Milvus indexes represent different points on the recall-latency-memory tradeoff space: FLAT for exact search (100% recall, linear scan, genuinely the right answer for small collections), IVF_FLAT and IVF_SQ8 for cluster-based approximate search, and HNSW for graph-based search. The supported set changes between releases, so check the version's documentation rather than a list from a book. For interview prep, know that HNSW is the standard choice for most production deployments due to its recall-latency tradeoff, and that IVF variants with quantization (SQ8, PQ) win when memory is the binding constraint, because they store compressed vectors rather than full-precision ones.

The Milvus-specific operational fact worth knowing is `LoadCollection`. Milvus keeps data in object storage and will not serve searches from a collection that has not been loaded into query-node memory. Forgetting it produces an error on a collection that visibly contains data, which is a confusing first encounter. It also means memory, not disk, bounds what you can search at any moment.

### Senior @ FAANG: Milvus Cluster Architecture for Production

Milvus cluster deployment requires understanding five node types: the root coordinator (manages metadata), query coordinators (manage query node lifecycle), data coordinators (manage data node lifecycle), query nodes (serve vector search queries), and data nodes (handle data ingestion). Each node type can be independently scaled based on load: if query latency is the bottleneck, add query nodes. If ingestion throughput is the bottleneck, add data nodes. This separation of concerns makes Milvus well-suited for production workloads with asymmetric read and write patterns.

The Milvus storage architecture (cold data in object storage, warm data in query node memory) introduces a cache management problem. The query node has a limited memory budget and must decide which segments to keep in memory and which to evict. Milvus's cache management policy (LRU-based eviction) may not match the access patterns of your workload (for example, a time-based workload where recent documents are queried more frequently). Tuning the cache size and understanding the latency implication of cache misses (a segment must be loaded from object storage before the query can proceed) is a senior-level performance optimization task.

At L6, Milvus infrastructure includes the Milvus operator for Kubernetes deployment (managing the complex multi-component deployment as a single Kubernetes custom resource), Etcd for distributed metadata management (a critical dependency that must be operated with care), and Pulsar or Kafka for the message queue that coordinates between data nodes and query nodes. Understanding the health of each of these dependencies and designing the monitoring and alerting system to detect failures in any component is a staff-level operational responsibility. Milvus clusters have many moving parts, and the MTTR for an incident is directly proportional to how well the team understands each component's failure modes.
