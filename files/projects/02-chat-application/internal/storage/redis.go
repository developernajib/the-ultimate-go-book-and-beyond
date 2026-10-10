package storage

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

type RedisStore struct {
	client *redis.Client
}

func NewRedisStore(client *redis.Client) *RedisStore {
	return &RedisStore{client: client}
}

// Presence operations

func (s *RedisStore) SetOnline(ctx context.Context, userID uuid.UUID) error {
	key := fmt.Sprintf("presence:%s", userID)
	return s.client.Set(ctx, key, "online", 5*time.Minute).Err()
}

func (s *RedisStore) SetOffline(ctx context.Context, userID uuid.UUID) error {
	key := fmt.Sprintf("presence:%s", userID)
	return s.client.Del(ctx, key).Err()
}

func (s *RedisStore) IsOnline(ctx context.Context, userID uuid.UUID) (bool, error) {
	key := fmt.Sprintf("presence:%s", userID)
	val, err := s.client.Get(ctx, key).Result()
	if err == redis.Nil {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return val == "online", nil
}

func (s *RedisStore) SetTyping(ctx context.Context, userID, channelID uuid.UUID, isTyping bool) error {
	key := fmt.Sprintf("typing:%s:%s", channelID, userID)

	if isTyping {
		// Set with 5-second TTL
		return s.client.Set(ctx, key, "1", 5*time.Second).Err()
	}

	return s.client.Del(ctx, key).Err()
}

func (s *RedisStore) GetTypingUsers(ctx context.Context, channelID uuid.UUID) ([]uuid.UUID, error) {
	pattern := fmt.Sprintf("typing:%s:*", channelID)
	keys, err := s.client.Keys(ctx, pattern).Result()
	if err != nil {
		return nil, err
	}

	var userIDs []uuid.UUID
	for _, key := range keys {
		// Extract user ID from key (typing:channelID:userID)
		var userID uuid.UUID
		_, err := fmt.Sscanf(key, "typing:"+channelID.String()+":%s", &userID)
		if err == nil {
			userIDs = append(userIDs, userID)
		}
	}

	return userIDs, nil
}

func (s *RedisStore) GetOnlineUsers(ctx context.Context, channelID uuid.UUID) ([]uuid.UUID, error) {
	// This would require maintaining a set of online users per channel
	// For simplicity, we'll use a different approach in production
	key := fmt.Sprintf("channel:online:%s", channelID)
	members, err := s.client.SMembers(ctx, key).Result()
	if err != nil {
		return nil, err
	}

	var userIDs []uuid.UUID
	for _, member := range members {
		userID, err := uuid.Parse(member)
		if err == nil {
			userIDs = append(userIDs, userID)
		}
	}

	return userIDs, nil
}

func (s *RedisStore) AddOnlineUser(ctx context.Context, channelID, userID uuid.UUID) error {
	key := fmt.Sprintf("channel:online:%s", channelID)
	return s.client.SAdd(ctx, key, userID.String()).Err()
}

func (s *RedisStore) RemoveOnlineUser(ctx context.Context, channelID, userID uuid.UUID) error {
	key := fmt.Sprintf("channel:online:%s", channelID)
	return s.client.SRem(ctx, key, userID.String()).Err()
}

// Rate limiting

func (s *RedisStore) CheckRateLimit(ctx context.Context, key string, limit int, window time.Duration) (bool, error) {
	now := time.Now().Unix()
	windowStart := now - int64(window.Seconds())

	pipe := s.client.Pipeline()

	// Remove old entries
	pipe.ZRemRangeByScore(ctx, key, "0", fmt.Sprintf("%d", windowStart))

	// Count current entries
	countCmd := pipe.ZCard(ctx, key)

	// Add current request
	pipe.ZAdd(ctx, key, redis.Z{
		Score:  float64(now),
		Member: fmt.Sprintf("%d", now),
	})

	// Set expiry
	pipe.Expire(ctx, key, window)

	_, err := pipe.Exec(ctx)
	if err != nil {
		return false, err
	}

	count := countCmd.Val()
	return count < int64(limit), nil
}

// Session management

func (s *RedisStore) SetSession(ctx context.Context, sessionID string, userID uuid.UUID, expiration time.Duration) error {
	key := fmt.Sprintf("session:%s", sessionID)
	return s.client.Set(ctx, key, userID.String(), expiration).Err()
}

func (s *RedisStore) GetSession(ctx context.Context, sessionID string) (*uuid.UUID, error) {
	key := fmt.Sprintf("session:%s", sessionID)
	val, err := s.client.Get(ctx, key).Result()
	if err == redis.Nil {
		return nil, fmt.Errorf("session not found")
	}
	if err != nil {
		return nil, err
	}

	userID, err := uuid.Parse(val)
	if err != nil {
		return nil, fmt.Errorf("invalid session data")
	}

	return &userID, nil
}

func (s *RedisStore) DeleteSession(ctx context.Context, sessionID string) error {
	key := fmt.Sprintf("session:%s", sessionID)
	return s.client.Del(ctx, key).Err()
}

// Caching

func (s *RedisStore) CacheMessage(ctx context.Context, channelID uuid.UUID, message any) error {
	// Cache latest messages for quick retrieval
	// key := fmt.Sprintf("cache:messages:%s", channelID)
	// Implementation depends on your caching strategy
	return nil
}
