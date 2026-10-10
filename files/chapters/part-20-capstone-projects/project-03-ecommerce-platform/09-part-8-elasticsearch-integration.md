## Part 8: Elasticsearch Integration

Relational databases like PostgreSQL are great for storing structured product data, but they struggle with fast, flexible full-text search across thousands of products. Elasticsearch is a specialized search engine that indexes your product data and supports features like fuzzy matching, faceted filtering, and relevance scoring out of the box. In this section, you will build a search service that syncs product data from PostgreSQL into Elasticsearch and exposes a rich search API that supports queries like "red running shoes under \$100" with instant results.

### 8.1 Product Search Service

**services/search/internal/elasticsearch/client.go**

```go
package elasticsearch

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"

	"github.com/elastic/go-elasticsearch/v8"
	"github.com/elastic/go-elasticsearch/v8/esapi"
	"github.com/google/uuid"
	"go.uber.org/zap"

	"github.com/yourusername/ecommerce/services/search/internal/domain"
)

// Client wraps Elasticsearch client
type Client struct {
	es     *elasticsearch.Client
	logger *zap.Logger
}

// NewClient creates a new Elasticsearch client
func NewClient(addresses []string, logger *zap.Logger) (*Client, error) {
	cfg := elasticsearch.Config{
		Addresses: addresses,
	}

	es, err := elasticsearch.NewClient(cfg)
	if err != nil {
		return nil, fmt.Errorf("creating Elasticsearch client: %w", err)
	}

	// Verify connection
	res, err := es.Info()
	if err != nil {
		return nil, fmt.Errorf("getting Elasticsearch info: %w", err)
	}
	defer res.Body.Close()

	if res.IsError() {
		return nil, fmt.Errorf("Elasticsearch error: %s", res.Status())
	}

	client := &Client{
		es:     es,
		logger: logger,
	}

	// Create indices
	if err := client.createIndices(); err != nil {
		return nil, fmt.Errorf("creating indices: %w", err)
	}

	return client, nil
}

// IndexProduct indexes a product
func (c *Client) IndexProduct(ctx context.Context, product *domain.Product) error {
	// Prepare document
	doc, err := json.Marshal(product)
	if err != nil {
		return fmt.Errorf("marshaling product: %w", err)
	}

	// Index document
	req := esapi.IndexRequest{
		Index:      "products",
		DocumentID: product.ID.String(),
		Body:       bytes.NewReader(doc),
		Refresh:    "true",
	}

	res, err := req.Do(ctx, c.es)
	if err != nil {
		return fmt.Errorf("indexing product: %w", err)
	}
	defer res.Body.Close()

	if res.IsError() {
		return fmt.Errorf("Elasticsearch error: %s", res.Status())
	}

	c.logger.Debug("product indexed", zap.String("id", product.ID.String()))

	return nil
}

// SearchProducts searches for products
func (c *Client) SearchProducts(
	ctx context.Context,
	query string,
	page, pageSize int,
) ([]*domain.Product, int, error) {
	// Build search query
	searchQuery := map[string]any{
		"query": map[string]any{
			"multi_match": map[string]any{
				"query":  query,
				"fields": []string{"name^3", "description", "tags"},
				"fuzziness": "AUTO",
			},
		},
		"from": (page - 1) * pageSize,
		"size": pageSize,
		"sort": []any{
			map[string]any{
				"_score": map[string]any{
					"order": "desc",
				},
			},
		},
	}

	// Marshal query
	var buf bytes.Buffer
	if err := json.NewEncoder(&buf).Encode(searchQuery); err != nil {
		return nil, 0, fmt.Errorf("encoding query: %w", err)
	}

	// Execute search
	res, err := c.es.Search(
		c.es.Search.WithContext(ctx),
		c.es.Search.WithIndex("products"),
		c.es.Search.WithBody(&buf),
	)
	if err != nil {
		return nil, 0, fmt.Errorf("executing search: %w", err)
	}
	defer res.Body.Close()

	if res.IsError() {
		return nil, 0, fmt.Errorf("Elasticsearch error: %s", res.Status())
	}

	// Parse response
	var result SearchResponse
	if err := json.NewDecoder(res.Body).Decode(&result); err != nil {
		return nil, 0, fmt.Errorf("decoding response: %w", err)
	}

	// Extract products
	products := make([]*domain.Product, 0, len(result.Hits.Hits))
	for _, hit := range result.Hits.Hits {
		var product domain.Product
		if err := json.Unmarshal(hit.Source, &product); err != nil {
			c.logger.Error("failed to unmarshal product", zap.Error(err))
			continue
		}
		products = append(products, &product)
	}

	return products, result.Hits.Total.Value, nil
}

// FacetedSearch performs faceted search
func (c *Client) FacetedSearch(
	ctx context.Context,
	query string,
	filters map[string][]string,
	page, pageSize int,
) (*FacetedSearchResult, error) {
	// Build search query with aggregations
	searchQuery := map[string]any{
		"query": buildFilteredQuery(query, filters),
		"from":  (page - 1) * pageSize,
		"size":  pageSize,
		"aggs": map[string]any{
			"categories": map[string]any{
				"terms": map[string]any{
					"field": "categories.keyword",
					"size":  20,
				},
			},
			"price_ranges": map[string]any{
				"range": map[string]any{
					"field": "price",
					"ranges": []map[string]any{
						{"to": 25},
						{"from": 25, "to": 50},
						{"from": 50, "to": 100},
						{"from": 100},
					},
				},
			},
		},
	}

	// Marshal query
	var buf bytes.Buffer
	if err := json.NewEncoder(&buf).Encode(searchQuery); err != nil {
		return nil, fmt.Errorf("encoding query: %w", err)
	}

	// Execute search
	res, err := c.es.Search(
		c.es.Search.WithContext(ctx),
		c.es.Search.WithIndex("products"),
		c.es.Search.WithBody(&buf),
	)
	if err != nil {
		return nil, fmt.Errorf("executing search: %w", err)
	}
	defer res.Body.Close()

	if res.IsError() {
		return nil, fmt.Errorf("Elasticsearch error: %s", res.Status())
	}

	// Parse response
	var result FacetedSearchResponse
	if err := json.NewDecoder(res.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("decoding response: %w", err)
	}

	// Extract products and facets
	products := make([]*domain.Product, 0, len(result.Hits.Hits))
	for _, hit := range result.Hits.Hits {
		var product domain.Product
		if err := json.Unmarshal(hit.Source, &product); err != nil {
			c.logger.Error("failed to unmarshal product", zap.Error(err))
			continue
		}
		products = append(products, &product)
	}

	return &FacetedSearchResult{
		Products: products,
		Total:    result.Hits.Total.Value,
		Facets:   extractFacets(result.Aggregations),
	}, nil
}

// DeleteProduct deletes a product from the index
func (c *Client) DeleteProduct(ctx context.Context, productID uuid.UUID) error {
	req := esapi.DeleteRequest{
		Index:      "products",
		DocumentID: productID.String(),
	}

	res, err := req.Do(ctx, c.es)
	if err != nil {
		return fmt.Errorf("deleting product: %w", err)
	}
	defer res.Body.Close()

	if res.IsError() && res.StatusCode != 404 {
		return fmt.Errorf("Elasticsearch error: %s", res.Status())
	}

	return nil
}

func (c *Client) createIndices() error {
	// Product index mapping
	mapping := `{
		"settings": {
			"number_of_shards": 1,
			"number_of_replicas": 1,
			"analysis": {
				"analyzer": {
					"product_analyzer": {
						"type": "custom",
						"tokenizer": "standard",
						"filter": ["lowercase", "asciifolding"]
					}
				}
			}
		},
		"mappings": {
			"properties": {
				"id": {"type": "keyword"},
				"name": {
					"type": "text",
					"analyzer": "product_analyzer",
					"fields": {
						"keyword": {"type": "keyword"}
					}
				},
				"description": {
					"type": "text",
					"analyzer": "product_analyzer"
				},
				"sku": {"type": "keyword"},
				"price": {"type": "float"},
				"currency": {"type": "keyword"},
				"categories": {
					"type": "text",
					"fields": {
						"keyword": {"type": "keyword"}
					}
				},
				"tags": {"type": "keyword"},
				"created_at": {"type": "date"},
				"updated_at": {"type": "date"}
			}
		}
	}`

	req := esapi.IndicesCreateRequest{
		Index: "products",
		Body:  bytes.NewReader([]byte(mapping)),
	}

	res, err := req.Do(context.Background(), c.es)
	if err != nil {
		return fmt.Errorf("creating index: %w", err)
	}
	defer res.Body.Close()

	// Ignore error if index already exists
	if res.IsError() && res.StatusCode != 400 {
		return fmt.Errorf("Elasticsearch error: %s", res.Status())
	}

	return nil
}

func buildFilteredQuery(query string, filters map[string][]string) map[string]any {
	mustClauses := []any{}

	if query != "" {
		mustClauses = append(mustClauses, map[string]any{
			"multi_match": map[string]any{
				"query":     query,
				"fields":    []string{"name^3", "description", "tags"},
				"fuzziness": "AUTO",
			},
		})
	}

	filterClauses := []any{}
	for field, values := range filters {
		if len(values) > 0 {
			filterClauses = append(filterClauses, map[string]any{
				"terms": map[string]any{
					field + ".keyword": values,
				},
			})
		}
	}

	boolQuery := map[string]any{
		"must": mustClauses,
	}

	if len(filterClauses) > 0 {
		boolQuery["filter"] = filterClauses
	}

	return map[string]any{
		"bool": boolQuery,
	}
}

func extractFacets(aggs map[string]any) map[string][]Facet {
	facets := make(map[string][]Facet)

	// Extract category facets
	if categories, ok := aggs["categories"].(map[string]any); ok {
		if buckets, ok := categories["buckets"].([]any); ok {
			for _, bucket := range buckets {
				if b, ok := bucket.(map[string]any); ok {
					facets["categories"] = append(facets["categories"], Facet{
						Value: b["key"].(string),
						Count: int(b["doc_count"].(float64)),
					})
				}
			}
		}
	}

	// Extract price range facets
	if priceRanges, ok := aggs["price_ranges"].(map[string]any); ok {
		if buckets, ok := priceRanges["buckets"].([]any); ok {
			for _, bucket := range buckets {
				if b, ok := bucket.(map[string]any); ok {
					label := getPriceRangeLabel(b)
					facets["price_ranges"] = append(facets["price_ranges"], Facet{
						Value: label,
						Count: int(b["doc_count"].(float64)),
					})
				}
			}
		}
	}

	return facets
}

func getPriceRangeLabel(bucket map[string]any) string {
	from, hasFrom := bucket["from"]
	to, hasTo := bucket["to"]

	if hasFrom && hasTo {
		return fmt.Sprintf("$%.0f - $%.0f", from, to)
	} else if hasFrom {
		return fmt.Sprintf("$%.0f+", from)
	} else if hasTo {
		return fmt.Sprintf("Under $%.0f", to)
	}
	return "Unknown"
}

// Response types

type SearchResponse struct {
	Hits struct {
		Total struct {
			Value int `json:"value"`
		} `json:"total"`
		Hits []struct {
			Source json.RawMessage `json:"_source"`
		} `json:"hits"`
	} `json:"hits"`
}

type FacetedSearchResponse struct {
	Hits struct {
		Total struct {
			Value int `json:"value"`
		} `json:"total"`
		Hits []struct {
			Source json.RawMessage `json:"_source"`
		} `json:"hits"`
	} `json:"hits"`
	Aggregations map[string]any `json:"aggregations"`
}

type FacetedSearchResult struct {
	Products []*domain.Product
	Total    int
	Facets   map[string][]Facet
}

type Facet struct {
	Value string
	Count int
}
```

---

### Junior → FAANG: Elasticsearch as a Secondary Index, Not a Database

The most important thing to understand about Elasticsearch in this context is that it is a secondary index of data that lives in PostgreSQL. The source of truth is PostgreSQL. Elasticsearch is a derived view optimized for search. This means: every write to PostgreSQL must propagate to Elasticsearch, Elasticsearch can lag behind PostgreSQL, and reads for non-search purposes (checkout, order confirmation) must use PostgreSQL.

For interviews, describe the sync mechanism: the Product Service publishes a ProductUpdated event when a product changes. The Search Service consumes the event and updates the Elasticsearch index. This is the standard event-driven indexing pattern. The lag between the PostgreSQL write and the Elasticsearch index update is typically 1-5 seconds.

Elasticsearch mapping (how fields are indexed) is analogous to a database schema but optimized for search. The `keyword` type is for exact match and faceting (filtering by category, brand). The `text` type is for full-text search (searching within product descriptions). Know the difference and when to use each.

### Senior @ FAANG: Search Infrastructure as a Platform

At senior level, Elasticsearch is not something each product team manages independently. It is a shared platform resource managed by a search infrastructure team. Product teams configure their index mappings and query patterns. The platform team manages cluster sizing, shard distribution, index lifecycle management, and upgrade procedures.

Index design for a product catalog at FAANG scale (tens of millions of products) requires careful sharding. An index with a single primary shard cannot leverage multiple Elasticsearch nodes. An index with too many shards creates excessive overhead. The rule of thumb is to target shard sizes between 10-50GB. For a product catalog, this typically means 5-20 primary shards, with one replica per shard for redundancy.

Elasticsearch index alias pattern enables zero-downtime reindexing. When the mapping needs to change (adding a new field, changing an analyzer), you create a new index, reindex all documents into it, and atomically swap the alias that your application uses to point to the new index. The application never sees a gap in search availability. Building this reindexing capability is a platform engineering investment that pays off every time the search schema needs to evolve.

Relevance tuning (boosting certain fields, adjusting TF-IDF weights) is an ongoing product concern, not a one-time engineering task. A search platform that enables product teams to A/B test relevance changes (compare click-through rates between two ranking configurations) without code deployments is a significant platform capability. Building the infrastructure for relevance experimentation is staff-level platform work.

---
