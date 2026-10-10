// internal/service/analytics.go
package service

import (
	"context"
	"fmt"

	"github.com/example/url-shortener/internal/models"
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
