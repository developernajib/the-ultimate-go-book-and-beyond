// internal/cache/redis.go
package cache

import (
    "context"
    "encoding/json"
    "fmt"
    "time"

    "github.com/google/uuid"
    "github.com/redis/go-redis/v9"
    "github.com/example/social-network/internal/domain"
)

type RedisCache struct {
    client *redis.Client
}

func NewRedisCache(client *redis.Client) *RedisCache {
    return &RedisCache{client: client}
}

// User caching
func (c *RedisCache) GetUser(ctx context.Context, userID uuid.UUID) (*domain.User, error) {
    key := fmt.Sprintf("user:%s", userID.String())
    data, err := c.client.Get(ctx, key).Bytes()
    if err != nil {
        return nil, err
    }

    var user domain.User
    if err := json.Unmarshal(data, &user); err != nil {
        return nil, err
    }

    return &user, nil
}

func (c *RedisCache) SetUser(ctx context.Context, user *domain.User, ttl time.Duration) error {
    key := fmt.Sprintf("user:%s", user.ID.String())
    data, err := json.Marshal(user)
    if err != nil {
        return err
    }

    return c.client.Set(ctx, key, data, ttl).Err()
}

// Post caching
func (c *RedisCache) GetPost(ctx context.Context, postID uuid.UUID) (*domain.Post, error) {
    key := fmt.Sprintf("post:%s", postID.String())
    data, err := c.client.Get(ctx, key).Bytes()
    if err != nil {
        return nil, err
    }

    var post domain.Post
    if err := json.Unmarshal(data, &post); err != nil {
        return nil, err
    }

    return &post, nil
}

func (c *RedisCache) SetPost(ctx context.Context, post *domain.Post, ttl time.Duration) error {
    key := fmt.Sprintf("post:%s", post.ID.String())
    data, err := json.Marshal(post)
    if err != nil {
        return err
    }

    return c.client.Set(ctx, key, data, ttl).Err()
}

// Counter caching (likes, followers, etc.)
func (c *RedisCache) IncrementCounter(ctx context.Context, key string, delta int64) error {
    return c.client.IncrBy(ctx, key, delta).Err()
}

func (c *RedisCache) GetCounter(ctx context.Context, key string) (int64, error) {
    return c.client.Get(ctx, key).Int64()
}

// Distributed lock for preventing race conditions
func (c *RedisCache) AcquireLock(ctx context.Context, key string, ttl time.Duration) (bool, error) {
    lockKey := fmt.Sprintf("lock:%s", key)
    return c.client.SetNX(ctx, lockKey, "1", ttl).Result()
}

func (c *RedisCache) ReleaseLock(ctx context.Context, key string) error {
    lockKey := fmt.Sprintf("lock:%s", key)
    return c.client.Del(ctx, lockKey).Err()
}
