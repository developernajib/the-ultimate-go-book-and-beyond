// pkg/cache/cache.go
package cache

import (
	"context"
	"time"
)

// Cache defines a generic cache interface
type Cache interface {
	Get(ctx context.Context, key string) (string, error)
	Set(ctx context.Context, key string, value any, ttl time.Duration) error
	Delete(ctx context.Context, key string) error
	ZAdd(ctx context.Context, key string, score float64, member string) error
	ZRemRangeByScore(ctx context.Context, key string, min, max float64) error
	ZCount(ctx context.Context, key string, min, max float64) (int64, error)
	Expire(ctx context.Context, key string, ttl time.Duration) error
	Increment(ctx context.Context, key string, delta int64) (int64, error)
}

// NoOpCache is a no-op cache implementation for testing/stub
type NoOpCache struct{}

func (c *NoOpCache) Get(_ context.Context, _ string) (string, error)                { return "", nil }
func (c *NoOpCache) Set(_ context.Context, _ string, _ any, _ time.Duration) error {
	return nil
}
func (c *NoOpCache) Delete(_ context.Context, _ string) error                            { return nil }
func (c *NoOpCache) ZAdd(_ context.Context, _ string, _ float64, _ string) error        { return nil }
func (c *NoOpCache) ZRemRangeByScore(_ context.Context, _ string, _, _ float64) error   { return nil }
func (c *NoOpCache) ZCount(_ context.Context, _ string, _, _ float64) (int64, error)    { return 0, nil }
func (c *NoOpCache) Expire(_ context.Context, _ string, _ time.Duration) error              { return nil }
func (c *NoOpCache) Increment(_ context.Context, _ string, _ int64) (int64, error) { return 0, nil }
