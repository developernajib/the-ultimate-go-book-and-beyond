## Part 8: Elasticsearch Integration

While building your own inverted index is valuable for learning, most production search systems use Elasticsearch (or its open-source fork, OpenSearch) as the underlying search engine. Elasticsearch handles the hard distributed systems problems, sharding data across multiple nodes, replicating for fault tolerance, and merging results from parallel searches, so your Go code can focus on query logic and business rules. The integration layer below wraps the Elasticsearch HTTP API with a typed Go client that supports document indexing, multi-field search with fuzziness for typo tolerance, boolean query composition, faceted aggregations, and result highlighting. The `ProductSearch` method at the end shows a realistic example that combines all of these features for an e-commerce product search.

```go
package elasticsearch

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

// ESClient wraps Elasticsearch HTTP API
type ESClient struct {
	baseURL    string
	httpClient *http.Client
	index      string
}

func NewESClient(baseURL, index string) *ESClient {
	return &ESClient{
		baseURL:    baseURL,
		httpClient: &http.Client{},
		index:      index,
	}
}

// IndexDoc indexes a document
func (c *ESClient) IndexDoc(ctx context.Context, id string, doc any) error {
	body, err := json.Marshal(doc)
	if err != nil {
		return fmt.Errorf("marshal doc: %w", err)
	}

	url := fmt.Sprintf("%s/%s/_doc/%s", c.baseURL, c.index, id)
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("index doc: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("index error %d: %s", resp.StatusCode, string(b))
	}
	return nil
}

// SearchQuery is an Elasticsearch query DSL
type SearchQuery struct {
	Query     any            `json:"query"`
	Highlight map[string]any `json:"highlight,omitempty"`
	Aggs      map[string]any `json:"aggs,omitempty"`
	Sort      []any          `json:"sort,omitempty"`
	From      int                    `json:"from,omitempty"`
	Size      int                    `json:"size"`
}

// BoolQuery is a boolean query container
type BoolQuery struct {
	Must    []any `json:"must,omitempty"`
	Should  []any `json:"should,omitempty"`
	MustNot []any `json:"must_not,omitempty"`
	Filter  []any `json:"filter,omitempty"`
}

// MultiMatchQuery searches multiple fields
func MultiMatchQuery(query string, fields []string, fuzziness string) map[string]any {
	q := map[string]any{
		"multi_match": map[string]any{
			"query":  query,
			"fields": fields,
			"type":   "best_fields",
		},
	}
	if fuzziness != "" {
		q["multi_match"].(map[string]any)["fuzziness"] = fuzziness
	}
	return q
}

// TermFilter is an exact-match filter
func TermFilter(field, value string) map[string]any {
	return map[string]any{
		"term": map[string]any{
			field: value,
		},
	}
}

// RangeFilter is a range filter
func RangeFilter(field string, gte, lte any) map[string]any {
	rangeClause := map[string]any{}
	if gte != nil {
		rangeClause["gte"] = gte
	}
	if lte != nil {
		rangeClause["lte"] = lte
	}
	return map[string]any{
		"range": map[string]any{
			field: rangeClause,
		},
	}
}

// Search executes a search query
func (c *ESClient) Search(ctx context.Context, q SearchQuery) (*SearchResponse, error) {
	body, err := json.Marshal(q)
	if err != nil {
		return nil, fmt.Errorf("marshal query: %w", err)
	}

	url := fmt.Sprintf("%s/%s/_search", c.baseURL, c.index)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("search: %w", err)
	}
	defer resp.Body.Close()

	var result SearchResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}
	return &result, nil
}

type SearchResponse struct {
	Hits struct {
		Total struct {
			Value int `json:"value"`
		} `json:"total"`
		Hits []struct {
			ID        string                 `json:"_id"`
			Score     float64                `json:"_score"`
			Source    map[string]any `json:"_source"`
			Highlight map[string][]string    `json:"highlight"`
		} `json:"hits"`
	} `json:"hits"`
	Aggregations map[string]json.RawMessage `json:"aggregations,omitempty"`
	Took         int                        `json:"took"`
}

// ProductSearch implements a real-world product search
func (c *ESClient) ProductSearch(ctx context.Context, query, category string, page, size int) (*SearchResponse, error) {
	boolQ := BoolQuery{
		Must: []any{
			MultiMatchQuery(query, []string{"title^3", "description", "tags^2"}, "AUTO"),
		},
	}

	if category != "" {
		boolQ.Filter = append(boolQ.Filter, TermFilter("category", category))
	}

	// Boost in-stock items
	boolQ.Should = append(boolQ.Should, map[string]any{
		"term": map[string]any{"in_stock": true},
	})

	q := SearchQuery{
		Query: map[string]any{"bool": boolQ},
		Highlight: map[string]any{
			"fields": map[string]any{
				"title":       map[string]any{},
				"description": map[string]any{"number_of_fragments": 2},
			},
			"pre_tags":  []string{"<mark>"},
			"post_tags": []string{"</mark>"},
		},
		Aggs: map[string]any{
			"categories": map[string]any{
				"terms": map[string]any{
					"field": "category",
					"size":  20,
				},
			},
			"price_range": map[string]any{
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
		Sort: []any{
			map[string]any{"_score": "desc"},
			map[string]any{"popularity": "desc"},
		},
		From: (page - 1) * size,
		Size: size,
	}

	return c.Search(ctx, q)
}
```

---
