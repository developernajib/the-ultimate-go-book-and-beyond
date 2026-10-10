## 37F.5 Advanced Search Features

### Autocomplete & Search-as-You-Type

Autocomplete requires a different indexing strategy than standard full-text search. The `completion` suggester uses an in-memory FST (finite state transducer) data structure for prefix lookups, returning suggestions in sub-millisecond time. The `AutocompleteService` below wraps the completion suggester with fuzzy matching so that typos like "lapt" still suggest "laptop".

```go
package elasticsearch

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"

	"github.com/elastic/go-elasticsearch/v9"
)

// AutocompleteService provides fast search suggestions
type AutocompleteService struct {
	client *elasticsearch.Client
	index  string
}

// Suggest returns autocomplete suggestions for a prefix
func (s *AutocompleteService) Suggest(ctx context.Context, prefix string, limit int) ([]string, error) {
	query := map[string]any{
		"suggest": map[string]any{
			"product_suggest": map[string]any{
				"prefix": prefix,
				"completion": map[string]any{
					"field": "name.autocomplete",
					"size":  limit,
					"fuzzy": map[string]any{
						"fuzziness": "AUTO",
					},
					"contexts": map[string]any{
						"active": []any{
							map[string]any{"context": true},
						},
					},
				},
			},
		},
		"_source": false,
		"size":    0,
	}

	body, _ := json.Marshal(query)
	res, err := s.client.Search(
		s.client.Search.WithContext(ctx),
		s.client.Search.WithIndex(s.index),
		s.client.Search.WithBody(bytes.NewReader(body)),
	)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()

	var resp struct {
		Suggest map[string][]struct {
			Options []struct {
				Text string `json:"text"`
			} `json:"options"`
		} `json:"suggest"`
	}
	json.NewDecoder(res.Body).Decode(&resp)

	var suggestions []string
	if opts, ok := resp.Suggest["product_suggest"]; ok && len(opts) > 0 {
		for _, opt := range opts[0].Options {
			suggestions = append(suggestions, opt.Text)
		}
	}
	return suggestions, nil
}

// PhraseSearch with phrase suggest for "did you mean?"
func (s *AutocompleteService) PhraseSearch(ctx context.Context, query string) (*PhraseResult, error) {
	body := map[string]any{
		"query": map[string]any{
			"match": map[string]any{
				"name": map[string]any{
					"query":    query,
					"operator": "and",
				},
			},
		},
		"suggest": map[string]any{
			"did_you_mean": map[string]any{
				"text": query,
				"phrase": map[string]any{
					"field":          "name",
					"size":           3,
					"gram_size":      3,
					"direct_generator": []any{
						map[string]any{
							"field":     "name",
							"suggest_mode": "missing",
						},
					},
					"highlight": map[string]any{
						"pre_tag":  "<em>",
						"post_tag": "</em>",
					},
				},
			},
		},
		"size": 10,
	}

	bodyBytes, _ := json.Marshal(body)
	res, err := s.client.Search(
		s.client.Search.WithContext(ctx),
		s.client.Search.WithIndex(s.index),
		s.client.Search.WithBody(bytes.NewReader(bodyBytes)),
	)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()

	var resp struct {
		Hits    struct{ Hits []struct{ Source Product `json:"_source"` } `json:"hits"` } `json:"hits"`
		Suggest map[string][]struct {
			Options []struct {
				Text        string  `json:"text"`
				Highlighted string  `json:"highlighted"`
				Score       float64 `json:"score"`
			} `json:"options"`
		} `json:"suggest"`
	}
	json.NewDecoder(res.Body).Decode(&resp)

	result := &PhraseResult{}
	for _, h := range resp.Hits.Hits {
		result.Products = append(result.Products, h.Source)
	}
	if opts, ok := resp.Suggest["did_you_mean"]; ok && len(opts) > 0 && len(opts[0].Options) > 0 {
		result.DidYouMean = opts[0].Options[0].Text
		result.DidYouMeanHighlighted = opts[0].Options[0].Highlighted
	}
	return result, nil
}

type PhraseResult struct {
	Products              []Product
	DidYouMean            string
	DidYouMeanHighlighted string
}

// SearchByAttribute queries nested attributes.
// Nested objects are indexed as separate hidden Lucene documents,
// so querying them requires a "nested" query that joins the parent
// and child at search time. The inner_hits parameter returns which
// specific nested object matched, useful for highlighting.
func (s *SearchService) SearchByAttribute(ctx context.Context, attrName, attrValue string) ([]Product, error) {
	query := map[string]any{
		"query": map[string]any{
			"nested": map[string]any{
				"path": "attributes",
				"query": map[string]any{
					"bool": map[string]any{
						"must": []any{
							map[string]any{
								"term": map[string]any{
									"attributes.name": attrName,
								},
							},
							map[string]any{
								"term": map[string]any{
									"attributes.value": attrValue,
								},
							},
						},
					},
				},
				"inner_hits": map[string]any{
					"name": "matching_attributes",
					"size": 5,
				},
			},
		},
		"size": 20,
	}

	bodyBytes, _ := json.Marshal(query)
	res, err := s.client.Search(
		s.client.Search.WithContext(ctx),
		s.client.Search.WithIndex(s.index),
		s.client.Search.WithBody(bytes.NewReader(bodyBytes)),
	)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()

	var resp ESSearchResponse
	json.NewDecoder(res.Body).Decode(&resp)

	var products []Product
	for _, h := range resp.Hits.Hits {
		products = append(products, h.Source)
	}
	return products, nil
}

// SearchNearby finds products within a geographic radius.
// The geo_distance filter uses a bounding box pre-filter for speed,
// then checks exact distance for candidates within the box. Results
// are sorted by ascending distance using the _geo_distance sort.
func (s *SearchService) SearchNearby(ctx context.Context, lat, lon, radiusKm float64, limit int) ([]Product, error) {
	query := map[string]any{
		"query": map[string]any{
			"bool": map[string]any{
				"must": map[string]any{"match_all": map[string]any{}},
				"filter": map[string]any{
					"geo_distance": map[string]any{
						"distance": fmt.Sprintf("%fkm", radiusKm),
						"location": map[string]any{
							"lat": lat,
							"lon": lon,
						},
					},
				},
			},
		},
		"sort": []any{
			map[string]any{
				"_geo_distance": map[string]any{
					"location": map[string]any{"lat": lat, "lon": lon},
					"order":    "asc",
					"unit":     "km",
				},
			},
		},
		"size": limit,
	}

	bodyBytes, _ := json.Marshal(query)
	res, err := s.client.Search(
		s.client.Search.WithContext(ctx),
		s.client.Search.WithIndex(s.index),
		s.client.Search.WithBody(bytes.NewReader(bodyBytes)),
	)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()

	var resp ESSearchResponse
	json.NewDecoder(res.Body).Decode(&resp)

	var products []Product
	for _, h := range resp.Hits.Hits {
		products = append(products, h.Source)
	}
	return products, nil
}

// SemanticSearch performs k-nearest-neighbor (kNN) search using dense
// vectors. The num_candidates parameter controls the accuracy/speed
// trade-off: higher values check more candidates for better recall
// but slower queries. A 10x oversampling ratio is a reasonable default.
func (s *SearchService) SemanticSearch(ctx context.Context, queryEmbedding []float32, limit int, filter map[string]any) ([]Product, error) {
	query := map[string]any{
		"knn": map[string]any{
			"field":          "embedding",
			"query_vector":   queryEmbedding,
			"k":              limit,
			"num_candidates": limit * 10, // oversampling for accuracy
			"filter": filter,
		},
		"_source": []string{"id", "name", "price", "category", "rating"},
		"size":    limit,
	}

	bodyBytes, _ := json.Marshal(query)
	res, err := s.client.Search(
		s.client.Search.WithContext(ctx),
		s.client.Search.WithIndex(s.index),
		s.client.Search.WithBody(bytes.NewReader(bodyBytes)),
	)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()

	var resp ESSearchResponse
	json.NewDecoder(res.Body).Decode(&resp)

	var products []Product
	for _, h := range resp.Hits.Hits {
		products = append(products, h.Source)
	}
	return products, nil
}

// HybridSearch combines BM25 keyword search with kNN vector search
// using Reciprocal Rank Fusion (RRF). RRF merges ranked lists from
// multiple retrievers without requiring score normalization. Each
// document's final rank is 1/(rank_constant + position_in_list),
// summed across retrievers. This consistently outperforms either
// retriever alone on relevance benchmarks.
func (s *SearchService) HybridSearch(ctx context.Context, text string, embedding []float32, limit int) ([]Product, error) {
	query := map[string]any{
		// Retrieval with RRF (Reciprocal Rank Fusion)
		"retriever": map[string]any{
			"rrf": map[string]any{
				"retrievers": []any{
					// BM25 retriever
					map[string]any{
						"standard": map[string]any{
							"query": map[string]any{
								"multi_match": map[string]any{
									"query":  text,
									"fields": []string{"name^3", "description"},
								},
							},
						},
					},
					// kNN retriever
					map[string]any{
						"knn": map[string]any{
							"field":          "embedding",
							"query_vector":   embedding,
							"k":              limit * 3,
							"num_candidates": limit * 10,
						},
					},
				},
				"rank_constant": 60,
				"rank_window_size": limit * 2,
			},
		},
		"size": limit,
	}

	bodyBytes, _ := json.Marshal(query)
	res, err := s.client.Search(
		s.client.Search.WithContext(ctx),
		s.client.Search.WithIndex(s.index),
		s.client.Search.WithBody(bytes.NewReader(bodyBytes)),
	)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()

	var resp ESSearchResponse
	json.NewDecoder(res.Body).Decode(&resp)

	var products []Product
	for _, h := range resp.Hits.Hits {
		products = append(products, h.Source)
	}
	return products, nil
}
```

### Junior → FAANG: Prerequisite Gaps and Worked Examples

If you are coming to this material fresh, the most common prerequisite gap is not understanding what a suggester actually is. A `completion` suggester is backed by a dedicated FST built at index time from a field of type `completion`. That field is separate from your normal analyzed text field. So if you index a product with `name: "MacBook Pro"` and want autocomplete, you need a sibling field like `name.autocomplete` mapped as `completion`, and you need to populate it in the source document as a string or an object with `input` and `weight`. The FST lives in heap, not on disk pages, which is why it returns sub-millisecond but also why you cannot have a 50GB completion field.

Worked example for a first-job ticket: "users typed `iphne` and got zero results, fix it." The naive fix is to add `fuzziness: AUTO` to a `match` query. AUTO means edit distance 0 for terms of 1 to 2 characters, 1 for 3 to 5 characters, 2 for 6 plus. That is usually fine for product names. The non-obvious follow-up is that fuzzy `match` queries expand into up to 50 terms per field by default (`max_expansions`), and each expansion costs a term dictionary lookup. On a hot path, set `max_expansions: 10` and `prefix_length: 1` so Elasticsearch only fuzzy-expands terms that share the first character. This is a classic interview entry-point: they ask "how does fuzzy search work" and they want you to say Levenshtein automaton plus prefix pruning, not "it uses AI."

Second worked example: nested queries. A common mistake is to map attributes as `object` and then wonder why searching `color=red AND size=XL` matches a product whose attributes are `{color: blue, size: XL}` and `{color: red, size: S}`. Elasticsearch flattens object arrays by default, losing the per-object correlation. The fix is mapping the field as `nested`, which indexes each sub-object as a hidden Lucene document and forces queries through a `nested` clause. Cost: nested queries are 3 to 5 times slower than flat and each nested doc counts toward the 2 billion doc-per-shard limit.

Interview entry-point checklist: know the difference between `term` and `match` (term does not analyze, match does), between `filter` and `must` (filter skips scoring and is cacheable, must scores), and between `keyword` and `text` field types (keyword for exact and aggregations, text for full-text). If you can draw the inverted index on a whiteboard and explain why `_source` is separate from the index itself, you clear the bar for most SDE 1 search roles.

### Senior @ FAANG: Staff and Principal Material

At staff level the conversation moves from "how do I write a query" to "how do I run relevance at scale without melting the cluster or the relevance metrics." Start with vector search. Elasticsearch 9.0 ships HNSW (Hierarchical Navigable Small World) as the only dense_vector index type worth using in production. HNSW is a multi-layer proximity graph where upper layers are sparse long-range links and lower layers are dense local links. Query cost is roughly O(log N) on the graph traversal but memory cost is brutal: a 1024-dimension float32 vector is 4KB raw, and HNSW adds roughly 1.1x to 1.5x overhead for the graph edges (`m` parameter, default 16). For 100 million vectors at 1024 dims you are looking at 450GB of heap-adjacent off-heap memory per replica before quantization. The two knobs that matter are `m` (edges per node, higher means better recall and more memory) and `ef_construction` (build-time candidate list, higher means slower indexing and better graph quality). Query-time, `num_candidates` is the `ef_search` equivalent. Rule of thumb: `num_candidates = max(100, k * 10)` for 95 percent recall on typical datasets, tune with a held-out recall@k evaluation set. Never accept a vendor claim of "99 percent recall" without seeing the dataset.

Quantization is how you make this affordable. As of 9.0, `element_type: float` with `index_options.type: int8_hnsw` gives you 4x compression with usually less than 1 percent recall loss on BERT-style embeddings. `int4_hnsw` gives 8x compression but needs rescoring on the full-precision vectors to recover recall, which Elasticsearch handles transparently if you keep the source vectors in `_source` and set `rescore_vector: {oversample: 2.0}` on the query. `bbq_hnsw` (Better Binary Quantization, 9.0) pushes to 32x compression and is the right choice for billion-scale catalogs where you cannot afford full-precision storage. Benchmark on your data, not theirs.

Sparse vector retrieval via ELSER (Elastic Learned Sparse EncodeR) is the pragmatic middle ground. ELSER expands each document into roughly 100 to 300 weighted token activations, indexed into a normal inverted index as a `sparse_vector` field. Retrieval uses standard BM25-style term matching on the expanded tokens, so it inherits filter pushdown, aggregations, and sharding for free. You pay inference cost at index time (roughly 50ms per doc on a CPU ML node, 5ms on a GPU) and at query time (one inference call per query). ELSER v2 beats BM25 on BEIR by roughly 10 to 15 points nDCG@10 on out-of-domain queries and matches tuned dense retrievers without requiring a vector index. For most FAANG search teams that do not already own a vector infra, ELSER is the correct first step into semantic search.

Hybrid search with RRF is the production standard for modern e-commerce and enterprise search. RRF with `rank_constant=60` (the original Cormack paper value) is almost always within 1 percent of a tuned value. Do not obsess over the constant. Do obsess over the `rank_window_size`: RRF only fuses the top-N from each retriever, so if `rank_window_size` is smaller than the k you need after fusion, you lose recall. Set it to at least 4x the final page size. Add a third retriever with a cross-encoder reranker (`text_similarity_reranker` in 9.0, backed by a cross-encoder like ms-marco-MiniLM) on the top 100 RRF results for a further 5 to 10 point nDCG bump. Cost: one transformer forward pass per candidate, so keep the rerank window at 50 to 100, not 1000.

Governance at staff level: you must own the relevance regression process. Build a judgment set of 500 to 5000 query-doc pairs with graded relevance (0 to 3), wire it into CI, and block mapping or analyzer changes that drop nDCG@10 by more than a threshold. Without this, every product manager who asks for "better search" ships drift. Second governance area: slow query log (`index.search.slowlog.threshold.query.warn: 1s`) feeding Kibana, with a weekly review of the top 20 expensive queries. Leading-wildcard `*foo*` queries, unbounded `terms` queries with thousands of values, and scripted sort functions are the usual culprits. Third: search templates (`_scripts` + `mustache`) so application code never constructs DSL directly, which gives you a chokepoint for query shape evolution and A/B testing. Fourth: runtime fields for schema-on-read when product asks for a new filter on a 10TB index and you do not want to reindex. Runtime fields cost CPU per query, so promote hot ones to indexed fields via reindex once usage stabilizes.

Highlight has a performance cliff most teams discover in production. The default `unified` highlighter is fine, but on fields larger than 1MB it loads the full `_source` for each hit and re-analyzes. Set `max_analyzed_offset` to 1000000 in index settings and prefer `fvh` (fast vector highlighter) with `term_vector: with_positions_offsets` in the mapping for any field over 100KB. The storage cost is roughly 2x the field size, which is worth it for log search and document search workloads but not for short product names.

---
