## Chapter 6: Analytics Pipeline

Analytics transform a simple URL shortener into a valuable business tool. Every time someone clicks a shortened link, we capture metadata like their IP address, browser, operating system, and referring website. This data is then enriched with geographic information and stored for later aggregation. In this chapter, we build the full analytics pipeline: a service layer that coordinates event processing, an enrichment module that parses user agents and looks up IP locations, and a repository that stores and queries the resulting data.

### 6.1 Analytics Service

The analytics service acts as the coordinator for all click-tracking operations. When a click event arrives, the service enriches it with parsed metadata and then persists it to the database. It also provides a `GetStats` method that retrieves aggregated statistics for a given short code over a specified number of days. By depending on interfaces rather than concrete implementations, this service can be tested with mock repositories.

```go
// internal/service/analytics.go
package service

import (
	"context"
	"fmt"
	"time"

	"github.com/yourusername/goshort/internal/models"
)

// AnalyticsRepository defines database operations for analytics
type AnalyticsRepository interface {
	RecordClick(ctx context.Context, event *models.ClickEvent) error
	GetStats(ctx context.Context, code string, days int) (*AnalyticsStats, error)
}

// AnalyticsStats represents aggregated statistics
type AnalyticsStats struct {
	ClicksByDay     map[string]int64
	TopCountries    map[string]int64
	TopReferrers    map[string]int64
	DeviceBreakdown map[string]int64
}

// AnalyticsServiceImpl implements analytics operations
type AnalyticsServiceImpl struct {
	repository AnalyticsRepository
	enricher   *EventEnricher
}

// NewAnalyticsService creates a new analytics service
func NewAnalyticsService(repo AnalyticsRepository, enricher *EventEnricher) *AnalyticsServiceImpl {
	return &AnalyticsServiceImpl{
		repository: repo,
		enricher:   enricher,
	}
}

// RecordClick records a click event
func (s *AnalyticsServiceImpl) RecordClick(ctx context.Context, event *models.ClickEvent) error {
	// Enrich event with parsed data
	s.enricher.Enrich(event)

	// Store in database (async operation)
	if err := s.repository.RecordClick(ctx, event); err != nil {
		return fmt.Errorf("recording click: %w", err)
	}

	return nil
}

// GetStats retrieves analytics statistics
func (s *AnalyticsServiceImpl) GetStats(ctx context.Context, code string, days int) (*AnalyticsStats, error) {
	return s.repository.GetStats(ctx, code, days)
}
```

### 6.2 Event Enrichment

Raw click events contain only a user agent string and an IP address, which are not very useful for analytics on their own. The event enricher parses the user agent to determine the visitor's browser, operating system, and device type (desktop, mobile, tablet, or bot). It also performs a GeoIP lookup to determine the visitor's country and city. This enrichment step happens before the event is stored, so that queries against the analytics table can filter and group by these fields directly.

```go
// internal/service/enricher.go
package service

import (
	"net"
	"strings"

	"github.com/mileusna/useragent"
	"github.com/yourusername/goshort/internal/models"
)

// EventEnricher enriches click events with parsed metadata
type EventEnricher struct {
	geoIP GeoIPService
}

// GeoIPService defines geo-location lookup
type GeoIPService interface {
	Lookup(ip string) (country, city string, err error)
}

// NewEventEnricher creates a new event enricher
func NewEventEnricher(geoIP GeoIPService) *EventEnricher {
	return &EventEnricher{
		geoIP: geoIP,
	}
}

// Enrich adds parsed metadata to the event
func (e *EventEnricher) Enrich(event *models.ClickEvent) {
	// Parse user agent
	e.parseUserAgent(event)

	// Lookup geographic location
	e.enrichGeolocation(event)
}

// parseUserAgent extracts device info from user agent
func (e *EventEnricher) parseUserAgent(event *models.ClickEvent) {
	ua := useragent.Parse(event.UserAgent)

	// Determine device type
	if ua.Bot {
		event.DeviceType = "bot"
	} else if ua.Mobile {
		event.DeviceType = "mobile"
	} else if ua.Tablet {
		event.DeviceType = "tablet"
	} else {
		event.DeviceType = "desktop"
	}

	// Extract OS and browser
	event.OS = ua.OS
	event.Browser = ua.Name
}

// enrichGeolocation adds geographic data
func (e *EventEnricher) enrichGeolocation(event *models.ClickEvent) {
	// Skip if invalid IP
	if event.IPAddress == "" || event.IPAddress == "::1" ||
	   strings.HasPrefix(event.IPAddress, "127.") {
		return
	}

	// Lookup location
	country, city, err := e.geoIP.Lookup(event.IPAddress)
	if err == nil {
		event.CountryCode = country
		event.City = city
	}
}

// MockGeoIPService is a simple mock for development
type MockGeoIPService struct{}

func (m *MockGeoIPService) Lookup(ip string) (string, string, error) {
	// In production, use MaxMind GeoIP2 or similar
	parsedIP := net.ParseIP(ip)
	if parsedIP == nil {
		return "", "", nil
	}

	// Mock data for demo
	return "US", "New York", nil
}
```

### 6.3 Analytics Repository

The analytics repository handles all database interactions for click events. It provides a `RecordClick` method that inserts a single enriched event row, and a `GetStats` method that runs several aggregation queries to produce a summary. Each aggregation query uses `GROUP BY` to bucket the data by day, country, referrer, or device type. In a production system with millions of events, you would typically partition this table by month to keep query performance fast.

```go
// internal/repository/postgres/analytics_repository.go
package postgres

import (
	"context"
	"fmt"
	"time"

	"github.com/jmoiron/sqlx"
	"github.com/yourusername/goshort/internal/models"
	"github.com/yourusername/goshort/internal/service"
)

// AnalyticsRepository handles analytics database operations
type AnalyticsRepository struct {
	db *sqlx.DB
}

// NewAnalyticsRepository creates a new analytics repository
func NewAnalyticsRepository(db *sqlx.DB) *AnalyticsRepository {
	return &AnalyticsRepository{db: db}
}

// RecordClick stores a click event
func (r *AnalyticsRepository) RecordClick(ctx context.Context, event *models.ClickEvent) error {
	query := `
		INSERT INTO analytics_events
		(short_code, ip_address, user_agent, referer, country_code, city,
		 device_type, os, browser, timestamp)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
	`

	_, err := r.db.ExecContext(
		ctx,
		query,
		event.ShortCode,
		event.IPAddress,
		event.UserAgent,
		event.Referer,
		event.CountryCode,
		event.City,
		event.DeviceType,
		event.OS,
		event.Browser,
		event.Timestamp,
	)

	if err != nil {
		return fmt.Errorf("inserting analytics event: %w", err)
	}

	return nil
}

// GetStats retrieves aggregated statistics
func (r *AnalyticsRepository) GetStats(ctx context.Context, code string, days int) (*service.AnalyticsStats, error) {
	startDate := time.Now().AddDate(0, 0, -days)

	stats := &service.AnalyticsStats{
		ClicksByDay:     make(map[string]int64),
		TopCountries:    make(map[string]int64),
		TopReferrers:    make(map[string]int64),
		DeviceBreakdown: make(map[string]int64),
	}

	// Clicks by day
	clicksByDay, err := r.getClicksByDay(ctx, code, startDate)
	if err != nil {
		return nil, err
	}
	stats.ClicksByDay = clicksByDay

	// Top countries
	topCountries, err := r.getTopCountries(ctx, code, startDate, 10)
	if err != nil {
		return nil, err
	}
	stats.TopCountries = topCountries

	// Top referrers
	topReferrers, err := r.getTopReferrers(ctx, code, startDate, 10)
	if err != nil {
		return nil, err
	}
	stats.TopReferrers = topReferrers

	// Device breakdown
	deviceBreakdown, err := r.getDeviceBreakdown(ctx, code, startDate)
	if err != nil {
		return nil, err
	}
	stats.DeviceBreakdown = deviceBreakdown

	return stats, nil
}

func (r *AnalyticsRepository) getClicksByDay(ctx context.Context, code string, startDate time.Time) (map[string]int64, error) {
	query := `
		SELECT DATE(timestamp) as day, COUNT(*) as clicks
		FROM analytics_events
		WHERE short_code = $1 AND timestamp >= $2
		GROUP BY DATE(timestamp)
		ORDER BY day DESC
	`

	rows, err := r.db.QueryContext(ctx, query, code, startDate)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := make(map[string]int64)
	for rows.Next() {
		var day time.Time
		var clicks int64
		if err := rows.Scan(&day, &clicks); err != nil {
			return nil, err
		}
		result[day.Format("2006-01-02")] = clicks
	}

	return result, nil
}

func (r *AnalyticsRepository) getTopCountries(ctx context.Context, code string, startDate time.Time, limit int) (map[string]int64, error) {
	query := `
		SELECT country_code, COUNT(*) as clicks
		FROM analytics_events
		WHERE short_code = $1 AND timestamp >= $2 AND country_code IS NOT NULL
		GROUP BY country_code
		ORDER BY clicks DESC
		LIMIT $3
	`

	rows, err := r.db.QueryContext(ctx, query, code, startDate, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := make(map[string]int64)
	for rows.Next() {
		var country string
		var clicks int64
		if err := rows.Scan(&country, &clicks); err != nil {
			return nil, err
		}
		result[country] = clicks
	}

	return result, nil
}

func (r *AnalyticsRepository) getTopReferrers(ctx context.Context, code string, startDate time.Time, limit int) (map[string]int64, error) {
	query := `
		SELECT referer, COUNT(*) as clicks
		FROM analytics_events
		WHERE short_code = $1 AND timestamp >= $2 AND referer IS NOT NULL AND referer != ''
		GROUP BY referer
		ORDER BY clicks DESC
		LIMIT $3
	`

	rows, err := r.db.QueryContext(ctx, query, code, startDate, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := make(map[string]int64)
	for rows.Next() {
		var referer string
		var clicks int64
		if err := rows.Scan(&referer, &clicks); err != nil {
			return nil, err
		}
		result[referer] = clicks
	}

	return result, nil
}

func (r *AnalyticsRepository) getDeviceBreakdown(ctx context.Context, code string, startDate time.Time) (map[string]int64, error) {
	query := `
		SELECT device_type, COUNT(*) as clicks
		FROM analytics_events
		WHERE short_code = $1 AND timestamp >= $2
		GROUP BY device_type
	`

	rows, err := r.db.QueryContext(ctx, query, code, startDate)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := make(map[string]int64)
	for rows.Next() {
		var deviceType string
		var clicks int64
		if err := rows.Scan(&deviceType, &clicks); err != nil {
			return nil, err
		}
		result[deviceType] = clicks
	}

	return result, nil
}
```

---

### Junior → FAANG: Analytics Pipelines as Decoupled Systems

The key insight in this chapter is that analytics are handled asynchronously. Capturing a click event and recording redirect analytics are separate concerns with separate latency requirements. The redirect must be fast (user is waiting). The analytics write can be eventual (user does not wait for it).

For interviews, describe this as the "fire and forget" pattern with one important caveat: fire-and-forget is only safe when losing events is acceptable. For billing-critical analytics (where click counts affect invoices), you need at-least-once delivery with deduplication. For informational dashboards, best-effort is fine. Know which one your system provides.

Dependency injection through interfaces (depending on `AnalyticsRepository` rather than a concrete database type) is worth highlighting in interviews. It shows you write testable code and understand how to mock dependencies in unit tests.

### Senior @ FAANG: Analytics at Scale Requires a Separate Data Plane

At senior level, the analytics pipeline in this chapter is a starting point, not a production solution. At high traffic (millions of clicks per hour), writing analytics to PostgreSQL synchronously (even via a buffered channel) creates write amplification that competes with redirect serving.

The production architecture separates the data plane. Click events are written to an event stream (Kafka or Kinesis), where they are durably buffered. A separate analytics service consumes the stream, performs enrichment and aggregation, and writes to a time-series or columnar store (ClickHouse, BigQuery, or Redshift) optimized for analytical queries. This separation means analytics failures never affect redirect serving, and the analytics pipeline can be scaled independently.

Schema design for time-series click data deserves its own ADR. Storing raw events allows flexible retroactive analysis but requires large storage and slow aggregation queries. Pre-aggregating at ingest time (hourly rollups) reduces storage and query latency but limits retroactive flexibility. Production systems often store raw events for 30 days and pre-aggregated summaries indefinitely. That retention policy is a compliance and cost decision that should be documented.

User agent parsing and IP geolocation at high throughput require caching. Parsing the same user agent string millions of times is wasteful. A bounded LRU cache of parsed user agents (most user agents repeat frequently) reduces CPU consumption by 90% or more. IP geolocation lookups against a local MaxMind database are cheap per-call but the database must be kept current (weekly updates). Both are operational concerns that belong in the runbook.

---
