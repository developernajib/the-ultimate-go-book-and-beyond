// internal/cache/layered.go
package cache

import (
	"context"
	"time"

	"github.com/example/url-shortener/internal/models"
)

// LayeredCache implements a two-tier cache (L1: LRU, L2: Redis)
type LayeredCache struct {
	l1 *LRUCache
	l2 *RedisCache
}

// NewLayeredCache creates a new layered cache
func NewLayeredCache(l1 *LRUCache, l2 *RedisCache) *LayeredCache {
	return &LayeredCache{
		l1: l1,
		l2: l2,
	}
}

// Get retrieves from L1, then L2, then returns nil
func (c *LayeredCache) Get(ctx context.Context, key string) (*models.URL, error) {
	// Try L1 first
	url, err := c.l1.Get(ctx, key)
	if err == nil && url != nil {
		return url, nil
	}

	// L1 miss, try L2
	url, err = c.l2.Get(ctx, key)
	if err != nil {
		return nil, err
	}

	if url != nil {
		// Populate L1 with L2 data
		_ = c.l1.Set(ctx, key, url, 1*time.Hour)
	}

	return url, nil
}

// Set stores in both L1 and L2
func (c *LayeredCache) Set(ctx context.Context, key string, url *models.URL, ttl time.Duration) error {
	// Set in L1
	_ = c.l1.Set(ctx, key, url, ttl)

	// Set in L2
	return c.l2.Set(ctx, key, url, ttl)
}

// Delete removes from both layers
func (c *LayeredCache) Delete(ctx context.Context, key string) error {
	_ = c.l1.Delete(ctx, key)
	return c.l2.Delete(ctx, key)
}
