## 27.9 Complete Production Idempotency Framework

This section presents a production-ready idempotency framework that integrates all the patterns discussed above into a cohesive system.

### Project Structure

The framework is partitioned into four domain-focused internal packages, `idempotency` (key management, storage, HTTP middleware, gRPC interceptor), `outbox` (transactional message publishing), `saga` (durable orchestration), and `dedup` (event deduplication), with a shared `pkg/retry` utility and a `cmd/server` entry point that assembles them into a running service. This separation means each idempotency concern can be adopted incrementally: a team can start with just the HTTP middleware and add the outbox or saga patterns later without refactoring the existing code.

```
idempotency-framework/
├── cmd/
│   └── server/
│       └── main.go
├── internal/
│   ├── idempotency/
│   │   ├── key.go
│   │   ├── store.go
│   │   ├── middleware.go
│   │   └── grpc.go
│   ├── outbox/
│   │   ├── repository.go
│   │   ├── publisher.go
│   │   └── worker.go
│   ├── saga/
│   │   ├── orchestrator.go
│   │   ├── step.go
│   │   └── persistence.go
│   ├── dedup/
│   │   ├── store.go
│   │   └── processor.go
│   └── api/
│       ├── handlers.go
│       └── routes.go
├── pkg/
│   └── retry/
│       └── retry.go
├── migrations/
│   └── 001_create_tables.sql
├── Dockerfile
├── docker-compose.yml
├── Makefile
└── go.mod
```

### internal/idempotency/key.go - Key Management

`key.go` defines the `Key` type and the `KeyBuilder` that constructs composite storage keys from a client-supplied raw key, optional user ID, and HTTP method and path, scoping the key to the caller and the endpoint so one tenant's `order-1` cannot collide with another's.

The SHA-256 body hash is computed here too, but it is deliberately **not** part of the composite key. It travels as a fingerprint, stored beside the response and compared on replay by `VerifyFingerprint`, so that a key reused with a different body is rejected with a `400` instead of being replayed or, far worse, executed as a new request. The distinction is the difference between a working idempotency layer and one that double-charges, and it is explained in full in section 27.2. The `KeyMetadata` struct tracks status transitions (`pending` → `completed`/`failed`), retry count, and expiry, giving operators a full audit trail of how many times a key was used before the framework returned a cached response.

> **This framework shipped both halves of the bug.** `buildCompositeKey` appended `key.BodyHash` to the composite, so a reused key with a different body produced a different storage key, missed the cache, and ran the operation again. Meanwhile `RequestHash` was faithfully computed, stored on every record, and **never once compared to anything**, and `ErrKeyMismatch` was declared, documented, wired into `handleError` with a `400` mapping, and never returned by any code path. Everything needed for the correct behavior was present except the four lines that use it.
>
> That combination is worth recognizing because it is how this bug survives review. A reader sees `RequestHash` in the struct, sees `ErrKeyMismatch` in the error list, sees a `400` case in the error handler, and concludes the fingerprint rule is implemented. Grep for a *read* of `RequestHash`, and there isn't one. **A field that is only ever written is not a feature, it is a rumor.** When you audit an idempotency implementation, do not check that the fingerprint is stored. Check that something compares it, and that a test proves the comparison fails a mismatched body.

```go
package idempotency

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
)

var (
	// ErrInvalidKey is returned when the idempotency key format is invalid
	ErrInvalidKey = errors.New("invalid idempotency key format")
	// ErrKeyTooLong is returned when the key exceeds maximum length
	ErrKeyTooLong = errors.New("idempotency key exceeds maximum length")
	// ErrKeyRequired is returned when a key is required but not provided
	ErrKeyRequired = errors.New("idempotency key is required for this operation")

	// keyRegex validates key format: alphanumeric, dashes, underscores, max 255 chars
	keyRegex = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,255}$`)
)

const (
	// MaxKeyLength is the maximum allowed length for an idempotency key
	MaxKeyLength = 255
	// DefaultKeyTTL is the default time-to-live for idempotency keys
	DefaultKeyTTL = 24 * time.Hour
	// MaxKeyTTL is the maximum allowed TTL for idempotency keys
	MaxKeyTTL = 7 * 24 * time.Hour
)

// KeyConfig holds configuration for idempotency key handling
type KeyConfig struct {
	// RequireKey requires clients to provide idempotency keys
	RequireKey bool
	// StrictValidation enables strict key format validation
	StrictValidation bool
	// IncludeBodyHash includes request body hash in the composite key
	IncludeBodyHash bool
	// IncludeUserID includes user ID in the composite key for isolation
	IncludeUserID bool
	// TTL is the time-to-live for stored responses
	TTL time.Duration
	// LockTTL is the time-to-live for locks during processing
	LockTTL time.Duration
	// Namespace is an optional namespace prefix for keys
	Namespace string
}

// DefaultKeyConfig returns the default key configuration
func DefaultKeyConfig() *KeyConfig {
	return &KeyConfig{
		RequireKey:       false,
		StrictValidation: true,
		IncludeBodyHash:  true,
		IncludeUserID:    true,
		TTL:              DefaultKeyTTL,
		LockTTL:          5 * time.Minute,
		Namespace:        "",
	}
}

// Key represents a validated idempotency key
type Key struct {
	// Raw is the original key provided by the client
	Raw string
	// Composite is the full key used for storage (includes hashes, namespace)
	Composite string
	// Namespace is the key namespace
	Namespace string
	// UserID is the associated user ID (if applicable)
	UserID string
	// BodyHash is the hash of the request body
	BodyHash string
	// Method is the HTTP method
	Method string
	// Path is the request path
	Path string
	// CreatedAt is when the key was created
	CreatedAt time.Time
	// ExpiresAt is when the key expires
	ExpiresAt time.Time
}

// KeyBuilder builds composite idempotency keys
type KeyBuilder struct {
	config *KeyConfig
}

// NewKeyBuilder creates a new key builder with the given configuration
func NewKeyBuilder(config *KeyConfig) *KeyBuilder {
	if config == nil {
		config = DefaultKeyConfig()
	}
	return &KeyBuilder{config: config}
}

// Build creates a Key from the provided components
func (b *KeyBuilder) Build(rawKey, method, path, userID string, body []byte) (*Key, error) {
	// Validate raw key
	if err := b.validateRawKey(rawKey); err != nil {
		return nil, err
	}

	// Build key components
	key := &Key{
		Raw:       rawKey,
		Method:    method,
		Path:      path,
		UserID:    userID,
		Namespace: b.config.Namespace,
		CreatedAt: time.Now(),
		ExpiresAt: time.Now().Add(b.config.TTL),
	}

	// Calculate body hash if enabled
	if b.config.IncludeBodyHash && len(body) > 0 {
		key.BodyHash = b.hashBody(body)
	}

	// Build composite key
	key.Composite = b.buildCompositeKey(key)

	return key, nil
}

// GenerateKey generates a new random idempotency key
func (b *KeyBuilder) GenerateKey() string {
	return uuid.New().String()
}

// validateRawKey validates the raw key format
func (b *KeyBuilder) validateRawKey(key string) error {
	if key == "" {
		if b.config.RequireKey {
			return ErrKeyRequired
		}
		return nil
	}

	if len(key) > MaxKeyLength {
		return ErrKeyTooLong
	}

	if b.config.StrictValidation && !keyRegex.MatchString(key) {
		return ErrInvalidKey
	}

	return nil
}

// hashBody creates a SHA256 hash of the request body
func (b *KeyBuilder) hashBody(body []byte) string {
	h := sha256.Sum256(body)
	// Use first 16 bytes (32 hex chars) for brevity
	return hex.EncodeToString(h[:16])
}

// buildCompositeKey creates the full storage key
func (b *KeyBuilder) buildCompositeKey(key *Key) string {
	parts := make([]string, 0, 6)

	// Add namespace if configured
	if key.Namespace != "" {
		parts = append(parts, key.Namespace)
	}

	// Add user ID if configured and present
	if b.config.IncludeUserID && key.UserID != "" {
		parts = append(parts, "user", key.UserID)
	}

	// Add method and path
	parts = append(parts, key.Method, sanitizePath(key.Path))

	// Add raw key
	parts = append(parts, key.Raw)

	// NOTE: key.BodyHash is deliberately NOT part of the composite key.
	// Folding it in would make a reused key with a different body miss the
	// cache and execute as a brand new request, which is a double charge.
	// The body hash is a FINGERPRINT: it is stored alongside the response
	// and compared on replay. See VerifyFingerprint below.

	return strings.Join(parts, ":")
}

// VerifyFingerprint reports whether a stored response came from a request
// identical to this one. A false result means the client reused the key with
// different parameters and must receive a 400, never a replayed response.
func (k *Key) VerifyFingerprint(stored string) bool {
	// Constant-time compare: the fingerprint is not a secret, but this costs
	// nothing and keeps the habit intact for the places where it matters.
	return subtle.ConstantTimeCompare([]byte(k.BodyHash), []byte(stored)) == 1
}

// sanitizePath removes query strings and normalizes the path
func sanitizePath(path string) string {
	// Remove query string
	if idx := strings.Index(path, "?"); idx != -1 {
		path = path[:idx]
	}
	// Remove trailing slashes
	path = strings.TrimRight(path, "/")
	// Replace slashes with colons for key compatibility
	path = strings.ReplaceAll(path, "/", ":")
	return path
}

// ParseKey attempts to parse a composite key back into its components
func ParseKey(composite string) (*Key, error) {
	parts := strings.Split(composite, ":")

	if len(parts) < 3 {
		return nil, ErrInvalidKey
	}

	key := &Key{
		Composite: composite,
	}

	// The raw key is typically the last or second-to-last component
	// This is a best-effort parse and may not recover all components
	key.Raw = parts[len(parts)-1]

	return key, nil
}

// KeyMetadata stores additional information about an idempotency key
type KeyMetadata struct {
	// Key is the idempotency key
	Key string `json:"key"`
	// Status is the current status of the request
	Status KeyStatus `json:"status"`
	// CreatedAt is when the key was first used
	CreatedAt time.Time `json:"created_at"`
	// CompletedAt is when the request completed (if applicable)
	CompletedAt *time.Time `json:"completed_at,omitempty"`
	// ExpiresAt is when the key expires
	ExpiresAt time.Time `json:"expires_at"`
	// RequestHash is a hash of the original request
	RequestHash string `json:"request_hash,omitempty"`
	// ResponseStatus is the HTTP status of the stored response
	ResponseStatus int `json:"response_status,omitempty"`
	// RetryCount tracks how many times this key has been used
	RetryCount int `json:"retry_count"`
	// LastRetryAt is the timestamp of the last retry attempt
	LastRetryAt *time.Time `json:"last_retry_at,omitempty"`
}

// KeyStatus represents the current status of an idempotency key
type KeyStatus string

const (
	// KeyStatusPending indicates the request is being processed
	KeyStatusPending KeyStatus = "pending"
	// KeyStatusCompleted indicates the request completed successfully
	KeyStatusCompleted KeyStatus = "completed"
	// KeyStatusFailed indicates the request failed
	KeyStatusFailed KeyStatus = "failed"
	// KeyStatusExpired indicates the key has expired
	KeyStatusExpired KeyStatus = "expired"
)

// KeyStats holds statistics about idempotency key usage
type KeyStats struct {
	// TotalKeys is the total number of keys in storage
	TotalKeys int64 `json:"total_keys"`
	// ActiveKeys is the number of keys with pending status
	ActiveKeys int64 `json:"active_keys"`
	// CompletedKeys is the number of completed requests
	CompletedKeys int64 `json:"completed_keys"`
	// FailedKeys is the number of failed requests
	FailedKeys int64 `json:"failed_keys"`
	// ReplayedRequests is the number of replayed responses
	ReplayedRequests int64 `json:"replayed_requests"`
	// AverageKeyAge is the average age of keys in storage
	AverageKeyAge time.Duration `json:"average_key_age"`
}

// String returns a string representation of the key
func (k *Key) String() string {
	return fmt.Sprintf("Key{raw=%s, composite=%s, expires=%s}",
		k.Raw, k.Composite, k.ExpiresAt.Format(time.RFC3339))
}

// IsExpired checks if the key has expired
func (k *Key) IsExpired() bool {
	return time.Now().After(k.ExpiresAt)
}

// RemainingTTL returns the remaining time-to-live for the key
func (k *Key) RemainingTTL() time.Duration {
	remaining := time.Until(k.ExpiresAt)
	if remaining < 0 {
		return 0
	}
	return remaining
}
```

### internal/idempotency/store.go - Multi-Backend Store

The `Store` interface defines a pluggable storage contract, get, set, delete, lock, and metadata operations, so the framework can run against Redis for low-latency microservices or PostgreSQL for services that already have a relational database and want transactional consistency. `Lock` implements distributed mutual exclusion so that concurrent retries for the same key during processing do not result in duplicate execution. Callers that cannot acquire the lock receive `ErrRequestInProgress` and should retry after a short backoff.

`Lock` returns a `Lease` rather than a bare `bool`, and that shape is load-bearing. A distributed lock needs an ownership token, because a holder that stalls past its TTL must not be able to delete the lock that has since been handed to someone else. The token has to live with the caller that acquired it. The moment it is parked somewhere shared, the next holder overwrites it, and the ownership check that the token exists to perform starts comparing the wrong values. Handing the caller a `Lease` makes ownership something you hold rather than something you look up.

> **The two backends did not provide the same guarantee, and the interface hid it.** The `Store` contract says `Lock` takes a `ttl`. Redis honors it. The PostgreSQL implementation called `pg_try_advisory_lock`, which has no TTL at all, and silently dropped the argument on the floor. That alone is an abstraction leaking a promise one backend cannot keep, but the advisory lock was wrong in two further ways. Advisory locks are scoped to a *session*, while `*sql.DB` is a connection *pool*: the `Unlock` could run on a different connection than the `Lock` did, release nothing, return a nil error, and leak the lock for the life of that connection. And advisory locks are re-entrant within a session, so two same-key requests served by the same pooled connection were **both** told they had acquired it, which is the exact opposite of the guarantee.
>
> Backing the lock with a row that has an `expires_at` column and a token fixes all three at once, because the row can express what the interface actually promises. **When one implementation of an interface cannot honor the contract, the bug is not in that implementation, it is in the contract.** Either every backend keeps the promise or the promise does not belong in the interface.

```go
package idempotency

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

var (
	// ErrResponseNotFound is returned when no stored response exists for a key
	ErrResponseNotFound = errors.New("response not found for idempotency key")
	// ErrLockNotAcquired is returned when a lock cannot be acquired
	ErrLockNotAcquired = errors.New("could not acquire lock for idempotency key")
	// ErrRequestInProgress is returned when a request is already being processed
	ErrRequestInProgress = errors.New("request with this idempotency key is already in progress")
	// ErrKeyMismatch is returned when the request doesn't match the stored key data
	ErrKeyMismatch = errors.New("request parameters do not match original request for this key")
)

// StoredResponse represents a cached response
type StoredResponse struct {
	// StatusCode is the HTTP status code
	StatusCode int `json:"status_code"`
	// Headers are the response headers
	Headers map[string]string `json:"headers"`
	// Body is the response body
	Body []byte `json:"body"`
	// CreatedAt is when the response was stored
	CreatedAt time.Time `json:"created_at"`
	// RequestHash is a hash of the original request for verification
	RequestHash string `json:"request_hash"`
}

// Store defines the interface for idempotency storage backends
type Store interface {
	// Get retrieves a stored response by key
	Get(ctx context.Context, key string) (*StoredResponse, error)
	// Set stores a response with the given TTL
	Set(ctx context.Context, key string, response *StoredResponse, ttl time.Duration) error
	// Delete removes a stored response
	Delete(ctx context.Context, key string) error
	// Lock attempts to acquire a distributed lock for a key. A nil Lease with
	// a nil error means the lock is currently held by someone else.
	Lock(ctx context.Context, key string, ttl time.Duration) (Lease, error)
	// GetMetadata retrieves key metadata
	GetMetadata(ctx context.Context, key string) (*KeyMetadata, error)
	// SetMetadata updates key metadata
	SetMetadata(ctx context.Context, key string, metadata *KeyMetadata) error
	// IncrementRetryCount increments the retry counter for a key
	IncrementRetryCount(ctx context.Context, key string) error
	// Stats returns storage statistics
	Stats(ctx context.Context) (*KeyStats, error)
	// Cleanup removes expired entries
	Cleanup(ctx context.Context) (int64, error)
	// Close closes the store connection
	Close() error
}

// Lease is proof that this caller, and no other, holds a lock. Release is the
// only way to give the lock back.
//
// The ownership token has to travel with the caller. Park it anywhere shared,
// a server-side hash, a field on the store, and the next holder overwrites it,
// after which a stalled process wakes up and releases a lock it no longer owns.
// The lock then has two holders and the operation it guards runs twice. This is
// the reason Lock hands back a value instead of returning a bare bool.
type Lease interface {
	// Release gives the lock back, but only if this lease still owns it. A
	// lease whose TTL lapsed and was taken over by someone else releases
	// nothing, which is exactly what we want.
	Release(ctx context.Context) error
}

// RedisStore implements Store using Redis
type RedisStore struct {
	client       *redis.Client
	prefix       string
	unlockScript *redis.Script
}

// NewRedisStore creates a new Redis-backed idempotency store
func NewRedisStore(client *redis.Client, prefix string) *RedisStore {
	// Lua script for safe lock release. GET and DEL have to happen without
	// anything slipping between them, otherwise the lock can expire and be
	// reacquired by another process in the gap, and we delete their lock.
	unlockScript := redis.NewScript(`
		local key = KEYS[1]
		local token = ARGV[1]

		if redis.call('GET', key) == token then
			return redis.call('DEL', key)
		end
		return 0
	`)

	return &RedisStore{
		client:       client,
		prefix:       prefix,
		unlockScript: unlockScript,
	}
}

// responseKey returns the key for storing responses
func (s *RedisStore) responseKey(key string) string {
	return fmt.Sprintf("%s:response:%s", s.prefix, key)
}

// lockKey returns the key for distributed locks
func (s *RedisStore) lockKey(key string) string {
	return fmt.Sprintf("%s:lock:%s", s.prefix, key)
}

// metadataKey returns the key for storing metadata
func (s *RedisStore) metadataKey(key string) string {
	return fmt.Sprintf("%s:metadata:%s", s.prefix, key)
}

// Get retrieves a stored response
func (s *RedisStore) Get(ctx context.Context, key string) (*StoredResponse, error) {
	data, err := s.client.Get(ctx, s.responseKey(key)).Bytes()
	if err == redis.Nil {
		return nil, ErrResponseNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get response: %w", err)
	}

	var response StoredResponse
	if err := json.Unmarshal(data, &response); err != nil {
		return nil, fmt.Errorf("failed to unmarshal response: %w", err)
	}

	return &response, nil
}

// Set stores a response with TTL
func (s *RedisStore) Set(ctx context.Context, key string, response *StoredResponse, ttl time.Duration) error {
	data, err := json.Marshal(response)
	if err != nil {
		return fmt.Errorf("failed to marshal response: %w", err)
	}

	if err := s.client.Set(ctx, s.responseKey(key), data, ttl).Err(); err != nil {
		return fmt.Errorf("failed to set response: %w", err)
	}

	return nil
}

// Delete removes a stored response
func (s *RedisStore) Delete(ctx context.Context, key string) error {
	pipe := s.client.Pipeline()
	pipe.Del(ctx, s.responseKey(key))
	pipe.Del(ctx, s.metadataKey(key))
	pipe.Del(ctx, s.lockKey(key))

	_, err := pipe.Exec(ctx)
	return err
}

// redisLease holds the token proving ownership of one Redis lock.
type redisLease struct {
	store *RedisStore
	key   string
	token string
}

// Release deletes the lock only if it still carries our token.
func (l *redisLease) Release(ctx context.Context) error {
	err := l.store.unlockScript.Run(ctx, l.store.client, []string{l.store.lockKey(l.key)}, l.token).Err()
	if err != nil && err != redis.Nil {
		return fmt.Errorf("failed to release lock: %w", err)
	}
	return nil
}

// Lock attempts to acquire a distributed lock. SET with NX and PX is a single
// atomic check-and-set: the key is written only if it does not already exist,
// and it carries an expiry from the moment it is written, so a holder that dies
// cannot wedge the key forever.
func (s *RedisStore) Lock(ctx context.Context, key string, ttl time.Duration) (Lease, error) {
	token, err := generateLockToken()
	if err != nil {
		return nil, err
	}

	ok, err := s.client.SetNX(ctx, s.lockKey(key), token, ttl).Result()
	if err != nil {
		return nil, fmt.Errorf("failed to acquire lock: %w", err)
	}
	if !ok {
		return nil, nil
	}

	return &redisLease{store: s, key: key, token: token}, nil
}

// GetMetadata retrieves key metadata
func (s *RedisStore) GetMetadata(ctx context.Context, key string) (*KeyMetadata, error) {
	data, err := s.client.Get(ctx, s.metadataKey(key)).Bytes()
	if err == redis.Nil {
		return nil, ErrResponseNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get metadata: %w", err)
	}

	var metadata KeyMetadata
	if err := json.Unmarshal(data, &metadata); err != nil {
		return nil, fmt.Errorf("failed to unmarshal metadata: %w", err)
	}

	return &metadata, nil
}

// SetMetadata updates key metadata
func (s *RedisStore) SetMetadata(ctx context.Context, key string, metadata *KeyMetadata) error {
	data, err := json.Marshal(metadata)
	if err != nil {
		return fmt.Errorf("failed to marshal metadata: %w", err)
	}

	ttl := time.Until(metadata.ExpiresAt)
	if ttl <= 0 {
		ttl = DefaultKeyTTL
	}

	return s.client.Set(ctx, s.metadataKey(key), data, ttl).Err()
}

// IncrementRetryCount increments the retry counter
func (s *RedisStore) IncrementRetryCount(ctx context.Context, key string) error {
	metadata, err := s.GetMetadata(ctx, key)
	if err != nil {
		return err
	}

	metadata.RetryCount++
	now := time.Now()
	metadata.LastRetryAt = &now

	return s.SetMetadata(ctx, key, metadata)
}

// Stats returns storage statistics
func (s *RedisStore) Stats(ctx context.Context) (*KeyStats, error) {
	stats := &KeyStats{}

	// Count keys by pattern
	var cursor uint64
	pattern := s.prefix + ":response:*"

	for {
		keys, nextCursor, err := s.client.Scan(ctx, cursor, pattern, 100).Result()
		if err != nil {
			return nil, fmt.Errorf("failed to scan keys: %w", err)
		}

		stats.TotalKeys += int64(len(keys))
		cursor = nextCursor

		if cursor == 0 {
			break
		}
	}

	// Get replayed requests counter
	replayed, _ := s.client.Get(ctx, s.prefix+":stats:replayed").Int64()
	stats.ReplayedRequests = replayed

	return stats, nil
}

// Cleanup removes expired entries
func (s *RedisStore) Cleanup(ctx context.Context) (int64, error) {
	// Redis handles TTL automatically, but we can clean up orphaned locks
	var cleaned int64
	pattern := s.prefix + ":lock:*"
	var cursor uint64

	for {
		keys, nextCursor, err := s.client.Scan(ctx, cursor, pattern, 100).Result()
		if err != nil {
			return cleaned, fmt.Errorf("failed to scan locks: %w", err)
		}

		for _, key := range keys {
			ttl, err := s.client.TTL(ctx, key).Result()
			if err != nil {
				continue
			}
			// Clean up locks with no TTL (shouldn't happen, but safety check)
			if ttl == -1 {
				s.client.Del(ctx, key)
				cleaned++
			}
		}

		cursor = nextCursor
		if cursor == 0 {
			break
		}
	}

	return cleaned, nil
}

// Close closes the Redis client
func (s *RedisStore) Close() error {
	return s.client.Close()
}

// PostgresStore implements Store using PostgreSQL
type PostgresStore struct {
	db     *sql.DB
	prefix string
}

// NewPostgresStore creates a new PostgreSQL-backed idempotency store
func NewPostgresStore(db *sql.DB, prefix string) *PostgresStore {
	return &PostgresStore{
		db:     db,
		prefix: prefix,
	}
}

// Get retrieves a stored response from PostgreSQL
func (s *PostgresStore) Get(ctx context.Context, key string) (*StoredResponse, error) {
	query := `
		SELECT status_code, headers, body, created_at, request_hash
		FROM idempotency_responses
		WHERE key = $1 AND expires_at > NOW()
	`

	var response StoredResponse
	var headersJSON []byte

	err := s.db.QueryRowContext(ctx, query, key).Scan(
		&response.StatusCode,
		&headersJSON,
		&response.Body,
		&response.CreatedAt,
		&response.RequestHash,
	)

	if err == sql.ErrNoRows {
		return nil, ErrResponseNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get response: %w", err)
	}

	if err := json.Unmarshal(headersJSON, &response.Headers); err != nil {
		return nil, fmt.Errorf("failed to unmarshal headers: %w", err)
	}

	return &response, nil
}

// Set stores a response in PostgreSQL
func (s *PostgresStore) Set(ctx context.Context, key string, response *StoredResponse, ttl time.Duration) error {
	headersJSON, err := json.Marshal(response.Headers)
	if err != nil {
		return fmt.Errorf("failed to marshal headers: %w", err)
	}

	query := `
		INSERT INTO idempotency_responses (key, status_code, headers, body, request_hash, created_at, expires_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (key) DO UPDATE SET
			status_code = EXCLUDED.status_code,
			headers = EXCLUDED.headers,
			body = EXCLUDED.body,
			request_hash = EXCLUDED.request_hash,
			created_at = EXCLUDED.created_at,
			expires_at = EXCLUDED.expires_at
	`

	_, err = s.db.ExecContext(ctx, query,
		key,
		response.StatusCode,
		headersJSON,
		response.Body,
		response.RequestHash,
		response.CreatedAt,
		time.Now().Add(ttl),
	)

	return err
}

// Delete removes a stored response
func (s *PostgresStore) Delete(ctx context.Context, key string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM idempotency_responses WHERE key = $1`, key)
	return err
}

// pgLease holds the token proving ownership of one row in idempotency_locks.
type pgLease struct {
	store *PostgresStore
	key   string
	token string
}

// Release deletes the lock row only if it still carries our token. If our TTL
// lapsed and another caller took the key over, their row has a different token
// and survives untouched.
func (l *pgLease) Release(ctx context.Context) error {
	_, err := l.store.db.ExecContext(ctx,
		`DELETE FROM idempotency_locks WHERE key = $1 AND token = $2`, l.key, l.token)
	if err != nil {
		return fmt.Errorf("failed to release lock: %w", err)
	}
	return nil
}

// Lock acquires a lock backed by a row with an explicit expiry.
//
// The obvious implementation, pg_try_advisory_lock, is wrong here twice over.
// Advisory locks are scoped to a *session*, but *sql.DB is a connection pool:
// the unlock can run on a different connection than the lock did, silently
// release nothing, and leak the lock for the life of that connection. Worse,
// advisory locks are re-entrant within a session, so two same-key requests that
// happen to be served by the same pooled connection would both be told they
// acquired it. Advisory locks also have no TTL, which the Store contract
// promises. A lock row with an expires_at column keeps all three promises.
//
// The INSERT below is a single atomic statement. The DO UPDATE fires only when
// the existing lock has already expired, so a live lock is never stolen, and
// RETURNING tells us whether the row we are looking at is ours.
func (s *PostgresStore) Lock(ctx context.Context, key string, ttl time.Duration) (Lease, error) {
	token, err := generateLockToken()
	if err != nil {
		return nil, err
	}

	const query = `
		INSERT INTO idempotency_locks (key, token, expires_at)
		VALUES ($1, $2, NOW() + $3::interval)
		ON CONFLICT (key) DO UPDATE SET
			token = EXCLUDED.token,
			expires_at = EXCLUDED.expires_at
		WHERE idempotency_locks.expires_at < NOW()
		RETURNING token
	`

	var stored string
	err = s.db.QueryRowContext(ctx, query, key, token, ttl.String()).Scan(&stored)
	if err == sql.ErrNoRows {
		// The WHERE clause held: a live lock exists and it is not ours.
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("failed to acquire lock: %w", err)
	}
	if stored != token {
		return nil, nil
	}

	return &pgLease{store: s, key: key, token: token}, nil
}

// GetMetadata retrieves key metadata
func (s *PostgresStore) GetMetadata(ctx context.Context, key string) (*KeyMetadata, error) {
	query := `
		SELECT key, status, created_at, completed_at, expires_at, request_hash, response_status, retry_count, last_retry_at
		FROM idempotency_metadata
		WHERE key = $1
	`

	var metadata KeyMetadata
	var completedAt, lastRetryAt sql.NullTime

	err := s.db.QueryRowContext(ctx, query, key).Scan(
		&metadata.Key,
		&metadata.Status,
		&metadata.CreatedAt,
		&completedAt,
		&metadata.ExpiresAt,
		&metadata.RequestHash,
		&metadata.ResponseStatus,
		&metadata.RetryCount,
		&lastRetryAt,
	)

	if err == sql.ErrNoRows {
		return nil, ErrResponseNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get metadata: %w", err)
	}

	if completedAt.Valid {
		metadata.CompletedAt = &completedAt.Time
	}
	if lastRetryAt.Valid {
		metadata.LastRetryAt = &lastRetryAt.Time
	}

	return &metadata, nil
}

// SetMetadata updates key metadata
func (s *PostgresStore) SetMetadata(ctx context.Context, key string, metadata *KeyMetadata) error {
	query := `
		INSERT INTO idempotency_metadata (key, status, created_at, completed_at, expires_at, request_hash, response_status, retry_count, last_retry_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		ON CONFLICT (key) DO UPDATE SET
			status = EXCLUDED.status,
			completed_at = EXCLUDED.completed_at,
			request_hash = EXCLUDED.request_hash,
			response_status = EXCLUDED.response_status,
			retry_count = EXCLUDED.retry_count,
			last_retry_at = EXCLUDED.last_retry_at
	`

	_, err := s.db.ExecContext(ctx, query,
		metadata.Key,
		metadata.Status,
		metadata.CreatedAt,
		metadata.CompletedAt,
		metadata.ExpiresAt,
		metadata.RequestHash,
		metadata.ResponseStatus,
		metadata.RetryCount,
		metadata.LastRetryAt,
	)

	return err
}

// IncrementRetryCount increments the retry counter
func (s *PostgresStore) IncrementRetryCount(ctx context.Context, key string) error {
	query := `
		UPDATE idempotency_metadata
		SET retry_count = retry_count + 1, last_retry_at = NOW()
		WHERE key = $1
	`
	_, err := s.db.ExecContext(ctx, query, key)
	return err
}

// Stats returns storage statistics
func (s *PostgresStore) Stats(ctx context.Context) (*KeyStats, error) {
	stats := &KeyStats{}

	query := `
		SELECT
			COUNT(*) as total,
			COUNT(*) FILTER (WHERE status = 'pending') as active,
			COUNT(*) FILTER (WHERE status = 'completed') as completed,
			COUNT(*) FILTER (WHERE status = 'failed') as failed
		FROM idempotency_metadata
		WHERE expires_at > NOW()
	`

	err := s.db.QueryRowContext(ctx, query).Scan(
		&stats.TotalKeys,
		&stats.ActiveKeys,
		&stats.CompletedKeys,
		&stats.FailedKeys,
	)

	return stats, err
}

// Cleanup removes expired entries
func (s *PostgresStore) Cleanup(ctx context.Context) (int64, error) {
	result, err := s.db.ExecContext(ctx, `DELETE FROM idempotency_responses WHERE expires_at < NOW()`)
	if err != nil {
		return 0, err
	}

	deleted, _ := result.RowsAffected()

	result2, err := s.db.ExecContext(ctx, `DELETE FROM idempotency_metadata WHERE expires_at < NOW()`)
	if err != nil {
		return deleted, err
	}

	deleted2, _ := result2.RowsAffected()

	result3, err := s.db.ExecContext(ctx, `DELETE FROM idempotency_locks WHERE expires_at < NOW()`)
	if err != nil {
		return deleted + deleted2, err
	}

	deleted3, _ := result3.RowsAffected()
	return deleted + deleted2 + deleted3, nil
}

// Close closes the database connection
func (s *PostgresStore) Close() error {
	return s.db.Close()
}

// Helper functions

// generateLockToken returns an unguessable lock ownership token. A timestamp is
// not good enough: two processes can read the same nanosecond, and a token that
// collides is a token that releases someone else's lock.
func generateLockToken() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("failed to generate lock token: %w", err)
	}
	return hex.EncodeToString(b), nil
}
```

### internal/idempotency/middleware.go - HTTP Middleware

The HTTP middleware intercepts requests that carry an `Idempotency-Key` header, checks the store for a cached response, and replays it immediately if found, completely bypassing the handler. When no cache entry exists it acquires a distributed lock, double-checks the cache after lock acquisition to prevent a race between concurrent retries, then wraps the underlying `http.ResponseWriter` with a buffering recorder so the response body and status code can be captured and stored atomically after the handler completes. A configurable `ExtractUserID` hook allows the composite key to incorporate the authenticated user's identity, ensuring that one user's idempotency key cannot collide with another's.

```go
package idempotency

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

const (
	// HeaderIdempotencyKey is the standard header name for idempotency keys
	HeaderIdempotencyKey = "Idempotency-Key"
	// HeaderIdempotencyReplay indicates the response was replayed from cache
	HeaderIdempotencyReplay = "Idempotency-Replay"
	// HeaderIdempotencyKeyStatus indicates the current status of the key
	HeaderIdempotencyKeyStatus = "Idempotency-Key-Status"
)

// MiddlewareConfig configures the idempotency middleware
type MiddlewareConfig struct {
	// Store is the idempotency storage backend
	Store Store
	// KeyConfig is the key configuration
	KeyConfig *KeyConfig
	// Logger for middleware events
	Logger *slog.Logger
	// Methods specifies which HTTP methods require idempotency
	Methods []string
	// Paths specifies path patterns that require idempotency
	Paths []string
	// ExcludePaths specifies path patterns to exclude from idempotency
	ExcludePaths []string
	// OnError is called when an error occurs (optional)
	OnError func(w http.ResponseWriter, r *http.Request, err error)
	// ExtractUserID extracts the user ID from the request (optional)
	ExtractUserID func(r *http.Request) string
}

// DefaultMiddlewareConfig returns the default middleware configuration
func DefaultMiddlewareConfig(store Store) *MiddlewareConfig {
	return &MiddlewareConfig{
		Store:     store,
		KeyConfig: DefaultKeyConfig(),
		Logger:    slog.Default(),
		Methods:   []string{"POST", "PUT", "PATCH"},
		Paths:     []string{"*"},
	}
}

// Middleware creates an HTTP middleware for idempotency
func Middleware(config *MiddlewareConfig) func(http.Handler) http.Handler {
	if config.KeyConfig == nil {
		config.KeyConfig = DefaultKeyConfig()
	}

	keyBuilder := NewKeyBuilder(config.KeyConfig)

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Check if method requires idempotency
			if !shouldApplyIdempotency(r, config) {
				next.ServeHTTP(w, r)
				return
			}

			// Extract idempotency key
			rawKey := r.Header.Get(HeaderIdempotencyKey)
			if rawKey == "" && !config.KeyConfig.RequireKey {
				// No key provided and not required - proceed normally
				next.ServeHTTP(w, r)
				return
			}

			// Read and restore body
			body, err := io.ReadAll(r.Body)
			if err != nil {
				handleError(w, r, config, err, http.StatusBadRequest)
				return
			}
			r.Body = io.NopCloser(bytes.NewReader(body))

			// Extract user ID if configured
			var userID string
			if config.ExtractUserID != nil {
				userID = config.ExtractUserID(r)
			}

			// Build composite key
			key, err := keyBuilder.Build(rawKey, r.Method, r.URL.Path, userID, body)
			if err != nil {
				handleError(w, r, config, err, http.StatusBadRequest)
				return
			}

			ctx := r.Context()

			// Try to get cached response
			cached, err := config.Store.Get(ctx, key.Composite)
			if err == nil {
				// A record exists for this key. Before replaying it, confirm
				// the request is actually the same one. Same key + different
				// body is a client bug, and replaying someone else's response
				// for it would be worse than useless.
				if !key.VerifyFingerprint(cached.RequestHash) {
					config.Logger.Warn("idempotency key reused with different request",
						"key", rawKey,
						"method", r.Method,
						"path", r.URL.Path,
					)
					handleError(w, r, config, ErrKeyMismatch, http.StatusBadRequest)
					return
				}

				config.Logger.Info("replaying cached response",
					"key", rawKey,
					"method", r.Method,
					"path", r.URL.Path,
				)

				replayResponse(w, cached)
				return
			}

			if err != ErrResponseNotFound {
				// Unexpected error
				handleError(w, r, config, err, http.StatusInternalServerError)
				return
			}

			// Try to acquire lock
			lease, err := config.Store.Lock(ctx, key.Composite, config.KeyConfig.LockTTL)
			if err != nil {
				handleError(w, r, config, err, http.StatusInternalServerError)
				return
			}

			if lease == nil {
				// Another request is in progress
				w.Header().Set(HeaderIdempotencyKeyStatus, "in_progress")
				handleError(w, r, config, ErrRequestInProgress, http.StatusConflict)
				return
			}

			// Finalising the request has to survive the client hanging up. On a
			// disconnect r.Context() is already cancelled, so caching the
			// response and releasing the lock on it would both fail, and the
			// client's retry would execute the operation a second time.
			finalCtx, finalCancel := context.WithTimeout(context.WithoutCancel(ctx), storeWriteTimeout)
			defer finalCancel()

			// Ensure we unlock when done
			defer func() {
				if unlockErr := lease.Release(finalCtx); unlockErr != nil {
					config.Logger.Error("failed to release lock",
						"key", rawKey,
						"error", unlockErr,
					)
				}
			}()

			// Double-check cache after acquiring lock (race condition protection)
			cached, err = config.Store.Get(ctx, key.Composite)
			if err == nil {
				// Same fingerprint check as the fast path above. A request
				// that completed while we waited for the lock still has to
				// prove it was the same request before we replay it.
				if !key.VerifyFingerprint(cached.RequestHash) {
					handleError(w, r, config, ErrKeyMismatch, http.StatusBadRequest)
					return
				}
				replayResponse(w, cached)
				return
			}

			// Create metadata record
			requestHash := hashRequest(r.Method, r.URL.Path, body)
			metadata := &KeyMetadata{
				Key:         key.Composite,
				Status:      KeyStatusPending,
				CreatedAt:   time.Now(),
				ExpiresAt:   key.ExpiresAt,
				RequestHash: requestHash,
			}
			if err := config.Store.SetMetadata(ctx, key.Composite, metadata); err != nil {
				config.Logger.Error("failed to store metadata", "error", err)
			}

			// Capture the response
			recorder := &responseRecorder{
				ResponseWriter: w,
				statusCode:     http.StatusOK,
				body:           &bytes.Buffer{},
				headers:        make(http.Header),
			}

			// Execute the actual handler
			next.ServeHTTP(recorder, r)

			// Store the response for future replay
			storedResponse := &StoredResponse{
				StatusCode:  recorder.statusCode,
				Headers:     flattenHeaders(recorder.headers),
				Body:        recorder.body.Bytes(),
				CreatedAt:   time.Now(),
				RequestHash: requestHash,
			}

			if storeErr := config.Store.Set(finalCtx, key.Composite, storedResponse, config.KeyConfig.TTL); storeErr != nil {
				config.Logger.Error("failed to store response",
					"key", rawKey,
					"error", storeErr,
				)
			}

			// Update metadata
			now := time.Now()
			metadata.Status = KeyStatusCompleted
			metadata.CompletedAt = &now
			metadata.ResponseStatus = recorder.statusCode
			if err := config.Store.SetMetadata(finalCtx, key.Composite, metadata); err != nil {
				config.Logger.Error("failed to update metadata", "error", err)
			}

			config.Logger.Info("stored response for idempotency key",
				"key", rawKey,
				"status", recorder.statusCode,
			)
		})
	}
}

// responseRecorder captures the response for storage
type responseRecorder struct {
	http.ResponseWriter
	statusCode    int
	body          *bytes.Buffer
	headers       http.Header
	wroteHeader   bool
	teeToOriginal bool
}

func (r *responseRecorder) Header() http.Header {
	return r.headers
}

func (r *responseRecorder) WriteHeader(code int) {
	if r.wroteHeader {
		return
	}
	r.wroteHeader = true
	r.statusCode = code

	// Copy headers to original writer
	for k, v := range r.headers {
		r.ResponseWriter.Header()[k] = v
	}
	r.ResponseWriter.WriteHeader(code)
}

func (r *responseRecorder) Write(b []byte) (int, error) {
	if !r.wroteHeader {
		r.WriteHeader(http.StatusOK)
	}
	r.body.Write(b)
	return r.ResponseWriter.Write(b)
}

// shouldApplyIdempotency determines if the request should have idempotency applied
func shouldApplyIdempotency(r *http.Request, config *MiddlewareConfig) bool {
	// Check method
	methodAllowed := false
	for _, m := range config.Methods {
		if strings.EqualFold(r.Method, m) {
			methodAllowed = true
			break
		}
	}
	if !methodAllowed {
		return false
	}

	// Check excluded paths
	for _, pattern := range config.ExcludePaths {
		if matchPath(r.URL.Path, pattern) {
			return false
		}
	}

	// Check included paths
	for _, pattern := range config.Paths {
		if pattern == "*" || matchPath(r.URL.Path, pattern) {
			return true
		}
	}

	return false
}

// matchPath performs simple path matching (supports * wildcard)
func matchPath(path, pattern string) bool {
	if pattern == "*" {
		return true
	}
	if strings.HasSuffix(pattern, "/*") {
		prefix := strings.TrimSuffix(pattern, "/*")
		return strings.HasPrefix(path, prefix)
	}
	return path == pattern
}

// replayResponse writes a cached response to the client
func replayResponse(w http.ResponseWriter, response *StoredResponse) {
	// Set headers
	for k, v := range response.Headers {
		w.Header().Set(k, v)
	}
	w.Header().Set(HeaderIdempotencyReplay, "true")
	w.Header().Set(HeaderIdempotencyKeyStatus, "completed")

	// Write status and body
	w.WriteHeader(response.StatusCode)
	w.Write(response.Body)
}

// handleError handles errors according to configuration
func handleError(w http.ResponseWriter, r *http.Request, config *MiddlewareConfig, err error, status int) {
	if config.OnError != nil {
		config.OnError(w, r, err)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)

	errorResponse := struct {
		Error   string `json:"error"`
		Code    string `json:"code"`
		Message string `json:"message"`
	}{
		Error:   err.Error(),
		Code:    errorCodeFromStatus(status),
		Message: errorMessageFromError(err),
	}

	json.NewEncoder(w).Encode(errorResponse)
}

// hashRequest creates a hash of the request for verification
func hashRequest(method, path string, body []byte) string {
	h := sha256.New()
	h.Write([]byte(method))
	h.Write([]byte(path))
	h.Write(body)
	return hex.EncodeToString(h.Sum(nil)[:16])
}

// flattenHeaders converts http.Header to map[string]string
func flattenHeaders(headers http.Header) map[string]string {
	result := make(map[string]string)
	for k, v := range headers {
		if len(v) > 0 {
			result[k] = v[0]
		}
	}
	return result
}

func errorCodeFromStatus(status int) string {
	switch status {
	case http.StatusBadRequest:
		return "INVALID_REQUEST"
	case http.StatusConflict:
		return "REQUEST_IN_PROGRESS"
	case http.StatusPreconditionFailed:
		return "KEY_MISMATCH"
	default:
		return "INTERNAL_ERROR"
	}
}

func errorMessageFromError(err error) string {
	switch {
	case errors.Is(err, ErrInvalidKey):
		return "The idempotency key format is invalid"
	case errors.Is(err, ErrKeyTooLong):
		return "The idempotency key exceeds the maximum length"
	case errors.Is(err, ErrKeyRequired):
		return "An idempotency key is required for this request"
	case errors.Is(err, ErrRequestInProgress):
		return "A request with this idempotency key is already being processed"
	case errors.Is(err, ErrKeyMismatch):
		return "The request parameters do not match the original request for this key"
	default:
		return err.Error()
	}
}
```

### internal/idempotency/grpc.go - gRPC Interceptor

The gRPC unary interceptor mirrors the HTTP middleware's lock-then-execute-then-cache pattern but reads the idempotency key from incoming gRPC metadata (`x-idempotency-key`) and serializes the request proto message with `proto.Marshal` to produce a deterministic body hash. Replayed responses are signaled to the client by setting the `x-idempotency-replay: true` response header, and concurrent duplicate calls receive a `codes.Aborted` status, the gRPC-idiomatic equivalent of HTTP `409 Conflict`, indicating the caller should retry after a brief delay.

When no key is present the interceptor's behavior is entirely `KeyConfig.RequireKey`'s to decide, and it fails closed only if you tell it to. `DefaultKeyConfig` sets `RequireKey: false`, which means an unkeyed call runs the handler with no idempotency protection whatsoever. That default is defensible for a mixed API where most methods are reads, and indefensible for a payments service. Set `RequireKey: true` on anything that moves money, or gate the interceptor with the `Methods` map so the mutating methods are the only ones it guards.

Replaying a gRPC response is harder than replaying an HTTP one, and the difference is worth dwelling on. HTTP responses are bytes: the middleware stores the body and writes it back. gRPC responses are typed messages, and the server marshals whatever the handler returns, so handing back the stored `[]byte` fails with `message is []uint8, want proto.Message`. The interceptor therefore stores the response's proto type name alongside the bytes and rebuilds the real message through `protoregistry` on replay. The status code has to make the round trip too, because a call that failed must replay as the same failure. Storing the error's message as the response body and replaying it with a nil error, which is the tempting shortcut, tells a client that its declined payment succeeded.

The interceptor also caches deterministic outcomes only. A `codes.Unavailable` from a downstream that was briefly down is not a fact about the request, it is a fact about the last five seconds, and pinning it in the cache for the full TTL means the client's retry, which is exactly the behavior idempotency keys are supposed to encourage, gets served that stale failure instead of a fresh attempt.

```go
package idempotency

import (
	"context"
	"log/slog"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/reflect/protoregistry"
)

const (
	// MetadataIdempotencyKey is the gRPC metadata key for idempotency
	MetadataIdempotencyKey = "x-idempotency-key"
	// MetadataIdempotencyReplay indicates the response was replayed
	MetadataIdempotencyReplay = "x-idempotency-replay"
	// headerResponseType records the full proto name of the cached response so
	// the replay path can rebuild the right message type
	headerResponseType = "response-proto-type"
	// storeWriteTimeout bounds the detached writes that finalise a request
	storeWriteTimeout = 5 * time.Second
)

// GRPCInterceptorConfig configures the gRPC idempotency interceptor
type GRPCInterceptorConfig struct {
	// Store is the idempotency storage backend
	Store Store
	// KeyConfig is the key configuration
	KeyConfig *KeyConfig
	// Logger for interceptor events
	Logger *slog.Logger
	// Methods specifies which methods require idempotency (empty = all mutating methods)
	Methods map[string]bool
	// ExtractUserID extracts user ID from context (optional)
	ExtractUserID func(ctx context.Context) string
}

// replayCached rebuilds a stored response into the values a gRPC handler would
// have returned.
//
// A cached gRPC response cannot be handed back as the raw bytes we stored. The
// server marshals whatever the handler returns, so returning a []byte makes it
// fail with "message is []uint8, want proto.Message" and every retry of a
// successful call errors out. We store the response's proto type name next to
// the bytes and rebuild the real message here. The status code has to survive
// the round trip too: a call that failed must replay as the same failure, never
// as a success carrying the error text in the body.
func replayCached(cached *StoredResponse) (any, error) {
	code := codes.Code(cached.StatusCode)
	if code != codes.OK {
		return nil, status.Error(code, string(cached.Body))
	}

	name := cached.Headers[headerResponseType]
	if name == "" {
		return nil, status.Error(codes.Internal, "cached response has no type information")
	}

	mt, err := protoregistry.GlobalTypes.FindMessageByName(protoreflect.FullName(name))
	if err != nil {
		return nil, status.Errorf(codes.Internal, "unknown cached response type %q", name)
	}

	msg := mt.New().Interface()
	if err := proto.Unmarshal(cached.Body, msg); err != nil {
		return nil, status.Error(codes.Internal, "failed to decode cached response")
	}

	return msg, nil
}

// isCacheableOutcome reports whether an outcome should be replayed to later
// retries.
//
// Only deterministic outcomes may be cached. Caching a transient failure such
// as Unavailable would pin it for the whole TTL: the client retries with the
// same key, as it is supposed to, and gets served the stale failure forever
// instead of a fresh attempt at the operation.
func isCacheableOutcome(err error) bool {
	if err == nil {
		return true
	}
	switch status.Code(err) {
	case codes.Unavailable, codes.DeadlineExceeded, codes.Aborted,
		codes.ResourceExhausted, codes.Internal, codes.Unknown, codes.Canceled:
		return false
	default:
		return true
	}
}

// UnaryServerInterceptor creates a gRPC unary interceptor for idempotency
func UnaryServerInterceptor(config *GRPCInterceptorConfig) grpc.UnaryServerInterceptor {
	if config.KeyConfig == nil {
		config.KeyConfig = DefaultKeyConfig()
	}
	if config.Logger == nil {
		config.Logger = slog.Default()
	}

	keyBuilder := NewKeyBuilder(config.KeyConfig)

	return func(
		ctx context.Context,
		req any,
		info *grpc.UnaryServerInfo,
		handler grpc.UnaryHandler,
	) (any, error) {
		// Check if method requires idempotency
		if config.Methods != nil && !config.Methods[info.FullMethod] {
			return handler(ctx, req)
		}

		// Extract idempotency key from metadata
		md, ok := metadata.FromIncomingContext(ctx)
		if !ok {
			md = metadata.MD{}
		}

		keys := md.Get(MetadataIdempotencyKey)
		if len(keys) == 0 {
			if !config.KeyConfig.RequireKey {
				return handler(ctx, req)
			}
			return nil, status.Error(codes.InvalidArgument, "idempotency key required")
		}
		rawKey := keys[0]

		// Serialize request for hashing
		var body []byte
		if msg, ok := req.(proto.Message); ok {
			body, _ = proto.Marshal(msg)
		}

		// Extract user ID
		var userID string
		if config.ExtractUserID != nil {
			userID = config.ExtractUserID(ctx)
		}

		// Build composite key
		key, err := keyBuilder.Build(rawKey, "GRPC", info.FullMethod, userID, body)
		if err != nil {
			return nil, status.Error(codes.InvalidArgument, err.Error())
		}

		// Try to get cached response
		cached, err := config.Store.Get(ctx, key.Composite)
		if err == nil {
			config.Logger.Info("replaying cached gRPC response",
				"key", rawKey,
				"method", info.FullMethod,
			)

			// Set replay header
			grpc.SetHeader(ctx, metadata.Pairs(MetadataIdempotencyReplay, "true"))

			return replayCached(cached)
		}

		if err != ErrResponseNotFound {
			return nil, status.Error(codes.Internal, "idempotency check failed")
		}

		// Acquire lock
		lease, err := config.Store.Lock(ctx, key.Composite, config.KeyConfig.LockTTL)
		if err != nil {
			return nil, status.Error(codes.Internal, "failed to acquire idempotency lock")
		}

		if lease == nil {
			return nil, status.Error(codes.Aborted, "request with this idempotency key is in progress")
		}

		// The store writes below must outlive the request context. If the
		// client's deadline fires while the handler is still working, this
		// context is already cancelled, and finalising on it would fail every
		// write: the response would never be cached and the lock would never be
		// released. The client then retries, finds nothing cached, and the
		// operation runs a second time. That is the exact double execution this
		// interceptor exists to prevent, so detach.
		finalCtx, finalCancel := context.WithTimeout(context.WithoutCancel(ctx), storeWriteTimeout)
		defer finalCancel()

		defer func() {
			if err := lease.Release(finalCtx); err != nil {
				config.Logger.Error("failed to release idempotency lock",
					"key", rawKey,
					"error", err,
				)
			}
		}()

		// Double-check cache
		cached, err = config.Store.Get(ctx, key.Composite)
		if err == nil {
			grpc.SetHeader(ctx, metadata.Pairs(MetadataIdempotencyReplay, "true"))
			return replayCached(cached)
		}

		// Execute handler
		resp, handlerErr := handler(ctx, req)

		// Cache the outcome so retries replay it rather than re-executing.
		// Deterministic failures are cached too, so a declined card replays as
		// the same decline instead of being attempted again.
		if isCacheableOutcome(handlerErr) {
			storedResponse := &StoredResponse{
				StatusCode:  int(codes.OK),
				Headers:     map[string]string{},
				CreatedAt:   time.Now(),
				RequestHash: key.BodyHash,
			}

			switch {
			case handlerErr != nil:
				st, _ := status.FromError(handlerErr)
				storedResponse.StatusCode = int(st.Code())
				storedResponse.Body = []byte(st.Message())
			default:
				msg, ok := resp.(proto.Message)
				if !ok {
					// Nothing we can replay later, so cache nothing now.
					return resp, handlerErr
				}
				body, marshalErr := proto.Marshal(msg)
				if marshalErr != nil {
					config.Logger.Error("failed to marshal gRPC response for caching",
						"key", rawKey,
						"error", marshalErr,
					)
					return resp, handlerErr
				}
				storedResponse.Body = body
				storedResponse.Headers[headerResponseType] = string(msg.ProtoReflect().Descriptor().FullName())
			}

			if storeErr := config.Store.Set(finalCtx, key.Composite, storedResponse, config.KeyConfig.TTL); storeErr != nil {
				config.Logger.Error("failed to store gRPC response",
					"key", rawKey,
					"error", storeErr,
				)
			}
		}

		return resp, handlerErr
	}
}

// StreamServerInterceptor creates a gRPC stream interceptor for idempotency
// Note: Idempotency for streams is typically handled differently or not at all
func StreamServerInterceptor(config *GRPCInterceptorConfig) grpc.StreamServerInterceptor {
	return func(
		srv any,
		ss grpc.ServerStream,
		info *grpc.StreamServerInfo,
		handler grpc.StreamHandler,
	) error {
		// For streams, idempotency is typically handled at the message level
		// or not used at all. This is a placeholder for custom implementations.
		return handler(srv, ss)
	}
}

// ClientUnaryInterceptor creates a client-side interceptor that automatically
// adds idempotency keys to requests
func ClientUnaryInterceptor(keyGenerator func() string) grpc.UnaryClientInterceptor {
	return func(
		ctx context.Context,
		method string,
		req, reply any,
		cc *grpc.ClientConn,
		invoker grpc.UnaryInvoker,
		opts ...grpc.CallOption,
	) error {
		// Check if key already exists
		md, ok := metadata.FromOutgoingContext(ctx)
		if !ok {
			md = metadata.MD{}
		}

		if len(md.Get(MetadataIdempotencyKey)) == 0 {
			// Generate and add key
			key := keyGenerator()
			md.Set(MetadataIdempotencyKey, key)
			ctx = metadata.NewOutgoingContext(ctx, md)
		}

		return invoker(ctx, method, req, reply, cc, opts...)
	}
}
```

### internal/saga/orchestrator.go - Durable Saga Orchestrator

The `Orchestrator` implements the saga pattern for long-running distributed transactions: each `Step` carries both an `Execute` function and a `Compensate` function, and the orchestrator writes to a SQL database both *before* a step runs and *after* it finishes, so that a crash mid-transaction can be resumed rather than restarted from scratch. When any step fails after its configured retry budget is exhausted, the orchestrator walks back through the applied steps in reverse order calling their `Compensate` functions, and the overall saga transitions to `compensated`, a safely rolled-back end state rather than an inconsistent half-applied one. Saga start calls accept an optional `idempotencyKey` so duplicate `Start` invocations for the same logical operation return the existing saga instance instead of launching a second execution.

The write-ahead marker is the part that earns its keep. Before a step executes, its record moves to `executing`. That write looks like bookkeeping and is actually the only evidence that will exist if the process dies while a payment gateway is deciding. The forward step and the durable record of it cannot be made atomic, because one of them is in another company's database, so there is always a window where the money moved and the log does not know it. The orchestrator resolves that window pessimistically: a step marked `executing` is assumed to have landed, and it is compensated.

> **This is why compensation must be driven by the log rather than by a counter.** The obvious implementation walks back from `saga.CurrentStep`, and it is wrong in both directions. `CurrentStep` only advances *after* a step is checkpointed, so the step that was mid-flight when the process died sits below it and never gets compensated: the card stays charged and no record of the intent to refund it survives. In the other direction, `CurrentStep` knows nothing about which compensations have already run, so resuming an interrupted rollback compensates the same steps again, and the customer is refunded twice.
>
> The step records already know both facts. Ask them. `compensatableSteps` selects the steps in `completed`, `executing`, or `failed` and orders by index descending, which yields reverse order, skips what is already compensated, and includes the mid-flight step, all from one query. **The counter is a summary of the log, and a summary is exactly the wrong thing to make a rollback decision from.**

Two consequences fall out of this design, and both are contracts the step author has to keep. Compensations must be idempotent, because a rollback that fails partway is retried from the top. And compensations must tolerate undoing something that never happened, because a step marked `executing` may have died before its side effect landed. A refund for a charge that was never captured has to be a no-op, not an error.

A failed compensation is the one failure the orchestrator refuses to swallow. Each compensation is retried up to `MaxCompensationAttempts` with backoff, and a saga that still cannot roll back is parked in `failed`, logged at error level, and counted, then picked up again by `RecoverStaleSagas` on the next sweep. That last part matters: a compensation usually fails because a downstream is down, which is a condition that ends. Marking such a saga terminal and walking away would leave real side effects applied with nothing left to undo them, so the saga stays in the recovery worker's queue, visibly failing, until a human intervenes or the downstream returns.

```go
package saga

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
)

var (
	// ErrSagaNotFound is returned when a saga cannot be found
	ErrSagaNotFound = errors.New("saga not found")
	// ErrSagaAlreadyCompleted is returned when trying to modify a completed saga
	ErrSagaAlreadyCompleted = errors.New("saga already completed")
	// ErrCompensationFailed is returned when compensation fails
	ErrCompensationFailed = errors.New("saga compensation failed")
	// ErrStepFailed is returned when a saga step fails
	ErrStepFailed = errors.New("saga step failed")
)

// SagaStatus represents the current status of a saga
type SagaStatus string

const (
	SagaStatusStarted      SagaStatus = "started"
	SagaStatusExecuting    SagaStatus = "executing"
	SagaStatusCompleted    SagaStatus = "completed"
	SagaStatusCompensating SagaStatus = "compensating"
	SagaStatusCompensated  SagaStatus = "compensated"
	SagaStatusFailed       SagaStatus = "failed"
)

// StepStatus represents the status of an individual step
type StepStatus string

const (
	StepStatusPending     StepStatus = "pending"
	StepStatusExecuting   StepStatus = "executing"
	StepStatusCompleted   StepStatus = "completed"
	StepStatusFailed      StepStatus = "failed"
	StepStatusCompensated StepStatus = "compensated"
)

// Saga represents a distributed transaction
type Saga struct {
	ID             string         `json:"id"`
	Type           string         `json:"type"`
	Status         SagaStatus     `json:"status"`
	State          map[string]any `json:"state"`
	CurrentStep    int            `json:"current_step"`
	Error          string         `json:"error,omitempty"`
	CreatedAt      time.Time      `json:"created_at"`
	UpdatedAt      time.Time      `json:"updated_at"`
	CompletedAt    *time.Time     `json:"completed_at,omitempty"`
	IdempotencyKey string         `json:"idempotency_key,omitempty"`
}

// StepRecord tracks execution of an individual step
type StepRecord struct {
	SagaID        string     `json:"saga_id"`
	StepIndex     int        `json:"step_index"`
	StepName      string     `json:"step_name"`
	Status        StepStatus `json:"status"`
	Error         string     `json:"error,omitempty"`
	Result        []byte     `json:"result,omitempty"`
	ExecutedAt    *time.Time `json:"executed_at,omitempty"`
	CompensatedAt *time.Time `json:"compensated_at,omitempty"`
}

// Step defines a saga step with execute and compensate functions.
//
// Both functions must be idempotent, because both can run more than once. A
// crash between a step's side effect and the checkpoint that records it means
// Execute is retried against work that already happened, and a compensation
// that fails partway is retried until it succeeds. Neither function may assume
// it is seeing the world for the first time.
type Step struct {
	Name string
	// Execute performs the step's work. It may be called again after a crash,
	// so it must tolerate seeing its own previous effects.
	Execute func(ctx context.Context, state map[string]any) (any, error)
	// Compensate undoes the step's work. It must be idempotent and it must
	// tolerate being called for a step whose Execute never completed, because
	// after a crash we cannot know whether the side effect landed.
	Compensate func(ctx context.Context, state map[string]any) error
	// Timeout bounds a single attempt, not the whole retry budget.
	Timeout time.Duration
	// Retries is the number of additional attempts after the first.
	Retries int
}

// Definition defines a saga type with its steps
type Definition struct {
	Type  string
	Steps []Step
}

// MaxCompensationAttempts bounds how many times Compensate retries a single
// compensation before parking the saga for an operator.
const MaxCompensationAttempts = 3

// Orchestrator manages saga execution
type Orchestrator struct {
	db          *sql.DB
	definitions map[string]*Definition
	logger      *slog.Logger
	metrics     *sagaCounters
}

// SagaMetrics is a point-in-time snapshot of saga execution counters.
type SagaMetrics struct {
	Started       int64 `json:"started"`
	Completed     int64 `json:"completed"`
	Failed        int64 `json:"failed"`
	Compensated   int64 `json:"compensated"`
	StepsExecuted int64 `json:"steps_executed"`
	StepsFailed   int64 `json:"steps_failed"`
}

// sagaCounters holds the live counters.
//
// Sagas run concurrently, one per request, so these have to be atomic. A plain
// counter++ from two goroutines is a data race, and the race detector says so
// on the first concurrent run.
type sagaCounters struct {
	started       atomic.Int64
	completed     atomic.Int64
	failed        atomic.Int64
	compensated   atomic.Int64
	stepsExecuted atomic.Int64
	stepsFailed   atomic.Int64
}

// NewOrchestrator creates a new saga orchestrator
func NewOrchestrator(db *sql.DB, logger *slog.Logger) *Orchestrator {
	return &Orchestrator{
		db:          db,
		definitions: make(map[string]*Definition),
		logger:      logger,
		metrics:     &sagaCounters{},
	}
}

// RegisterDefinition registers a saga definition
func (o *Orchestrator) RegisterDefinition(def *Definition) {
	o.definitions[def.Type] = def
}

// Start begins a new saga execution
func (o *Orchestrator) Start(ctx context.Context, sagaType string, initialState map[string]any, idempotencyKey string) (*Saga, error) {
	def, ok := o.definitions[sagaType]
	if !ok {
		return nil, fmt.Errorf("unknown saga type: %s", sagaType)
	}

	// Check for existing saga with same idempotency key
	if idempotencyKey != "" {
		existing, err := o.findByIdempotencyKey(ctx, idempotencyKey)
		switch {
		case err == nil:
			o.logger.Info("found existing saga for idempotency key",
				"saga_id", existing.ID,
				"status", existing.Status,
			)
			return existing, nil
		case !errors.Is(err, ErrSagaNotFound):
			// Swallowing this would start a second saga for the same key on
			// nothing worse than a blip in the database.
			return nil, fmt.Errorf("failed to check idempotency key: %w", err)
		}
	}

	saga := &Saga{
		ID:             uuid.New().String(),
		Type:           sagaType,
		Status:         SagaStatusStarted,
		State:          initialState,
		CurrentStep:    0,
		CreatedAt:      time.Now(),
		UpdatedAt:      time.Now(),
		IdempotencyKey: idempotencyKey,
	}

	if err := o.saveSaga(ctx, saga); err != nil {
		// The lookup above is a check, not a guarantee: two concurrent Starts
		// for one key both see nothing and both insert. The unique index on
		// idempotency_key is what actually enforces the rule, so a conflict
		// here means we lost the race and the winner's saga is the answer.
		if existing, findErr := o.findByIdempotencyKey(ctx, idempotencyKey); idempotencyKey != "" && findErr == nil {
			return existing, nil
		}
		return nil, fmt.Errorf("failed to create saga: %w", err)
	}

	// Create step records
	for i, step := range def.Steps {
		record := &StepRecord{
			SagaID:    saga.ID,
			StepIndex: i,
			StepName:  step.Name,
			Status:    StepStatusPending,
		}
		if err := o.saveStepRecord(ctx, record); err != nil {
			return nil, fmt.Errorf("failed to create step record: %w", err)
		}
	}

	o.metrics.started.Add(1)

	return saga, nil
}

// Execute runs all saga steps
func (o *Orchestrator) Execute(ctx context.Context, sagaID string) error {
	saga, err := o.GetSaga(ctx, sagaID)
	if err != nil {
		return err
	}

	if saga.Status == SagaStatusCompleted {
		return nil
	}

	if saga.Status == SagaStatusFailed || saga.Status == SagaStatusCompensated {
		return fmt.Errorf("saga is in terminal state: %s", saga.Status)
	}

	def, ok := o.definitions[saga.Type]
	if !ok {
		return fmt.Errorf("unknown saga type: %s", saga.Type)
	}

	saga.Status = SagaStatusExecuting
	saga.UpdatedAt = time.Now()
	if err := o.saveSaga(ctx, saga); err != nil {
		return err
	}

	// Execute steps from current position
	for i := saga.CurrentStep; i < len(def.Steps); i++ {
		step := def.Steps[i]

		o.logger.Info("executing saga step",
			"saga_id", sagaID,
			"step_index", i,
			"step_name", step.Name,
		)

		// Update step status
		if err := o.updateStepStatus(ctx, sagaID, i, StepStatusExecuting, ""); err != nil {
			return err
		}

		// Execute step with retries. The timeout bounds each attempt
		// separately: one context spanning every attempt plus the backoff
		// sleeps would leave the later retries running against an already
		// expired deadline, which is a retry budget that cannot be spent.
		var result any
		var stepErr error

		for attempt := 0; attempt <= step.Retries; attempt++ {
			if attempt > 0 {
				if err := sleepCtx(ctx, time.Duration(attempt)*time.Second); err != nil {
					stepErr = err
					break
				}
			}

			result, stepErr = o.runStep(ctx, step, saga.State)
			if stepErr == nil {
				break
			}

			o.logger.Warn("saga step failed, retrying",
				"saga_id", sagaID,
				"step_name", step.Name,
				"attempt", attempt+1,
				"error", stepErr,
			)
		}

		o.metrics.stepsExecuted.Add(1)

		if stepErr != nil {
			o.metrics.stepsFailed.Add(1)
			o.logger.Error("saga step failed",
				"saga_id", sagaID,
				"step_name", step.Name,
				"error", stepErr,
			)

			if err := o.updateStepStatus(ctx, sagaID, i, StepStatusFailed, stepErr.Error()); err != nil {
				return err
			}

			saga.Error = fmt.Sprintf("step %s failed: %v", step.Name, stepErr)
			saga.UpdatedAt = time.Now()
			if err := o.saveSaga(ctx, saga); err != nil {
				return err
			}

			// Roll back what has already been applied. Compensation runs on
			// a context detached from this one: the step may well have failed
			// because ctx was cancelled, and compensating on a dead context
			// would fail every rollback instantly and strand the saga
			// half-applied.
			compErr := o.Compensate(context.WithoutCancel(ctx), sagaID)

			// Report the failure. Returning the compensation's nil here would
			// tell the caller the saga succeeded when it in fact rolled back.
			if compErr != nil {
				return errors.Join(fmt.Errorf("%w: step %s: %w", ErrStepFailed, step.Name, stepErr), compErr)
			}
			return fmt.Errorf("%w: step %s: %w", ErrStepFailed, step.Name, stepErr)
		}

		// Store result in state if returned
		if result != nil {
			saga.State[fmt.Sprintf("step_%d_result", i)] = result
		}

		// Update step and saga
		if err := o.updateStepStatus(ctx, sagaID, i, StepStatusCompleted, ""); err != nil {
			return err
		}

		saga.CurrentStep = i + 1
		saga.UpdatedAt = time.Now()
		if err := o.saveSaga(ctx, saga); err != nil {
			return err
		}
	}

	// All steps completed
	now := time.Now()
	saga.Status = SagaStatusCompleted
	saga.CompletedAt = &now
	saga.UpdatedAt = now
	if err := o.saveSaga(ctx, saga); err != nil {
		return err
	}

	o.metrics.completed.Add(1)

	o.logger.Info("saga completed successfully",
		"saga_id", sagaID,
		"type", saga.Type,
	)

	return nil
}

// runStep executes one attempt, bounded by the step's own timeout.
func (o *Orchestrator) runStep(ctx context.Context, step Step, state map[string]any) (any, error) {
	if step.Timeout <= 0 {
		return step.Execute(ctx, state)
	}

	stepCtx, cancel := context.WithTimeout(ctx, step.Timeout)
	defer cancel()

	return step.Execute(stepCtx, state)
}

// sleepCtx waits for d, or returns early if the context is done.
func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()

	select {
	case <-t.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Compensate runs compensation for all completed steps
func (o *Orchestrator) Compensate(ctx context.Context, sagaID string) error {
	saga, err := o.GetSaga(ctx, sagaID)
	if err != nil {
		return err
	}

	if saga.Status == SagaStatusCompensated {
		return nil
	}
	if saga.Status == SagaStatusCompleted {
		return ErrSagaAlreadyCompleted
	}

	def, ok := o.definitions[saga.Type]
	if !ok {
		return fmt.Errorf("unknown saga type: %s", saga.Type)
	}

	saga.Status = SagaStatusCompensating
	saga.UpdatedAt = time.Now()
	if err := o.saveSaga(ctx, saga); err != nil {
		return err
	}

	o.logger.Info("starting saga compensation",
		"saga_id", sagaID,
		"current_step", saga.CurrentStep,
	)

	// Which steps need undoing is a question only the durable log can answer.
	//
	// Walking back from saga.CurrentStep instead gets it wrong twice. The
	// counter advances only after a step is checkpointed, so a step that was
	// marked executing, whose side effect landed, and whose process then died
	// sits below CurrentStep and never gets compensated: the card stays
	// charged. And the counter knows nothing about compensations that already
	// ran, so resuming an interrupted rollback compensates them a second time.
	// The step records know both, so ask them.
	pending, err := o.compensatableSteps(ctx, sagaID)
	if err != nil {
		return fmt.Errorf("failed to load steps for compensation: %w", err)
	}

	var compensationErrors []error

	// Reverse order: the last thing applied is the first thing undone.
	for _, rec := range pending {
		if rec.StepIndex >= len(def.Steps) {
			continue
		}
		step := def.Steps[rec.StepIndex]

		if step.Compensate == nil {
			o.logger.Debug("skipping step without compensation",
				"saga_id", sagaID,
				"step_name", step.Name,
			)
			continue
		}

		o.logger.Info("compensating saga step",
			"saga_id", sagaID,
			"step_index", rec.StepIndex,
			"step_name", step.Name,
			"step_status", rec.Status,
		)

		if err := o.compensateStep(ctx, saga, step); err != nil {
			// Do not stop. The remaining steps still hold real side effects,
			// and undoing as many as possible leaves less for a human to sort
			// out than abandoning the rest at the first refusal.
			o.logger.Error("compensation failed after retries",
				"saga_id", sagaID,
				"step_name", step.Name,
				"error", err,
			)
			compensationErrors = append(compensationErrors, fmt.Errorf("step %s: %w", step.Name, err))
			continue
		}

		if err := o.updateStepStatus(ctx, sagaID, rec.StepIndex, StepStatusCompensated, ""); err != nil {
			return err
		}
	}

	now := time.Now()

	if len(compensationErrors) > 0 {
		// Park the saga, loudly. It keeps its compensated steps recorded, so a
		// retry resumes exactly where this attempt stopped rather than undoing
		// anything twice.
		saga.Status = SagaStatusFailed
		saga.Error = fmt.Sprintf("compensation failed: %v", errors.Join(compensationErrors...))
		saga.UpdatedAt = now
		o.metrics.failed.Add(1)

		if err := o.saveSaga(ctx, saga); err != nil {
			return err
		}

		o.logger.Error("saga parked with incomplete compensation, operator attention required",
			"saga_id", sagaID,
			"error", saga.Error,
		)

		return fmt.Errorf("%w: saga %s: %w", ErrCompensationFailed, sagaID, errors.Join(compensationErrors...))
	}

	saga.Status = SagaStatusCompensated
	saga.CompletedAt = &now
	saga.UpdatedAt = now
	o.metrics.compensated.Add(1)

	return o.saveSaga(ctx, saga)
}

// compensateStep runs one compensation, retrying a transient refusal.
//
// A compensation that fails once and is then forgotten is how a saga loses
// money: the forward step already moved something in the real world, and the
// only record of the intent to undo it is this call. Retry it.
func (o *Orchestrator) compensateStep(ctx context.Context, saga *Saga, step Step) error {
	var err error

	for attempt := 1; attempt <= MaxCompensationAttempts; attempt++ {
		if attempt > 1 {
			if sleepErr := sleepCtx(ctx, time.Duration(attempt-1)*time.Second); sleepErr != nil {
				return errors.Join(err, sleepErr)
			}
		}

		err = step.Compensate(ctx, saga.State)
		if err == nil {
			return nil
		}

		o.logger.Warn("compensation attempt failed",
			"saga_id", saga.ID,
			"step_name", step.Name,
			"attempt", attempt,
			"error", err,
		)
	}

	return err
}

// compensatableSteps returns the steps whose effects may exist, newest first.
//
// A step marked executing is included on purpose. Its process died mid-flight,
// so we cannot know whether the side effect landed, and the only safe
// assumption is that it did. This is why compensations must be idempotent and
// must tolerate undoing something that never happened.
func (o *Orchestrator) compensatableSteps(ctx context.Context, sagaID string) ([]StepRecord, error) {
	query := `
		SELECT step_index, step_name, status
		FROM saga_steps
		WHERE saga_id = $1 AND status IN ('completed', 'executing', 'failed')
		ORDER BY step_index DESC
	`

	rows, err := o.db.QueryContext(ctx, query, sagaID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var records []StepRecord
	for rows.Next() {
		var rec StepRecord
		if err := rows.Scan(&rec.StepIndex, &rec.StepName, &rec.Status); err != nil {
			return nil, err
		}
		rec.SagaID = sagaID
		records = append(records, rec)
	}

	return records, rows.Err()
}

// GetSaga retrieves a saga by ID
func (o *Orchestrator) GetSaga(ctx context.Context, sagaID string) (*Saga, error) {
	query := `
		SELECT id, type, status, state, current_step, error, created_at, updated_at, completed_at, idempotency_key
		FROM sagas
		WHERE id = $1
	`

	var saga Saga
	var stateJSON []byte
	var completedAt sql.NullTime
	var sagaError, idempotencyKey sql.NullString

	err := o.db.QueryRowContext(ctx, query, sagaID).Scan(
		&saga.ID,
		&saga.Type,
		&saga.Status,
		&stateJSON,
		&saga.CurrentStep,
		&sagaError,
		&saga.CreatedAt,
		&saga.UpdatedAt,
		&completedAt,
		&idempotencyKey,
	)

	if err == sql.ErrNoRows {
		return nil, ErrSagaNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get saga: %w", err)
	}

	if err := json.Unmarshal(stateJSON, &saga.State); err != nil {
		return nil, fmt.Errorf("failed to unmarshal state: %w", err)
	}

	if completedAt.Valid {
		saga.CompletedAt = &completedAt.Time
	}
	if sagaError.Valid {
		saga.Error = sagaError.String
	}
	if idempotencyKey.Valid {
		saga.IdempotencyKey = idempotencyKey.String
	}

	return &saga, nil
}

// findByIdempotencyKey finds a saga by its idempotency key
func (o *Orchestrator) findByIdempotencyKey(ctx context.Context, key string) (*Saga, error) {
	query := `
		SELECT id FROM sagas WHERE idempotency_key = $1
	`

	var sagaID string
	err := o.db.QueryRowContext(ctx, query, key).Scan(&sagaID)
	if err == sql.ErrNoRows {
		return nil, ErrSagaNotFound
	}
	if err != nil {
		return nil, err
	}

	return o.GetSaga(ctx, sagaID)
}

// saveSaga persists a saga to the database
func (o *Orchestrator) saveSaga(ctx context.Context, saga *Saga) error {
	stateJSON, err := json.Marshal(saga.State)
	if err != nil {
		return fmt.Errorf("failed to marshal state: %w", err)
	}

	query := `
		INSERT INTO sagas (id, type, status, state, current_step, error, created_at, updated_at, completed_at, idempotency_key)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
		ON CONFLICT (id) DO UPDATE SET
			status = EXCLUDED.status,
			state = EXCLUDED.state,
			current_step = EXCLUDED.current_step,
			error = EXCLUDED.error,
			updated_at = EXCLUDED.updated_at,
			completed_at = EXCLUDED.completed_at
	`

	var completedAt *time.Time
	if saga.CompletedAt != nil {
		completedAt = saga.CompletedAt
	}

	var sagaError *string
	if saga.Error != "" {
		sagaError = &saga.Error
	}

	var idempotencyKey *string
	if saga.IdempotencyKey != "" {
		idempotencyKey = &saga.IdempotencyKey
	}

	_, err = o.db.ExecContext(ctx, query,
		saga.ID,
		saga.Type,
		saga.Status,
		stateJSON,
		saga.CurrentStep,
		sagaError,
		saga.CreatedAt,
		saga.UpdatedAt,
		completedAt,
		idempotencyKey,
	)

	return err
}

// saveStepRecord persists a step record to the database
func (o *Orchestrator) saveStepRecord(ctx context.Context, record *StepRecord) error {
	query := `
		INSERT INTO saga_steps (saga_id, step_index, step_name, status, error, result, executed_at, compensated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		ON CONFLICT (saga_id, step_index) DO UPDATE SET
			status = EXCLUDED.status,
			error = EXCLUDED.error,
			result = EXCLUDED.result,
			executed_at = EXCLUDED.executed_at,
			compensated_at = EXCLUDED.compensated_at
	`

	_, err := o.db.ExecContext(ctx, query,
		record.SagaID,
		record.StepIndex,
		record.StepName,
		record.Status,
		record.Error,
		record.Result,
		record.ExecutedAt,
		record.CompensatedAt,
	)

	return err
}

// updateStepStatus updates the status of a step
func (o *Orchestrator) updateStepStatus(ctx context.Context, sagaID string, stepIndex int, status StepStatus, errMsg string) error {
	record := &StepRecord{
		SagaID:    sagaID,
		StepIndex: stepIndex,
		Status:    status,
		Error:     errMsg,
	}

	now := time.Now()
	if status == StepStatusCompleted {
		record.ExecutedAt = &now
	}
	if status == StepStatusCompensated {
		record.CompensatedAt = &now
	}

	query := `
		UPDATE saga_steps
		SET status = $1, error = $2, executed_at = COALESCE($3, executed_at), compensated_at = COALESCE($4, compensated_at)
		WHERE saga_id = $5 AND step_index = $6
	`

	_, err := o.db.ExecContext(ctx, query,
		record.Status,
		record.Error,
		record.ExecutedAt,
		record.CompensatedAt,
		record.SagaID,
		record.StepIndex,
	)

	return err
}

// claimSaga takes ownership of a stale saga with a compare-and-swap on
// updated_at. It reports false when another worker got there first.
func (o *Orchestrator) claimSaga(ctx context.Context, saga *Saga) (bool, error) {
	result, err := o.db.ExecContext(ctx,
		`UPDATE sagas SET updated_at = NOW() WHERE id = $1 AND updated_at = $2`,
		saga.ID, saga.UpdatedAt)
	if err != nil {
		return false, err
	}

	affected, err := result.RowsAffected()
	if err != nil {
		return false, err
	}

	return affected == 1, nil
}

// GetMetrics returns a snapshot of current saga metrics
func (o *Orchestrator) GetMetrics() *SagaMetrics {
	return &SagaMetrics{
		Started:       o.metrics.started.Load(),
		Completed:     o.metrics.completed.Load(),
		Failed:        o.metrics.failed.Load(),
		Compensated:   o.metrics.compensated.Load(),
		StepsExecuted: o.metrics.stepsExecuted.Load(),
		StepsFailed:   o.metrics.stepsFailed.Load(),
	}
}

// RecoverStaleSagas finds and processes sagas that may have been abandoned.
//
// staleAfter must be longer than the slowest step. A saga only touches
// updated_at between steps, so a step that runs longer than staleAfter looks
// abandoned, and this worker would start a second execution alongside the first.
//
// Sagas parked in 'failed' are picked up too. Their compensation ran out of
// attempts, which is usually a downstream service being down rather than
// anything permanent, and the step log means a retry resumes from where it
// stopped instead of undoing completed work twice. A compensation that can
// never succeed keeps failing here, in the open, which is the point: the
// alternative is a saga with real side effects quietly abandoned forever.
func (o *Orchestrator) RecoverStaleSagas(ctx context.Context, staleAfter time.Duration) error {
	query := `
		SELECT id FROM sagas
		WHERE status IN ('started', 'executing', 'compensating', 'failed')
		AND updated_at < $1
	`

	rows, err := o.db.QueryContext(ctx, query, time.Now().Add(-staleAfter))
	if err != nil {
		return fmt.Errorf("failed to query stale sagas: %w", err)
	}
	defer rows.Close()

	var sagaIDs []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return err
		}
		sagaIDs = append(sagaIDs, id)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("failed to read stale sagas: %w", err)
	}

	for _, sagaID := range sagaIDs {
		o.logger.Info("recovering stale saga", "saga_id", sagaID)

		saga, err := o.GetSaga(ctx, sagaID)
		if err != nil {
			o.logger.Error("failed to get stale saga", "saga_id", sagaID, "error", err)
			continue
		}

		// Claim the saga before touching it, so two recovery workers cannot
		// drive the same saga at once. The compare-and-swap on updated_at
		// means only the worker that moved it wins.
		claimed, err := o.claimSaga(ctx, saga)
		if err != nil {
			o.logger.Error("failed to claim stale saga", "saga_id", sagaID, "error", err)
			continue
		}
		if !claimed {
			continue
		}

		switch saga.Status {
		case SagaStatusStarted, SagaStatusExecuting:
			// Resume execution
			if err := o.Execute(ctx, sagaID); err != nil {
				o.logger.Error("failed to resume saga", "saga_id", sagaID, "error", err)
			}
		case SagaStatusCompensating, SagaStatusFailed:
			// Resume or retry compensation
			if err := o.Compensate(ctx, sagaID); err != nil {
				o.logger.Error("failed to resume compensation", "saga_id", sagaID, "error", err)
			}
		}
	}

	return nil
}
```

### cmd/server/main.go - Main Application

The main function wires together Redis (for idempotency storage), PostgreSQL (for saga persistence and the transactional outbox), and `chi` router with the idempotency middleware applied only to mutating methods, `POST`, `PUT`, `PATCH`, while health and metrics endpoints are explicitly excluded. A concrete `order_creation` saga demonstrates the three-step pattern in practice: inventory reservation, payment charge, and shipment creation, each with its own compensation function and independent retry budget so failures at any step trigger only the necessary rollbacks without over-compensating earlier successful steps.

```go
package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"log"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	_ "github.com/lib/pq"
	"github.com/redis/go-redis/v9"

	"github.com/yourorg/idempotency-framework/internal/idempotency"
	"github.com/yourorg/idempotency-framework/internal/outbox"
	"github.com/yourorg/idempotency-framework/internal/saga"
)

func main() {
	// Setup logging
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))
	slog.SetDefault(logger)

	// Setup Redis
	redisClient := redis.NewClient(&redis.Options{
		Addr:     getEnv("REDIS_ADDR", "localhost:6379"),
		Password: getEnv("REDIS_PASSWORD", ""),
		DB:       0,
	})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	if err := redisClient.Ping(ctx).Err(); err != nil {
		log.Fatalf("Failed to connect to Redis: %v", err)
	}
	cancel()

	// Setup PostgreSQL
	db, err := sql.Open("postgres", getEnv("DATABASE_URL", "postgres://localhost:5432/idempotency?sslmode=disable"))
	if err != nil {
		log.Fatalf("Failed to connect to PostgreSQL: %v", err)
	}
	defer db.Close()

	db.SetMaxOpenConns(25)
	db.SetMaxIdleConns(5)
	db.SetConnMaxLifetime(5 * time.Minute)

	// Run migrations
	if err := runMigrations(db); err != nil {
		log.Fatalf("Failed to run migrations: %v", err)
	}

	// Create idempotency store
	idempotencyStore := idempotency.NewRedisStore(redisClient, "idem")

	// Create idempotency middleware
	idempotencyMiddleware := idempotency.Middleware(&idempotency.MiddlewareConfig{
		Store: idempotencyStore,
		KeyConfig: &idempotency.KeyConfig{
			RequireKey:       false,
			StrictValidation: true,
			IncludeBodyHash:  true,
			IncludeUserID:    true,
			TTL:              24 * time.Hour,
			LockTTL:          5 * time.Minute,
		},
		Logger:        logger,
		Methods:       []string{"POST", "PUT", "PATCH"},
		ExcludePaths:  []string{"/health", "/metrics"},
		ExtractUserID: extractUserID,
	})

	// Create saga orchestrator
	sagaOrchestrator := saga.NewOrchestrator(db, logger)

	// Register order saga
	sagaOrchestrator.RegisterDefinition(&saga.Definition{
		Type: "order_creation",
		Steps: []saga.Step{
			{
				Name: "reserve_inventory",
				Execute: func(ctx context.Context, state map[string]any) (any, error) {
					logger.Info("Reserving inventory", "order_id", state["order_id"])
					// Simulate inventory reservation
					time.Sleep(100 * time.Millisecond)
					return map[string]string{"reservation_id": "res-123"}, nil
				},
				Compensate: func(ctx context.Context, state map[string]any) error {
					logger.Info("Releasing inventory reservation", "order_id", state["order_id"])
					return nil
				},
				Timeout: 30 * time.Second,
				Retries: 3,
			},
			{
				Name: "charge_payment",
				Execute: func(ctx context.Context, state map[string]any) (any, error) {
					logger.Info("Charging payment", "order_id", state["order_id"])
					// Simulate payment
					time.Sleep(200 * time.Millisecond)
					return map[string]string{"payment_id": "pay-456"}, nil
				},
				Compensate: func(ctx context.Context, state map[string]any) error {
					logger.Info("Refunding payment", "order_id", state["order_id"])
					return nil
				},
				Timeout: 60 * time.Second,
				Retries: 2,
			},
			{
				Name: "create_shipment",
				Execute: func(ctx context.Context, state map[string]any) (any, error) {
					logger.Info("Creating shipment", "order_id", state["order_id"])
					// Simulate shipment creation
					time.Sleep(150 * time.Millisecond)
					return map[string]string{"shipment_id": "ship-789"}, nil
				},
				Compensate: func(ctx context.Context, state map[string]any) error {
					logger.Info("Cancelling shipment", "order_id", state["order_id"])
					return nil
				},
				Timeout: 30 * time.Second,
				Retries: 2,
			},
		},
	})

	// Create outbox publisher (would normally publish to Kafka)
	outboxRepo := outbox.NewOutboxRepository(db)
	mockPublisher := &mockMessagePublisher{logger: logger}
	outboxPublisher := outbox.NewOutboxPublisher(outboxRepo, mockPublisher, logger)

	// Start outbox worker
	outboxCtx, outboxCancel := context.WithCancel(context.Background())
	go outboxPublisher.Start(outboxCtx)

	// Start saga recovery worker
	sagaCtx, sagaCancel := context.WithCancel(context.Background())
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()

		for {
			select {
			case <-sagaCtx.Done():
				return
			case <-ticker.C:
				if err := sagaOrchestrator.RecoverStaleSagas(sagaCtx, 5*time.Minute); err != nil {
					logger.Error("failed to recover stale sagas", "error", err)
				}
			}
		}
	}()

	// Setup HTTP router
	r := chi.NewRouter()

	// Middleware
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(middleware.Timeout(60 * time.Second))

	// Health endpoints (no idempotency)
	r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]string{"status": "healthy"})
	})

	r.Get("/metrics", func(w http.ResponseWriter, r *http.Request) {
		metrics := sagaOrchestrator.GetMetrics()
		json.NewEncoder(w).Encode(metrics)
	})

	// API routes with idempotency
	r.Route("/api", func(r chi.Router) {
		r.Use(idempotencyMiddleware)

		// Payments endpoint
		r.Post("/payments", func(w http.ResponseWriter, r *http.Request) {
			var req struct {
				AmountCents int64  `json:"amount_cents"` // integer cents, never float64
				Currency    string `json:"currency"`
				UserID      string `json:"user_id"`
			}

			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}

			// Simulate payment processing
			time.Sleep(500 * time.Millisecond)

			response := map[string]any{
				"payment_id":   "pay_" + middleware.GetReqID(r.Context()),
				"amount_cents": req.AmountCents,
				"currency":     req.Currency,
				"status":       "succeeded",
				"created_at":   time.Now().Format(time.RFC3339),
			}

			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(response)
		})

		// Orders endpoint with saga
		r.Post("/orders", func(w http.ResponseWriter, r *http.Request) {
			var req struct {
				UserID string `json:"user_id"`
				Items  []struct {
					ProductID string `json:"product_id"`
					Quantity  int    `json:"quantity"`
				} `json:"items"`
				TotalCents int64 `json:"total_cents"` // integer cents, never float64
			}

			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}

			// Get idempotency key for saga
			idempotencyKey := r.Header.Get("Idempotency-Key")

			// Start saga
			orderID := "order_" + middleware.GetReqID(r.Context())
			sagaState := map[string]any{
				"order_id":    orderID,
				"user_id":     req.UserID,
				"items":       req.Items,
				"total_cents": req.TotalCents,
			}

			s, err := sagaOrchestrator.Start(r.Context(), "order_creation", sagaState, idempotencyKey)
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}

			// Execute saga (could be async in production)
			if err := sagaOrchestrator.Execute(r.Context(), s.ID); err != nil {
				// Get updated saga status
				s, _ = sagaOrchestrator.GetSaga(r.Context(), s.ID)
			}

			response := map[string]any{
				"order_id":   orderID,
				"saga_id":    s.ID,
				"saga_status": s.Status,
				"created_at": s.CreatedAt.Format(time.RFC3339),
			}

			// Content-Type has to be set before WriteHeader. Once the status
			// line is written the header map is already on the wire, and later
			// writes to it are silently dropped.
			w.Header().Set("Content-Type", "application/json")

			if s.Error != "" {
				response["error"] = s.Error
				w.WriteHeader(http.StatusInternalServerError)
			}

			json.NewEncoder(w).Encode(response)
		})

		// Get saga status
		r.Get("/sagas/{sagaID}", func(w http.ResponseWriter, r *http.Request) {
			sagaID := chi.URLParam(r, "sagaID")

			s, err := sagaOrchestrator.GetSaga(r.Context(), sagaID)
			if err != nil {
				http.Error(w, err.Error(), http.StatusNotFound)
				return
			}

			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(s)
		})
	})

	// Create server
	server := &http.Server{
		Addr:         ":" + getEnv("PORT", "8080"),
		Handler:      r,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 60 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// Start server
	go func() {
		logger.Info("Starting server", "addr", server.Addr)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Server error: %v", err)
		}
	}()

	// Wait for shutdown signal
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	logger.Info("Shutting down server...")

	// Cancel background workers
	outboxCancel()
	sagaCancel()

	// Graceful shutdown
	ctx, cancel = context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := server.Shutdown(ctx); err != nil {
		log.Fatalf("Server shutdown error: %v", err)
	}

	// Close connections
	idempotencyStore.Close()
	redisClient.Close()

	logger.Info("Server stopped")
}

func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

func extractUserID(r *http.Request) string {
	// In production, extract from JWT or session
	return r.Header.Get("X-User-ID")
}

type mockMessagePublisher struct {
	logger *slog.Logger
}

func (p *mockMessagePublisher) Publish(ctx context.Context, topic string, key string, payload []byte) error {
	p.logger.Info("Publishing message",
		"topic", topic,
		"key", key,
		"payload_size", len(payload),
	)
	return nil
}

func runMigrations(db *sql.DB) error {
	migrations := []string{
		`CREATE TABLE IF NOT EXISTS idempotency_responses (
			key VARCHAR(512) PRIMARY KEY,
			status_code INTEGER NOT NULL,
			headers JSONB NOT NULL,
			body BYTEA,
			request_hash VARCHAR(64),
			created_at TIMESTAMP NOT NULL,
			expires_at TIMESTAMP NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS idempotency_metadata (
			key VARCHAR(512) PRIMARY KEY,
			status VARCHAR(32) NOT NULL,
			created_at TIMESTAMP NOT NULL,
			completed_at TIMESTAMP,
			expires_at TIMESTAMP NOT NULL,
			request_hash VARCHAR(64),
			response_status INTEGER,
			retry_count INTEGER DEFAULT 0,
			last_retry_at TIMESTAMP
		)`,
		// Locks are rows, not advisory locks, so that they carry a real expiry
		// and an ownership token. See PostgresStore.Lock for why.
		`CREATE TABLE IF NOT EXISTS idempotency_locks (
			key VARCHAR(512) PRIMARY KEY,
			token VARCHAR(64) NOT NULL,
			expires_at TIMESTAMPTZ NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS sagas (
			id VARCHAR(64) PRIMARY KEY,
			type VARCHAR(128) NOT NULL,
			status VARCHAR(32) NOT NULL,
			state JSONB NOT NULL,
			current_step INTEGER NOT NULL DEFAULT 0,
			error TEXT,
			created_at TIMESTAMP NOT NULL,
			updated_at TIMESTAMP NOT NULL,
			completed_at TIMESTAMP,
			idempotency_key VARCHAR(256) UNIQUE
		)`,
		`CREATE TABLE IF NOT EXISTS saga_steps (
			saga_id VARCHAR(64) NOT NULL REFERENCES sagas(id),
			step_index INTEGER NOT NULL,
			step_name VARCHAR(128) NOT NULL,
			status VARCHAR(32) NOT NULL,
			error TEXT,
			result JSONB,
			executed_at TIMESTAMP,
			compensated_at TIMESTAMP,
			PRIMARY KEY (saga_id, step_index)
		)`,
		`CREATE TABLE IF NOT EXISTS outbox (
			id VARCHAR(64) PRIMARY KEY,
			aggregate_id VARCHAR(128) NOT NULL,
			event_type VARCHAR(128) NOT NULL,
			payload BYTEA NOT NULL,
			created_at TIMESTAMP NOT NULL,
			processed_at TIMESTAMP
		)`,
		`CREATE INDEX IF NOT EXISTS idx_idempotency_responses_expires ON idempotency_responses(expires_at)`,
		`CREATE INDEX IF NOT EXISTS idx_idempotency_locks_expires ON idempotency_locks(expires_at)`,
		`CREATE INDEX IF NOT EXISTS idx_sagas_status ON sagas(status)`,
		`CREATE INDEX IF NOT EXISTS idx_sagas_updated ON sagas(updated_at)`,
		`CREATE INDEX IF NOT EXISTS idx_outbox_unprocessed ON outbox(created_at) WHERE processed_at IS NULL`,
	}

	for _, migration := range migrations {
		if _, err := db.Exec(migration); err != nil {
			return err
		}
	}

	return nil
}
```

### Dockerfile

The two-stage build produces a statically-linked binary with no CGO dependencies so it runs identically on any Linux container without concern for glibc version mismatches. The runtime image runs as a non-root user and includes only the binary and CA certificates, reducing the attack surface to the minimum required for a service that makes outbound TLS connections to Redis and PostgreSQL.

```dockerfile
# Build stage
FROM golang:1.27.1-alpine AS builder

WORKDIR /app

# Install build dependencies
RUN apk add --no-cache git ca-certificates

# Copy go mod files
COPY go.mod go.sum ./
RUN go mod download

# Copy source
COPY . .

# Build
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
    -ldflags="-w -s -X main.version=$(git describe --tags --always --dirty 2>/dev/null || echo dev)" \
    -o /idempotency-server ./cmd/server

# Runtime stage
FROM alpine:3.19

WORKDIR /app

# Install runtime dependencies
RUN apk add --no-cache ca-certificates tzdata

# Copy binary
COPY --from=builder /idempotency-server /app/server

# Create non-root user
RUN adduser -D -g '' appuser
USER appuser

# Expose port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

# Run
CMD ["/app/server"]
```

### docker-compose.yml

The Compose stack provisions the complete runtime environment: the application server, Redis for distributed locking and response caching, PostgreSQL for saga state and the transactional outbox, and Prometheus for scraping metrics. Service `depends_on` health-check conditions prevent the application from starting before both Redis and PostgreSQL are accepting connections, avoiding the race conditions that commonly cause container startup failures in integration test environments.

```yaml
# No `version:` key: obsolete since Compose V2.

services:
  app:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "8080:8080"
    environment:
      - PORT=8080
      - DATABASE_URL=postgres://postgres:postgres@postgres:5432/idempotency?sslmode=disable
      - REDIS_ADDR=redis:6379
      - REDIS_PASSWORD=
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:8080/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s

  postgres:
    image: postgres:18-alpine
    environment:
      - POSTGRES_USER=postgres
      - POSTGRES_PASSWORD=postgres
      - POSTGRES_DB=idempotency
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 5s
      retries: 5

  redis:
    image: redis:8-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 5
    command: redis-server --appendonly yes

  # Optional: Kafka for production message queue
  kafka:
    image: confluentinc/cp-kafka:7.5.0
    depends_on:
      - zookeeper
    ports:
      - "9092:9092"
    environment:
      KAFKA_BROKER_ID: 1
      KAFKA_ZOOKEEPER_CONNECT: zookeeper:2181
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://kafka:29092,PLAINTEXT_HOST://localhost:9092
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: PLAINTEXT:PLAINTEXT,PLAINTEXT_HOST:PLAINTEXT
      KAFKA_INTER_BROKER_LISTENER_NAME: PLAINTEXT
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1
    profiles:
      - full

  zookeeper:
    image: confluentinc/cp-zookeeper:7.5.0
    ports:
      - "2181:2181"
    environment:
      ZOOKEEPER_CLIENT_PORT: 2181
    profiles:
      - full

volumes:
  postgres_data:
  redis_data:
```

### Makefile

The Makefile provides a `docker-up` target that starts the full Compose stack and a `docker-down` target for teardown, making it easy to spin up the complete dependency graph for local integration testing with a single command. The `coverage` target generates an HTML coverage report from the test run, giving developers a visual map of which idempotency and saga code paths are exercised by the test suite.

```makefile
.PHONY: all build run test clean docker docker-up docker-down lint fmt coverage help

# Go parameters
GOCMD=go
GOBUILD=$(GOCMD) build
GOCLEAN=$(GOCMD) clean
GOTEST=$(GOCMD) test
GOGET=$(GOCMD) get
GOMOD=$(GOCMD) mod
GOFMT=gofmt
GOLINT=golangci-lint

# Binary name
BINARY_NAME=idempotency-server
BINARY_PATH=./cmd/server

# Docker
DOCKER_COMPOSE=docker compose
DOCKER_IMAGE=idempotency-framework

# Version
VERSION?=$(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
BUILD_TIME=$(shell date -u '+%Y-%m-%d_%H:%M:%S')
LDFLAGS=-ldflags "-X main.version=$(VERSION) -X main.buildTime=$(BUILD_TIME)"

all: lint test build
```

### Staff Lens: Framework as Template

Ship idempotency framework as shared library. Every mutation API imports it. Consistency across services.
