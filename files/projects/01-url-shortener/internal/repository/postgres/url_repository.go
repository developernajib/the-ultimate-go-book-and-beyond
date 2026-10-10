// internal/repository/postgres/url_repository.go
package postgres

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/jmoiron/sqlx"
	"github.com/example/url-shortener/internal/models"
)

// URLRepository handles database operations for URLs
type URLRepository struct {
	db *sqlx.DB
}

// NewURLRepository creates a new URL repository
func NewURLRepository(db *sqlx.DB) *URLRepository {
	return &URLRepository{db: db}
}

// Create inserts a new URL
func (r *URLRepository) Create(ctx context.Context, url *models.URL) error {
	query := `
		INSERT INTO urls (short_code, long_url, user_id, created_at, expires_at, active)
		VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING id
	`

	err := r.db.QueryRowContext(
		ctx,
		query,
		url.ShortCode,
		url.LongURL,
		url.UserID,
		url.CreatedAt,
		url.ExpiresAt,
		url.Active,
	).Scan(&url.ID)

	if err != nil {
		return fmt.Errorf("creating URL: %w", err)
	}

	return nil
}

// GetByCode retrieves a URL by its short code
func (r *URLRepository) GetByCode(ctx context.Context, code string) (*models.URL, error) {
	var url models.URL

	query := `
		SELECT id, short_code, long_url, user_id, created_at, expires_at,
		       active, clicks, last_accessed_at
		FROM urls
		WHERE short_code = $1 AND active = true
	`

	err := r.db.GetContext(ctx, &url, query, code)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, fmt.Errorf("URL not found")
		}
		return nil, fmt.Errorf("getting URL: %w", err)
	}

	return &url, nil
}

// GetByLongURL retrieves a URL by its long URL (for deduplication)
func (r *URLRepository) GetByLongURL(ctx context.Context, longURL string) (*models.URL, error) {
	var url models.URL

	query := `
		SELECT id, short_code, long_url, user_id, created_at, expires_at,
		       active, clicks, last_accessed_at
		FROM urls
		WHERE long_url = $1 AND active = true AND expires_at IS NULL
		ORDER BY created_at DESC
		LIMIT 1
	`

	err := r.db.GetContext(ctx, &url, query, longURL)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil // Not an error, just doesn't exist
		}
		return nil, fmt.Errorf("getting URL by long URL: %w", err)
	}

	return &url, nil
}

// CodeExists checks if a short code already exists
func (r *URLRepository) CodeExists(ctx context.Context, code string) (bool, error) {
	var exists bool

	query := `SELECT EXISTS(SELECT 1 FROM urls WHERE short_code = $1)`

	err := r.db.GetContext(ctx, &exists, query, code)
	if err != nil {
		return false, fmt.Errorf("checking code existence: %w", err)
	}

	return exists, nil
}

// IncrementClicks increments the click counter
func (r *URLRepository) IncrementClicks(ctx context.Context, code string) error {
	query := `
		UPDATE urls
		SET clicks = clicks + 1, last_accessed_at = $1
		WHERE short_code = $2
	`

	_, err := r.db.ExecContext(ctx, query, time.Now(), code)
	if err != nil {
		return fmt.Errorf("incrementing clicks: %w", err)
	}

	return nil
}

// GetUserURLs retrieves all URLs for a user with pagination
func (r *URLRepository) GetUserURLs(ctx context.Context, userID int64, limit, offset int) ([]*models.URL, error) {
	var urls []*models.URL

	query := `
		SELECT id, short_code, long_url, user_id, created_at, expires_at,
		       active, clicks, last_accessed_at
		FROM urls
		WHERE user_id = $1 AND active = true
		ORDER BY created_at DESC
		LIMIT $2 OFFSET $3
	`

	err := r.db.SelectContext(ctx, &urls, query, userID, limit, offset)
	if err != nil {
		return nil, fmt.Errorf("getting user URLs: %w", err)
	}

	return urls, nil
}

// DeleteExpiredURLs removes expired URLs (background job)
func (r *URLRepository) DeleteExpiredURLs(ctx context.Context) (int64, error) {
	query := `
		UPDATE urls
		SET active = false
		WHERE expires_at IS NOT NULL AND expires_at < $1 AND active = true
	`

	result, err := r.db.ExecContext(ctx, query, time.Now())
	if err != nil {
		return 0, fmt.Errorf("deleting expired URLs: %w", err)
	}

	rowsAffected, _ := result.RowsAffected()
	return rowsAffected, nil
}
