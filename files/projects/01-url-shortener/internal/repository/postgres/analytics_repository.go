// internal/repository/postgres/analytics_repository.go
package postgres

import (
	"context"
	"fmt"
	"time"

	"github.com/jmoiron/sqlx"
	"github.com/example/url-shortener/internal/models"
	"github.com/example/url-shortener/internal/service"
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
