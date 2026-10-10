## 33.10 Complete Production Application: Search & Analytics Platform

This section brings together the advanced PostgreSQL features from the chapter into a single application: a search and analytics platform that uses full-text search, window functions, CTEs, LISTEN/NOTIFY, and advisory locks.

### Project Structure

The directory layout below reflects a clean separation of concerns: commands and entry points live under `cmd/`, reusable packages under `internal/`, and public APIs under `pkg/`. This structure scales from a small tool to a production codebase by keeping each package focused on a single responsibility.

```
searchplatform/
├── cmd/
│   └── server/
│       └── main.go
├── internal/
│   ├── database/
│   │   └── postgres.go
│   ├── search/
│   │   ├── search.go
│   │   └── indexer.go
│   ├── analytics/
│   │   └── analytics.go
│   ├── events/
│   │   └── listener.go
│   └── lock/
│       └── advisory.go
├── migrations/
│   └── 001_initial.sql
├── Dockerfile
├── docker-compose.yml
└── Makefile
```

### Database Schema (migrations/001_initial.sql)

Schema migrations track the history of database changes as ordered, versioned scripts. A migration tool applies pending scripts in sequence and records their completion in a `schema_migrations` table, ensuring that each change is applied exactly once across all environments.

```sql
-- Articles with full-text search
CREATE TABLE articles (
    id BIGSERIAL PRIMARY KEY,
    title VARCHAR(500) NOT NULL,
    body TEXT NOT NULL,
    author_id BIGINT NOT NULL,
    metadata JSONB DEFAULT '{}',
    tags TEXT[] DEFAULT '{}',
    status VARCHAR(50) DEFAULT 'draft',
    search_vector tsvector,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    published_at TIMESTAMPTZ
);

-- Full-text search index
CREATE INDEX idx_articles_search ON articles USING GIN(search_vector);
CREATE INDEX idx_articles_metadata ON articles USING GIN(metadata);
CREATE INDEX idx_articles_tags ON articles USING GIN(tags);
CREATE INDEX idx_articles_status ON articles(status) WHERE status = 'published';

-- Update search vector trigger
CREATE OR REPLACE FUNCTION update_article_search_vector()
RETURNS TRIGGER AS $$
BEGIN
    NEW.search_vector :=
        setweight(to_tsvector('english', COALESCE(NEW.title, '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(NEW.body, '')), 'B') ||
        setweight(to_tsvector('english', COALESCE(array_to_string(NEW.tags, ' '), '')), 'C');
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER article_search_update
    BEFORE INSERT OR UPDATE ON articles
    FOR EACH ROW EXECUTE FUNCTION update_article_search_vector();

-- Analytics events
CREATE TABLE page_views (
    id BIGSERIAL PRIMARY KEY,
    article_id BIGINT REFERENCES articles(id),
    user_id BIGINT,
    session_id VARCHAR(100),
    referrer VARCHAR(500),
    user_agent VARCHAR(500),
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_page_views_article ON page_views(article_id);
CREATE INDEX idx_page_views_created ON page_views(created_at DESC);

-- Notifications trigger
CREATE OR REPLACE FUNCTION notify_article_change()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM pg_notify('article_changes', json_build_object(
        'operation', TG_OP,
        'id', COALESCE(NEW.id, OLD.id),
        'title', COALESCE(NEW.title, OLD.title)
    )::text);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER article_notify
    AFTER INSERT OR UPDATE OR DELETE ON articles
    FOR EACH ROW EXECUTE FUNCTION notify_article_change();

-- Categories with hierarchy
CREATE TABLE categories (
    id BIGSERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(255) UNIQUE NOT NULL,
    parent_id BIGINT REFERENCES categories(id),
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_categories_parent ON categories(parent_id);
```

### Search Service (internal/search/search.go)

The service layer encapsulates business logic independently of the transport and persistence layers. Accepting interfaces for its dependencies rather than concrete types allows the service to be unit-tested in isolation without a running database or HTTP server.

```go
package search

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// SearchResult represents a search result
type SearchResult struct {
	ID          int64     `json:"id"`
	Title       string    `json:"title"`
	Body        string    `json:"body"`
	Tags        []string  `json:"tags"`
	Rank        float64   `json:"rank"`
	Headline    string    `json:"headline"`
	PublishedAt time.Time `json:"published_at"`
}

// SearchOptions configures search behavior
type SearchOptions struct {
	Query       string
	Tags        []string
	AuthorID    *int64
	Status      string
	Limit       int
	Offset      int
	MinRank     float64
	Language    string
	Highlight   bool
}

// SearchService handles full-text search operations
type SearchService struct {
	pool *pgxpool.Pool
}

// NewSearchService creates a new search service
func NewSearchService(pool *pgxpool.Pool) *SearchService {
	return &SearchService{pool: pool}
}

// Search performs a full-text search with ranking
func (s *SearchService) Search(ctx context.Context, opts SearchOptions) ([]SearchResult, int, error) {
	if opts.Language == "" {
		opts.Language = "english"
	}
	if opts.Limit <= 0 || opts.Limit > 100 {
		opts.Limit = 20
	}

	// Build the search query
	var conditions []string
	var args []any
	argNum := 1

	conditions = append(conditions, "status = 'published'")

	// Full-text search condition
	if opts.Query != "" {
		// Convert query to tsquery with prefix matching
		tsQuery := buildTSQuery(opts.Query)
		conditions = append(conditions, fmt.Sprintf(
			"search_vector @@ to_tsquery($%d, $%d)", argNum, argNum+1))
		args = append(args, opts.Language, tsQuery)
		argNum += 2
	}

	// Tag filter
	if len(opts.Tags) > 0 {
		conditions = append(conditions, fmt.Sprintf("tags && $%d", argNum))
		args = append(args, opts.Tags)
		argNum++
	}

	// Author filter
	if opts.AuthorID != nil {
		conditions = append(conditions, fmt.Sprintf("author_id = $%d", argNum))
		args = append(args, *opts.AuthorID)
		argNum++
	}

	whereClause := strings.Join(conditions, " AND ")

	// Build rank expression
	rankExpr := "1.0"
	if opts.Query != "" {
		rankExpr = fmt.Sprintf(
			"ts_rank_cd(search_vector, to_tsquery($1, $2), 32)",
		)
	}

	// Build headline expression
	headlineExpr := "body"
	if opts.Highlight && opts.Query != "" {
		headlineExpr = fmt.Sprintf(`
			ts_headline($1, body, to_tsquery($1, $2),
				'StartSel=<mark>, StopSel=</mark>, MaxWords=50, MinWords=20')
		`)
	}

	// Count query
	countQuery := fmt.Sprintf(`
		SELECT COUNT(*) FROM articles WHERE %s
	`, whereClause)

	var total int
	countArgs := args
	if opts.Query != "" {
		countArgs = args[:2] // Only language and tsquery for count
	}
	err := s.pool.QueryRow(ctx, countQuery, countArgs...).Scan(&total)
	if err != nil {
		return nil, 0, fmt.Errorf("counting results: %w", err)
	}

	// Search query
	searchQuery := fmt.Sprintf(`
		SELECT
			id,
			title,
			%s as headline,
			tags,
			%s as rank,
			published_at
		FROM articles
		WHERE %s
		ORDER BY rank DESC, published_at DESC
		LIMIT $%d OFFSET $%d
	`, headlineExpr, rankExpr, whereClause, argNum, argNum+1)

	args = append(args, opts.Limit, opts.Offset)

	rows, err := s.pool.Query(ctx, searchQuery, args...)
	if err != nil {
		return nil, 0, fmt.Errorf("executing search: %w", err)
	}
	defer rows.Close()

	var results []SearchResult
	for rows.Next() {
		var r SearchResult
		if err := rows.Scan(
			&r.ID, &r.Title, &r.Headline, &r.Tags, &r.Rank, &r.PublishedAt,
		); err != nil {
			return nil, 0, fmt.Errorf("scanning result: %w", err)
		}
		results = append(results, r)
	}

	return results, total, rows.Err()
}

// Suggest returns search suggestions based on partial input
func (s *SearchService) Suggest(ctx context.Context, prefix string, limit int) ([]string, error) {
	if limit <= 0 || limit > 10 {
		limit = 5
	}

	// Use trigram similarity for suggestions
	query := `
		SELECT DISTINCT title
		FROM articles
		WHERE status = 'published'
		AND title ILIKE $1 || '%'
		ORDER BY similarity(title, $1) DESC
		LIMIT $2
	`

	rows, err := s.pool.Query(ctx, query, prefix, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var suggestions []string
	for rows.Next() {
		var title string
		if err := rows.Scan(&title); err != nil {
			return nil, err
		}
		suggestions = append(suggestions, title)
	}

	return suggestions, rows.Err()
}

// buildTSQuery converts a user query to PostgreSQL tsquery format
func buildTSQuery(query string) string {
	terms := strings.Fields(query)
	if len(terms) == 0 {
		return ""
	}

	// Add prefix matching for each term
	for i, term := range terms {
		// Escape special characters
		term = strings.ReplaceAll(term, "'", "''")
		terms[i] = term + ":*"
	}

	return strings.Join(terms, " & ")
}
```

### Analytics Service (internal/analytics/analytics.go)

The analytics service uses window functions and CTEs to compute article performance metrics entirely in the database. The `GetArticleMetrics` method chains three CTEs: daily aggregation, totals per article, and ranking. The `GetTimeSeries` method uses `generate_series` to fill in dates with zero views, then applies running totals and a 7-day moving average as window functions.

```go
package analytics

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// ArticleMetrics represents article performance metrics
type ArticleMetrics struct {
	ArticleID       int64     `json:"article_id"`
	Title           string    `json:"title"`
	TotalViews      int64     `json:"total_views"`
	UniqueVisitors  int64     `json:"unique_visitors"`
	AvgTimeOnPage   float64   `json:"avg_time_on_page"`
	ViewsToday      int64     `json:"views_today"`
	ViewsThisWeek   int64     `json:"views_this_week"`
	DayOverDay      float64   `json:"day_over_day_change"`
	Rank            int       `json:"rank"`
	PercentileRank  float64   `json:"percentile_rank"`
}

// TimeSeriesData represents time-based metrics
type TimeSeriesData struct {
	Date        time.Time `json:"date"`
	Views       int64     `json:"views"`
	Visitors    int64     `json:"visitors"`
	RunningTotal int64    `json:"running_total"`
	MovingAvg   float64   `json:"moving_avg_7d"`
}

// AnalyticsService provides analytics queries
type AnalyticsService struct {
	pool *pgxpool.Pool
}

// NewAnalyticsService creates a new analytics service
func NewAnalyticsService(pool *pgxpool.Pool) *AnalyticsService {
	return &AnalyticsService{pool: pool}
}

// GetArticleMetrics returns comprehensive article metrics using window functions
func (s *AnalyticsService) GetArticleMetrics(ctx context.Context, limit int) ([]ArticleMetrics, error) {
	query := `
		WITH daily_stats AS (
			SELECT
				article_id,
				DATE(created_at) as view_date,
				COUNT(*) as views,
				COUNT(DISTINCT session_id) as visitors
			FROM page_views
			WHERE created_at >= NOW() - INTERVAL '30 days'
			GROUP BY article_id, DATE(created_at)
		),
		article_totals AS (
			SELECT
				article_id,
				SUM(views) as total_views,
				SUM(visitors) as total_visitors,
				SUM(CASE WHEN view_date = CURRENT_DATE THEN views ELSE 0 END) as views_today,
				SUM(CASE WHEN view_date >= CURRENT_DATE - INTERVAL '7 days' THEN views ELSE 0 END) as views_week,
				SUM(CASE WHEN view_date = CURRENT_DATE - INTERVAL '1 day' THEN views ELSE 0 END) as views_yesterday
			FROM daily_stats
			GROUP BY article_id
		),
		ranked AS (
			SELECT
				at.article_id,
				at.total_views,
				at.total_visitors,
				at.views_today,
				at.views_week,
				CASE
					WHEN at.views_yesterday > 0
					THEN (at.views_today::float - at.views_yesterday) / at.views_yesterday * 100
					ELSE 0
				END as day_over_day,
				RANK() OVER (ORDER BY at.total_views DESC) as rank,
				PERCENT_RANK() OVER (ORDER BY at.total_views) as percentile_rank
			FROM article_totals at
		)
		SELECT
			r.article_id,
			a.title,
			r.total_views,
			r.total_visitors,
			0.0 as avg_time_on_page,
			r.views_today,
			r.views_week,
			r.day_over_day,
			r.rank,
			r.percentile_rank
		FROM ranked r
		JOIN articles a ON r.article_id = a.id
		ORDER BY r.total_views DESC
		LIMIT $1
	`

	rows, err := s.pool.Query(ctx, query, limit)
	if err != nil {
		return nil, fmt.Errorf("querying metrics: %w", err)
	}
	defer rows.Close()

	var metrics []ArticleMetrics
	for rows.Next() {
		var m ArticleMetrics
		if err := rows.Scan(
			&m.ArticleID, &m.Title, &m.TotalViews, &m.UniqueVisitors,
			&m.AvgTimeOnPage, &m.ViewsToday, &m.ViewsThisWeek,
			&m.DayOverDay, &m.Rank, &m.PercentileRank,
		); err != nil {
			return nil, fmt.Errorf("scanning metrics: %w", err)
		}
		metrics = append(metrics, m)
	}

	return metrics, rows.Err()
}

// GetTimeSeries returns time series data with running totals and moving averages
func (s *AnalyticsService) GetTimeSeries(ctx context.Context, articleID int64, days int) ([]TimeSeriesData, error) {
	query := `
		WITH daily_data AS (
			SELECT
				DATE(created_at) as date,
				COUNT(*) as views,
				COUNT(DISTINCT session_id) as visitors
			FROM page_views
			WHERE article_id = $1
			AND created_at >= NOW() - ($2 || ' days')::INTERVAL
			GROUP BY DATE(created_at)
		),
		filled_dates AS (
			SELECT
				generate_series(
					(NOW() - ($2 || ' days')::INTERVAL)::DATE,
					CURRENT_DATE,
					'1 day'
				)::DATE as date
		)
		SELECT
			fd.date,
			COALESCE(dd.views, 0) as views,
			COALESCE(dd.visitors, 0) as visitors,
			SUM(COALESCE(dd.views, 0)) OVER (ORDER BY fd.date) as running_total,
			AVG(COALESCE(dd.views, 0)) OVER (
				ORDER BY fd.date
				ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
			) as moving_avg_7d
		FROM filled_dates fd
		LEFT JOIN daily_data dd ON fd.date = dd.date
		ORDER BY fd.date
	`

	rows, err := s.pool.Query(ctx, query, articleID, days)
	if err != nil {
		return nil, fmt.Errorf("querying time series: %w", err)
	}
	defer rows.Close()

	var data []TimeSeriesData
	for rows.Next() {
		var d TimeSeriesData
		if err := rows.Scan(&d.Date, &d.Views, &d.Visitors, &d.RunningTotal, &d.MovingAvg); err != nil {
			return nil, fmt.Errorf("scanning time series: %w", err)
		}
		data = append(data, d)
	}

	return data, rows.Err()
}

// GetCategoryHierarchy returns category tree using recursive CTE
func (s *AnalyticsService) GetCategoryHierarchy(ctx context.Context) ([]CategoryNode, error) {
	query := `
		WITH RECURSIVE category_tree AS (
			-- Base case: root categories
			SELECT
				id,
				name,
				slug,
				parent_id,
				0 as level,
				ARRAY[id] as path,
				name::text as full_path
			FROM categories
			WHERE parent_id IS NULL

			UNION ALL

			-- Recursive case: children
			SELECT
				c.id,
				c.name,
				c.slug,
				c.parent_id,
				ct.level + 1,
				ct.path || c.id,
				ct.full_path || ' > ' || c.name
			FROM categories c
			JOIN category_tree ct ON c.parent_id = ct.id
			WHERE ct.level < 10  -- Prevent infinite recursion
		)
		SELECT id, name, slug, parent_id, level, path, full_path
		FROM category_tree
		ORDER BY path
	`

	rows, err := s.pool.Query(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("querying categories: %w", err)
	}
	defer rows.Close()

	var categories []CategoryNode
	for rows.Next() {
		var c CategoryNode
		if err := rows.Scan(
			&c.ID, &c.Name, &c.Slug, &c.ParentID,
			&c.Level, &c.Path, &c.FullPath,
		); err != nil {
			return nil, fmt.Errorf("scanning category: %w", err)
		}
		categories = append(categories, c)
	}

	return categories, rows.Err()
}

// CategoryNode represents a node in the category tree
type CategoryNode struct {
	ID       int64   `json:"id"`
	Name     string  `json:"name"`
	Slug     string  `json:"slug"`
	ParentID *int64  `json:"parent_id"`
	Level    int     `json:"level"`
	Path     []int64 `json:"path"`
	FullPath string  `json:"full_path"`
}
```

### Event Listener (internal/events/listener.go)

PostgreSQL's LISTEN/NOTIFY implements a lightweight pub-sub channel: the server sends a notification to all connected clients listening on a channel name when `NOTIFY channel_name, payload` is executed in any transaction that commits. The `pgx` driver surfaces notifications through `conn.WaitForNotification(ctx)`, which blocks until a notification arrives or the context is canceled, enabling event-driven processing without polling the database. Each notification carries a string payload (up to 8KB) and the PID of the sending backend. The Go consumer parses the payload as JSON and dispatches to the appropriate handler, keeping the notification system schema-free.

```go
package events

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// ArticleEvent represents an article change event
type ArticleEvent struct {
	Operation string `json:"operation"`
	ID        int64  `json:"id"`
	Title     string `json:"title"`
}

// EventHandler handles incoming events
type EventHandler func(ctx context.Context, event ArticleEvent) error

// EventListener listens for PostgreSQL notifications
type EventListener struct {
	pool     *pgxpool.Pool
	logger   *slog.Logger
	handlers map[string][]EventHandler
	mu       sync.RWMutex
	done     chan struct{}
}

// NewEventListener creates a new event listener
func NewEventListener(pool *pgxpool.Pool, logger *slog.Logger) *EventListener {
	return &EventListener{
		pool:     pool,
		logger:   logger,
		handlers: make(map[string][]EventHandler),
		done:     make(chan struct{}),
	}
}

// Subscribe registers a handler for a channel
func (l *EventListener) Subscribe(channel string, handler EventHandler) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.handlers[channel] = append(l.handlers[channel], handler)
}

// Start begins listening for notifications
func (l *EventListener) Start(ctx context.Context, channels ...string) error {
	conn, err := l.pool.Acquire(ctx)
	if err != nil {
		return err
	}

	// Subscribe to channels
	for _, channel := range channels {
		_, err := conn.Exec(ctx, "LISTEN "+channel)
		if err != nil {
			conn.Release()
			return err
		}
		l.logger.Info("subscribed to channel", "channel", channel)
	}

	go func() {
		defer conn.Release()

		for {
			select {
			case <-ctx.Done():
				return
			case <-l.done:
				return
			default:
				// Wait for notification with timeout
				waitCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
				notification, err := conn.Conn().WaitForNotification(waitCtx)
				cancel()

				if err != nil {
					if ctx.Err() != nil {
						return
					}
					// Timeout is expected, continue
					continue
				}

				l.handleNotification(ctx, notification.Channel, notification.Payload)
			}
		}
	}()

	return nil
}

// Stop stops the listener
func (l *EventListener) Stop() {
	close(l.done)
}

func (l *EventListener) handleNotification(ctx context.Context, channel, payload string) {
	l.mu.RLock()
	handlers := l.handlers[channel]
	l.mu.RUnlock()

	if len(handlers) == 0 {
		return
	}

	var event ArticleEvent
	if err := json.Unmarshal([]byte(payload), &event); err != nil {
		l.logger.Error("failed to unmarshal event",
			"channel", channel,
			"payload", payload,
			"error", err,
		)
		return
	}

	for _, handler := range handlers {
		if err := handler(ctx, event); err != nil {
			l.logger.Error("handler error",
				"channel", channel,
				"event", event,
				"error", err,
			)
		}
	}
}

// Notify sends a notification to a channel
func (l *EventListener) Notify(ctx context.Context, channel string, payload any) error {
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	_, err = l.pool.Exec(ctx, "SELECT pg_notify($1, $2)", channel, string(data))
	return err
}
```

### Advisory Lock Manager (internal/lock/advisory.go)

The lock manager wraps PostgreSQL advisory locks behind a string-key interface. It hashes the string key to an `int64` using FNV-1a, which PostgreSQL accepts as the lock identifier. The `WithLock` and `WithTryLock` methods follow the acquire-defer-release pattern, ensuring the lock is always released even if the callback panics or returns an error.

```go
package lock

import (
	"context"
	"errors"
	"fmt"
	"hash/fnv"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrLockNotAcquired = errors.New("lock not acquired")
	ErrLockTimeout     = errors.New("lock acquisition timeout")
)

// AdvisoryLock manages PostgreSQL advisory locks
type AdvisoryLock struct {
	pool *pgxpool.Pool
}

// NewAdvisoryLock creates a new advisory lock manager
func NewAdvisoryLock(pool *pgxpool.Pool) *AdvisoryLock {
	return &AdvisoryLock{pool: pool}
}

// TryLock attempts to acquire a lock without waiting
func (l *AdvisoryLock) TryLock(ctx context.Context, key string) (bool, error) {
	lockID := hashKey(key)

	var acquired bool
	err := l.pool.QueryRow(ctx,
		"SELECT pg_try_advisory_lock($1)",
		lockID,
	).Scan(&acquired)

	return acquired, err
}

// Lock acquires a lock, blocking until available
func (l *AdvisoryLock) Lock(ctx context.Context, key string) error {
	lockID := hashKey(key)

	_, err := l.pool.Exec(ctx, "SELECT pg_advisory_lock($1)", lockID)
	return err
}

// LockWithTimeout tries to acquire lock with timeout
func (l *AdvisoryLock) LockWithTimeout(ctx context.Context, key string, timeout time.Duration) error {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	lockID := hashKey(key)

	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return ErrLockTimeout
		case <-ticker.C:
			var acquired bool
			err := l.pool.QueryRow(ctx,
				"SELECT pg_try_advisory_lock($1)",
				lockID,
			).Scan(&acquired)

			if err != nil {
				return err
			}
			if acquired {
				return nil
			}
		}
	}
}

// Unlock releases a lock
func (l *AdvisoryLock) Unlock(ctx context.Context, key string) error {
	lockID := hashKey(key)

	var released bool
	err := l.pool.QueryRow(ctx,
		"SELECT pg_advisory_unlock($1)",
		lockID,
	).Scan(&released)

	if err != nil {
		return err
	}
	if !released {
		return ErrLockNotAcquired
	}
	return nil
}

// WithLock executes a function while holding a lock
func (l *AdvisoryLock) WithLock(ctx context.Context, key string, fn func() error) error {
	if err := l.Lock(ctx, key); err != nil {
		return fmt.Errorf("acquiring lock: %w", err)
	}
	defer l.Unlock(ctx, key)

	return fn()
}

// WithTryLock tries to execute with lock, returns immediately if not available
func (l *AdvisoryLock) WithTryLock(ctx context.Context, key string, fn func() error) error {
	acquired, err := l.TryLock(ctx, key)
	if err != nil {
		return err
	}
	if !acquired {
		return ErrLockNotAcquired
	}
	defer l.Unlock(ctx, key)

	return fn()
}

// TransactionLock acquires a transaction-level lock (auto-released on commit/rollback)
func (l *AdvisoryLock) TransactionLock(ctx context.Context, tx interface{ Exec(context.Context, string, ...any) (any, error) }, key string) error {
	lockID := hashKey(key)
	_, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", lockID)
	return err
}

func hashKey(key string) int64 {
	h := fnv.New64a()
	h.Write([]byte(key))
	return int64(h.Sum64())
}
```

### Main Application (cmd/server/main.go)

The main function wires everything together: it creates a connection pool, initializes each service, starts the event listener in a background goroutine, and registers HTTP handlers. Graceful shutdown is handled via signal notification, giving in-flight requests up to 30 seconds to complete before the server stops.

```go
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"searchplatform/internal/analytics"
	"searchplatform/internal/events"
	"searchplatform/internal/lock"
	"searchplatform/internal/search"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	// Connect to PostgreSQL
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		logger.Error("failed to connect to database", "error", err)
		os.Exit(1)
	}
	defer pool.Close()

	// Initialize services
	searchSvc := search.NewSearchService(pool)
	analyticsSvc := analytics.NewAnalyticsService(pool)
	lockMgr := lock.NewAdvisoryLock(pool)
	eventListener := events.NewEventListener(pool, logger)

	// Subscribe to article changes
	eventListener.Subscribe("article_changes", func(ctx context.Context, event events.ArticleEvent) error {
		logger.Info("article changed",
			"operation", event.Operation,
			"id", event.ID,
			"title", event.Title,
		)
		// Could invalidate cache, update search index, etc.
		return nil
	})

	// Start event listener
	if err := eventListener.Start(ctx, "article_changes"); err != nil {
		logger.Error("failed to start event listener", "error", err)
		os.Exit(1)
	}
	defer eventListener.Stop()

	// Setup HTTP handlers
	mux := http.NewServeMux()

	mux.HandleFunc("GET /search", searchHandler(searchSvc))
	mux.HandleFunc("GET /analytics/articles", analyticsHandler(analyticsSvc))
	mux.HandleFunc("GET /analytics/timeseries/{id}", timeSeriesHandler(analyticsSvc))
	mux.HandleFunc("GET /categories", categoriesHandler(analyticsSvc))
	mux.HandleFunc("POST /process/{key}", processHandler(lockMgr, logger))

	server := &http.Server{
		Addr:    ":8080",
		Handler: mux,
	}

	// Graceful shutdown
	go func() {
		sigChan := make(chan os.Signal, 1)
		signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
		<-sigChan

		shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		server.Shutdown(shutdownCtx)
	}()

	logger.Info("starting server", "addr", server.Addr)
	if err := server.ListenAndServe(); err != http.ErrServerClosed {
		logger.Error("server error", "error", err)
	}
}

func searchHandler(svc *search.SearchService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		opts := search.SearchOptions{
			Query:     r.URL.Query().Get("q"),
			Limit:     20,
			Highlight: true,
		}

		results, total, err := svc.Search(r.Context(), opts)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"results": results,
			"total":   total,
		})
	}
}

func analyticsHandler(svc *analytics.AnalyticsService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		metrics, err := svc.GetArticleMetrics(r.Context(), 50)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(metrics)
	}
}

func timeSeriesHandler(svc *analytics.AnalyticsService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Parse article ID from path
		var articleID int64
		fmt.Sscanf(r.PathValue("id"), "%d", &articleID)

		data, err := svc.GetTimeSeries(r.Context(), articleID, 30)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(data)
	}
}

func categoriesHandler(svc *analytics.AnalyticsService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		categories, err := svc.GetCategoryHierarchy(r.Context())
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(categories)
	}
}

func processHandler(lockMgr *lock.AdvisoryLock, logger *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		key := r.PathValue("key")

		err := lockMgr.WithTryLock(r.Context(), "process:"+key, func() error {
			logger.Info("processing", "key", key)
			time.Sleep(2 * time.Second) // Simulate work
			return nil
		})

		if err == lock.ErrLockNotAcquired {
			http.Error(w, "already processing", http.StatusConflict)
			return
		}
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		w.WriteHeader(http.StatusOK)
		w.Write([]byte("processed"))
	}
}
```

### Junior → FAANG: reading this application like a first-day engineer

If you are new to backend work, this codebase looks intimidating because it touches every piece of the chapter at once. The way to learn from it is to walk the request path for a single feature and stop at each layer.

Start with `GET /search?q=postgres`. The HTTP router in `main.go` dispatches to `searchHandler`, which constructs a `SearchOptions` struct and calls `searchSvc.Search`. The service layer builds a SQL query with parameterized placeholders (never string-concatenate user input), runs it against the pool, and returns typed results. The HTTP layer does not know about SQL. The service layer does not know about HTTP. This separation is the single most important architectural idea in the whole file, and it is what lets you unit test `SearchService` with a fake pool and integration test `searchHandler` with a stubbed service.

Worked mental exercise. Add a new endpoint `GET /trending` that returns the top 10 articles by views in the last hour. You would add a method on `AnalyticsService` with the query, add an HTTP handler in `main.go`, register the route, and write a test for the service method. You should not touch `search.go` or `lock.go`. If your change touches more than one package, you have probably violated the layering.

First-job interview entry-point. Be ready to answer where SQL queries are allowed in this codebase (inside service packages under `internal/`, never in handlers), where business logic lives (service methods), where transport concerns live (`main.go` handlers), why the event listener runs in a goroutine (because `WaitForNotification` blocks), and why advisory lock is used for `/process/{key}` (to prevent two HTTP requests from processing the same key concurrently, returning 409 instead).

### Senior @ FAANG: ADRs, scaling cliffs, and production hardening

This section is the honest staff review of the sample application. Pretty architecture diagrams hide the failure modes. The job is to name them.

ADR-1: the analytics workload does not belong on the OLTP primary. `GetArticleMetrics` scans 30 days of `page_views`, performs three CTE stages with aggregations, and runs two window functions. On a table that grows by millions of rows per day this query becomes a cache-polluter that evicts hot OLTP pages from shared buffers and drives random read latency on user-facing queries. The production decision is to route analytics reads to a dedicated replica with `hot_standby_feedback = on` and a higher `work_mem`, or to a separate analytics store entirely. Code change is small, accept a second `*pgxpool.Pool` in `AnalyticsService` and route reads to it. Operational change is large, replication monitoring, replica lag alerting, runbook for replica outage.

ADR-2: when Postgres alone stops fitting, the 2026 menu. Options in order of cost. One, scale vertically on RDS or self-managed PG 17/18 with aggressive partitioning on `page_views(created_at)` and dropping partitions older than retention. This buys you one or two years for most workloads. Two, add `pg_duckdb` (a 2024 extension that reached 1.0 in 2026) that embeds DuckDB inside Postgres and runs analytical queries against the same tables with columnar vectorized execution. For the `page_views` aggregation this typically wins by 10x to 100x with no data movement. Three, Citus for horizontal scale-out sharded analytics when a single node's storage or compute is the bottleneck, with `page_views` distributed on `article_id` or hash of session. Four, a ClickHouse or DuckDB sidecar fed by a CDC pipeline (Debezium to Kafka to ClickHouse, or logical replication to DuckDB files on S3). Five, a managed warehouse (BigQuery, Snowflake, Redshift). Each step up the list adds operational surface and latency. Do not skip steps for fashion.

ADR-3: the LISTEN/NOTIFY pattern here is a cache-invalidation hint, not a durable event bus. The listener subscribes to `article_changes` and logs. If you wire this to invalidate a CDN cache or update a search index, you must add an outbox table with the same transaction that writes the article, a reconciliation worker that scans the outbox for undelivered rows, and a reconnect loop in `EventListener.Start` that re-issues `LISTEN` after every transport error. The current code logs on notification receipt and does not survive a replica failover or a pgBouncer restart. In review, this is a release blocker for any use case where a missed notification causes stale data.

ADR-4: advisory locks on the HTTP critical path without a timeout. `processHandler` uses `WithTryLock` which returns immediately, so contention produces 409 rather than latency. That is correct for this use case. But the same `AdvisoryLock` type exposes `LockWithTimeout` which polls every 100 ms. Polling for locks is an anti-pattern on shared connections because each poll takes a connection from the pool. Under sustained contention you can starve the pool. The fix is to use Postgres native `SET LOCAL lock_timeout = '5s'` followed by `SELECT pg_advisory_lock($1)` inside a transaction, or to prefer `pg_advisory_xact_lock` on a transaction the caller already has.

ADR-5: connection pool topology. One `*pgxpool.Pool` is shared between request handlers, analytics, and the LISTEN goroutine. The LISTEN goroutine holds a connection indefinitely. Under load spikes this means the pool capacity is effectively `max - 1`, which is fine at 50 but painful at 5. Production setups use a dedicated small pool for LISTEN (or a direct connection bypassing the pooler) and size the main pool based on actual concurrency, typically `cpu_cores * 2` on the database side divided across app instances.

ADR-6: partitioning `page_views`. At production scale this table must be range-partitioned on `created_at` by day or week. PG 17/18 supports partition pruning on window-function queries and supports attaching and detaching partitions without rewriting. The indexes must be local to partitions. Retention becomes a `DETACH` and `DROP`, which is O(partition) not O(row). The query in `GetArticleMetrics` as written will not benefit fully from partition pruning until the planner sees `WHERE created_at >= $1 AND created_at < $2` as explicit literals or well-estimated parameters. Use `set_config('plan_cache_mode', 'force_custom_plan', false)` for parameterized analytics queries that are sensitive to pruning.

ADR-7: observability gaps in the sample. No `pg_stat_statements` parsing, no per-service query metrics, no tracing of the LISTEN reconnect loop, no alert on `pg_notification_queue_usage()`, no alert on replica lag, no dashboard of top-N advisory locks by hold duration, no slow-query log routed to a sink with correlation IDs. The production version of this app has roughly as much observability code as business code. Plan for it.

ADR-8: multi-tenancy and the `article_changes` channel. Today every listener sees every article change. For a multi-tenant deployment, this leaks existence and names across tenant boundaries. Move to per-tenant channels (`article_changes_t_<tenant_id>`) and authorize listener subscriptions through the application layer. Or drop NOTIFY entirely and use per-tenant outbox consumers with explicit authorization.

ADR-9: search quality. `tsvector` with `ts_rank_cd` is a respectable baseline and wins on operational simplicity (no extra service, transactional updates). It loses on relevance tuning, vector similarity for semantic search, and typo tolerance. The 2026 production answer depends on scale. Under a few million documents keep it in Postgres and add `pg_trgm` for typo tolerance and `pgvector` for embeddings. Beyond that, a dedicated service (OpenSearch, Elastic, Vespa, or a managed vector DB) with an outbox-driven indexer. Do not rewrite the search stack on vibes, benchmark both and write the ADR.

Review gate for shipping. Each ADR above must have an explicit yes-we-did-this or no-with-tracked-tech-debt-and-a-trigger-condition before the first real tenant onboards. Architecture that is undocumented is architecture that will be re-litigated every quarter by whoever is on call when it breaks.

---
