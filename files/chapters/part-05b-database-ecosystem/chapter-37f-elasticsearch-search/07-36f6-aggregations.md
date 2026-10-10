## 37F.6 Aggregations

### Analytics with ES Aggregations

Elasticsearch aggregations compute analytics over distributed result sets in a single query, functioning as a distributed `GROUP BY`. The pipeline below composes terms, date histogram, and nested aggregations to produce a product analytics dashboard directly from the search index.

```go
package elasticsearch

import (
	"bytes"
	"context"
	"encoding/json"
	"time"

	"github.com/elastic/go-elasticsearch/v9"
)

// AnalyticsService provides ES-backed analytics
type AnalyticsService struct {
	client *elasticsearch.Client
	index  string
}

// SalesDashboard returns a complete sales analytics dashboard
func (a *AnalyticsService) SalesDashboard(ctx context.Context, from, to time.Time) (*Dashboard, error) {
	query := map[string]any{
		"query": map[string]any{
			"range": map[string]any{
				"created_at": map[string]any{
					"gte": from.UTC().Format(time.RFC3339),
					"lte": to.UTC().Format(time.RFC3339),
				},
			},
		},
		"size": 0, // no hits, only aggregations
		"aggs": map[string]any{
			// Date histogram: daily revenue
			"daily_revenue": map[string]any{
				"date_histogram": map[string]any{
					"field":             "created_at",
					"calendar_interval": "day",
					"format":            "yyyy-MM-dd",
					"time_zone":         "UTC",
				},
				"aggs": map[string]any{
					"revenue": map[string]any{
						"sum": map[string]any{"field": "total"},
					},
					"order_count": map[string]any{
						"value_count": map[string]any{"field": "order_id"},
					},
				},
			},

			// Top categories by revenue
			"top_categories": map[string]any{
				"terms": map[string]any{
					"field": "category",
					"size":  10,
					"order": map[string]any{"revenue": "desc"},
				},
				"aggs": map[string]any{
					"revenue": map[string]any{
						"sum": map[string]any{"field": "total"},
					},
				},
			},

			// Revenue percentiles
			"revenue_percentiles": map[string]any{
				"percentiles": map[string]any{
					"field":    "total",
					"percents": []float64{25, 50, 75, 90, 95, 99},
				},
			},

			// Status breakdown
			"order_status": map[string]any{
				"terms": map[string]any{
					"field": "status",
					"size":  10,
				},
				"aggs": map[string]any{
					"revenue": map[string]any{
						"sum": map[string]any{"field": "total"},
					},
				},
			},

			// Moving average (7-day rolling)
			"daily_orders": map[string]any{
				"date_histogram": map[string]any{
					"field":             "created_at",
					"calendar_interval": "day",
				},
				"aggs": map[string]any{
					"order_count": map[string]any{
						"value_count": map[string]any{"field": "order_id"},
					},
					"7day_avg": map[string]any{
						"moving_avg": map[string]any{
							"buckets_path": "order_count",
							"window":       7,
						},
					},
				},
			},

			// Geo heatmap
			"geo_heatmap": map[string]any{
				"geohash_grid": map[string]any{
					"field":     "shipping_location",
					"precision": 3,
				},
				"aggs": map[string]any{
					"revenue": map[string]any{
						"sum": map[string]any{"field": "total"},
					},
				},
			},
		},
	}

	bodyBytes, _ := json.Marshal(query)
	res, err := a.client.Search(
		a.client.Search.WithContext(ctx),
		a.client.Search.WithIndex(a.index),
		a.client.Search.WithBody(bytes.NewReader(bodyBytes)),
	)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()

	var resp struct {
		Aggregations map[string]json.RawMessage `json:"aggregations"`
	}
	json.NewDecoder(res.Body).Decode(&resp)

	return parseDashboard(resp.Aggregations), nil
}

type Dashboard struct {
	DailyRevenue        []DailyRevenue
	TopCategories       []CategoryRevenue
	RevenuePercentiles  map[string]float64
	OrderStatusBreakdown []StatusCount
}

type DailyRevenue struct {
	Date       string
	Revenue    float64
	OrderCount int64
}

type CategoryRevenue struct {
	Category string
	Revenue  float64
}

type StatusCount struct {
	Status  string
	Count   int64
	Revenue float64
}

func parseDashboard(aggs map[string]json.RawMessage) *Dashboard {
	d := &Dashboard{}

	// Parse daily revenue
	if raw, ok := aggs["daily_revenue"]; ok {
		var hist struct {
			Buckets []struct {
				KeyAsString string `json:"key_as_string"`
				Revenue     struct{ Value float64 `json:"value"` } `json:"revenue"`
				OrderCount  struct{ Value int64 `json:"value"` } `json:"order_count"`
			} `json:"buckets"`
		}
		json.Unmarshal(raw, &hist)
		for _, b := range hist.Buckets {
			d.DailyRevenue = append(d.DailyRevenue, DailyRevenue{
				Date:       b.KeyAsString,
				Revenue:    b.Revenue.Value,
				OrderCount: b.OrderCount.Value,
			})
		}
	}

	return d
}
```

### Junior → FAANG: Prerequisite Gaps and Worked Examples

The mental model that unlocks aggregations is this: an aggregation is a tree. Bucket aggregations (`terms`, `date_histogram`, `range`, `histogram`, `filters`, `geohash_grid`) split documents into groups. Metric aggregations (`sum`, `avg`, `min`, `max`, `cardinality`, `percentiles`, `stats`) compute a number over documents. Pipeline aggregations (`moving_avg`, `cumulative_sum`, `bucket_sort`, `derivative`) compute on the output of other aggregations. You compose them by nesting. If you understand that, you can read any dashboard query.

Worked example for a first-job ticket: "count unique users per day." The naive query uses a `date_histogram` with a nested `value_count` on `user_id`. That returns the number of events per day, not unique users. The correct answer is `cardinality` on `user_id.keyword`. The next gotcha: `cardinality` is approximate, using HyperLogLog++ with default `precision_threshold: 3000`. Below the threshold, counts are exact. Above, error is roughly 1 to 6 percent. If product needs exact counts for billing, you cannot use cardinality and must pre-aggregate in a separate pipeline. Junior engineers ship the approximate version and get paged six months later when finance reconciles.

Second worked example: "group by product name." If `name` is mapped as `text`, a `terms` aggregation on it will either fail (since ES 5.x) or silently activate fielddata on a text field, which loads every unique term for every document into heap and can OOM the node. The right fix is `name.keyword`. This is the single most common junior aggregation bug. Lesson: aggregate on `keyword`, search on `text`, and plan your multi-field mapping up front.

Interview entry-point: know that `size: 0` on the root query means "skip the hits, return only aggs." Know that aggregations run after the query, so filtering cuts cost. Know that terms aggregations return the top N per shard, not the true global top N, which is the classic `shard_size` question. Be ready to explain why `size: 10` with two shards might miss a globally top-10 term whose occurrences were scattered across both shards below each shard's local top-10. The answer is to increase `shard_size` (default is `size * 1.5 + 10`) or accept the `doc_count_error_upper_bound` returned in the response.

### Senior @ FAANG: Staff and Principal Material

Aggregations at scale are where teams burn the most cluster budget, and where a staff engineer earns their keep by saying no. Start with the terms aggregation, the most-used and most-abused aggregation in the system. The accuracy-versus-memory tradeoff is governed by `size` (what you return to the client) and `shard_size` (what each shard computes locally before sending to the coordinating node). The coordinating node merges shard results and recomputes the global top N. If shard_size is too small, you get `doc_count_error_upper_bound` bigger than zero, meaning a term could have been missed. The fix is raising shard_size, but shard_size times number of shards is the memory footprint on the coordinator. On a 100-shard index with `size: 100`, a naive `shard_size: 10000` allocates a 1 million entry priority queue per query. Prefer composite aggregations for any case where you actually need all buckets, because composite paginates and never materializes the full cardinality in memory.

Cardinality via HLL: the `precision_threshold` parameter trades memory for accuracy. Precision 100 uses roughly 400 bytes per bucket, precision 40000 (max) uses roughly 80KB. For dashboards with one cardinality metric on top-level, 40000 is cheap. For nested terms with cardinality child, where you compute cardinality per bucket for 10000 buckets, 40000 precision means 800MB of HLL state per query, and you will OOM. Tune precision_threshold against your expected cardinality, not defensively. Second HLL pitfall: the hash is computed from the field value, so `cardinality` on a keyword field hashes the string every query. For hot paths, index with `precomputed_hash: true` in the mapping or use a `_doc_count` field, which stores pre-hashed values in doc_values.

Doc_values discipline is the deepest aggregation skill. Aggregations read doc_values (column-oriented on-disk data structures in Lucene) rather than the inverted index. A field with `doc_values: false` cannot be aggregated, sorted, or scripted. On a large log index where most fields are never aggregated, disabling doc_values on the 90 percent of fields you never group by can cut disk footprint by 30 to 50 percent. The audit is straightforward: join slow_log queries with the mapping, find fields that only appear in `query` never in `aggs` or `sort`, and set `doc_values: false` in the next mapping version. Conversely, a field that is aggregated heavily but defined as `text` is burning fielddata heap. Force it to `keyword` with a multi-field.

Composite aggregations are the correct choice for any aggregation that returns more than a few hundred buckets, for exporting, or for powering paginated analytics UIs. Composite holds a small in-memory buffer per shard and streams buckets in sorted order with an `after` cursor, so memory is O(`size`) not O(cardinality). The tradeoff is that composite does not support bucket ordering by sub-metric, only by the bucket key. If product wants "top 10000 customers by spend," composite alone will not do it. You either: (1) pre-aggregate via a transform job to a summary index and use terms on that, or (2) combine composite with a client-side heap. Pipeline aggregations like `bucket_sort` do order by metric, but they operate on the parent's output, which still requires the parent to materialize all buckets in memory. That is the trap.

Transforms and entity-centric indices are the staff-level answer to expensive aggregations. A continuous transform reads a source index, computes a group-by, and writes the results to a destination index as regular documents. Your dashboards query the destination, which is already aggregated and therefore orders of magnitude cheaper. The ES transform API supports `pivot` (group-by) and `latest` (last doc per key). Run them as continuous with a `sync.time.field` and a reasonable `frequency: 1m`. The gotcha: transforms run as regular search-and-index jobs on the coordinating node, so they compete with live traffic. Schedule them on dedicated ingest nodes or off-peak windows.

Date_histogram has two footguns. First, `calendar_interval` vs `fixed_interval`. Calendar intervals (day, month) respect DST and month lengths, fixed intervals (24h, 30d) do not. Using `day` for a billing dashboard with users in multiple time zones is almost always wrong, because a "day" shifts with DST. Pin to UTC fixed intervals and let the client render local time. Second, `min_doc_count: 1` is the default, which omits empty buckets. If you want a flat time series chart, set `min_doc_count: 0` and `extended_bounds`, otherwise your chart will have gaps and your moving_avg will jump.

Pipeline aggregations like `moving_fn` and `cumulative_sum` run after the bucket tree is built. They are cheap compute-wise but can destabilize a query if the parent date_histogram has millions of buckets, which happens with `fixed_interval: 1s` on a long range. Cap the bucket count with `max_bucket` at the cluster or request level. Set `search.max_buckets: 65536` cluster-wide and reject queries that exceed it rather than letting them OOM a node.

Finally, governance. Aggregations are the number one source of heap-related incidents in Elasticsearch clusters. Enforce these rules in a query linter or middle-tier: reject terms aggregations on text fields, reject terms with `size > 10000`, reject cardinality with `precision_threshold > 10000`, require composite for pagination, require `size: 0` on pure analytics queries. Route heavy analytics traffic to a dedicated coordinating-node tier with its own circuit breakers and keep interactive search on a separate tier. Expose per-query aggregation cost in APM traces so product teams see the dollar impact of their dashboards.

---
