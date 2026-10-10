## 60.4 Database Design

### Schema

The database schema separates URL metadata from click analytics into distinct tables, enabling each to be indexed, archived, and partitioned independently based on their different access patterns and retention requirements. The `urls` table uses a `BIGSERIAL` primary key that becomes the numeric input for base62 encoding, while a separate unique index on `short_id` ensures fast lookups on the read path. The `clicks` table will grow unboundedly with traffic and should be partitioned by time (monthly or weekly) to keep query performance acceptable as the dataset scales.

```sql
-- migrations/001_create_tables.sql

-- Main URLs table
CREATE TABLE urls (
    id BIGSERIAL PRIMARY KEY,
    short_id VARCHAR(10) UNIQUE NOT NULL,
    long_url TEXT NOT NULL,
    user_id BIGINT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE,
    is_active BOOLEAN DEFAULT true,
    click_count BIGINT DEFAULT 0
);

-- Create index for lookups
CREATE INDEX idx_urls_short_id ON urls(short_id) WHERE is_active = true;
CREATE INDEX idx_urls_long_url ON urls USING hash(long_url);
CREATE INDEX idx_urls_expires_at ON urls(expires_at) WHERE expires_at IS NOT NULL;

-- Click events table (for analytics)
CREATE TABLE click_events (
    id BIGSERIAL PRIMARY KEY,
    url_id BIGINT REFERENCES urls(id),
    short_id VARCHAR(10) NOT NULL,
    clicked_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    ip_address INET,
    user_agent TEXT,
    referer TEXT,
    country VARCHAR(2),
    city VARCHAR(100)
) PARTITION BY RANGE (clicked_at);

-- Create monthly partitions
CREATE TABLE click_events_2024_01 PARTITION OF click_events
    FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');
CREATE TABLE click_events_2024_02 PARTITION OF click_events
    FOR VALUES FROM ('2024-02-01') TO ('2024-03-01');
-- ... more partitions

-- Index for analytics queries
CREATE INDEX idx_click_events_short_id ON click_events(short_id, clicked_at);
CREATE INDEX idx_click_events_url_id ON click_events(url_id);
```

### Repository Implementation

The repository wraps `pgxpool.Pool` rather than a single connection so the application can serve concurrent redirect requests without serializing on a single database connection. `GetByShortID` performs the expiration check in Go after retrieving the row rather than in SQL, which lets the database index serve the lookup without a computed predicate while still returning a typed `ErrURLExpired` sentinel that calling code can distinguish from a missing record. Soft deletion via `is_active = false` preserves click history for analytics even after a URL is removed.

```go
// repository/url_repository.go
package repository

import (
    "context"
    "errors"
    "time"

    "github.com/jackc/pgx/v5"
    "github.com/jackc/pgx/v5/pgconn"
    "github.com/jackc/pgx/v5/pgxpool"
)

var (
    ErrURLNotFound = errors.New("URL not found")
    ErrURLExpired  = errors.New("URL has expired")
    ErrDuplicateID = errors.New("short ID already exists")
)

// URL represents a shortened URL
type URL struct {
    ID         int64
    ShortID    string
    LongURL    string
    UserID     *int64
    CreatedAt  time.Time
    ExpiresAt  *time.Time
    IsActive   bool
    ClickCount int64
}

// URLRepository handles URL database operations
type URLRepository struct {
    pool *pgxpool.Pool
}

// NewURLRepository creates a new repository
func NewURLRepository(pool *pgxpool.Pool) *URLRepository {
    return &URLRepository{pool: pool}
}

func isPgUniqueViolation(err error) bool {
    var pgErr *pgconn.PgError
    if errors.As(err, &pgErr) {
        return pgErr.Code == "23505"
    }
    return false
}

// Create inserts a new URL
func (r *URLRepository) Create(ctx context.Context, url *URL) error {
    query := `
        INSERT INTO urls (short_id, long_url, user_id, expires_at)
        VALUES ($1, $2, $3, $4)
        RETURNING id, created_at
    `

    err := r.pool.QueryRow(ctx, query,
        url.ShortID,
        url.LongURL,
        url.UserID,
        url.ExpiresAt,
    ).Scan(&url.ID, &url.CreatedAt)

    if err != nil {
        if isPgUniqueViolation(err) {
            return ErrDuplicateID
        }
        return err
    }

    return nil
}

// GetByShortID retrieves a URL by its short ID
func (r *URLRepository) GetByShortID(ctx context.Context, shortID string) (*URL, error) {
    query := `
        SELECT id, short_id, long_url, user_id, created_at, expires_at, is_active, click_count
        FROM urls
        WHERE short_id = $1 AND is_active = true
    `

    var url URL
    err := r.pool.QueryRow(ctx, query, shortID).Scan(
        &url.ID,
        &url.ShortID,
        &url.LongURL,
        &url.UserID,
        &url.CreatedAt,
        &url.ExpiresAt,
        &url.IsActive,
        &url.ClickCount,
    )

    if errors.Is(err, pgx.ErrNoRows) {
        return nil, ErrURLNotFound
    }
    if err != nil {
        return nil, err
    }

    // Check expiration
    if url.ExpiresAt != nil && url.ExpiresAt.Before(time.Now()) {
        return nil, ErrURLExpired
    }

    return &url, nil
}

// GetByLongURL finds an existing short URL for a long URL
func (r *URLRepository) GetByLongURL(ctx context.Context, longURL string, userID *int64) (*URL, error) {
    query := `
        SELECT id, short_id, long_url, user_id, created_at, expires_at, is_active, click_count
        FROM urls
        WHERE long_url = $1
          AND (user_id = $2 OR (user_id IS NULL AND $2 IS NULL))
          AND is_active = true
          AND (expires_at IS NULL OR expires_at > NOW())
    `

    var url URL
    err := r.pool.QueryRow(ctx, query, longURL, userID).Scan(
        &url.ID,
        &url.ShortID,
        &url.LongURL,
        &url.UserID,
        &url.CreatedAt,
        &url.ExpiresAt,
        &url.IsActive,
        &url.ClickCount,
    )

    if errors.Is(err, pgx.ErrNoRows) {
        return nil, ErrURLNotFound
    }
    if err != nil {
        return nil, err
    }

    return &url, nil
}

// IncrementClickCount atomically increments the click count
func (r *URLRepository) IncrementClickCount(ctx context.Context, shortID string) error {
    query := `UPDATE urls SET click_count = click_count + 1 WHERE short_id = $1`
    _, err := r.pool.Exec(ctx, query, shortID)
    return err
}

// Delete soft-deletes a URL
func (r *URLRepository) Delete(ctx context.Context, shortID string) error {
    query := `UPDATE urls SET is_active = false WHERE short_id = $1`
    result, err := r.pool.Exec(ctx, query, shortID)
    if err != nil {
        return err
    }

    if result.RowsAffected() == 0 {
        return ErrURLNotFound
    }

    return nil
}

// CleanupExpired removes expired URLs
func (r *URLRepository) CleanupExpired(ctx context.Context) (int64, error) {
    query := `
        UPDATE urls
        SET is_active = false
        WHERE expires_at < NOW() AND is_active = true
    `
    result, err := r.pool.Exec(ctx, query)
    if err != nil {
        return 0, err
    }
    return result.RowsAffected(), nil
}

// ShortIDExists checks if a short ID already exists
func (r *URLRepository) ShortIDExists(ctx context.Context, shortID string) (bool, error) {
    query := `SELECT EXISTS(SELECT 1 FROM urls WHERE short_id = $1)`
    var exists bool
    err := r.pool.QueryRow(ctx, query, shortID).Scan(&exists)
    return exists, err
}
```

---

### Junior → FAANG: Database Schema Design for the URL Shortener

Database design in a system design interview reveals whether you think about data access patterns before you design tables. The schema in this section is deliberately opinionated. Here is why each decision was made.

**The primary key is a BIGSERIAL, not the short_id.** A numeric auto-increment primary key gives you a stable, compact row identifier for foreign keys (click_events references urls.id). The short_id is a separate unique index because it serves a different purpose: fast lookups by the redirect path. Separating these means you can change the short_id format (length, alphabet) without affecting the foreign key relationship.

**The partial index `WHERE is_active = true` matters for performance.** Most redirect lookups are for active URLs. If you index all short_ids including soft-deleted ones, the index is larger and lookup plans may include dead rows. The partial index keeps only active entries, making it smaller and faster for the 99% case. This is a detail junior candidates rarely include but that interviewers notice.

**Time-based partitioning on click_events is a non-negotiable at scale.** The click_events table will receive 100M rows per month at the stated scale (one click event per redirect, 100:1 read ratio). After six months, the table has 600M rows. Without partitioning, a query like "get clicks for the last 30 days" scans the full table. With monthly range partitions, it scans only one or two partitions. PostgreSQL partition pruning makes this automatic when the WHERE clause includes the partition key (clicked_at). Know that partitions must be created in advance or you need a background job that creates next month's partition before it is needed.

**Soft deletion preserves click history.** Setting `is_active = false` instead of deleting the row means click_events records that reference the URL's `id` remain valid. A hard delete would violate the foreign key constraint or require cascading deletion of all click events, destroying the analytics history. Soft deletion is the right choice for any system where audit history matters.

---

### Senior @ FAANG: Data Modeling for Scale, Compliance, and Long-Term Ownership

At L6/L7, a database schema is not just a correctness artifact. It is a long-term operational commitment that constrains every future migration, every analytics query, and every compliance audit.

**Schema evolution must be planned from day one.** The `urls` table in this section will receive new columns over time: tenant_id for multi-tenancy, utm_parameters for marketing tracking, security_scan_result for phishing detection. PostgreSQL `ALTER TABLE ADD COLUMN` with a DEFAULT is generally non-blocking for nullable or defaulted columns, but adding a NOT NULL column without a default requires a full table rewrite in older PostgreSQL versions (before 11). At L6+, you document the schema migration policy: all new columns must be nullable or have a server-side default, all index additions use `CREATE INDEX CONCURRENTLY` to avoid table locks, and all migrations are reviewed for lock acquisition before deployment.

**The click_events table has a data retention governance requirement.** At FAANG scale, click events accumulate petabytes of data annually. A data retention policy answers: how long do you keep raw click events (typically 90 days for GDPR compliance, longer for aggregate summaries), how do you delete data for a specific user on a right-to-erasure request (IP address is personal data under GDPR, requiring deletion or anonymization), and how do you enforce retention without blocking redirect traffic. The standard pattern is a tiered architecture: raw events in the hot partition for 90 days, aggregated summaries (count by day, count by country) retained indefinitely, raw events deleted on a scheduled job that drops partitions. Document which data fields are PII (IP address, user agent) and which are not.

**Connection pool sizing is an operational parameter, not an afterthought.** The repository uses `pgxpool.Pool`, which is correct. The pool size must be tuned against the PostgreSQL `max_connections` setting, the number of replicas, and the expected query duration distribution. A pool that is too large exhausts PostgreSQL connections under load. A pool that is too small forces requests to queue, adding latency. The formula for pool size is: `target_query_concurrency / expected_query_duration_seconds`. For a redirect endpoint targeting 100K requests per second with 2ms average query time, you need around 200 concurrent query slots. Divide by the number of service replicas to get per-replica pool size. This calculation belongs in the service's operational runbook.

**The soft-delete pattern requires a cleanup job SLA.** `is_active = false` rows remain in the table forever unless explicitly purged. At 100M URLs per month, a year produces 1.2 billion rows with many soft-deleted. The `CleanupExpired` function in the repository is correct, but it must run on a schedule (daily background job) and must be bounded (process N rows per run to avoid long-running transactions that hold locks). Document the cleanup job's maximum run time, its retry behavior on failure, and the monitoring alert that fires when the backlog exceeds a threshold. This operational discipline distinguishes a service that was designed to run for years from one that accumulates silent technical debt.
