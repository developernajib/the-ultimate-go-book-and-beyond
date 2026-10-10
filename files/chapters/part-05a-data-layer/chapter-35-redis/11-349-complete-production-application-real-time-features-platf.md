## 35.9 Complete Production Application: Real-Time Features Platform

This section assembles the patterns from earlier in the chapter into a production-ready application with caching, leaderboards, rate limiting, session management, and real-time events - all backed by Redis.

### Project Structure

The directory layout below reflects a clean separation of concerns: commands and entry points live under `cmd/`, reusable packages under `internal/`, and public APIs under `pkg/`. This structure scales from a small tool to a production codebase by keeping each package focused on a single responsibility.

```
realtime/
├── cmd/
│   └── server/
│       └── main.go
├── internal/
│   ├── cache/
│   │   ├── cache.go
│   │   └── user_cache.go
│   ├── leaderboard/
│   │   └── leaderboard.go
│   ├── ratelimit/
│   │   └── ratelimit.go
│   ├── session/
│   │   └── session.go
│   ├── pubsub/
│   │   └── events.go
│   └── queue/
│       └── jobs.go
├── Dockerfile
├── docker-compose.yml
└── Makefile
```

### Cache Service (internal/cache/cache.go)

The `Cache` struct wraps a `redis.Client` with key prefixing, JSON serialization, structured logging, and tag-based invalidation. `GetOrSet` implements the cache-aside pattern in a single call: it checks the cache, computes the value on a miss, stores it, and returns - so callers do not need to manage cache miss logic themselves. `DeleteByPattern` uses `SCAN` (not `KEYS`) to iterate matching keys without blocking the Redis server on large keyspaces.

```go
package cache

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/redis/go-redis/v9"
)

var (
	ErrCacheMiss = errors.New("cache miss")
	ErrInvalidData = errors.New("invalid cached data")
)

// Cache provides a type-safe caching layer
type Cache struct {
	rdb    *redis.Client
	logger *slog.Logger
	prefix string
}

// CacheConfig holds cache configuration
type CacheConfig struct {
	Addr         string
	Password     string
	DB           int
	PoolSize     int
	MinIdleConns int
	DialTimeout  time.Duration
	ReadTimeout  time.Duration
	WriteTimeout time.Duration
}

// NewCache creates a new cache instance
func NewCache(cfg CacheConfig, logger *slog.Logger, prefix string) (*Cache, error) {
	rdb := redis.NewClient(&redis.Options{
		Addr:         cfg.Addr,
		Password:     cfg.Password,
		DB:           cfg.DB,
		PoolSize:     cfg.PoolSize,
		MinIdleConns: cfg.MinIdleConns,
		DialTimeout:  cfg.DialTimeout,
		ReadTimeout:  cfg.ReadTimeout,
		WriteTimeout: cfg.WriteTimeout,
	})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := rdb.Ping(ctx).Err(); err != nil {
		return nil, fmt.Errorf("connecting to redis: %w", err)
	}

	return &Cache{
		rdb:    rdb,
		logger: logger,
		prefix: prefix,
	}, nil
}

// Close closes the Redis connection
func (c *Cache) Close() error {
	return c.rdb.Close()
}

// Get retrieves a value from cache
func (c *Cache) Get(ctx context.Context, key string, dest any) error {
	fullKey := c.prefix + key

	data, err := c.rdb.Get(ctx, fullKey).Bytes()
	if err == redis.Nil {
		return ErrCacheMiss
	}
	if err != nil {
		return fmt.Errorf("getting from cache: %w", err)
	}

	if err := json.Unmarshal(data, dest); err != nil {
		c.logger.Warn("invalid cached data", "key", key, "error", err)
		c.rdb.Del(ctx, fullKey) // Clean up invalid data
		return ErrInvalidData
	}

	return nil
}

// Set stores a value in cache
func (c *Cache) Set(ctx context.Context, key string, value any, ttl time.Duration) error {
	data, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("marshaling cache value: %w", err)
	}

	fullKey := c.prefix + key
	if err := c.rdb.Set(ctx, fullKey, data, ttl).Err(); err != nil {
		return fmt.Errorf("setting cache: %w", err)
	}

	return nil
}

// GetOrSet retrieves from cache or computes and stores the value
func (c *Cache) GetOrSet(ctx context.Context, key string, dest any, ttl time.Duration, compute func() (any, error)) error {
	// Try cache first
	if err := c.Get(ctx, key, dest); err == nil {
		return nil
	}

	// Compute value
	value, err := compute()
	if err != nil {
		return err
	}

	// Store in cache
	if err := c.Set(ctx, key, value, ttl); err != nil {
		c.logger.Warn("failed to cache computed value", "key", key, "error", err)
	}

	// Copy value to destination
	data, _ := json.Marshal(value)
	return json.Unmarshal(data, dest)
}

// Delete removes a value from cache
func (c *Cache) Delete(ctx context.Context, keys ...string) error {
	if len(keys) == 0 {
		return nil
	}

	fullKeys := make([]string, len(keys))
	for i, k := range keys {
		fullKeys[i] = c.prefix + k
	}

	return c.rdb.Del(ctx, fullKeys...).Err()
}

// DeleteByPattern removes all keys matching a pattern
func (c *Cache) DeleteByPattern(ctx context.Context, pattern string) error {
	fullPattern := c.prefix + pattern

	var cursor uint64
	for {
		keys, newCursor, err := c.rdb.Scan(ctx, cursor, fullPattern, 100).Result()
		if err != nil {
			return fmt.Errorf("scanning keys: %w", err)
		}

		if len(keys) > 0 {
			if err := c.rdb.Del(ctx, keys...).Err(); err != nil {
				return fmt.Errorf("deleting keys: %w", err)
			}
		}

		cursor = newCursor
		if cursor == 0 {
			break
		}
	}

	return nil
}

// SetWithTags stores a value with tags for grouped invalidation
func (c *Cache) SetWithTags(ctx context.Context, key string, value any, ttl time.Duration, tags ...string) error {
	if err := c.Set(ctx, key, value, ttl); err != nil {
		return err
	}

	// Add key to tag sets
	fullKey := c.prefix + key
	pipe := c.rdb.Pipeline()
	for _, tag := range tags {
		tagKey := c.prefix + "tag:" + tag
		pipe.SAdd(ctx, tagKey, fullKey)
		pipe.Expire(ctx, tagKey, ttl+time.Hour) // Tags expire slightly after values
	}

	_, err := pipe.Exec(ctx)
	return err
}

// InvalidateByTag removes all cached values with a specific tag
func (c *Cache) InvalidateByTag(ctx context.Context, tag string) error {
	tagKey := c.prefix + "tag:" + tag

	keys, err := c.rdb.SMembers(ctx, tagKey).Result()
	if err != nil {
		return fmt.Errorf("getting tag members: %w", err)
	}

	if len(keys) == 0 {
		return nil
	}

	pipe := c.rdb.Pipeline()
	pipe.Del(ctx, keys...)
	pipe.Del(ctx, tagKey)
	_, err = pipe.Exec(ctx)

	return err
}

// Stats returns cache statistics
func (c *Cache) Stats(ctx context.Context) (map[string]string, error) {
	info, err := c.rdb.Info(ctx, "stats", "memory").Result()
	if err != nil {
		return nil, err
	}

	stats := make(map[string]string)
	// Parse info string...
	stats["info"] = info

	return stats, nil
}
```

### Leaderboard Service (internal/leaderboard/leaderboard.go)

The leaderboard uses a Redis sorted set where each member is a user ID and the score is their point total. `ZRevRangeWithScores` retrieves the top N entries in descending order, and `ZRevRank` returns a user's position - both in O(log N) time regardless of how many entries exist. A separate hash maps user IDs to display names, fetched in bulk with `HMGet` to avoid N+1 queries when rendering the leaderboard. `GetAroundUser` shows the neighborhood around a specific player's rank, which is the standard UI pattern for "your position" views.

```go
package leaderboard

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// Entry represents a leaderboard entry
type Entry struct {
	UserID   string  `json:"user_id"`
	Username string  `json:"username"`
	Score    float64 `json:"score"`
	Rank     int64   `json:"rank"`
}

// Leaderboard manages game or application leaderboards
type Leaderboard struct {
	rdb    *redis.Client
	prefix string
}

// NewLeaderboard creates a new leaderboard manager
func NewLeaderboard(rdb *redis.Client, prefix string) *Leaderboard {
	return &Leaderboard{
		rdb:    rdb,
		prefix: prefix,
	}
}

func (l *Leaderboard) key(name string) string {
	return l.prefix + "leaderboard:" + name
}

func (l *Leaderboard) userKey(name string) string {
	return l.prefix + "leaderboard:" + name + ":users"
}

// AddScore adds or updates a user's score
func (l *Leaderboard) AddScore(ctx context.Context, name, userID string, score float64, username string) error {
	pipe := l.rdb.Pipeline()

	// Add to sorted set
	pipe.ZAdd(ctx, l.key(name), redis.Z{
		Score:  score,
		Member: userID,
	})

	// Store username mapping
	pipe.HSet(ctx, l.userKey(name), userID, username)

	_, err := pipe.Exec(ctx)
	return err
}

// IncrementScore increments a user's score
func (l *Leaderboard) IncrementScore(ctx context.Context, name, userID string, delta float64) (float64, error) {
	return l.rdb.ZIncrBy(ctx, l.key(name), delta, userID).Result()
}

// GetRank returns a user's rank (0-indexed, highest score = 0)
func (l *Leaderboard) GetRank(ctx context.Context, name, userID string) (int64, error) {
	rank, err := l.rdb.ZRevRank(ctx, l.key(name), userID).Result()
	if err == redis.Nil {
		return -1, nil // Not found
	}
	return rank, err
}

// GetScore returns a user's score
func (l *Leaderboard) GetScore(ctx context.Context, name, userID string) (float64, error) {
	return l.rdb.ZScore(ctx, l.key(name), userID).Result()
}

// GetTop returns the top N entries
func (l *Leaderboard) GetTop(ctx context.Context, name string, count int64) ([]Entry, error) {
	results, err := l.rdb.ZRevRangeWithScores(ctx, l.key(name), 0, count-1).Result()
	if err != nil {
		return nil, err
	}

	// Get usernames
	userIDs := make([]string, len(results))
	for i, r := range results {
		userIDs[i] = r.Member.(string)
	}

	usernames, err := l.rdb.HMGet(ctx, l.userKey(name), userIDs...).Result()
	if err != nil {
		return nil, err
	}

	entries := make([]Entry, len(results))
	for i, r := range results {
		username := ""
		if usernames[i] != nil {
			username = usernames[i].(string)
		}
		entries[i] = Entry{
			UserID:   r.Member.(string),
			Score:    r.Score,
			Rank:     int64(i),
			Username: username,
		}
	}

	return entries, nil
}

// GetAroundUser returns entries around a specific user
func (l *Leaderboard) GetAroundUser(ctx context.Context, name, userID string, count int64) ([]Entry, error) {
	rank, err := l.GetRank(ctx, name, userID)
	if err != nil {
		return nil, err
	}
	if rank < 0 {
		return nil, fmt.Errorf("user not found in leaderboard")
	}

	start := rank - count/2
	if start < 0 {
		start = 0
	}
	end := start + count - 1

	results, err := l.rdb.ZRevRangeWithScores(ctx, l.key(name), start, end).Result()
	if err != nil {
		return nil, err
	}

	entries := make([]Entry, len(results))
	for i, r := range results {
		entries[i] = Entry{
			UserID: r.Member.(string),
			Score:  r.Score,
			Rank:   start + int64(i),
		}
	}

	return entries, nil
}

// GetCount returns total number of entries
func (l *Leaderboard) GetCount(ctx context.Context, name string) (int64, error) {
	return l.rdb.ZCard(ctx, l.key(name)).Result()
}

// RemoveUser removes a user from the leaderboard
func (l *Leaderboard) RemoveUser(ctx context.Context, name, userID string) error {
	pipe := l.rdb.Pipeline()
	pipe.ZRem(ctx, l.key(name), userID)
	pipe.HDel(ctx, l.userKey(name), userID)
	_, err := pipe.Exec(ctx)
	return err
}

// GetPercentile returns a user's percentile (0-100)
func (l *Leaderboard) GetPercentile(ctx context.Context, name, userID string) (float64, error) {
	pipe := l.rdb.Pipeline()
	rankCmd := pipe.ZRevRank(ctx, l.key(name), userID)
	countCmd := pipe.ZCard(ctx, l.key(name))

	_, err := pipe.Exec(ctx)
	if err != nil {
		return 0, err
	}

	rank := rankCmd.Val()
	count := countCmd.Val()

	if count == 0 {
		return 0, nil
	}

	// Higher percentile = better (top 1% = 99th percentile)
	percentile := (1 - float64(rank)/float64(count)) * 100
	return percentile, nil
}
```

### Rate Limiter (internal/ratelimit/ratelimit.go)

Token bucket rate limiting in Redis uses a Lua script that reads the current token count, adds tokens accumulated since the last check based on elapsed time, caps at the bucket maximum, deducts one token for the current request, and stores the new count, all atomically in a single round trip. The sliding window counter variant stores per-second buckets in a Redis hash, increments the current second's bucket, sums all buckets within the window, and removes expired buckets using `HDEL`, providing smoother rate limiting than a fixed window with no burst at window boundaries. Per-user rate limits use a key like `ratelimit:user:42` with a TTL equal to the window duration, automatically expiring the limit counter for inactive users without a separate cleanup job.

```go
package ratelimit

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// Result contains rate limit check result
type Result struct {
	Allowed    bool
	Limit      int
	Remaining  int
	RetryAfter time.Duration
}

// RateLimiter implements multiple rate limiting algorithms
type RateLimiter struct {
	rdb    *redis.Client
	prefix string
}

// NewRateLimiter creates a new rate limiter
func NewRateLimiter(rdb *redis.Client, prefix string) *RateLimiter {
	return &RateLimiter{
		rdb:    rdb,
		prefix: prefix,
	}
}

// AllowFixedWindow implements fixed window rate limiting
func (r *RateLimiter) AllowFixedWindow(ctx context.Context, key string, limit int, window time.Duration) (*Result, error) {
	fullKey := r.prefix + "ratelimit:fw:" + key

	pipe := r.rdb.Pipeline()
	incrCmd := pipe.Incr(ctx, fullKey)
	pipe.Expire(ctx, fullKey, window)
	ttlCmd := pipe.TTL(ctx, fullKey)

	_, err := pipe.Exec(ctx)
	if err != nil {
		return nil, err
	}

	current := int(incrCmd.Val())
	ttl := ttlCmd.Val()

	result := &Result{
		Limit:     limit,
		Remaining: limit - current,
	}

	if current > limit {
		result.Allowed = false
		result.Remaining = 0
		result.RetryAfter = ttl
	} else {
		result.Allowed = true
	}

	return result, nil
}

// AllowSlidingWindow implements sliding window log rate limiting
func (r *RateLimiter) AllowSlidingWindow(ctx context.Context, key string, limit int, window time.Duration) (*Result, error) {
	fullKey := r.prefix + "ratelimit:sw:" + key
	now := time.Now()
	windowStart := now.Add(-window).UnixMilli()

	script := redis.NewScript(`
		local key = KEYS[1]
		local now = tonumber(ARGV[1])
		local window_start = tonumber(ARGV[2])
		local limit = tonumber(ARGV[3])
		local window_ms = tonumber(ARGV[4])

		-- Remove old entries
		redis.call('ZREMRANGEBYSCORE', key, '-inf', window_start)

		-- Get current count
		local count = redis.call('ZCARD', key)

		if count < limit then
			-- Add new request
			redis.call('ZADD', key, now, now .. '-' .. math.random())
			redis.call('PEXPIRE', key, window_ms)
			return {1, limit - count - 1, 0}
		else
			-- Get oldest entry to calculate retry time
			local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
			local retry_after = 0
			if oldest[2] then
				retry_after = window_ms - (now - tonumber(oldest[2]))
			end
			return {0, 0, retry_after}
		end
	`)

	result, err := script.Run(ctx, r.rdb, []string{fullKey},
		now.UnixMilli(), windowStart, limit, window.Milliseconds()).Slice()
	if err != nil {
		return nil, err
	}

	allowed := result[0].(int64) == 1
	remaining := int(result[1].(int64))
	retryAfterMs := result[2].(int64)

	return &Result{
		Allowed:    allowed,
		Limit:      limit,
		Remaining:  remaining,
		RetryAfter: time.Duration(retryAfterMs) * time.Millisecond,
	}, nil
}

// AllowTokenBucket implements token bucket rate limiting
func (r *RateLimiter) AllowTokenBucket(ctx context.Context, key string, capacity int, refillRate float64, tokens int) (*Result, error) {
	fullKey := r.prefix + "ratelimit:tb:" + key

	script := redis.NewScript(`
		local key = KEYS[1]
		local capacity = tonumber(ARGV[1])
		local refill_rate = tonumber(ARGV[2])
		local now = tonumber(ARGV[3])
		local requested = tonumber(ARGV[4])

		local bucket = redis.call('HMGET', key, 'tokens', 'last_update')
		local current_tokens = tonumber(bucket[1]) or capacity
		local last_update = tonumber(bucket[2]) or now

		-- Calculate refill
		local elapsed = (now - last_update) / 1000
		local refill = elapsed * refill_rate
		current_tokens = math.min(capacity, current_tokens + refill)

		-- Try to consume tokens
		local allowed = 0
		local remaining = current_tokens

		if current_tokens >= requested then
			current_tokens = current_tokens - requested
			allowed = 1
			remaining = current_tokens
		end

		-- Update bucket
		redis.call('HMSET', key, 'tokens', current_tokens, 'last_update', now)
		redis.call('EXPIRE', key, 3600)

		-- Calculate retry time if not allowed
		local retry_after = 0
		if allowed == 0 then
			retry_after = (requested - current_tokens) / refill_rate * 1000
		end

		return {allowed, remaining, retry_after}
	`)

	result, err := script.Run(ctx, r.rdb, []string{fullKey},
		capacity, refillRate, time.Now().UnixMilli(), tokens).Slice()
	if err != nil {
		return nil, err
	}

	allowed := result[0].(int64) == 1
	remaining := int(result[1].(int64))
	retryAfterMs := result[2].(int64)

	return &Result{
		Allowed:    allowed,
		Limit:      capacity,
		Remaining:  remaining,
		RetryAfter: time.Duration(retryAfterMs) * time.Millisecond,
	}, nil
}
```

### Session Store (internal/session/session.go)

The session store keeps user sessions in Redis with automatic expiration. Each session is stored as a JSON-serialized string keyed by a cryptographically random session ID. A separate Redis set per user tracks all of that user's active session IDs, enabling "log out everywhere" with a single `DeleteAllForUser` call. Session IDs are generated from 32 bytes of `crypto/rand`, base64-encoded, producing 256 bits of entropy - sufficient to prevent brute-force session guessing.

```go
package session

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

var ErrSessionNotFound = errors.New("session not found")

// Session represents a user session
type Session struct {
	ID        string                 `json:"id"`
	UserID    string                 `json:"user_id"`
	Data      map[string]any `json:"data"`
	CreatedAt time.Time              `json:"created_at"`
	ExpiresAt time.Time              `json:"expires_at"`
}

// Store manages sessions in Redis
type Store struct {
	rdb    *redis.Client
	prefix string
	ttl    time.Duration
}

// NewStore creates a new session store
func NewStore(rdb *redis.Client, prefix string, ttl time.Duration) *Store {
	return &Store{
		rdb:    rdb,
		prefix: prefix,
		ttl:    ttl,
	}
}

func (s *Store) key(sessionID string) string {
	return s.prefix + "session:" + sessionID
}

func (s *Store) userKey(userID string) string {
	return s.prefix + "user_sessions:" + userID
}

// Create creates a new session
func (s *Store) Create(ctx context.Context, userID string, data map[string]any) (*Session, error) {
	sessionID, err := generateSessionID()
	if err != nil {
		return nil, fmt.Errorf("generating session ID: %w", err)
	}

	now := time.Now()
	session := &Session{
		ID:        sessionID,
		UserID:    userID,
		Data:      data,
		CreatedAt: now,
		ExpiresAt: now.Add(s.ttl),
	}

	sessionData, err := json.Marshal(session)
	if err != nil {
		return nil, fmt.Errorf("marshaling session: %w", err)
	}

	pipe := s.rdb.Pipeline()
	pipe.Set(ctx, s.key(sessionID), sessionData, s.ttl)
	pipe.SAdd(ctx, s.userKey(userID), sessionID)
	pipe.Expire(ctx, s.userKey(userID), s.ttl+time.Hour)

	_, err = pipe.Exec(ctx)
	if err != nil {
		return nil, fmt.Errorf("storing session: %w", err)
	}

	return session, nil
}

// Get retrieves a session by ID
func (s *Store) Get(ctx context.Context, sessionID string) (*Session, error) {
	data, err := s.rdb.Get(ctx, s.key(sessionID)).Bytes()
	if err == redis.Nil {
		return nil, ErrSessionNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("getting session: %w", err)
	}

	var session Session
	if err := json.Unmarshal(data, &session); err != nil {
		return nil, fmt.Errorf("unmarshaling session: %w", err)
	}

	return &session, nil
}

// Update updates session data
func (s *Store) Update(ctx context.Context, sessionID string, data map[string]any) error {
	session, err := s.Get(ctx, sessionID)
	if err != nil {
		return err
	}

	// Merge data
	for k, v := range data {
		session.Data[k] = v
	}

	sessionData, err := json.Marshal(session)
	if err != nil {
		return fmt.Errorf("marshaling session: %w", err)
	}

	ttl := time.Until(session.ExpiresAt)
	if ttl <= 0 {
		return ErrSessionNotFound
	}

	return s.rdb.Set(ctx, s.key(sessionID), sessionData, ttl).Err()
}

// Refresh extends the session TTL
func (s *Store) Refresh(ctx context.Context, sessionID string) error {
	session, err := s.Get(ctx, sessionID)
	if err != nil {
		return err
	}

	session.ExpiresAt = time.Now().Add(s.ttl)

	sessionData, err := json.Marshal(session)
	if err != nil {
		return fmt.Errorf("marshaling session: %w", err)
	}

	return s.rdb.Set(ctx, s.key(sessionID), sessionData, s.ttl).Err()
}

// Delete removes a session
func (s *Store) Delete(ctx context.Context, sessionID string) error {
	session, err := s.Get(ctx, sessionID)
	if err != nil {
		return err
	}

	pipe := s.rdb.Pipeline()
	pipe.Del(ctx, s.key(sessionID))
	pipe.SRem(ctx, s.userKey(session.UserID), sessionID)
	_, err = pipe.Exec(ctx)

	return err
}

// DeleteAllForUser removes all sessions for a user
func (s *Store) DeleteAllForUser(ctx context.Context, userID string) error {
	sessionIDs, err := s.rdb.SMembers(ctx, s.userKey(userID)).Result()
	if err != nil {
		return fmt.Errorf("getting user sessions: %w", err)
	}

	if len(sessionIDs) == 0 {
		return nil
	}

	keys := make([]string, len(sessionIDs)+1)
	for i, id := range sessionIDs {
		keys[i] = s.key(id)
	}
	keys[len(sessionIDs)] = s.userKey(userID)

	return s.rdb.Del(ctx, keys...).Err()
}

func generateSessionID() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.URLEncoding.EncodeToString(b), nil
}
```

### Junior to FAANG: how to read this platform and where to start contributing

This is not one application, it is five services sharing one Redis. Each package in `internal/` is a Redis pattern you already saw earlier in the chapter, now wrapped in a Go type with a constructor, a prefix, and method-level context. Read the code in this order: cache, session, leaderboard, ratelimit, then the pubsub and queue packages you will build in later sections. Do not try to hold all five in your head at once.

Prerequisites you need solid. The `redis.Client` pool: what `PoolSize` and `MinIdleConns` actually do (pre-opened TCP connections, avoids cold-start latency on the first request). Context propagation: every Redis call here takes a `ctx`, and a canceled ctx cancels the in-flight Redis call. JSON marshalling in `Cache.Get`: when `json.Unmarshal` fails we delete the key because corrupt cache is worse than cache miss. Pipelines in `SetWithTags`, `AddScore`, `DeleteAllForUser`: each one is a round trip saver, find all pipelines in this file and count the commands per flush.

Worked example. A new engineer is asked to add "rooms online" counters to the platform. The senior on the team says "use a hyperloglog keyed by room, increment on presence events, read on the dashboard." You add a `presence` package next to `leaderboard`, construct it with a prefix, and write `PFAdd` on user-joined and `PFCount` on read. You add tests that use `miniredis` so unit tests run without a container. That is a contribution shaped like the rest of the codebase.

First-job context and common questions. Why `SCAN` and not `KEYS` in `DeleteByPattern`? `KEYS` scans the entire keyspace and blocks the single Redis thread for the duration, which can be many seconds on a large instance and cause a production incident. `SCAN` is cursor-based, returns in bounded time per call, and is safe on live instances. Why a prefix on every service? Because multiple services share one Redis in many deployments and prefixes provide namespace isolation without running separate databases or instances. Why 32 bytes in `generateSessionID`? 256 bits of entropy makes brute-force session guessing computationally infeasible, even for a nation-state.

Interview entry point. "Walk me through this codebase and tell me what I would change." Good answers: add a circuit breaker so Redis outages degrade gracefully, add singleflight to `GetOrSet` so cache misses do not thunder the origin, add tracing spans around every pipeline, make `SetWithTags` atomic with a Lua script, add structured metrics per method. Mention each and pick one to discuss deeply. Interviewers want to see design judgment, not a list.

### Senior at FAANG: what this platform misses, where it breaks at scale, and the ADR moves

Single Redis is a single point of failure. Everything in this chapter talks to one `redis.Client`. At low scale this is fine. At production scale you want separation of concerns: cache on one instance (eviction enabled, `allkeys-lru`), session on another (no eviction, persistent, AOF every second), rate limiting on a third (small, replicated), streams on a fourth (large memory, AOF, no eviction), pubsub on a fifth. The reason is blast radius. A hot cache workload that pushes `maxmemory` eviction will evict your sessions if they share an instance. Users are logged out at random. This is the kind of outage that reaches the postmortem stage. Instance separation prevents it and costs only the per-instance overhead.

Cluster shape. For a single-tenant product at small scale, one Redis primary with one replica is enough. At medium scale, separate instances per data domain as above. At large scale you move the cache instance to Redis Cluster (dozens of shards) and keep the others single-primary. Sessions scale vertically for a long time (one million active sessions is 2 to 4 GB of memory). Leaderboards scale vertically unless you have millions of independent leaderboards. Streams scale by sharding with hash tags. The rule: shard only the domains whose working set exceeds a node, keep the others simple.

Cache stampede. `GetOrSet` as written has a classic stampede bug. If 1000 requests hit the same missing key simultaneously, 1000 calls to `compute()` run, 1000 writes hit the cache. The fix is singleflight in the Go process (the `golang.org/x/sync/singleflight` package) so only one computation runs per key per process, combined with a probabilistic early-expiration to avoid all processes recomputing at the same instant. Senior engineers add both. The ADR for the cache states the stampede strategy explicitly.

Cache coherence. There is no cache invalidation here beyond TTL and tags. Real systems invalidate on write: the writer publishes an invalidation event, every cache instance on every replica subscribes and drops the key. This closes the staleness window from "TTL" (can be seconds to minutes) to "propagation time" (milliseconds). The event bus for this is Pub/Sub because we already established that cache invalidation is the canonical Pub/Sub use case.

Leaderboard at scale. A sorted set with 10 million members and 10k updates per second is fine on one node. At 100 million members or 100k updates per second you start hitting CPU limits on the single Redis thread serving that slot. Shard leaderboards by partition key, merge at read time. Alternatively, compute leaderboards out of band (a batch job reads events from a stream and rewrites the sorted set) so writes do not compete with reads. For global, frequently-updated leaderboards at massive scale, Redis is probably the wrong primitive, reach for a purpose-built ranking system or Apache Pinot.

Session safety. The session store as written has no CSRF protection story, no session fixation protection (regenerate session ID on privilege change), no secure cookie attribute enforcement (that is at the HTTP layer, but the session library should enforce invariants about how its ID is transported). Senior review would add: regenerate on login, expire on password change, track device fingerprint and IP to detect session hijack, rate limit `DeleteAllForUser` because an attacker who gains one session should not be able to invalidate all other sessions cheaply.

Rate limiter fairness. The token bucket here is keyed by one string. The section earlier covered tier hierarchies. Production deploy of this platform needs all four tiers. Also, the script reads the system clock via `now` passed from Go. Replace with `redis.call("TIME")` inside the Lua so every replica sees a consistent clock.

Observability. Add the following per service: operation counters labeled by method, histograms of Redis round trip time, cache hit ratio with a target SLO, session creation and deletion rates, rate-limit reject rates per tier, stream lag metrics. Without these numbers you cannot answer "is Redis healthy" at 3 AM.

Staff ADR for the platform. The ADR must address: (1) blast radius per data domain and justify the instance layout, (2) failure behavior for each dependency (cache miss on Redis-down fails open and hits the origin, session miss fails closed and logs the user out, rate limit miss fails open for availability), (3) data durability requirements per domain (cache ephemeral, session durable with AOF, leaderboard rebuild-from-source-of-truth acceptable), (4) backup and restore story per instance, (5) capacity model with growth projections, (6) migration path if any domain outgrows Redis (sessions to Postgres, leaderboards to Pinot, streams to Kafka). A platform without all six in the ADR will be rebuilt under duress within three years.

---
