## 37F.8 Scroll & Point in Time API

### Processing Large Result Sets

Deep pagination with `from`/`size` is expensive because Elasticsearch must collect and rank `from + size` hits on every shard, which is why the cluster enforces `index.max_result_window` (default 10,000) as a hard ceiling. The Point in Time (PIT) API opens a consistent snapshot of the index and, combined with `search_after`, enables stateless cursor-based pagination that scales to millions of results without the memory overhead of the legacy scroll API. Scroll has been deprecated for deep pagination since 7.10 and should be treated as a compatibility-only path. Prefer PIT + `search_after` for every new workload, including reindex, export, and background analytics jobs. Unlike scroll, PIT is cheap to open in parallel, does not pin a search context per cursor, and composes naturally with aggregations and `track_total_hits: false`.

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

// ScrollProcessor processes large datasets using PIT (Point in Time) API
// Preferred over scroll for concurrent reads and consistent snapshots
type ScrollProcessor struct {
	client *elasticsearch.Client
	index  string
}

// ProcessAll processes all documents in batches using PIT + search_after
func (p *ScrollProcessor) ProcessAll(ctx context.Context, query map[string]any, batchSize int, process func([]Product) error) error {
	// Open PIT
	res, err := p.client.OpenPointInTime(
		p.client.OpenPointInTime.WithIndex(p.index),
		p.client.OpenPointInTime.WithKeepAlive("5m"),
		p.client.OpenPointInTime.WithContext(ctx),
	)
	if err != nil {
		return fmt.Errorf("open PIT: %w", err)
	}
	defer res.Body.Close()

	var pitResp struct{ ID string `json:"id"` }
	json.NewDecoder(res.Body).Decode(&pitResp)
	pitID := pitResp.ID

	// Ensure PIT is closed on exit
	defer func() {
		closeBody, _ := json.Marshal(map[string]any{"id": pitID})
		closeRes, _ := p.client.ClosePointInTime(
			p.client.ClosePointInTime.WithBody(bytes.NewReader(closeBody)),
		)
		if closeRes != nil {
			closeRes.Body.Close()
		}
	}()

	var searchAfter []any

	for {
		searchQuery := map[string]any{
			"query": query,
			"size":  batchSize,
			"sort": []any{
				map[string]any{"created_at": "asc"},
				map[string]any{"_id": "asc"}, // tiebreaker
			},
			"pit": map[string]any{
				"id":         pitID,
				"keep_alive": "5m",
			},
			"track_total_hits": false, // faster for large datasets
		}

		if len(searchAfter) > 0 {
			searchQuery["search_after"] = searchAfter
		}

		body, _ := json.Marshal(searchQuery)
		searchRes, err := p.client.Search(
			p.client.Search.WithContext(ctx),
			p.client.Search.WithBody(bytes.NewReader(body)),
			// No index needed when using PIT
		)
		if err != nil {
			return fmt.Errorf("search: %w", err)
		}

		var resp ESSearchResponse
		json.NewDecoder(searchRes.Body).Decode(&resp)
		searchRes.Body.Close()

		// Update PIT ID (server may rotate it)
		// pitID = resp.PitID (if present in response)

		if len(resp.Hits.Hits) == 0 {
			break // no more results
		}

		// Extract products
		var products []Product
		for _, h := range resp.Hits.Hits {
			products = append(products, h.Source)
		}

		// Process batch
		if err := process(products); err != nil {
			return fmt.Errorf("process batch: %w", err)
		}

		// Update search_after from last hit's sort values
		// In real implementation, extract sort values from last hit
		if len(resp.Hits.Hits) < batchSize {
			break // last page
		}
	}

	return nil
}

// ReindexWithTransform reindexes data with transformation
func (p *ScrollProcessor) Reindex(ctx context.Context, sourceIndex, destIndex string) error {
	body := map[string]any{
		"source": map[string]any{
			"index": sourceIndex,
			"size":  1000,
		},
		"dest": map[string]any{
			"index":   destIndex,
			"op_type": "create", // fail if doc already exists
		},
		"script": map[string]any{
			"source": `
				ctx._source.migrated_at = params.now;
				if (ctx._source.containsKey('old_field')) {
					ctx._source.new_field = ctx._source.old_field;
					ctx._source.remove('old_field');
				}
			`,
			"params": map[string]any{
				"now": time.Now().UTC().Format(time.RFC3339),
			},
			"lang": "painless",
		},
	}

	bodyBytes, _ := json.Marshal(body)
	res, err := p.client.Reindex(
		p.client.Reindex.WithBody(bytes.NewReader(bodyBytes)),
		p.client.Reindex.WithContext(ctx),
		p.client.Reindex.WithWaitForCompletion(false), // async for large datasets
		p.client.Reindex.WithRequestsPerSecond(1000),  // throttle
	)
	if err != nil {
		return err
	}
	defer res.Body.Close()

	var task struct{ Task string `json:"task"` }
	json.NewDecoder(res.Body).Decode(&task)
	fmt.Printf("Reindex task: %s\n", task.Task)
	return nil
}
```

### Junior → FAANG: Prerequisite Gaps and Worked Examples

The prerequisite idea is that Elasticsearch is a distributed system without global ordering. For paginated search, the coordinating node fetches top `from + size` from every shard, merges, discards the first `from`, and returns `size`. At `from: 100000` on a 10-shard index, that is 1 million hits merged per request. That is why deep `from` pagination is banned. Cursor-based pagination with `search_after` avoids this because each request starts exactly where the last left off, using the sort value as a cursor. No merging window grows with page depth.

Worked example for a first-job ticket: "we need to export all 5 million orders for a compliance audit." The wrong answer is a loop from page 1 with `from` and `size`, which hits `max_result_window` at 10000 and then quietly returns wrong data if someone raised the setting. The correct answer is PIT plus `search_after`. Open PIT once, sort by a stable tiebreaker (`created_at` plus `_id`), iterate pulling 1000 at a time, close PIT at the end. This is the pattern every senior expects you to write from memory. Second detail: set `track_total_hits: false` so ES does not count the total result set on every request, which saves significant CPU for large exports.

Second worked example: "scroll is leaking memory." Scroll pins a search context on every shard for the configured `keep_alive`, and each context holds file handles and heap. If your code opens scrolls and never calls `_search/scroll/_all` to close them, the cluster leaks until it hits `search.max_open_scroll_context` (default 500) and starts rejecting. The fix is to always defer the close call, or to migrate to PIT which is cheaper to open and close. PIT is stored as a compact search context that does not pin per-shard readers as aggressively. In 9.0, new code should use PIT for everything and scroll only appears in legacy pipelines.

Interview entry-point: know that `search_after` requires a deterministic sort. Sorting by `score` alone is non-deterministic under index changes. Always append `_id` or another unique field as tiebreaker. Know that PIT is immutable: documents indexed after `OpenPointInTime` are invisible through it, so PIT gives you snapshot semantics for consistent exports. Know that PIT holds resources proportional to the number of segments at open time, so force-merging right after opening a long-lived PIT is wasted work because the PIT still references old segments.

### Senior @ FAANG: Staff and Principal Material

Scroll is deprecated for new use since 7.10 and actively discouraged in 9.0. The reason is architectural. Scroll pins a per-shard `ContextIndexSearcher` holding a snapshot of the shard state at scroll open, and re-entering the same scroll ID routes back to the same coordinating node and shards. Scroll cannot run in parallel across multiple clients on the same cursor, cannot survive a coordinating node restart, and cannot be sliced across workers efficiently. Sliced scroll exists but is a two-level hack that double-counts docs under concurrent indexing. PIT plus `search_after` addresses each of these by making the cursor a pure value (the sort tuple) that any client can resume, and by making the snapshot a named reader reference that any shard replica can serve. At staff level, do not just ban scroll in new code, run a deprecation audit against the slow_log and application code, track down every scroll caller, and migrate them. Leaving scroll in the fleet caps cluster restart flexibility because you cannot drain a node cleanly with active long scrolls.

PIT keep_alive tuning is the single most important performance lever. A PIT prevents segment merging from reclaiming any segment referenced at open time, which means a long-lived PIT on a write-heavy index can balloon the segment count and stall merges, which in turn degrades indexing throughput and query latency. Rule: keep_alive should match expected iteration time plus a safety margin, not "a long time to be safe." For a 5-million-doc export at 1000 per batch with 50ms per batch, you need 250 seconds. Set `keep_alive: 5m` and renew on every request by returning the rotated PIT ID. If your export can complete in 5 minutes, never extend. Monitor `pit_info` via the `_pit/stats` endpoint (9.0) and alert on any PIT older than 1 hour unless explicitly whitelisted. A rogue PIT left open by a crashed worker is a common root cause of "segment count keeps climbing" incidents.

Parallel export with slicing is the staff-level pattern for exporting 100M plus documents in bounded time. Open one PIT, then run N workers, each with a `slice` parameter on the search body: `{"slice": {"id": i, "max": N}}`. Each worker iterates its slice with its own `search_after`. Slicing partitions by `_id` hash, so work distributes roughly evenly, and since all slices share the PIT they see the same consistent snapshot. This is dramatically better than sliced scroll because the PIT is cheap and each slice is an independent cursor. Tune `max` to roughly 1x to 2x the number of shards. More slices than shards produces diminishing returns because multiple slices contend for the same shard.

Reindex API under the hood uses a scroll, which is ironic given the deprecation stance. In 9.0, `POST _reindex?slices=auto` parallelizes across shards and is the correct invocation for large reindexes. Throttle with `requests_per_second` to avoid starving live traffic. For true massive reindexes (billions of docs), prefer an external indexer that opens a PIT on the source and bulks into the destination with your own code. The advantages are: you control checkpointing (save `search_after` cursor to durable storage every batch), you control error handling (dead-letter queue for rejected documents instead of failing the whole task), you control transformation (Painless scripts are sandboxed but slow, Go code is faster and debuggable), and you can read from the source and write to the destination across clusters or across versions without the source cluster seeing the destination. Reindex within a single cluster via the API is fine for small migrations, not for the annual rebuild.

Consistency model at staff level: PIT gives you read-your-writes only for documents indexed before PIT open. This is usually fine for export but a trap for incremental sync. If you do "open PIT, export docs newer than last watermark, close PIT," any documents indexed during the export but timestamped before the watermark update will be missed on the next pass because the next PIT is opened with a fresh snapshot that has moved past them. Fix: use a sliding watermark that lags real time by at least `refresh_interval` plus network slack, typically 5 to 10 seconds, and rely on at-least-once delivery with idempotent writes downstream. Or use change data capture via the `_seq_no` and `_primary_term` on each doc, which is what the ES CDC connectors do internally.

Cancellation and circuit breakers. Long searches under PIT still consume heap for coalescing buffers, and a slice can accidentally fetch millions of huge documents if your size is wrong. Set `search.max_buckets` at the cluster level, set per-index `search.max_result_window` to bound `size`, and wrap the Go client with a context deadline that cancels stuck requests. The go-elasticsearch v9 client respects context cancellation and sends the `X-Opaque-Id` header automatically if you set it, which makes it possible to `_tasks _cancel?actions=*search*&x_opaque_id=<id>` from ops tooling. Budget this: every long-running export should have an ops-level kill switch that does not require redeploying application code.

Finally, cross-cluster search (CCS) and PIT. CCS supports PIT in 9.0 via the `indices.all_pit_searcheable: true` setting on the remote. Cross-cluster PIT lets you run global exports across 10 regional clusters as one consistent cursor, which is the right pattern for a multi-region log archive. The gotcha is that `keep_alive` applies per remote, and if any remote's PIT expires mid-iteration the whole search fails. Use a larger `keep_alive` budget for CCS (10 to 15 minutes) and refresh eagerly on every batch response.

---
