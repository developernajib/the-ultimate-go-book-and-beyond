// internal/optimization/cache_strategy.go
package optimization

import (
    "context"
    "fmt"
    "time"

    "github.com/example/saas-platform/pkg/cache"
    "github.com/example/saas-platform/pkg/logger"
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
