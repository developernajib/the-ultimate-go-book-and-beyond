## 37F.7 Index Lifecycle Management (ILM)

### Data Streams and Rollover

Time-series data like logs and metrics grows continuously, and old data becomes less valuable over time. ILM policies automate the progression of indices through lifecycle phases (hot with active writes and fast SSDs, warm with read-only force-merged shards, cold with searchable snapshots on object storage, and delete) based on age or size thresholds. Combined with data streams, which abstract away the underlying rolling indices, ILM keeps storage costs bounded while maintaining query access to historical data.

```go
package elasticsearch

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"

	"github.com/elastic/go-elasticsearch/v9"
)

// ILMManager manages index lifecycle policies
type ILMManager struct {
	client *elasticsearch.Client
}

// CreateLogILMPolicy creates a policy for log data
func (m *ILMManager) CreateLogILMPolicy(ctx context.Context) error {
	policy := map[string]any{
		"policy": map[string]any{
			"phases": map[string]any{
				// Hot: active writes, full replicas
				"hot": map[string]any{
					"min_age": "0ms",
					"actions": map[string]any{
						"rollover": map[string]any{
							"max_size":       "50gb",
							"max_age":        "7d",
							"max_docs":       50_000_000,
						},
						"set_priority": map[string]any{"priority": 100},
					},
				},
				// Warm: no writes, reduce replicas, force merge
				"warm": map[string]any{
					"min_age": "7d",
					"actions": map[string]any{
						"shrink":       map[string]any{"number_of_shards": 1},
						"forcemerge":   map[string]any{"max_num_segments": 1},
						"allocate":     map[string]any{"number_of_replicas": 1},
						"set_priority": map[string]any{"priority": 50},
					},
				},
				// Cold: snapshot, remove replicas
				"cold": map[string]any{
					"min_age": "30d",
					"actions": map[string]any{
						"allocate":     map[string]any{"number_of_replicas": 0},
						"set_priority": map[string]any{"priority": 0},
						"searchable_snapshot": map[string]any{
							"snapshot_repository": "my_s3_repository",
						},
					},
				},
				// Frozen: minimal cost storage
				"frozen": map[string]any{
					"min_age": "60d",
					"actions": map[string]any{
						"searchable_snapshot": map[string]any{
							"snapshot_repository": "my_s3_repository",
						},
					},
				},
				// Delete: purge
				"delete": map[string]any{
					"min_age": "90d",
					"actions": map[string]any{
						"delete": map[string]any{},
					},
				},
			},
		},
	}

	body, _ := json.Marshal(policy)
	res, err := m.client.ILM.PutLifecycle(
		"logs-policy",
		m.client.ILM.PutLifecycle.WithBody(bytes.NewReader(body)),
		m.client.ILM.PutLifecycle.WithContext(ctx),
	)
	if err != nil {
		return err
	}
	defer res.Body.Close()

	if res.IsError() {
		return fmt.Errorf("ILM policy create: %s", res.String())
	}
	return nil
}

// CreateIndexTemplate creates a template for data streams
func (m *ILMManager) CreateDataStreamTemplate(ctx context.Context) error {
	template := map[string]any{
		"index_patterns": []string{"logs-*-*"},
		"data_stream":    map[string]any{},
		"template": map[string]any{
			"settings": map[string]any{
				"number_of_shards":   2,
				"number_of_replicas": 1,
				"index.lifecycle.name": "logs-policy",
				"index.codec": "best_compression",
			},
			"mappings": map[string]any{
				"dynamic":    true,
				"properties": map[string]any{
					"@timestamp": map[string]any{"type": "date"},
					"level":      map[string]any{"type": "keyword"},
					"service":    map[string]any{"type": "keyword"},
					"message":    map[string]any{"type": "text"},
					"trace_id":   map[string]any{"type": "keyword"},
					"span_id":    map[string]any{"type": "keyword"},
					"error": map[string]any{
						"properties": map[string]any{
							"type":       map[string]any{"type": "keyword"},
							"message":    map[string]any{"type": "text"},
							"stacktrace": map[string]any{"type": "text", "index": false},
						},
					},
				},
			},
		},
		"priority": 500,
	}

	body, _ := json.Marshal(template)
	res, err := m.client.Indices.PutIndexTemplate(
		"logs-template",
		bytes.NewReader(body),
		m.client.Indices.PutIndexTemplate.WithContext(ctx),
	)
	if err != nil {
		return err
	}
	defer res.Body.Close()

	if res.IsError() {
		return fmt.Errorf("template create: %s", res.String())
	}
	return nil
}

// DataStreamIndexer writes to an Elasticsearch data stream
type DataStreamIndexer struct {
	client *elasticsearch.Client
	stream string
}

// IndexLog writes a log entry to the data stream
func (d *DataStreamIndexer) IndexLog(ctx context.Context, log LogEntry) error {
	body, _ := json.Marshal(log)

	res, err := d.client.Index(
		d.stream, // data stream name
		bytes.NewReader(body),
		d.client.Index.WithContext(ctx),
		// No _id for data streams - ES generates time-series ID
	)
	if err != nil {
		return err
	}
	defer res.Body.Close()

	if res.IsError() {
		return fmt.Errorf("index log: %s", res.String())
	}
	return nil
}

type LogEntry struct {
	Timestamp time.Time              `json:"@timestamp"`
	Level     string                 `json:"level"`
	Service   string                 `json:"service"`
	Message   string                 `json:"message"`
	TraceID   string                 `json:"trace_id,omitempty"`
	SpanID    string                 `json:"span_id,omitempty"`
	Fields    map[string]any `json:"fields,omitempty"`
	Error     *LogError              `json:"error,omitempty"`
}

type LogError struct {
	Type       string `json:"type"`
	Message    string `json:"message"`
	Stacktrace string `json:"stacktrace,omitempty"`
}
```

### Junior → FAANG: Prerequisite Gaps and Worked Examples

The prerequisite concept you need is the rolling index. Elasticsearch indices have a hard upper limit of roughly 2 billion documents per shard, and practical sweet-spot shard size is 10 to 50GB. A single unbounded index for logs is therefore wrong from day one. Rollover creates a new backing index when any threshold (size, age, or doc count) is crossed, and ILM drives that rollover automatically. A data stream is a thin alias layer over these rolling indices that routes writes to the latest index and fans reads across all. If you understand that, the rest of ILM is policy plumbing.

Worked example for a first-job ticket: "our log index is 800GB and queries are slow, fix it." The first move is not to delete data, it is to set up a data stream with an ILM policy that rolls over at 50GB or 7 days, force-merges warm indices to one segment, and deletes data older than retention. Run a one-time reindex from the old monolithic index into the data stream, then delete the old index. Second-order work: set `index.codec: best_compression` (DEFLATE instead of LZ4) on the template, which typically cuts disk by 15 to 25 percent on log data at the cost of slightly higher CPU during queries. Most log workloads are disk-bound, so this is a win.

Second worked example: "we can query logs from today fast, but queries for last month time out." Diagnosis: warm or cold indices still have the same replica count and shard count as hot, so they spread across many nodes and every query fans out widely. Fix: in the warm phase add `shrink` to one shard and `forcemerge` to one segment. Shard count drops, per-shard size goes up (still under 50GB), coordinating node talks to fewer shards, latency drops. Add a `allocate` action that moves warm indices to slower/cheaper nodes via `_tier_preference: data_warm`.

Interview entry-point: know that rollover triggers check on scheduled ILM polls (default every 10 minutes, `indices.lifecycle.poll_interval`). That is why "my index did not roll over at exactly 50GB" is normal, not a bug. Know that force-merging to one segment is not free: it rewrites the entire shard and doubles disk IO for the duration. Never force-merge a hot index that is still being written. Know the difference between close (index is offline, takes no heap, cannot be searched) and freeze (the old `_freeze` API was deprecated back in 7.14 and superseded by the frozen tier with searchable snapshots).

### Senior @ FAANG: Staff and Principal Material

At staff level, ILM becomes a cost and capacity planning tool more than an operational one. The core economic argument is tier differentiation: hot data on NVMe at maybe $0.30 per GB-month, warm on SSDs at $0.10, cold on searchable snapshots against S3 at $0.023, frozen at roughly $0.005 through aggressive partial caching. For a 100TB annual log retention, that gap is the difference between a $300k/year Elasticsearch bill and a $40k/year bill. Your ILM policy is a budget artifact, not just a config file.

Searchable snapshots are the single biggest 9.0-era capability shift. In the `cold` phase, you mount a snapshot from S3 (or GCS, Azure Blob) as a fully searchable index where the primary data lives in object storage and the node keeps a local LRU cache. Reads that miss the cache fetch from S3 on demand, typically in 100 to 500ms for a cold block. In the `frozen` tier, there is no local full copy, only a small shared cache sized by the `xpack.searchable.snapshot.shared_cache.size` setting (recommended 90 percent of the local disk). Frozen nodes routinely run 100x the ratio of indexed data to local disk, meaning one frozen node with 2TB of disk can serve 200TB of historical data with acceptable latency for dashboards that hit it occasionally. The failure mode to watch is cache thrash: if your dashboards scan broadly across frozen data, cache evictions become the bottleneck and p99 jumps to tens of seconds. Mitigate by pinning high-traffic dashboards to a time window that fits in warm or cold tiers, or by pre-warming the frozen cache with synthetic queries before a known-heavy read window.

Rollover thresholds deserve staff-level attention because they interact non-obviously with shard sizing. The target is 30 to 50GB per shard post-merge. If you set `max_primary_shard_size: 50gb` in the rollover action (9.0 preferred over the legacy `max_size`), ILM rolls over based on the largest primary shard, which is the metric you actually care about. Older policies use `max_size` which is total primary+replica across the whole index, which is meaningless for shard sizing. Audit old policies and migrate.

Shrink and force-merge are the two cost-reduction actions that matter most. Shrink reduces shard count by merging shards in place, requiring the source shards to all sit on the same node first (the `set_single_node` and `allocate` preconditions). On a cluster with tight disk headroom, shrink can fail because it needs space for both the source and target. Budget 2x the index size as free space on at least one node in the target tier. Force-merge to one segment eliminates the per-segment overhead for queries and lets `_doc` values compress better, but it is a one-shot operation that rewrites the entire index. On a 50GB shard it can take 30 minutes and saturate the disk. Schedule force-merge during low-traffic windows or route warm traffic around the merging node.

Data streams vs aliases: data streams are the strict superset for append-only time-series data. They enforce `@timestamp` presence, route writes to the write-index automatically, and disallow updates to documents in non-write indices. That last point catches teams migrating from aliases: if your pipeline does upserts on log documents, data streams will reject them. Use TSDS (time series data streams) in 9.0 for metrics, which adds dimension-based routing and 2x to 5x storage compression via ordered-by-dimension LSM-style writes. TSDS is the correct choice for Prometheus-style metrics shipped to Elasticsearch, and it is dramatically cheaper than regular data streams at metric scale.

Snapshot repository design is where teams lose data. The repository must be on durable shared storage (S3 with versioning, GCS, or a correctly configured shared filesystem). Run `verify_repository` in a scheduled job because silent credential rotation is the usual failure mode. Enable SLM (Snapshot Lifecycle Management) with at least two policies: a daily policy with 14 day retention for operational rollback, and a weekly policy with 90 day retention for compliance. Never rely on searchable snapshots as your only backup. A searchable snapshot is a mount of a snapshot, but if the snapshot is deleted or the repository corrupts, the mounted index becomes unreadable. Keep independent snapshots for disaster recovery separate from the searchable-snapshot repository if audit requires it.

Governance and correctness. ILM policies are versioned but not strictly immutable, and a policy change applies to new rollovers while existing indices continue on their old phase definitions. If you change `delete.min_age` from 90d to 30d, expect existing indices to hold on the stale policy until they are manually updated via `POST _ilm/retry` or the `index.lifecycle.name` is re-applied. Run a reconciliation check weekly that compares every index's current phase to the latest policy and alerts on drift. Second governance point: cross-cluster replication (CCR) with ILM has edge cases around rollover on the follower. Use CCR auto-follow patterns that match the data stream name, not individual backing indices, and let the follower's ILM run in read-only mode (`ccr` phase actions, not the full policy). Third: kill switches. Tag critical indices with `index.lifecycle.prevent_rollover: true` before a schema migration and restore after, so an unexpected rollover mid-migration does not leave you with two incompatible backing indices.

Finally, capacity math. Daily ingest D (GB), retention R (days), hot duration H, warm W, cold C, frozen F. Hot storage = D times H times replica_factor times 1.1 (overhead). Warm = D times W times replica_factor times 0.7 (force-merge savings) times 0.85 (best_compression). Cold searchable_snapshot = D times C times 0.5 (no replicas, object store). Frozen = D times F times 0.5 (no local copies). Plug your numbers in, multiply by tier pricing, and you have a defensible tiering proposal that survives finance review. That is the staff deliverable, not a policy YAML.

---
