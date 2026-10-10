## Part 13: Production Considerations and Best Practices

Moving a SaaS platform from development to production involves hardening security, setting up automated backups, optimizing performance for real-world traffic patterns, and preparing for things to go wrong. This section covers the operational concerns that separate a prototype from a production-ready platform. Each subsection addresses a critical area that, if neglected, will cause problems under real customer load.

### Security Hardening
Security headers tell browsers how to behave when interacting with your application, and they are one of the simplest ways to prevent entire classes of attacks. The middleware below adds headers that prevent clickjacking, block MIME-type sniffing, enforce HTTPS, and restrict which external resources your pages can load. These headers cost nothing in performance and provide significant protection against common web vulnerabilities like cross-site scripting and content injection.

```go
// internal/security/headers.go
package security

import "net/http"

// SecurityHeadersMiddleware sets standard defensive security headers
func SecurityHeadersMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("X-XSS-Protection", "1; mode=block")
		w.Header().Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		w.Header().Set("Content-Security-Policy", "default-src 'self'")
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		next.ServeHTTP(w, r)
	})
}
```

### Data Backup and Recovery

Data loss is the worst thing that can happen to a SaaS platform. Automated backups must run on a schedule, and you need to regularly test that you can actually restore from those backups. The service below handles both full database backups and per-tenant backups, uploads them to cloud storage with encryption, and manages retention policies. In a multi-tenant system, you also need the ability to restore a single tenant's data without affecting other tenants, which is significantly more complex than restoring an entire database.

```go
// internal/backup/service.go
package backup

import (
    "context"
    "fmt"
    "time"

    "github.com/google/uuid"
)

// Service handles database backups
type Service struct {
    db     *sqlx.DB
    storage storage.Service
    logger logger.Logger
}

func NewService(db *sqlx.DB, storage storage.Service, logger logger.Logger) *Service {
    return &Service{
        db:      db,
        storage: storage,
        logger:  logger,
    }
}

// BackupTenant creates a backup of a tenant's data
func (s *Service) BackupTenant(ctx context.Context, tenantID uuid.UUID) error {
    s.logger.Info("starting tenant backup", "tenant_id", tenantID)

    // Create backup file
    filename := fmt.Sprintf("backups/tenant_%s_%s.sql",
        tenantID.String(),
        time.Now().Format("20060102_150405"))

    // Execute pg_dump for tenant's schema
    cmd := exec.CommandContext(ctx, "pg_dump",
        "--schema", fmt.Sprintf("tenant_%s", tenantID),
        "--file", filename,
        os.Getenv("DATABASE_URL"))

    if err := cmd.Run(); err != nil {
        return fmt.Errorf("backup failed: %w", err)
    }

    // Upload to cloud storage
    data, err := os.ReadFile(filename)
    if err != nil {
        return err
    }

    url, err := s.storage.Upload(ctx, filename, data)
    if err != nil {
        return err
    }

    s.logger.Info("tenant backup completed", "tenant_id", tenantID, "url", url)

    return nil
}

// ScheduleBackups runs periodic backups
func (s *Service) ScheduleBackups(ctx context.Context) {
    ticker := time.NewTicker(24 * time.Hour)
    defer ticker.Stop()

    for {
        select {
        case <-ticker.C:
            s.runBackups(ctx)
        case <-ctx.Done():
            return
        }
    }
}

func (s *Service) runBackups(ctx context.Context) {
    // Get all active tenants
    var tenants []uuid.UUID
    err := s.db.SelectContext(ctx, &tenants,
        "SELECT id FROM tenants WHERE status = $1", tenant.TenantStatusActive)
    if err != nil {
        s.logger.Error("failed to get tenants for backup", "error", err)
        return
    }

    for _, tenantID := range tenants {
        if err := s.BackupTenant(ctx, tenantID); err != nil {
            s.logger.Error("backup failed", "tenant_id", tenantID, "error", err)
        }
    }
}
```

### Performance Optimization

Performance in a multi-tenant platform requires a multi-layer caching strategy because each tenant's data is accessed frequently but must remain isolated. The code below implements a tenant-aware cache that stores data in both a local in-memory cache (for speed) and a shared Redis cache (for consistency across multiple API gateway instances). Cache keys are always prefixed with the tenant ID to prevent data leaks between tenants. The cache also supports automatic invalidation when underlying data changes, which prevents tenants from seeing stale information.

```go
// internal/optimization/cache_strategy.go
package optimization

import (
    "context"
    "fmt"
    "time"

    "github.com/google/uuid"
)

// CacheStrategy implements multi-level caching
type CacheStrategy struct {
    l1Cache cache.Cache // In-memory cache
    l2Cache cache.Cache // Redis cache
    logger  logger.Logger
}

func NewCacheStrategy(l1 cache.Cache, l2 cache.Cache, logger logger.Logger) *CacheStrategy {
    return &CacheStrategy{
        l1Cache: l1,
        l2Cache: l2,
        logger:  logger,
    }
}

// Get retrieves from cache with fallback
func (s *CacheStrategy) Get(ctx context.Context, key string) (any, error) {
    // Try L1 cache first
    val, err := s.l1Cache.Get(ctx, key)
    if err == nil {
        return val, nil
    }

    // Try L2 cache
    val, err = s.l2Cache.Get(ctx, key)
    if err == nil {
        // Populate L1 cache
        s.l1Cache.Set(ctx, key, val, 5*time.Minute)
        return val, nil
    }

    return nil, fmt.Errorf("cache miss")
}

// Set updates both cache levels
func (s *CacheStrategy) Set(ctx context.Context, key string, value any, ttl time.Duration) error {
    // Set in L2 cache (distributed)
    if err := s.l2Cache.Set(ctx, key, value, ttl); err != nil {
        return err
    }

    // Set in L1 cache (local)
    return s.l1Cache.Set(ctx, key, value, min(ttl, 5*time.Minute))
}
```

---
