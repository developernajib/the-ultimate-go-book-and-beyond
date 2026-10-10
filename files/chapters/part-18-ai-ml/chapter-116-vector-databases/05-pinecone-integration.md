## 116.4 Pinecone Integration

Pinecone is a managed vector database with good performance and developer experience.

One caveat before the code, because it will bite you on your first request. The client below constructs its base URL from an `Environment` string such as `us-west1-gcp`, which reflects Pinecone's **pod-based** generation. Pinecone's serverless generation dropped that scheme: you no longer compose the data-plane host from an environment name, you ask the control plane (`api.pinecone.io`) to describe the index and it returns the host to use, which you then cache. Hand-rolling the legacy URL pattern against a serverless index produces DNS failures that look like network problems and are not.

Read this section, then, for the shape of the operations (upsert, query, delete, fetch, namespaces, metadata filters), which is stable across both generations and across competing products. Take the exact hostnames and the auth handshake from Pinecone's current documentation, or use the official Go SDK and let it resolve hosts for you. Hardcoding a managed vendor's URL scheme is a bet on it not changing, and this one already has.

```go
// pkg/vectordb/pinecone/client.go
package pinecone

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	neturl "net/url"
	"time"

	"github.com/yourusername/gobook/pkg/vectordb"
)

// Config configures Pinecone client
type Config struct {
	APIKey      string
	Environment string // e.g., "us-west1-gcp"
	IndexName   string
	ProjectID   string
	Timeout     time.Duration
}

// Client is a Pinecone client
type Client struct {
	config     Config
	httpClient *http.Client
	baseURL    string
}

// NewClient creates a new Pinecone client
func NewClient(config Config) (*Client, error) {
	if config.APIKey == "" {
		return nil, fmt.Errorf("API key required")
	}
	if config.IndexName == "" {
		return nil, fmt.Errorf("index name required")
	}

	if config.Timeout == 0 {
		config.Timeout = 30 * time.Second
	}

	// LEGACY pod-based URL format:
	//   https://INDEX_NAME-PROJECT_ID.svc.ENVIRONMENT.pinecone.io
	//
	// This composition does not work for serverless indexes. There, you call
	// the control plane (api.pinecone.io) to describe the index, read the host
	// out of the response, and cache it. Treat the line below as a
	// configuration default to override, not as a fact about the service.
	baseURL := fmt.Sprintf("https://%s-%s.svc.%s.pinecone.io",
		config.IndexName, config.ProjectID, config.Environment)

	return &Client{
		config: config,
		httpClient: &http.Client{
			Timeout: config.Timeout,
		},
		baseURL: baseURL,
	}, nil
}

// UpsertRequest represents a Pinecone upsert request
type UpsertRequest struct {
	Vectors   []Vector `json:"vectors"`
	Namespace string   `json:"namespace,omitempty"`
}

// Vector represents a Pinecone vector
type Vector struct {
	ID       string         `json:"id"`
	Values   []float32      `json:"values"`
	Metadata map[string]any `json:"metadata,omitempty"`
}

// UpsertResponse represents a Pinecone upsert response
type UpsertResponse struct {
	UpsertedCount int `json:"upsertedCount"`
}

// Upsert inserts or updates vectors in Pinecone
func (c *Client) Upsert(ctx context.Context, docs []vectordb.Document) error {
	return c.UpsertNamespace(ctx, docs, "")
}

// UpsertNamespace upserts to a specific namespace
func (c *Client) UpsertNamespace(ctx context.Context, docs []vectordb.Document, namespace string) error {
	if len(docs) == 0 {
		return nil
	}

	// Pinecone recommends batches of 100-1000 vectors
	const batchSize = 100

	for i := 0; i < len(docs); i += batchSize {
		end := i + batchSize
		if end > len(docs) {
			end = len(docs)
		}

		batch := docs[i:end]
		if err := c.upsertBatch(ctx, batch, namespace); err != nil {
			return fmt.Errorf("upserting batch %d-%d: %w", i, end, err)
		}
	}

	return nil
}

// upsertBatch upserts a single batch
func (c *Client) upsertBatch(ctx context.Context, docs []vectordb.Document, namespace string) error {
	vectors := make([]Vector, len(docs))
	for i, doc := range docs {
		vectors[i] = Vector{
			ID:       doc.ID,
			Values:   doc.Vector,
			Metadata: doc.Metadata,
		}
	}

	req := UpsertRequest{
		Vectors:   vectors,
		Namespace: namespace,
	}

	var resp UpsertResponse
	if err := c.doRequest(ctx, "POST", "/vectors/upsert", req, &resp); err != nil {
		return err
	}

	if resp.UpsertedCount != len(docs) {
		return fmt.Errorf("expected to upsert %d vectors, upserted %d", len(docs), resp.UpsertedCount)
	}

	return nil
}

// QueryRequest represents a Pinecone query request
type QueryRequest struct {
	Vector          []float32      `json:"vector"`
	TopK            int            `json:"topK"`
	Namespace       string         `json:"namespace,omitempty"`
	Filter          map[string]any `json:"filter,omitempty"`
	IncludeValues   bool           `json:"includeValues"`
	IncludeMetadata bool           `json:"includeMetadata"`
}

// QueryResponse represents a Pinecone query response
type QueryResponse struct {
	Matches []Match `json:"matches"`
}

// Match represents a single query match
type Match struct {
	ID       string         `json:"id"`
	Score    float32        `json:"score"`
	Values   []float32      `json:"values,omitempty"`
	Metadata map[string]any `json:"metadata,omitempty"`
}

// Query performs similarity search
func (c *Client) Query(ctx context.Context, vector vectordb.Vector, topK int, filter vectordb.Metadata) (*vectordb.SearchResponse, error) {
	return c.QueryNamespace(ctx, vector, topK, filter, "")
}

// QueryNamespace queries a specific namespace
func (c *Client) QueryNamespace(ctx context.Context, vector vectordb.Vector, topK int, filter vectordb.Metadata, namespace string) (*vectordb.SearchResponse, error) {
	start := time.Now()

	req := QueryRequest{
		Vector:          vector,
		TopK:            topK,
		Namespace:       namespace,
		Filter:          filter,
		IncludeValues:   false,
		IncludeMetadata: true,
	}

	var resp QueryResponse
	if err := c.doRequest(ctx, "POST", "/query", req, &resp); err != nil {
		return nil, err
	}

	results := make([]vectordb.SearchResult, len(resp.Matches))
	for i, match := range resp.Matches {
		results[i] = vectordb.SearchResult{
			ID:       match.ID,
			Score:    match.Score,
			Metadata: match.Metadata,
		}
	}

	return &vectordb.SearchResponse{
		Results:   results,
		QueryTime: time.Since(start),
	}, nil
}

// DeleteRequest represents a Pinecone delete request
type DeleteRequest struct {
	IDs       []string `json:"ids,omitempty"`
	DeleteAll bool     `json:"deleteAll,omitempty"`
	Namespace string   `json:"namespace,omitempty"`
}

// Delete removes vectors by ID
func (c *Client) Delete(ctx context.Context, ids []string) error {
	return c.DeleteNamespace(ctx, ids, "")
}

// DeleteNamespace deletes from a specific namespace
func (c *Client) DeleteNamespace(ctx context.Context, ids []string, namespace string) error {
	req := DeleteRequest{
		IDs:       ids,
		Namespace: namespace,
	}

	return c.doRequest(ctx, "POST", "/vectors/delete", req, nil)
}

// FetchRequest represents a Pinecone fetch request
type FetchRequest struct {
	IDs       []string `json:"ids"`
	Namespace string   `json:"namespace,omitempty"`
}

// FetchResponse represents a Pinecone fetch response
type FetchResponse struct {
	Vectors map[string]struct {
		ID       string         `json:"id"`
		Values   []float32      `json:"values"`
		Metadata map[string]any `json:"metadata"`
	} `json:"vectors"`
}

// Fetch retrieves vectors by ID
func (c *Client) Fetch(ctx context.Context, ids []string) ([]vectordb.Document, error) {
	return c.FetchNamespace(ctx, ids, "")
}

// FetchNamespace fetches from a specific namespace
func (c *Client) FetchNamespace(ctx context.Context, ids []string, namespace string) ([]vectordb.Document, error) {
	if len(ids) == 0 {
		return nil, nil
	}

	// Build the query string with proper escaping. Concatenating raw IDs into a
	// URL is a real bug, not a style nit: document IDs routinely contain "&",
	// "=", "#", spaces, or non-ASCII characters (they are often derived from
	// file paths or titles). An unescaped "&" silently splits one ID into two
	// bogus parameters and the fetch quietly returns the wrong set. url.Values
	// handles the encoding, so never hand-roll it.
	q := neturl.Values{}
	if namespace != "" {
		q.Set("namespace", namespace)
	}
	for _, id := range ids {
		q.Add("ids", id)
	}
	path := "/vectors/fetch?" + q.Encode()

	var resp FetchResponse
	if err := c.doRequest(ctx, "GET", path, nil, &resp); err != nil {
		return nil, err
	}

	docs := make([]vectordb.Document, 0, len(resp.Vectors))
	for _, vec := range resp.Vectors {
		docs = append(docs, vectordb.Document{
			ID:       vec.ID,
			Vector:   vec.Values,
			Metadata: vec.Metadata,
		})
	}

	return docs, nil
}

// doRequest performs an HTTP request to Pinecone
func (c *Client) doRequest(ctx context.Context, method, path string, body, result any) error {
	var reqBody io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("marshaling request: %w", err)
		}
		reqBody = bytes.NewReader(data)
	}

	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reqBody)
	if err != nil {
		return fmt.Errorf("creating request: %w", err)
	}

	req.Header.Set("Api-Key", c.config.APIKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("executing request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		bodyBytes, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("Pinecone API error: %s: %s", resp.Status, string(bodyBytes))
	}

	if result != nil {
		if err := json.NewDecoder(resp.Body).Decode(result); err != nil {
			return fmt.Errorf("decoding response: %w", err)
		}
	}

	return nil
}

// Close closes the client
func (c *Client) Close() error {
	return nil
}

// DescribeIndexStats returns statistics about the index
func (c *Client) DescribeIndexStats(ctx context.Context) (*IndexStats, error) {
	var stats IndexStats
	if err := c.doRequest(ctx, "GET", "/describe_index_stats", nil, &stats); err != nil {
		return nil, err
	}
	return &stats, nil
}

// IndexStats represents Pinecone index statistics
type IndexStats struct {
	Namespaces map[string]struct {
		VectorCount int `json:"vectorCount"`
	} `json:"namespaces"`
	Dimension        int     `json:"dimension"`
	IndexFullness    float64 `json:"indexFullness"`
	TotalVectorCount int     `json:"totalVectorCount"`
}
```

### Junior → FAANG: Pinecone as a Learning and Prototyping Platform

Pinecone is an excellent starting point for learning vector database integration because the API is simple, the documentation is comprehensive, and the managed service eliminates all operational concerns. For a junior building their first RAG system or semantic search prototype, Pinecone's developer tier provides free capacity sufficient for experimentation. The lessons learned from building on Pinecone (understanding namespaces, metadata filtering, batch upsert, and query response structure) transfer directly to other vector database providers.

The Pinecone metadata filtering API is worth studying carefully because it represents the general pattern for vector database filtering. Metadata filters are applied as a JSON object with MongoDB-style operators: `{"$and": [{"author": {"$eq": "Alice"}}, {"date": {"$gte": 1704067200}}]}`. Understanding this filter syntax and knowing that it must be combined with vector search efficiently (not by first loading all vectors that match the filter and then searching) is the knowledge that prevents the most common Pinecone performance pitfall.

For interview prep, know the concepts, and know which generation of the product they belong to, because that distinction is itself the depth signal. In the older pod-based model you provisioned pods as the unit of compute and capacity, and replicas for read throughput, so capacity planning was your problem. The serverless model removed that decision and bills on usage instead, which changes the cost conversation from "how many pods do we need" to "how do we control read volume".

**Namespaces** span both generations and are the concept worth understanding deeply: they partition one index into isolated segments, and a query touches exactly one. That is why namespace-per-tenant beats a metadata filter on `tenant_id` for multi-tenancy. It is not a convenience, it is the fix for the filtering problem from the fundamentals section, since the tenant becomes a routing decision instead of a predicate the graph traversal has to fight. It also makes isolation structural rather than dependent on every query remembering to include the filter, which matters when the failure mode is showing one customer another customer's documents.

### Senior @ FAANG: Managed Vector Database Evaluation

At senior level, the evaluation of Pinecone versus self-hosted alternatives is an ADR-level decision. The key dimensions are: cost at scale (Pinecone's pricing is per pod per hour, and the cost grows linearly with vector count and QPS), data residency (Pinecone stores data in AWS or GCP, which may not satisfy data sovereignty requirements), operational overhead (Pinecone manages all infrastructure, self-hosted requires the team to operate the database), and feature completeness (Pinecone has a focused API, self-hosted alternatives offer more configuration flexibility).

At sufficient scale (billions of vectors, thousands of QPS), the cost difference between managed and self-hosted can justify the operational investment of self-hosting. Do the arithmetic yourself against current price lists rather than trusting a figure from a book: managed vector pricing has been repriced repeatedly, and any number printed here is wrong by the time you read it. The structure of the comparison is what is durable, and it has three parts.

Price the managed option from the vendor's current rate card at *your* vector count, dimensionality, and QPS. Price the self-hosted option honestly, which means the instances sized for a memory-resident HNSW index (RAM is the binding constraint, not vCPU), plus replicas for availability, plus storage, plus backups. Then price the part that gets left out of every one of these comparisons and dominates it: the engineers. Self-hosting a stateful, memory-bound database with an on-call rotation, an upgrade path, and a rebuild story is a standing team commitment, not a one-off migration. Compare total cost of ownership, not instance cost, and be suspicious of any analysis where the infrastructure line item is smaller than a single engineer's loaded cost.

The honest conclusion is usually scale-dependent rather than universal: managed wins decisively until the infrastructure bill is large enough to fund the team, and self-hosted wins after. Know which side of that line you are on before you argue for either.

The governance implications of using a managed vector database include: the vendor's data processing terms (is data used to train their models?), the SLA terms (what is the compensation for downtime?), the data retention policy (how long is data stored after you delete it?), and the lock-in risk (how difficult is it to migrate away if the vendor changes pricing or is acquired?). Senior engineers document these risks in the ADR and design the integration to be replaceable with a migration plan for the top-risk scenarios. The `VectorStore` interface from the fundamentals section is exactly that insurance policy: it costs almost nothing to define up front and it is what makes the migration a new implementation rather than a rewrite.
