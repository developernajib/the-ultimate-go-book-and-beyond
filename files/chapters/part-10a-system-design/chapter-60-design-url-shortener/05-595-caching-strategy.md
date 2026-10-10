## 60.5 Caching Strategy

The cache layer is critical for a URL shortener because redirect requests vastly outnumber writes and the working set (hot short URLs) fits comfortably in memory. The cache-aside pattern stores URL records in Redis with a TTL aligned to the URL's expiration time, so expired URLs are automatically evicted without requiring a separate cleanup process. A cache miss triggers a database read and a cache populate, while write-through on URL creation ensures the cache is warm for new URLs immediately rather than waiting for the first cache miss.

```go
// cache/url_cache.go
package cache

import (
    "context"
    "encoding/json"
    "errors"
    "time"

    "github.com/redis/go-redis/v9"
)

var (
    ErrCacheMiss = errors.New("cache miss")
)

// CachedURL represents a cached URL entry
type CachedURL struct {
    LongURL   string     `json:"long_url"`
    ExpiresAt *time.Time `json:"expires_at,omitempty"`
}

// URLCache handles URL caching
type URLCache struct {
    client     *redis.Client
    keyPrefix  string
    defaultTTL time.Duration
}

// NewURLCache creates a new URL cache
func NewURLCache(client *redis.Client, prefix string, defaultTTL time.Duration) *URLCache {
    return &URLCache{
        client:     client,
        keyPrefix:  prefix,
        defaultTTL: defaultTTL,
    }
}

func (c *URLCache) key(shortID string) string {
    return c.keyPrefix + ":" + shortID
}

// Get retrieves a URL from cache
func (c *URLCache) Get(ctx context.Context, shortID string) (*CachedURL, error) {
    data, err := c.client.Get(ctx, c.key(shortID)).Bytes()
    if err == redis.Nil {
        return nil, ErrCacheMiss
    }
    if err != nil {
        return nil, err
    }

    var cached CachedURL
    if err := json.Unmarshal(data, &cached); err != nil {
        return nil, err
    }

    // Check if expired
    if cached.ExpiresAt != nil && cached.ExpiresAt.Before(time.Now()) {
        c.Delete(ctx, shortID) // Clean up expired entry
        return nil, ErrCacheMiss
    }

    return &cached, nil
}

// Set stores a URL in cache
func (c *URLCache) Set(ctx context.Context, shortID string, url *CachedURL) error {
    data, err := json.Marshal(url)
    if err != nil {
        return err
    }

    // Calculate TTL
    ttl := c.defaultTTL
    if url.ExpiresAt != nil {
        remaining := time.Until(*url.ExpiresAt)
        if remaining < ttl {
            ttl = remaining
        }
    }

    return c.client.Set(ctx, c.key(shortID), data, ttl).Err()
}

// Delete removes a URL from cache
func (c *URLCache) Delete(ctx context.Context, shortID string) error {
    return c.client.Del(ctx, c.key(shortID)).Err()
}

// SetWithTTL stores a URL with a specific TTL
func (c *URLCache) SetWithTTL(ctx context.Context, shortID string, url *CachedURL, ttl time.Duration) error {
    data, err := json.Marshal(url)
    if err != nil {
        return err
    }
    return c.client.Set(ctx, c.key(shortID), data, ttl).Err()
}

// Warm preloads popular URLs into cache
func (c *URLCache) Warm(ctx context.Context, urls map[string]*CachedURL) error {
    pipe := c.client.Pipeline()

    for shortID, url := range urls {
        data, err := json.Marshal(url)
        if err != nil {
            continue
        }
        pipe.Set(ctx, c.key(shortID), data, c.defaultTTL)
    }

    _, err := pipe.Exec(ctx)
    return err
}

// MultiGet retrieves multiple URLs from cache
func (c *URLCache) MultiGet(ctx context.Context, shortIDs []string) (map[string]*CachedURL, error) {
    if len(shortIDs) == 0 {
        return nil, nil
    }

    keys := make([]string, len(shortIDs))
    for i, id := range shortIDs {
        keys[i] = c.key(id)
    }

    results, err := c.client.MGet(ctx, keys...).Result()
    if err != nil {
        return nil, err
    }

    cached := make(map[string]*CachedURL)
    for i, result := range results {
        if result == nil {
            continue
        }

        data, ok := result.(string)
        if !ok {
            continue
        }

        var url CachedURL
        if err := json.Unmarshal([]byte(data), &url); err != nil {
            continue
        }

        cached[shortIDs[i]] = &url
    }

    return cached, nil
}
```

### Cache-Aside Pattern with Read-Through

The service layer implements cache-aside manually rather than relying on Redis as a transparent proxy, which gives precise control over error handling: a Redis failure logs a warning but falls through to the database rather than returning an error to the caller. URL deduplication on the write path, checking whether the same long URL already has an active short ID before generating a new one, avoids creating multiple short codes for identical destinations, keeping the database lean and preventing user confusion. Cache population on both read (miss recovery) and write (eager warming) paths ensures the cache hit rate stays high even immediately after a URL is created.

```go
// service/url_service.go
package service

import (
    "context"
    "errors"
    "log"

    "yourproject/cache"
    "yourproject/encoding"
    "yourproject/generator"
    "yourproject/repository"
)

var ErrCustomIDTaken = errors.New("custom short ID already taken")

// URLService orchestrates URL operations with caching
type URLService struct {
    repo      *repository.URLRepository
    cache     *cache.URLCache
    generator generator.IDGenerator
    encoder   *encoding.Base62Encoder
    baseURL   string
}

// NewURLService creates a new URL service
func NewURLService(
    repo *repository.URLRepository,
    cache *cache.URLCache,
    gen generator.IDGenerator,
    baseURL string,
) *URLService {
    return &URLService{
        repo:      repo,
        cache:     cache,
        generator: gen,
        encoder:   encoding.NewBase62Encoder(),
        baseURL:   baseURL,
    }
}

// GetLongURL retrieves the original URL (cache-aside pattern)
func (s *URLService) GetLongURL(ctx context.Context, shortID string) (string, error) {
    // 1. Check cache first
    cached, err := s.cache.Get(ctx, shortID)
    if err == nil {
        return cached.LongURL, nil
    }
    if err != nil && !errors.Is(err, cache.ErrCacheMiss) {
        // Log cache error but continue to database
        log.Printf("Cache error: %v", err)
    }

    // 2. Cache miss - query database
    url, err := s.repo.GetByShortID(ctx, shortID)
    if err != nil {
        return "", err
    }

    // 3. Populate cache
    cachedURL := &cache.CachedURL{
        LongURL:   url.LongURL,
        ExpiresAt: url.ExpiresAt,
    }
    if err := s.cache.Set(ctx, shortID, cachedURL); err != nil {
        // Log but don't fail the request
        log.Printf("Failed to cache URL: %v", err)
    }

    return url.LongURL, nil
}

// CreateShortURL creates a new short URL
func (s *URLService) CreateShortURL(ctx context.Context, req ShortenRequest) (*ShortenResponse, error) {
    var shortID string
    var err error

    if req.CustomID != "" {
        // Custom alias requested
        shortID = req.CustomID

        // Check if it's available
        exists, err := s.repo.ShortIDExists(ctx, shortID)
        if err != nil {
            return nil, err
        }
        if exists {
            return nil, ErrCustomIDTaken
        }
    } else {
        // Check if URL already shortened (deduplication)
        existing, err := s.repo.GetByLongURL(ctx, req.LongURL, nil)
        if err == nil {
            return &ShortenResponse{
                ShortURL:  s.baseURL + "/" + existing.ShortID,
                ShortID:   existing.ShortID,
                LongURL:   existing.LongURL,
                ExpiresAt: existing.ExpiresAt,
                CreatedAt: existing.CreatedAt,
            }, nil
        }
        if !errors.Is(err, repository.ErrURLNotFound) {
            return nil, err
        }

        // Generate new short ID
        shortID, err = s.generateUniqueShortID(ctx)
        if err != nil {
            return nil, err
        }
    }

    // Create URL record
    url := &repository.URL{
        ShortID:   shortID,
        LongURL:   req.LongURL,
        ExpiresAt: req.ExpiresAt,
    }

    if err := s.repo.Create(ctx, url); err != nil {
        return nil, err
    }

    // Populate cache
    cachedURL := &cache.CachedURL{
        LongURL:   url.LongURL,
        ExpiresAt: url.ExpiresAt,
    }
    s.cache.Set(ctx, shortID, cachedURL)

    return &ShortenResponse{
        ShortURL:  s.baseURL + "/" + shortID,
        ShortID:   shortID,
        LongURL:   url.LongURL,
        ExpiresAt: url.ExpiresAt,
        CreatedAt: url.CreatedAt,
    }, nil
}

// generateUniqueShortID generates a unique short ID with collision handling
func (s *URLService) generateUniqueShortID(ctx context.Context) (string, error) {
    maxRetries := 5

    for i := 0; i < maxRetries; i++ {
        id, err := s.generator.Generate(ctx)
        if err != nil {
            return "", err
        }

        shortID := s.encoder.EncodeWithPadding(id, 7)

        // Check for collision
        exists, err := s.repo.ShortIDExists(ctx, shortID)
        if err != nil {
            return "", err
        }

        if !exists {
            return shortID, nil
        }
    }

    return "", errors.New("failed to generate unique short ID")
}

// DeleteURL removes a URL
func (s *URLService) DeleteURL(ctx context.Context, shortID string) error {
    // Delete from database
    if err := s.repo.Delete(ctx, shortID); err != nil {
        return err
    }

    // Invalidate cache
    s.cache.Delete(ctx, shortID)

    return nil
}
```

---

### Junior → FAANG: Cache-Aside Pattern and Redis Fundamentals

Caching is the most impactful optimization in a read-heavy system, and the cache-aside pattern is the most common caching pattern in production services. Understanding it well is essential before an interview.

**Cache-aside in three steps.** On a read: check the cache first. On a hit, return immediately. On a miss, read from the database, populate the cache, and return. On a write: write to the database, then either invalidate the cache entry (lazy population) or update it (eager population). The code in this section uses eager population on writes (URL creation pre-warms the cache) and lazy population on reads (cache is populated on first miss). This hybrid approach means the redirect path almost never hits the database for newly created URLs.

**TTL alignment to URL expiration is a correctness requirement.** If a URL expires at 2:00 PM and the cache TTL is 24 hours, the cache will serve redirect requests for that URL until 2:00 AM the next day, long after it should have stopped. The `Set` method in `URLCache` calculates the TTL as the minimum of the default TTL and the time remaining until expiration. This is a subtle but important detail. Practice explaining why it is necessary.

**Cache errors should degrade gracefully, not fail the request.** The `GetLongURL` service method logs cache errors but falls through to the database rather than returning an error. This is the correct behavior: a Redis outage should cause a performance degradation (more database reads), not a complete service failure. The redirect service is more important than the caching layer. Know this principle and be able to articulate it: "I treat the cache as a performance hint, not a correctness requirement."

**`singleflight` prevents thundering herd.** When a hot URL's cache entry expires, multiple concurrent redirect requests all miss the cache simultaneously and all query the database at once. `singleflight.Group.Do` collapses these into a single database query. All waiting goroutines receive the same result. This is not covered in the cache implementation above but is a critical production optimization worth knowing for interviews.

---

### Senior @ FAANG: Cache Invalidation, Consistency Guarantees, and Multi-Tier Cache Architecture

Cache invalidation is famously difficult. "There are only two hard things in computer science: cache invalidation and naming things." At L6+, you are expected to have made and documented decisions about cache consistency, invalidation propagation, and the failure modes of each approach.

**Write-through vs write-behind vs cache-aside: choosing the right contract.** The service in this section uses cache-aside (application manages cache explicitly). Write-through (cache is always updated synchronously with the database write) gives stronger consistency but adds latency to every write. Write-behind (cache is updated first, database updated asynchronously) allows faster writes but risks data loss if the process crashes before the database write completes. For a URL shortener, cache-aside is correct: writes are infrequent, the cost of a cache miss on a new URL is a single database read, and the consistency window between database write and cache population is negligible. Document this choice and the consistency guarantee it provides: "There is a small window after URL creation when a redirect request may hit the database. This is acceptable because redirect latency on the first request is still well within our 100ms SLA."

**Multi-tier cache architecture at FAANG scale.** The chapter describes Redis as the cache layer. Production FAANG services use three tiers: (1) in-process LRU (freecache, ristretto, or a plain sync.Map with bounded size) for the top 0.1% of hot URLs with sub-microsecond latency, (2) Redis cluster for the broader hot set with sub-millisecond latency, (3) CDN edge caching for globally distributed redirect serving. The CDN tier is the most impactful: a Cloudflare or Fastly edge cache that serves a 302 response for the top 1% of URLs eliminates 80%+ of database-origin traffic entirely. Designing the CDN layer requires deciding the CDN TTL (typically short, 60-300 seconds, because URLs can be revoked), the cache key strategy (just the short code, not query parameters), and the purge mechanism (API-driven invalidation on URL deletion or expiration).

**Cache stampede mitigation with probabilistic early refresh.** The XFetch algorithm extends cache-aside with proactive background refresh: when a cache entry is within a configurable time of its TTL expiry, each request has a probability proportional to how close the entry is to expiry to trigger a background re-fetch. This prevents the thundering herd problem where all clients simultaneously miss a freshly expired entry. The implementation requires TTL-aware cache lookups (Redis `PTTL` command to get remaining TTL), a configurable beta parameter controlling how aggressively to pre-fetch, and a background goroutine pool to perform re-fetches without blocking the redirect response. Document the beta tuning: a beta of 1.0 is conservative (refresh only very close to expiry), a beta of 3.0 is aggressive (start refreshing well before expiry). Tune based on measured cache miss rate and p99 redirect latency.
