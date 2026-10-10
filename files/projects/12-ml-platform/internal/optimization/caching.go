// internal/optimization/caching.go
package optimization

import (
	"context"
	"encoding/json"
	"time"

	"github.com/go-redis/redis/v8"
)

// CachingLayer provides caching for frequently accessed data
type CachingLayer struct {
	redis *redis.Client
	ttl   time.Duration
}

// NewCachingLayer creates a new caching layer
func NewCachingLayer(redisClient *redis.Client, ttl time.Duration) *CachingLayer {
	return &CachingLayer{
		redis: redisClient,
		ttl:   ttl,
	}
}

// Get retrieves a value from cache
func (c *CachingLayer) Get(ctx context.Context, key string, value any) (bool, error) {
	data, err := c.redis.Get(ctx, key).Bytes()
	if err == redis.Nil {
		return false, nil
	}
	if err != nil {
		return false, err
	}

	if err := json.Unmarshal(data, value); err != nil {
		return false, err
	}

	return true, nil
}

// Set stores a value in cache
func (c *CachingLayer) Set(ctx context.Context, key string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}

	return c.redis.Set(ctx, key, data, c.ttl).Err()
}

// Delete removes a value from cache
func (c *CachingLayer) Delete(ctx context.Context, key string) error {
	return c.redis.Del(ctx, key).Err()
}
