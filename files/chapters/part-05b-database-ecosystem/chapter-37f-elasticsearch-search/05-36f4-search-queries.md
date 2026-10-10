## 37F.4 Search Queries

### Full-Text Search & Bool Query

Elasticsearch's bool query composes `must`, `should`, `must_not`, and `filter` clauses: `must` and `should` contribute to the relevance score, while `filter` clauses are cached and score-free, making them the preferred way to restrict results by exact values or ranges. Full-text fields use the analyzed `match` query. Keyword fields use the faster `term` query.

```go
package elasticsearch

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/elastic/go-elasticsearch/v9"
)

// SearchService handles search operations
type SearchService struct {
	client *elasticsearch.Client
	index  string
}

// SearchRequest represents a search request
type SearchRequest struct {
	Query      string
	Category   string
	Brand      string
	MinPrice   float64
	MaxPrice   float64
	Tags       []string
	MinRating  float32
	InStock    bool
	SortBy     string // "relevance", "price_asc", "price_desc", "rating", "newest"
	Page       int
	PageSize   int
}

// SearchResult represents paginated search results
type SearchResult struct {
	Total    int64
	MaxScore float64
	Hits     []SearchHit
	Aggs     *SearchAggregations
	Took     int // milliseconds
}

type SearchHit struct {
	ID          string
	Score       float64
	Source      Product
	Highlights  map[string][]string
	Explanation *json.RawMessage // for debug
}

type SearchAggregations struct {
	Categories  []AggBucket
	Brands      []AggBucket
	PriceRanges []AggBucket
	AvgPrice    float64
	AvgRating   float64
}

type AggBucket struct {
	Key   string
	Count int64
}

// Search performs a comprehensive product search
func (s *SearchService) Search(ctx context.Context, req SearchRequest) (*SearchResult, error) {
	if req.PageSize <= 0 {
		req.PageSize = 20
	}
	if req.Page <= 0 {
		req.Page = 1
	}

	query := s.buildQuery(req)

	body, err := json.Marshal(query)
	if err != nil {
		return nil, fmt.Errorf("marshal query: %w", err)
	}

	res, err := s.client.Search(
		s.client.Search.WithContext(ctx),
		s.client.Search.WithIndex(s.index),
		s.client.Search.WithBody(bytes.NewReader(body)),
		s.client.Search.WithTrackTotalHits(true),
	)
	if err != nil {
		return nil, fmt.Errorf("search: %w", err)
	}
	defer res.Body.Close()

	if res.IsError() {
		return nil, fmt.Errorf("search error: %s", res.String())
	}

	var esResp ESSearchResponse
	if err := json.NewDecoder(res.Body).Decode(&esResp); err != nil {
		return nil, err
	}

	return parseSearchResponse(esResp), nil
}

// buildQuery constructs the full Elasticsearch query
func (s *SearchService) buildQuery(req SearchRequest) map[string]any {
	must := []any{}
	filter := []any{}

	// Full-text search
	if req.Query != "" {
		must = append(must, map[string]any{
			"multi_match": map[string]any{
				"query":  req.Query,
				"fields": []string{"name^3", "description^1", "brand^2", "tags^1.5"},
				"type":   "best_fields",
				"fuzziness": "AUTO",
				"operator": "and",
			},
		})
	} else {
		must = append(must, map[string]any{"match_all": map[string]any{}})
	}

	// Filters (don't affect relevance score)
	filter = append(filter, map[string]any{
		"term": map[string]any{"active": true},
	})

	if req.Category != "" {
		filter = append(filter, map[string]any{
			"term": map[string]any{"category": req.Category},
		})
	}

	if req.Brand != "" {
		filter = append(filter, map[string]any{
			"term": map[string]any{"brand": req.Brand},
		})
	}

	if req.MinPrice > 0 || req.MaxPrice > 0 {
		priceRange := map[string]any{}
		if req.MinPrice > 0 {
			priceRange["gte"] = req.MinPrice
		}
		if req.MaxPrice > 0 {
			priceRange["lte"] = req.MaxPrice
		}
		filter = append(filter, map[string]any{
			"range": map[string]any{"price": priceRange},
		})
	}

	if len(req.Tags) > 0 {
		filter = append(filter, map[string]any{
			"terms": map[string]any{"tags": req.Tags},
		})
	}

	if req.MinRating > 0 {
		filter = append(filter, map[string]any{
			"range": map[string]any{"rating": map[string]any{"gte": req.MinRating}},
		})
	}

	if req.InStock {
		filter = append(filter, map[string]any{
			"range": map[string]any{"stock": map[string]any{"gt": 0}},
		})
	}

	// Function score for relevance boosting
	boolQuery := map[string]any{
		"bool": map[string]any{
			"must":   must,
			"filter": filter,
		},
	}

	var mainQuery any
	if req.Query != "" {
		// Boost by rating and review count
		mainQuery = map[string]any{
			"function_score": map[string]any{
				"query": boolQuery,
				"functions": []any{
					// Boost popular items
					map[string]any{
						"field_value_factor": map[string]any{
							"field":    "review_count",
							"factor":   0.1,
							"modifier": "log1p",
							"missing":  1,
						},
					},
					// Boost high-rated items
					map[string]any{
						"field_value_factor": map[string]any{
							"field":    "rating",
							"factor":   1.5,
							"modifier": "none",
							"missing":  3,
						},
					},
					// Recency boost
					map[string]any{
						"gauss": map[string]any{
							"created_at": map[string]any{
								"origin": time.Now().UTC().Format(time.RFC3339),
								"scale":  "30d",
								"decay":  0.5,
							},
						},
					},
				},
				"score_mode": "sum",
				"boost_mode": "multiply",
			},
		}
	} else {
		mainQuery = boolQuery
	}

	// Sort
	sort := s.buildSort(req.SortBy, req.Query != "")

	// Aggregations for facets
	aggs := map[string]any{
		"categories": map[string]any{
			"terms": map[string]any{
				"field": "category",
				"size":  20,
			},
		},
		"brands": map[string]any{
			"terms": map[string]any{
				"field": "brand",
				"size":  20,
			},
		},
		"price_ranges": map[string]any{
			"range": map[string]any{
				"field": "price",
				"ranges": []any{
					map[string]any{"to": 25},
					map[string]any{"from": 25, "to": 50},
					map[string]any{"from": 50, "to": 100},
					map[string]any{"from": 100, "to": 250},
					map[string]any{"from": 250},
				},
			},
		},
		"avg_price": map[string]any{
			"avg": map[string]any{"field": "price"},
		},
		"avg_rating": map[string]any{
			"avg": map[string]any{"field": "rating"},
		},
	}

	return map[string]any{
		"query": mainQuery,
		"sort":  sort,
		"from":  (req.Page - 1) * req.PageSize,
		"size":  req.PageSize,
		"highlight": map[string]any{
			"fields": map[string]any{
				"name":        map[string]any{"number_of_fragments": 0},
				"description": map[string]any{"fragment_size": 150, "number_of_fragments": 3},
			},
			"pre_tags":  []string{"<mark>"},
			"post_tags": []string{"</mark>"},
		},
		"aggs":    aggs,
		"_source": true,
	}
}

func (s *SearchService) buildSort(sortBy string, hasQuery bool) []any {
	switch sortBy {
	case "price_asc":
		return []any{
			map[string]any{"price": map[string]any{"order": "asc"}},
		}
	case "price_desc":
		return []any{
			map[string]any{"price": map[string]any{"order": "desc"}},
		}
	case "rating":
		return []any{
			map[string]any{"rating": map[string]any{"order": "desc"}},
		}
	case "newest":
		return []any{
			map[string]any{"created_at": map[string]any{"order": "desc"}},
		}
	default: // relevance
		if hasQuery {
			return []any{"_score", map[string]any{"review_count": map[string]any{"order": "desc"}}}
		}
		return []any{
			map[string]any{"review_count": map[string]any{"order": "desc"}},
			map[string]any{"rating": map[string]any{"order": "desc"}},
		}
	}
}

// ESSearchResponse represents the raw Elasticsearch response
type ESSearchResponse struct {
	Took     int  `json:"took"`
	TimedOut bool `json:"timed_out"`
	Hits     struct {
		Total    struct{ Value int64 `json:"value"` } `json:"total"`
		MaxScore *float64                              `json:"max_score"`
		Hits     []struct {
			ID          string              `json:"_id"`
			Score       *float64            `json:"_score"`
			Source      Product             `json:"_source"`
			Highlight   map[string][]string `json:"highlight"`
		} `json:"hits"`
	} `json:"hits"`
	Aggregations map[string]json.RawMessage `json:"aggregations"`
}

func parseSearchResponse(r ESSearchResponse) *SearchResult {
	result := &SearchResult{
		Total: r.Hits.Total.Value,
		Took:  r.Took,
	}
	if r.Hits.MaxScore != nil {
		result.MaxScore = *r.Hits.MaxScore
	}

	for _, h := range r.Hits.Hits {
		hit := SearchHit{
			ID:         h.ID,
			Source:     h.Source,
			Highlights: h.Highlight,
		}
		if h.Score != nil {
			hit.Score = *h.Score
		}
		result.Hits = append(result.Hits, hit)
	}

	return result
}
```

### Junior → FAANG: Query DSL fundamentals, scoring intuition, and interview traps

The bool query has four clause types and they are not interchangeable. `must` requires the clause to match and contributes to `_score`. `should` is optional and contributes to `_score` when it matches. `filter` requires the clause to match and does not contribute to `_score`, and it is cacheable. `must_not` requires the clause not to match and does not contribute to `_score`. The single most common beginner mistake is writing `must: {"term": {"active": true}}` for a boolean filter that has nothing to do with relevance. That doubles query cost because the filter cache is bypassed and the clause is scored pointlessly. The rule is simple: if removing the clause cannot change which document is "better", it is a filter, not a must.

Worked example of the `multi_match` query above. The `fields` array boosts `name` by 3x, `brand` by 2x, `tags` by 1.5x, and `description` by 1x. When the user searches for `"apple iphone"`, Elasticsearch scores each document using BM25 per field and combines them according to `type`. `best_fields` takes the single best-scoring field (good for disjunctive matches where the query probably lives in one field). `most_fields` sums across fields (good for the same content analyzed different ways, like `name` and `name.stemmed`). `cross_fields` treats all fields as one virtual field (good for names split across first and last). `phrase` requires the terms to appear as a phrase. `phrase_prefix` allows the last term to be a prefix. Pick the type deliberately, do not leave it at the default.

Match versus term. `match` runs through the analyser chain, so `{"match": {"name": "Running Shoes"}}` on a text field with the standard analyser queries for `[running, shoes]`. `term` does not run through the analyser, so `{"term": {"name": "Running Shoes"}}` looks for the literal string `"Running Shoes"` in the posting list, which will not match anything because the indexed tokens are `[running, shoes]` lowercase. Term queries are correct on keyword fields. Match queries are correct on text fields. Mixing them up is the single most common source of "why does my query return nothing" tickets.

Interview entry-points. "How do you implement autocomplete?" Three valid answers with tradeoffs: edge-ngram analyser at index time with a standard search analyser (cheap, flexible, shown in the mapping earlier), the `search_as_you_type` field type (simpler, less control), or the completion suggester (fastest, prefix-only, no typo tolerance). "How do you paginate past 10,000?" `search_after` with a PIT, never `from + size` for deep pagination. "How do you debug why a document ranks where it does?" `explain: true` in the search request, or the `_explain` API for a single doc. These are the three questions that reliably come up.

### Senior @ FAANG: Scoring, rank fusion, learning to rank, and relevance operations

BM25 is the default similarity in modern Elasticsearch and OpenSearch. Understanding it is table stakes. Score is roughly `idf * tf_saturation * field_length_norm` where `tf_saturation` uses the `k1` parameter (default 1.2) to bound the benefit of repeated terms and `field_length_norm` uses `b` (default 0.75) to penalise long fields. Per-field tuning of `k1` and `b` via `similarity` on the mapping matters when fields have very different length distributions. A product `title` with a narrow length distribution wants a low `b`. A `description` with wide length variance wants a higher `b`. These knobs are invisible until you start measuring and then they are worth real nDCG points.

Function score is powerful and dangerous. The query above combines three functions (review count with log1p, rating linear, created_at gaussian decay) under `score_mode: sum` and `boost_mode: multiply`. The multiply applied to the bool query score means a document with great text relevance and zero reviews gets drowned by a document with mediocre text relevance and 10,000 reviews. That may or may not be the business intent. The mature pattern is to parameterise the boost weights and A/B test them, with an offline judgment set to catch regressions. Function score also defeats query caching because the score is document-dependent. For workloads dominated by function score, prefer `rank_feature` fields with precomputed popularity priors, which use `saturation`, `log`, or `sigmoid` functions and are cheaper and cacheable.

Rank features and rank_feature queries. Introduced in 7.0, matured through 8.x, they are the correct primitive for static document priors. You store `{"popularity": 42.0}` as a `rank_feature` field in the mapping, and at query time add `{"rank_feature": {"field": "popularity", "saturation": {"pivot": 20}}}` as a `should` clause. The function saturates at `pivot`, meaning doubling popularity from 10 to 20 matters, doubling from 1000 to 2000 barely does. This matches human intuition about diminishing returns on social signals and is more tractable than tuning a log1p in function_score. For negative priors use `rank_feature` with a `log` or a reciprocal, or define a `rank_features` field (plural) for sparse feature vectors such as the output of an ELSER model.

Hybrid retrieval with dense vectors. In Elasticsearch 9 the `retriever` construct replaces hand-rolled score normalization. A `standard` retriever wraps a BM25 query. A `knn` retriever does approximate nearest neighbor against a `dense_vector` field. An `rrf` retriever fuses N retrievers using reciprocal rank fusion, which is score-agnostic and works well across disparate score distributions. OpenSearch 3 has a `hybrid` query with normalization processors that does something similar. The lesson is that hand-weighting BM25 and kNN scores ("alpha times BM25 plus one minus alpha times cosine") is brittle because the score ranges drift with the corpus, and RRF is both simpler and more reliable. Dense-only retrieval is almost always worse than hybrid on real product-catalog and technical-documentation corpora because names, identifiers, and numbers are exact-match signals that embeddings miss.

Learning to rank. The Elasticsearch LTR plugin (and OpenSearch's ltr-plugin) implements a two-phase retrieve-then-rerank pipeline. A fast first-pass retriever (BM25 or hybrid) produces a few hundred candidates, a feature logger extracts per-document features, and a pre-trained model (XGBoost, LambdaMART) reranks. The productionization burden is large: a feature store that reconciles train-serve skew, an offline judgment pipeline with inter-annotator agreement tracking, a feedback loop that debiases click-through data, and a deployment process for model updates. The payoff is measurable nDCG gains on mature query sets. The anti-pattern is reaching for LTR before exhausting query-DSL-level tuning, because 80 percent of relevance wins come from the mapping and the query, and LTR only earns its complexity after those are saturated.

Relevance operations. The discipline that separates a mature search team is the judgment pipeline. A frozen golden set of queries with graded relevance judgments (typically 4-point: perfect, good, ok, bad) runs through `_rank_eval` on every query DSL change. nDCG@10 and MRR are reported as the primary metrics. A regression above a threshold (typically 1 percent relative) blocks the change. Parallel to this, an online A/B framework compares variants on live traffic with CTR, conversion, and abandonment as outcomes. The golden set catches regressions cheaply. The A/B framework catches changes where the offline metric did not correlate with the business metric. A team without both eventually ships a change that "looks better" offline and tanks revenue online, and spends a month unwinding it. The go-elasticsearch v9 typed API makes the golden-set discipline cheaper by letting you version query builders as code, test them with `_rank_eval` in CI, and reject regressions at PR time, which is the senior endgame.

---
