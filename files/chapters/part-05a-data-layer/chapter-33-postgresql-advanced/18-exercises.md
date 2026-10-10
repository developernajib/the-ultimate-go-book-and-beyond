## Exercises

### Exercise 1: Build a Full-Text Search Engine

Build a complete search service with:
- Search with ranking and highlighting
- Autocomplete suggestions
- Faceted search (by category, date range)
- Search analytics

**Solution**:

```go
package search

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type SearchEngine struct {
	pool *pgxpool.Pool
}

type SearchResult struct {
	ID        int64     `json:"id"`
	Title     string    `json:"title"`
	Snippet   string    `json:"snippet"`
	Category  string    `json:"category"`
	Score     float64   `json:"score"`
	CreatedAt time.Time `json:"created_at"`
}

type Facet struct {
	Value string `json:"value"`
	Count int    `json:"count"`
}

type SearchResponse struct {
	Results    []SearchResult `json:"results"`
	Total      int            `json:"total"`
	Categories []Facet        `json:"categories"`
	DateRanges []Facet        `json:"date_ranges"`
}

type SearchOptions struct {
	Category  string
	StartDate *time.Time
	EndDate   *time.Time
	Limit     int
	Offset    int
}

func (e *SearchEngine) Search(ctx context.Context, query string, opts SearchOptions) (*SearchResponse, error) {
	tsQuery := buildSearchQuery(query)

	// Main search query with facets
	mainQuery := `
		WITH search_results AS (
			SELECT
				id, title, body, category, created_at,
				ts_rank_cd(search_vector, to_tsquery('english', $1), 32) as score
			FROM articles
			WHERE search_vector @@ to_tsquery('english', $1)
			AND ($2 = '' OR category = $2)
			AND ($3::timestamptz IS NULL OR created_at >= $3)
			AND ($4::timestamptz IS NULL OR created_at < $4)
		),
		category_facets AS (
			SELECT category as value, COUNT(*) as count
			FROM search_results
			GROUP BY category
			ORDER BY count DESC
		),
		date_facets AS (
			SELECT
				CASE
					WHEN created_at >= NOW() - INTERVAL '1 day' THEN 'Today'
					WHEN created_at >= NOW() - INTERVAL '7 days' THEN 'This Week'
					WHEN created_at >= NOW() - INTERVAL '30 days' THEN 'This Month'
					ELSE 'Older'
				END as value,
				COUNT(*) as count
			FROM search_results
			GROUP BY 1
			ORDER BY MIN(created_at) DESC
		)
		SELECT
			(SELECT COUNT(*) FROM search_results) as total,
			(SELECT json_agg(row_to_json(category_facets)) FROM category_facets) as categories,
			(SELECT json_agg(row_to_json(date_facets)) FROM date_facets) as date_ranges,
			sr.id, sr.title,
			ts_headline('english', sr.body, to_tsquery('english', $1),
				'StartSel=<em>, StopSel=</em>, MaxWords=30') as snippet,
			sr.category, sr.score, sr.created_at
		FROM search_results sr
		ORDER BY sr.score DESC
		LIMIT $5 OFFSET $6
	`

	rows, err := e.pool.Query(ctx, mainQuery,
		tsQuery,
		opts.Category,
		opts.StartDate,
		opts.EndDate,
		opts.Limit,
		opts.Offset,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	response := &SearchResponse{}
	var categoriesJSON, dateRangesJSON []byte

	for rows.Next() {
		var r SearchResult
		err := rows.Scan(
			&response.Total, &categoriesJSON, &dateRangesJSON,
			&r.ID, &r.Title, &r.Snippet, &r.Category, &r.Score, &r.CreatedAt,
		)
		if err != nil {
			return nil, err
		}
		response.Results = append(response.Results, r)
	}

	// Parse facets from JSON
	json.Unmarshal(categoriesJSON, &response.Categories)
	json.Unmarshal(dateRangesJSON, &response.DateRanges)

	return response, nil
}

func (e *SearchEngine) Autocomplete(ctx context.Context, prefix string) ([]string, error) {
	// Use trigram similarity for fuzzy matching
	query := `
		SELECT DISTINCT title
		FROM articles
		WHERE title ILIKE $1 || '%'
		OR similarity(title, $1) > 0.3
		ORDER BY similarity(title, $1) DESC
		LIMIT 10
	`

	rows, err := e.pool.Query(ctx, query, prefix)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var suggestions []string
	for rows.Next() {
		var title string
		rows.Scan(&title)
		suggestions = append(suggestions, title)
	}

	return suggestions, nil
}

func (e *SearchEngine) LogSearch(ctx context.Context, query string, resultCount int, userID *int64) error {
	_, err := e.pool.Exec(ctx, `
		INSERT INTO search_logs (query, result_count, user_id)
		VALUES ($1, $2, $3)
	`, query, resultCount, userID)
	return err
}

func buildSearchQuery(query string) string {
	terms := strings.Fields(query)
	for i, term := range terms {
		terms[i] = term + ":*" // Prefix matching
	}
	return strings.Join(terms, " & ")
}
```

### Exercise 2: Real-Time Analytics Dashboard

Build a real-time dashboard using LISTEN/NOTIFY and window functions.

**Solution**:

```go
package dashboard

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type ArticleStats struct {
	ArticleID   int64 `json:"article_id"`
	Views       int64 `json:"views"`
	UniqueViews int64 `json:"unique_views"`
	Rank        int   `json:"rank"`
}

type TimePoint struct {
	Minute time.Time `json:"minute"`
	Views  int64     `json:"views"`
}

type Activity struct {
	ID        int64     `json:"id"`
	ArticleID int64     `json:"article_id"`
	Action    string    `json:"action"`
	CreatedAt time.Time `json:"created_at"`
}

type DashboardData struct {
	TotalViews     int64          `json:"total_views"`
	ActiveUsers    int64          `json:"active_users"`
	TopArticles    []ArticleStats `json:"top_articles"`
	ViewsPerMinute []TimePoint    `json:"views_per_minute"`
	RecentActivity []Activity     `json:"recent_activity"`
}

type RealTimeDashboard struct {
	pool      *pgxpool.Pool
	data      *DashboardData
	mu        sync.RWMutex
	listeners []chan *DashboardData
	listenerMu sync.Mutex
}

func NewRealTimeDashboard(pool *pgxpool.Pool) *RealTimeDashboard {
	return &RealTimeDashboard{
		pool: pool,
		data: &DashboardData{},
	}
}

func (d *RealTimeDashboard) Start(ctx context.Context) error {
	// Initial data load
	if err := d.refresh(ctx); err != nil {
		return err
	}

	// Start listening for notifications
	conn, err := d.pool.Acquire(ctx)
	if err != nil {
		return err
	}

	_, err = conn.Exec(ctx, "LISTEN page_view_events")
	if err != nil {
		conn.Release()
		return err
	}

	// Notification handler
	go func() {
		defer conn.Release()
		for {
			notification, err := conn.Conn().WaitForNotification(ctx)
			if err != nil {
				return
			}
			d.handleNotification(ctx, notification.Payload)
		}
	}()

	// Periodic refresh
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				d.refresh(ctx)
			}
		}
	}()

	return nil
}

func (d *RealTimeDashboard) refresh(ctx context.Context) error {
	query := `
		WITH recent_views AS (
			SELECT * FROM page_views WHERE created_at > NOW() - INTERVAL '1 hour'
		),
		top_articles AS (
			SELECT
				article_id,
				COUNT(*) as views,
				COUNT(DISTINCT session_id) as unique_views,
				ROW_NUMBER() OVER (ORDER BY COUNT(*) DESC) as rank
			FROM recent_views
			GROUP BY article_id
			LIMIT 10
		),
		views_timeline AS (
			SELECT
				date_trunc('minute', created_at) as minute,
				COUNT(*) as views
			FROM recent_views
			GROUP BY 1
			ORDER BY 1 DESC
			LIMIT 60
		)
		SELECT
			(SELECT COUNT(*) FROM recent_views) as total_views,
			(SELECT COUNT(DISTINCT session_id) FROM recent_views) as active_users,
			(SELECT json_agg(row_to_json(top_articles)) FROM top_articles) as top_articles,
			(SELECT json_agg(row_to_json(views_timeline)) FROM views_timeline) as timeline
	`

	var topArticlesJSON, timelineJSON []byte
	data := &DashboardData{}

	err := d.pool.QueryRow(ctx, query).Scan(
		&data.TotalViews,
		&data.ActiveUsers,
		&topArticlesJSON,
		&timelineJSON,
	)
	if err != nil {
		return err
	}

	json.Unmarshal(topArticlesJSON, &data.TopArticles)
	json.Unmarshal(timelineJSON, &data.ViewsPerMinute)

	d.mu.Lock()
	d.data = data
	d.mu.Unlock()

	d.broadcast(data)
	return nil
}

func (d *RealTimeDashboard) handleNotification(ctx context.Context, payload string) {
	var event struct {
		ArticleID int64 `json:"article_id"`
		SessionID string `json:"session_id"`
	}
	json.Unmarshal([]byte(payload), &event)

	d.mu.Lock()
	d.data.TotalViews++
	d.mu.Unlock()

	d.broadcast(d.GetData())
}

func (d *RealTimeDashboard) GetData() *DashboardData {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return d.data
}

func (d *RealTimeDashboard) Subscribe() chan *DashboardData {
	ch := make(chan *DashboardData, 10)
	d.listenerMu.Lock()
	d.listeners = append(d.listeners, ch)
	d.listenerMu.Unlock()
	return ch
}

func (d *RealTimeDashboard) broadcast(data *DashboardData) {
	d.listenerMu.Lock()
	defer d.listenerMu.Unlock()

	for _, ch := range d.listeners {
		select {
		case ch <- data:
		default:
			// Channel full, skip
		}
	}
}
```

### Junior → FAANG: Extending the Exercises Into Portfolio Work

The two exercises above are starter kits. Junior engineers complete them and move on. FAANG-track engineers extend them until they would pass a staff-level code review. The delta between the starter code and production-grade is the interview signal you are building.

Prerequisite gaps to close before shipping either exercise to production:
1. The search exercise uses `to_tsquery` with prefix-appended terms. If a user searches for `"iPhone 15"`, the naive code breaks on the space. Fix by calling `plainto_tsquery` or `websearch_to_tsquery` on user input and layering prefix matching only on the final term.
2. The dashboard exercise uses `LISTEN page_view_events` with no backpressure. Under burst load, the notification queue can fill. Apply the outbox pattern from the pitfalls section: table-driven event store with NOTIFY as a hint.
3. Neither exercise sanitizes user input beyond parameterized queries. Sanitization for FTS queries means rejecting control characters that `to_tsquery` treats as operators. The input `"rm -rf"` will crash `to_tsquery` with a syntax error. Use `websearch_to_tsquery` or escape operator characters.
4. Neither exercise emits metrics or traces. In production, you need `pg_stat_statements` entries per query pattern, histograms on query latency, and a `correlation_id` threaded through the handler.

Worked example: extending the search exercise to catch its own slow queries.

```go
func (e *SearchEngine) Search(ctx context.Context, query string, opts SearchOptions) (*SearchResponse, error) {
    start := time.Now()
    defer func() {
        elapsed := time.Since(start)
        if elapsed > 200*time.Millisecond {
            // Emit an event carrying the query, elapsed time, and plan
            log.Warn("slow search",
                "query", query,
                "elapsed_ms", elapsed.Milliseconds(),
                "limit", opts.Limit,
            )
        }
        metrics.SearchLatency.Observe(elapsed.Seconds())
    }()
    // ... existing code
}
```

Interview entry-point: "Walk me through what would break in the search engine at 10x traffic." Expected answer:
- The `ts_rank_cd` call runs on every matching row before LIMIT. At 10x matches, that is 10x CPU.
- The `ts_headline` call is even more expensive because it re-scans the document for highlight offsets. At scale, compute snippets only for the top N results, not all matches.
- The faceting CTE re-aggregates on every query. Cache facet results per filter set with a short TTL.
- The autocomplete query uses `similarity(title, $1)` without a trigram GIN index on `title`. At 10x traffic, this degrades to full scan.

Exercise extension challenges graded by level:
- L3 challenge: add an index to make `Autocomplete` use the trigram operator and verify with `EXPLAIN`.
- L4 challenge: add pagination cursors instead of OFFSET to the search results, because OFFSET gets slow beyond page 20.
- L5 challenge: add a secondary index on `(category, search_vector)` as a partial index, and verify the planner picks it when category is specified.
- L6 challenge: write the ADR for whether to keep FTS in Postgres or migrate to ParadeDB, OpenSearch, or a dedicated search service once the article table exceeds 50M rows.

### Senior @ FAANG: Exercises as ADR and Runbook Material

At staff level, the exercises are not code kata. They are case studies for architecture reviews and oncall runbooks. Every design decision in the two exercises is a lever that changes the production profile. Your job is to document the levers, pick defaults, and write the rollback.

ADR template for adopting the search exercise as a platform capability:

```
# ADR-0XXX: In-Postgres Full-Text Search vs Dedicated Search Service

## Context
- Article table projected to 50M rows over 18 months
- Search latency SLO: p99 < 200ms
- Relevance tuning requirements: synonyms, stemming, phrase boosting, popularity
- Team size: 3 engineers, no dedicated search specialist

## Options
1. Postgres FTS with pg_trgm for autocomplete (current exercise)
2. Postgres FTS plus ParadeDB for BM25 ranking
3. Dual-write to OpenSearch via logical replication plus Debezium
4. Dedicated search service (Algolia, Elastic Cloud, Typesense)

## Decision
Start with Option 1. Migrate to Option 2 when:
- Relevance complaints exceed 5% of search sessions, OR
- p99 latency crosses 150ms, OR
- ParadeDB reaches 1.0 on Postgres 18 with stable extension story.
Skip to Option 3 only if analytics-style aggregations become a core requirement.
Option 4 reserved for teams that will not invest in search engineering.

## Consequences
- Keeps search transactionally consistent with articles (no dual-write bugs)
- Limits relevance tuning headroom (no custom analyzers, no learned ranking)
- Rollback to Option 2 is an extension install and a reindex, not a service migration
```

Runbook for the dashboard exercise in production:

```
# Runbook: Real-Time Dashboard Outage

## Symptoms
- Dashboard shows stale data or blanks
- WebSocket clients disconnecting
- LISTEN pg_notification_queue_usage() > 0.8

## Triage
1. Check dashboard service logs for "LISTEN connection lost" or context cancellations.
2. Check pg_stat_activity for the LISTEN session, verify it is still connected.
3. Check pg_notification_queue_usage. If > 0.5, a long-running transaction is
   blocking notification delivery. Identify with:
     SELECT pid, xact_start, query FROM pg_stat_activity
     WHERE xact_start IS NOT NULL ORDER BY xact_start LIMIT 5
4. Check the periodic refresh query in pg_stat_statements. If its mean_exec_time
   crossed 5s, the dashboard is behind on refreshes regardless of NOTIFY.

## Remediation
- Restart the dashboard service to re-establish LISTEN.
- Kill the offending long transaction after owner approval.
- If NOTIFY overflow is recurring, shorten the refresh interval and rely on
  polling instead of NOTIFY. The outbox table is the durable source of truth.

## Prevention
- Enforce statement_timeout at the role level for application connections.
- Monitor pg_notification_queue_usage as an alert metric.
- Migrate from raw NOTIFY to outbox + CDC when event volume exceeds 100/sec.
```

Maturity model applied to the exercises:
- L1: A single team runs the dashboard on a shared Postgres instance, manually debugs outages.
- L2: Dashboards are per-service, observability exists but is ad-hoc.
- L3: A shared dashboard service is provisioned with standard runbooks and alerts. LISTEN/NOTIFY is understood as "best effort."
- L4: Dashboards run on an event bus (Kafka, NATS) with durable replay. Postgres is the source of truth but not the message bus.
- L5: Dashboards are a self-service platform capability. Product teams declare metrics and views, the platform handles ingestion, storage, and delivery. Postgres is one of several backends.

Staff-level code review signals on the search exercise:
- Does the code path through `buildSearchQuery` safely handle adversarial input? Single-character terms after stopword removal, Unicode normalization, injection of `&` or `|` operators.
- Is there a test that verifies `ts_headline` falls back gracefully on a document with no matching terms (it returns the beginning of the document, which may leak unrelated content).
- Is the `search_logs` insert on the hot path? It should be async or batched, never blocking the response.
- Is there a backpressure mechanism if the search index falls behind? The exercise assumes `search_vector` is a generated column, which is fine, but under bulk ingest the INSERT path will slow down.

Staff-level code review signals on the dashboard exercise:
- The `handleNotification` path holds `d.mu.Lock()` while incrementing and then calls `d.GetData()` which re-acquires the read lock. This is correct but fragile. A review would flag the risk of future edits introducing a deadlock.
- The listener goroutine has no restart logic. If `WaitForNotification` returns an error, the goroutine exits and the dashboard silently stops receiving events. Production code needs exponential backoff and reconnect.
- `broadcast` uses a `select` default case to drop on a full channel. This is the right policy but must be instrumented. Drops should increment a metric so operators can size the channel buffer correctly.
- The periodic refresh runs every 30s regardless of activity. Under idle load this wastes Postgres capacity. Under heavy load it may overlap with handler-driven refreshes. Add a token-bucket or coalesce pending refreshes.

Bar-raiser prompt on the exercises: "The search exercise works for 1M articles. Walk me through everything that changes when we get to 1B articles." Expected staff-level answer:
- Sharding strategy. Shard by tenant_id if multi-tenant, or by hash of article_id otherwise. Route queries via a routing layer similar to Figma's colocation-based DBProxy approach.
- Index strategy. GIN indexes on 1B rows are in the hundreds of GB. Partition the table by time or by tenant and maintain per-partition indexes.
- Ranking. ts_rank does not scale to 1B. Either move to ParadeDB for BM25 with better indexing, or move search entirely to OpenSearch with Postgres as the write-side source of truth.
- Cost model. At 1B articles, a dedicated search service may be cheaper than the Postgres storage cost plus index maintenance.
- Migration plan. Dual-write, shadow-read, cutover, with explicit rollback criteria.

The exercise answer is not the important part. The reasoning pattern is. That is what FAANG looks for at L6 and above.

---
