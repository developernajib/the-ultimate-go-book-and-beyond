// internal/service/shortener.go
package service

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"time"

	"github.com/example/url-shortener/internal/models"
	"github.com/example/url-shortener/pkg/shortener"
)

var (
	ErrInvalidURL        = errors.New("invalid URL")
	ErrURLTooLong        = errors.New("URL exceeds maximum length")
	ErrExpiredURL        = errors.New("URL has expired")
	ErrURLNotFound       = errors.New("URL not found")
	ErrRateLimitExceeded = errors.New("rate limit exceeded")
)

const (
	maxURLLength = 2048
)

// ShortenerService handles URL shortening operations
type ShortenerService struct {
	generator   *shortener.Generator
	resolver    *shortener.CollisionResolver
	repository  URLRepository
	cache       CacheService
	analytics   AnalyticsService
	rateLimiter RateLimiter
}

// URLRepository defines database operations
type URLRepository interface {
	Create(ctx context.Context, url *models.URL) error
	GetByCode(ctx context.Context, code string) (*models.URL, error)
	GetByLongURL(ctx context.Context, longURL string) (*models.URL, error)
	CodeExists(ctx context.Context, code string) (bool, error)
	IncrementClicks(ctx context.Context, code string) error
}

// CacheService defines cache operations
type CacheService interface {
	Get(ctx context.Context, key string) (*models.URL, error)
	Set(ctx context.Context, key string, url *models.URL, ttl time.Duration) error
	Delete(ctx context.Context, key string) error
}

// AnalyticsService defines analytics operations
type AnalyticsService interface {
	RecordClick(ctx context.Context, event *models.ClickEvent) error
}

// RateLimiter defines rate limiting operations
type RateLimiter interface {
	Allow(ctx context.Context, identifier string) (bool, error)
}

// ShortenRequest represents a URL shortening request
type ShortenRequest struct {
	LongURL     string
	CustomAlias string
	ExpiresAt   *time.Time
	UserID      *int64 // nil for anonymous users
}

// ShortenResponse represents the shortening result
type ShortenResponse struct {
	ShortCode string
	ShortURL  string
	LongURL   string
	CreatedAt time.Time
	ExpiresAt *time.Time
}

// NewShortenerService creates a new shortener service
func NewShortenerService(
	repo URLRepository,
	cache CacheService,
	analytics AnalyticsService,
	rateLimiter RateLimiter,
) *ShortenerService {
	gen := shortener.NewGenerator()
	return &ShortenerService{
		generator:   gen,
		resolver:    shortener.NewCollisionResolver(repo),
		repository:  repo,
		cache:       cache,
		analytics:   analytics,
		rateLimiter: rateLimiter,
	}
}

// Shorten creates a short URL
func (s *ShortenerService) Shorten(ctx context.Context, req *ShortenRequest) (*ShortenResponse, error) {
	// Validate URL
	if err := s.validateURL(req.LongURL); err != nil {
		return nil, err
	}

	// Check if URL already exists (optional: for deduplication)
	existing, err := s.repository.GetByLongURL(ctx, req.LongURL)
	if err == nil && existing != nil && req.CustomAlias == "" {
		// Return existing short URL (idempotent operation)
		return s.buildResponse(existing), nil
	}

	// Generate short code
	var shortCode string
	if req.CustomAlias != "" {
		// Use custom alias
		if err := s.generator.ValidateCustomAlias(req.CustomAlias); err != nil {
			return nil, err
		}

		exists, err := s.repository.CodeExists(ctx, req.CustomAlias)
		if err != nil {
			return nil, fmt.Errorf("checking alias: %w", err)
		}
		if exists {
			return nil, shortener.ErrAliasAlreadyExists
		}

		shortCode = req.CustomAlias
	} else {
		// Generate from hash and resolve collisions
		baseCode := s.generator.GenerateFromURL(req.LongURL)
		shortCode, err = s.resolver.ResolveCollision(ctx, baseCode)
		if err != nil {
			return nil, fmt.Errorf("generating short code: %w", err)
		}
	}

	// Create URL record
	urlRecord := &models.URL{
		ShortCode: shortCode,
		LongURL:   req.LongURL,
		CreatedAt: time.Now(),
		ExpiresAt: req.ExpiresAt,
		UserID:    req.UserID,
		Clicks:    0,
		Active:    true,
	}

	if err := s.repository.Create(ctx, urlRecord); err != nil {
		return nil, fmt.Errorf("storing URL: %w", err)
	}

	// Warm the cache
	_ = s.cache.Set(ctx, shortCode, urlRecord, 1*time.Hour)

	return s.buildResponse(urlRecord), nil
}

// GetURL retrieves the original URL by short code
func (s *ShortenerService) GetURL(ctx context.Context, code string) (*models.URL, error) {
	// Try cache first
	cached, err := s.cache.Get(ctx, code)
	if err == nil && cached != nil {
		return cached, nil
	}

	// Cache miss - query database
	urlRecord, err := s.repository.GetByCode(ctx, code)
	if err != nil {
		return nil, ErrURLNotFound
	}

	// Check expiration
	if urlRecord.ExpiresAt != nil && time.Now().After(*urlRecord.ExpiresAt) {
		return nil, ErrExpiredURL
	}

	if !urlRecord.Active {
		return nil, ErrURLNotFound
	}

	// Update cache
	_ = s.cache.Set(ctx, code, urlRecord, 1*time.Hour)

	return urlRecord, nil
}

// RecordClick records a click and returns the URL
func (s *ShortenerService) RecordClick(ctx context.Context, code string, event *models.ClickEvent) (*models.URL, error) {
	urlRecord, err := s.GetURL(ctx, code)
	if err != nil {
		return nil, err
	}

	// Increment counter asynchronously (fire and forget)
	go func() {
		_ = s.repository.IncrementClicks(context.Background(), code)
	}()

	// Record analytics event asynchronously
	event.ShortCode = code
	event.Timestamp = time.Now()
	go func() {
		_ = s.analytics.RecordClick(context.Background(), event)
	}()

	return urlRecord, nil
}

// validateURL validates the long URL
func (s *ShortenerService) validateURL(longURL string) error {
	if len(longURL) > maxURLLength {
		return ErrURLTooLong
	}

	parsedURL, err := url.Parse(longURL)
	if err != nil {
		return ErrInvalidURL
	}

	// Must have a scheme
	if parsedURL.Scheme != "http" && parsedURL.Scheme != "https" {
		return ErrInvalidURL
	}

	// Must have a host
	if parsedURL.Host == "" {
		return ErrInvalidURL
	}

	return nil
}

// buildResponse creates a ShortenResponse
func (s *ShortenerService) buildResponse(u *models.URL) *ShortenResponse {
	return &ShortenResponse{
		ShortCode: u.ShortCode,
		ShortURL:  fmt.Sprintf("https://goshort.io/%s", u.ShortCode),
		LongURL:   u.LongURL,
		CreatedAt: u.CreatedAt,
		ExpiresAt: u.ExpiresAt,
	}
}
