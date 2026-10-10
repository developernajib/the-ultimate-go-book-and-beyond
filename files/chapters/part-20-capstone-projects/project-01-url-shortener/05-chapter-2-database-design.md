## Chapter 2: Database Design

A URL shortener lives and dies by its database design. The database must support extremely fast reads for redirect lookups while also storing metadata for analytics and user management. In this chapter, we design a normalized PostgreSQL schema with carefully chosen indexes, define Go struct models that map to our tables, and implement a repository layer that abstracts all database operations behind clean interfaces.

### 2.1 PostgreSQL Schema

We need a normalized schema that supports high read throughput:

```sql
-- migrations/000001_initial_schema.up.sql

-- Enable necessary extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- URLs table (main mapping)
CREATE TABLE urls (
    id BIGSERIAL PRIMARY KEY,
    short_code VARCHAR(20) UNIQUE NOT NULL,
    long_url TEXT NOT NULL,
    user_id BIGINT,

    -- Metadata
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMP,
    active BOOLEAN NOT NULL DEFAULT true,

    -- Analytics counters (cached aggregates)
    clicks BIGINT NOT NULL DEFAULT 0,
    last_accessed_at TIMESTAMP,

    -- Indexes
    CONSTRAINT urls_short_code_check CHECK (length(short_code) >= 3)
);

-- Indexes for fast lookups
CREATE INDEX idx_urls_short_code ON urls(short_code) WHERE active = true;
CREATE INDEX idx_urls_long_url_hash ON urls USING hash(long_url);
CREATE INDEX idx_urls_user_id ON urls(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX idx_urls_created_at ON urls(created_at DESC);
CREATE INDEX idx_urls_expires_at ON urls(expires_at) WHERE expires_at IS NOT NULL;

-- Users table (for authenticated users)
CREATE TABLE users (
    id BIGSERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    api_key UUID UNIQUE NOT NULL DEFAULT uuid_generate_v4(),

    -- Subscription tier
    tier VARCHAR(50) NOT NULL DEFAULT 'free', -- free, pro, enterprise

    -- Rate limits
    rate_limit_per_hour INT NOT NULL DEFAULT 100,
    rate_limit_per_day INT NOT NULL DEFAULT 1000,

    -- Timestamps
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    last_login_at TIMESTAMP,
    active BOOLEAN NOT NULL DEFAULT true
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_api_key ON users(api_key);

-- Analytics events table (time-series data)
CREATE TABLE analytics_events (
    id BIGSERIAL PRIMARY KEY,
    short_code VARCHAR(20) NOT NULL,

    -- Request metadata
    ip_address INET,
    user_agent TEXT,
    referer TEXT,

    -- Geographic data (from IP lookup)
    country_code CHAR(2),
    city VARCHAR(100),

    -- Device info (parsed from user agent)
    device_type VARCHAR(50), -- desktop, mobile, tablet, bot
    os VARCHAR(50),
    browser VARCHAR(50),

    -- Timestamp (partitioned)
    timestamp TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Partition by month for better performance
-- This is a simplified example; in production, use pg_partman or similar
CREATE INDEX idx_analytics_short_code_timestamp ON analytics_events(short_code, timestamp DESC);
CREATE INDEX idx_analytics_timestamp ON analytics_events(timestamp DESC);

-- Foreign key constraints
ALTER TABLE urls ADD CONSTRAINT fk_urls_user_id
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- Custom domains table (enterprise feature)
CREATE TABLE custom_domains (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    domain VARCHAR(255) UNIQUE NOT NULL,
    verified BOOLEAN NOT NULL DEFAULT false,
    verification_token UUID NOT NULL DEFAULT uuid_generate_v4(),
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),

    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_custom_domains_user_id ON custom_domains(user_id);
CREATE INDEX idx_custom_domains_domain ON custom_domains(domain) WHERE verified = true;
```

### 2.2 Database Models

Go structs serve as the bridge between your database rows and your application logic. Each model below maps directly to a database table using `db` struct tags, which the `sqlx` library uses to automatically scan query results into your fields. Notice that nullable columns use pointer types (like `*int64` and `*time.Time`) so that Go can represent the difference between a zero value and a missing value.

```go
// internal/models/url.go
package models

import (
	"time"
)

// URL represents a shortened URL
type URL struct {
	ID             int64      `db:"id"`
	ShortCode      string     `db:"short_code"`
	LongURL        string     `db:"long_url"`
	UserID         *int64     `db:"user_id"`
	CreatedAt      time.Time  `db:"created_at"`
	ExpiresAt      *time.Time `db:"expires_at"`
	Active         bool       `db:"active"`
	Clicks         int64      `db:"clicks"`
	LastAccessedAt *time.Time `db:"last_accessed_at"`
}

// User represents a registered user
type User struct {
	ID                int64     `db:"id"`
	Email             string    `db:"email"`
	PasswordHash      string    `db:"password_hash"`
	APIKey            string    `db:"api_key"`
	Tier              string    `db:"tier"`
	RateLimitPerHour  int       `db:"rate_limit_per_hour"`
	RateLimitPerDay   int       `db:"rate_limit_per_day"`
	CreatedAt         time.Time `db:"created_at"`
	LastLoginAt       *time.Time `db:"last_login_at"`
	Active            bool      `db:"active"`
}

// ClickEvent represents a single click/redirect event
type ClickEvent struct {
	ID          int64     `db:"id"`
	ShortCode   string    `db:"short_code"`
	IPAddress   string    `db:"ip_address"`
	UserAgent   string    `db:"user_agent"`
	Referer     string    `db:"referer"`
	CountryCode string    `db:"country_code"`
	City        string    `db:"city"`
	DeviceType  string    `db:"device_type"`
	OS          string    `db:"os"`
	Browser     string    `db:"browser"`
	Timestamp   time.Time `db:"timestamp"`
}

// CustomDomain represents a custom domain for enterprise users
type CustomDomain struct {
	ID                int64     `db:"id"`
	UserID            int64     `db:"user_id"`
	Domain            string    `db:"domain"`
	Verified          bool      `db:"verified"`
	VerificationToken string    `db:"verification_token"`
	CreatedAt         time.Time `db:"created_at"`
}
```

### 2.3 Repository Implementation

The repository pattern encapsulates all SQL queries behind a clean Go interface, keeping database details out of your service layer. This makes it straightforward to swap PostgreSQL for another database in the future, or to use a mock implementation in tests. Each method uses parameterized queries with `$1`, `$2` placeholders to prevent SQL injection, and wraps errors with `fmt.Errorf` so that callers get meaningful context when something fails.

```go
// internal/repository/postgres/url_repository.go
package postgres

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/jmoiron/sqlx"
	"github.com/yourusername/goshort/internal/models"
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
```

---

### Junior → FAANG: Why Database Design Is the First Interview Differentiator

Interviewers notice immediately whether a candidate has actually designed a database schema or just described one abstractly. Walking through a real schema, index by index, shows hands-on experience. For the URL shortener, the critical indexes are on the short code (the primary lookup key) and on user ID with expiration (for listing and cleanup jobs). Be ready to explain why each index exists and what query it accelerates.

The repository pattern is a first-job habit worth building early. It keeps database details out of business logic, makes unit testing possible without a real database, and makes it straightforward to swap PostgreSQL for a different store later. Even if your interviewer does not ask about it directly, mentioning that your data access is abstracted behind interfaces signals awareness of testability.

Migrations as versioned SQL files is also worth highlighting. It demonstrates that you treat schema changes as code, with review and rollback support.

### Senior @ FAANG: Database Design as a Long-Term Operational Commitment

At senior level, the schema design document is a long-term contract. Every column you add becomes a migration burden. Every index you add affects write throughput. Every foreign key you add constrains future sharding options.

For a URL shortener at FAANG scale, the hardest database decision is not the initial schema but the sharding strategy. A single PostgreSQL primary handles roughly 10k writes per second under favorable conditions. Beyond that, you need horizontal partitioning. Sharding by user ID keeps user data co-located but creates hot shards for high-volume users. Sharding by short code distributes writes more evenly but scatters user data. Document this decision in an ADR with explicit scaling thresholds: at what write rate does the current single-primary design fail, and what is the migration path?

Soft deletes versus hard deletes is an operational decision, not just a data modeling preference. Soft deletes (is_deleted flag) preserve audit trails and simplify recovery from accidental deletion, but they complicate every query and require a background cleanup job. The ADR should document the compliance requirement that motivates soft deletes and the operational overhead it introduces.

Index maintenance is a production concern that never appears in design documents. PostgreSQL index bloat under high update rates requires periodic `VACUUM` and `REINDEX` operations. At scale, those operations compete with production traffic. A senior engineer defines the maintenance window, monitors index bloat as a metric, and documents the procedure in the runbook. That operational depth is what separates production-ready design from academic exercise.

---
