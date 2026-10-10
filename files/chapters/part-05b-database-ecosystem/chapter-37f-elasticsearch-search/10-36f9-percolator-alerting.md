## 37F.9 Percolator & Alerting

### Real-Time Query Matching

The percolator inverts the normal search relationship: instead of storing documents and running queries against them, it stores queries and tests incoming documents to find which queries match. This pattern fits real-time alerting where thousands of users each have a saved search and need to be notified when a new document matches their criteria.

**Scaling caveat:** the percolator does not scale linearly. Every incoming document is, under the hood, turned into a tiny in-memory index and matched against every stored percolator query (with a term-acceleration pre-filter). Ten thousand stored queries on a warm shard is fine. ten million is not. Past roughly 100k active queries per shard, or a document-arrival rate above a few hundred per second, the cost of per-document matching dominates the whole cluster. Production alerting at higher volume moves the match out of Elasticsearch: a Kafka Streams / Flink job holds the compiled queries in memory per partition, matches in-process, and writes results back. Keep percolators for "tens of thousands of rules" territory, not "every user's saved search on a social feed."

```go
package elasticsearch

import (
	"bytes"
	"context"
	"encoding/json"

	"github.com/elastic/go-elasticsearch/v9"
)

// Percolator: store queries, test documents against stored queries
// Use case: real-time alerts when documents match user-defined queries

const PercolatorMapping = `{
  "mappings": {
    "properties": {
      "query": { "type": "percolator" },
      "user_id": { "type": "keyword" },
      "alert_name": { "type": "keyword" },
      "channels": { "type": "keyword" },
      "name": { "type": "text" },
      "price": { "type": "scaled_float", "scaling_factor": 100 },
      "category": { "type": "keyword" }
    }
  }
}`

// RegisterAlert stores a search query to percolate against
func RegisterAlert(ctx context.Context, client *elasticsearch.Client, alert PriceAlert) error {
	doc := map[string]any{
		"user_id":    alert.UserID,
		"alert_name": alert.Name,
		"channels":   alert.Channels,
		// The stored query: "notify me when a laptop under $500 appears"
		"query": map[string]any{
			"bool": map[string]any{
				"must": []any{
					map[string]any{
						"match": map[string]any{"name": alert.Keyword},
					},
				},
				"filter": []any{
					map[string]any{
						"range": map[string]any{
							"price": map[string]any{"lte": alert.MaxPrice},
						},
					},
					map[string]any{
						"term": map[string]any{"category": alert.Category},
					},
				},
			},
		},
	}

	body, _ := json.Marshal(doc)
	res, err := client.Index(
		"price-alerts",
		bytes.NewReader(body),
		client.Index.WithDocumentID(alert.ID),
		client.Index.WithContext(ctx),
	)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	return nil
}

// CheckNewProduct finds all matching alerts for a new product
func CheckNewProduct(ctx context.Context, client *elasticsearch.Client, product Product) ([]PriceAlert, error) {
	query := map[string]any{
		"query": map[string]any{
			"percolate": map[string]any{
				"field":    "query",
				"document": product,
			},
		},
	}

	body, _ := json.Marshal(query)
	res, err := client.Search(
		client.Search.WithContext(ctx),
		client.Search.WithIndex("price-alerts"),
		client.Search.WithBody(bytes.NewReader(body)),
	)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()

	var resp struct {
		Hits struct {
			Hits []struct {
				Source PriceAlert `json:"_source"`
			} `json:"hits"`
		} `json:"hits"`
	}
	json.NewDecoder(res.Body).Decode(&resp)

	var alerts []PriceAlert
	for _, h := range resp.Hits.Hits {
		alerts = append(alerts, h.Source)
	}
	return alerts, nil
}

type PriceAlert struct {
	ID       string
	UserID   string
	Name     string
	Keyword  string
	Category string
	MaxPrice float64
	Channels []string // email, sms, push
}
```

### Junior → FAANG: Prerequisite Gaps and Worked Examples

The prerequisite flip is understanding that a percolator query is a document. You index it into a regular index, with a special field of type `percolator` that holds a JSON-serialized query. At match time, you call the `_search` API with a `percolate` clause that wraps the incoming document, and Elasticsearch turns that single document into a miniature in-memory index, runs every stored query against it, and returns the queries that matched. The "query" and "document" roles are reversed from normal search.

Worked example for a first-job ticket: "users want to be notified when new laptops match their saved search." The right mental model is two indexes. Index A holds products, used for normal search traffic. Index B has `type: percolator` on a `query` field, plus keyword fields for `user_id`, `alert_name`, and notification channels. When a new product is indexed into A, a pipeline reads it, runs a `percolate` query against B with the product as the document, and for each match fires a notification to the stored `user_id` via the stored `channels`. The extension you will be asked about in interviews: what if the product is edited to no longer match? Percolator does not track state. You implement it in the pipeline by re-percolating the old and new versions and diffing the match sets.

Second worked example: "our percolator is slow." Diagnosis usually: (1) every stored query has a `match_all` or leading wildcard that forces full-index scans of the in-memory doc, (2) too many stored queries per shard, (3) the `percolate` call includes the full JSON document when only a few fields are queried. Fixes in order: add `batched_reduce_size` and `filter` fields on the percolator index to pre-narrow candidate queries by the categorical fields the incoming doc has, normalize stored queries to use `term` and `range` rather than leading wildcards, and ship only the fields that stored queries reference.

Interview entry-point: know that percolator uses a term-acceleration filter. At index time, the percolator mapping extracts required terms from each stored query and indexes them as a hidden field. At percolate time, the incoming document's terms are used to skip stored queries that can never match. This is why a `match` on `name: "laptop"` only scans stored queries that also mention "laptop." Know that this optimization fails for queries that do not extract terms (leading wildcards, `match_all`, script queries), which silently scan every stored query.

### Senior @ FAANG: Staff and Principal Material

Alerting architecture is a decision tree more than a feature. The three realistic options in the Elastic 9.0 ecosystem are percolator, Kibana Alerting, and Watcher (deprecated but still present), plus the "roll your own" option on Kafka or Flink. The decision depends on cardinality and latency.

Kibana Alerting is the modern default for "run this query every N minutes and alert if the count crosses a threshold." It is a scheduled query engine with connectors for Slack, PagerDuty, email, webhook, and ServiceNow. It is the right tool when alert rules are in the tens to low thousands, each rule is a saved query plus a threshold, and the alert cadence is minutes not milliseconds. Kibana Alerting handles rule lifecycle, dedup via alert instance IDs, throttle and mute, and it integrates with Cases for incident tracking. Do not build this yourself unless you have a specific reason. Scale ceiling: Kibana task manager becomes the bottleneck at low-tens-of-thousands of rules per cluster. Past that, shard the rules across multiple Kibana instances or move to a custom scheduler.

Watcher is the XPack legacy, still supported but no new features. It is a JSON-defined rule engine with triggers, inputs, conditions, transforms, and actions. If you inherit Watchers, keep them running but migrate to Kibana Alerting when feature parity is reached. Writing new Watchers in 2026 is a choice against the roadmap.

Percolator is the right tool only when two conditions hold: rules are defined by end users (not ops), and the matching latency requirement is per-event not per-window. The canonical fit is "alert me when any new document matches my saved search," with tens of thousands of user-defined rules and a per-event latency SLO in the hundreds of milliseconds. Percolator falls over for very high rule counts because every incoming event becomes an in-memory index that must be matched against every stored query on the shards that hold percolators matching at least one of the event's terms. Even with term-acceleration filtering, million-rule percolator indices regularly saturate a single node's CPU and have unpredictable p99 because a single event with many extracted terms (a long text document) can match thousands of stored queries, each of which runs a full query execution.

Stream-processing alternative. For high-volume alerting (social feeds, fraud detection, security SIEM detection rules), move matching out of Elasticsearch entirely. Partition the rule set by some stable key (user_id, tenant, region), compile rules in-process on Flink or Kafka Streams operators, and match events inline in the stream. The rules can be stored in Elasticsearch for governance but loaded into operator state on startup and refreshed via a broadcast stream for updates. Benefits: matching is O(1) hash lookups plus small boolean evaluations, throughput scales linearly with Kafka partitions, and Elasticsearch is not in the hot path. Cost: you re-implement the subset of query DSL you actually support. For SIEM-style detection, that subset is typically just predicates over structured fields, which is tractable. For fuzzy text matching, it is not, and you are back to percolator.

Security detection engines (Elastic Security, Sigma, Falco) use a hybrid. Structured detection rules run as scheduled ES aggregation queries (Kibana Alerting internals), while EDR endpoint rules run in process. Do not try to replace the whole stack with a single engine. Tier by rule type.

Correctness concerns for percolator at staff level. First, deduplication. A percolator match fires every time the document is indexed. If your pipeline retries on failure, you re-fire, and users get duplicate alerts. Use idempotency keys downstream (tuple of alert_id + product_id + version) and dedup in the notifier. Second, rule update visibility. A user updating their saved search expects the next matching product to use the new query. Because percolator is just a document, updates go through normal ES versioning, and queries read the latest refreshed version. If `refresh_interval` is 30s on the percolator index, there is a 30-second gap where old queries are still in effect. Force refresh on rule update endpoints. Third, schema evolution. Percolator queries compile against the main index mapping. If you add a field to the product mapping, old stored queries that referenced the missing field as a `term` (returning nothing) now start matching. This is the most common production surprise. Version your percolator queries with a `schema_version` field and filter percolate calls by compatible versions.

Capacity planning. Model percolator cost as `C = Q times avg_match_cost_per_query times event_rate`. Avg match cost depends on query shape but is typically 10 to 100 microseconds. Q is queries per shard. At 1 million QPS of events on a 10-node cluster with 100k queries per shard, each event needs 100k times 50us = 5 seconds of CPU, which is 5000x more than you have. Fix by reducing Q (shard rules across many percolator indices, route events to only the index holding rules that can match), reducing per-query cost (strict term-accelerable queries only), or moving to stream processing. This math is the staff deliverable, not the mapping.

Governance: treat rules as code. Version rule definitions in Git, deploy them via a CI pipeline that validates query syntax (via `_validate/query`), runs a canary against a held-out event set to catch mass-match explosions, and tracks noisy-rule SLOs (a rule that fires more than N times per day is auto-disabled). Alert quality is a product metric. Without this, users mute alerts and the whole system loses value silently.

---
