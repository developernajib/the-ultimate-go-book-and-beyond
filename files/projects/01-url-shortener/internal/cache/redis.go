// internal/cache/redis.go
package cache

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/example/url-shortener/internal/models"
)

// RedisCache implements CacheService with Redis
type RedisCache struct {
	client     *redis.Client
	prefix     string
	defaultTTL time.Duration
}

// NewRedisCache creates a new Redis cache
func NewRedisCache(client *redis.Client, prefix string) *RedisCache {
	return &RedisCache{
		client:     client,
		prefix:     prefix,
		defaultTTL: 1 * time.Hour,
	}
}

// Get retrieves a URL from cache
func (c *RedisCache) Get(ctx context.Context, key string) (*models.URL, error) {
	fullKey := c.makeKey(key)

	data, err := c.client.Get(ctx, fullKey).Bytes()
	if err != nil {
		if err == redis.Nil {
			return nil, nil // Cache miss
		}
		return nil, fmt.Errorf("redis get: %w", err)
	}

	var url models.URL
	if err := json.Unmarshal(data, &url); err != nil {
		return nil, fmt.Errorf("unmarshaling cached URL: %w", err)
	}

	return &url, nil
}

// Set stores a URL in cache
func (c *RedisCache) Set(ctx context.Context, key string, url *models.URL, ttl time.Duration) error {
	fullKey := c.makeKey(key)

	data, err := json.Marshal(url)
	if err != nil {
		return fmt.Errorf("marshaling URL: %w", err)
	}

	if ttl == 0 {
		ttl = c.defaultTTL
	}

	if err := c.client.Set(ctx, fullKey, data, ttl).Err(); err != nil {
		return fmt.Errorf("redis set: %w", err)
	}

	return nil
}

// Delete removes a URL from cache
func (c *RedisCache) Delete(ctx context.Context, key string) error {
	fullKey := c.makeKey(key)

	if err := c.client.Del(ctx, fullKey).Err(); err != nil {
		return fmt.Errorf("redis delete: %w", err)
	}

	return nil
}

// makeKey creates a prefixed cache key
func (c *RedisCache) makeKey(key string) string {
	return fmt.Sprintf("%s:url:%s", c.prefix, key)
}

// Ping checks Redis connectivity
func (c *RedisCache) Ping(ctx context.Context) error {
	return c.client.Ping(ctx).Err()
}
