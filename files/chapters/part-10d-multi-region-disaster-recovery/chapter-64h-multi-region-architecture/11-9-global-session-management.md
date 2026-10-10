## 9. Global Session Management

Sessions in a multi-region system must be readable in the region closest to the user. We use a Redis-backed store with cross-region replication. When a user logs in, the session is created in the local Redis cluster for fast access, and then replicated asynchronously to Redis clusters in all other regions. If the user's next request is routed to a different region (due to DNS changes or failover), the session store first checks the local Redis. If it misses, it queries all remote clusters in parallel and warms the local cache with the result. This "local-first with remote fallback" pattern avoids adding cross-region latency to every single authenticated request, which would happen if you used a single global Redis instance.

```go
// session/store.go
package session

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"
)

// ErrSessionNotFound is returned when no session exists for the given ID.
var ErrSessionNotFound = errors.New("session not found")

// Session holds authenticated user state.
type Session struct {
	ID         string            `json:"id"`
	UserID     string            `json:"user_id"`
	Region     string            `json:"region"`      // region where session was created
	Data       map[string]string `json:"data"`
	CreatedAt  time.Time         `json:"created_at"`
	ExpiresAt  time.Time         `json:"expires_at"`
	LastSeenAt time.Time         `json:"last_seen_at"`
}

// IsExpired returns true if the session has passed its expiry time.
func (s *Session) IsExpired() bool {
	return time.Now().UTC().After(s.ExpiresAt)
}

// RedisClient is the minimal interface the store needs.
// Implementations: go-redis, rueidis, etc.
type RedisClient interface {
	Set(ctx context.Context, key string, value []byte, ttl time.Duration) error
	Get(ctx context.Context, key string) ([]byte, error)
	Del(ctx context.Context, key string) error
	Exists(ctx context.Context, key string) (bool, error)
}

// Store manages sessions across multiple Redis clusters.
type Store struct {
	local      RedisClient            // local region Redis - low latency reads
	remotes    map[string]RedisClient // other region Redis clusters
	ttl        time.Duration
	localRegion string
	logger     *slog.Logger
}

// NewStore constructs a session store.
func NewStore(
	localRegion string,
	local RedisClient,
	remotes map[string]RedisClient,
	ttl time.Duration,
	logger *slog.Logger,
) *Store {
	return &Store{
		local:       local,
		remotes:     remotes,
		ttl:         ttl,
		localRegion: localRegion,
		logger:      logger,
	}
}

// Create persists a new session locally and replicates to all remote regions.
func (s *Store) Create(ctx context.Context, userID string, data map[string]string) (*Session, error) {
	id, err := generateSessionID()
	if err != nil {
		return nil, fmt.Errorf("generating session ID: %w", err)
	}

	now := time.Now().UTC()
	sess := &Session{
		ID:         id,
		UserID:     userID,
		Region:     s.localRegion,
		Data:       data,
		CreatedAt:  now,
		ExpiresAt:  now.Add(s.ttl),
		LastSeenAt: now,
	}

	raw, err := json.Marshal(sess)
	if err != nil {
		return nil, fmt.Errorf("marshalling session: %w", err)
	}

	key := sessionKey(id)
	if err := s.local.Set(ctx, key, raw, s.ttl); err != nil {
		return nil, fmt.Errorf("persisting session locally: %w", err)
	}

	// Replicate asynchronously to remote regions.
	go s.replicateToRemotes(context.Background(), key, raw)

	s.logger.InfoContext(ctx, "session created", "id", id, "user", userID, "region", s.localRegion)
	return sess, nil
}

// Get reads a session, trying local first then remote regions.
func (s *Store) Get(ctx context.Context, id string) (*Session, error) {
	key := sessionKey(id)

	raw, err := s.local.Get(ctx, key)
	if err == nil {
		return s.unmarshalAndValidate(raw)
	}

	// Try remote regions in parallel.
	type result struct {
		sess *Session
		err  error
	}
	ch := make(chan result, len(s.remotes))
	for regionID, client := range s.remotes {
		go func(rid string, c RedisClient) {
			data, err := c.Get(ctx, key)
			if err != nil {
				ch <- result{err: err}
				return
			}
			sess, err := s.unmarshalAndValidate(data)
			ch <- result{sess: sess, err: err}
			if err == nil {
				// Warm local cache.
				_ = s.local.Set(ctx, key, data, time.Until(sess.ExpiresAt))
				s.logger.DebugContext(ctx, "session cache warmed from remote",
					"id", id, "source_region", rid)
			}
		}(regionID, client)
	}

	for range s.remotes {
		res := <-ch
		if res.err == nil {
			return res.sess, nil
		}
	}

	return nil, ErrSessionNotFound
}

// Invalidate deletes a session from all regions.
func (s *Store) Invalidate(ctx context.Context, id string) error {
	key := sessionKey(id)
	if err := s.local.Del(ctx, key); err != nil {
		s.logger.WarnContext(ctx, "local delete failed", "id", id, "err", err)
	}
	for regionID, client := range s.remotes {
		go func(rid string, c RedisClient) {
			if err := c.Del(ctx, key); err != nil {
				s.logger.Warn("remote delete failed",
					"id", id, "region", rid, "err", err)
			}
		}(regionID, client)
	}
	return nil
}

func (s *Store) replicateToRemotes(ctx context.Context, key string, raw []byte) {
	for regionID, client := range s.remotes {
		if err := client.Set(ctx, key, raw, s.ttl); err != nil {
			s.logger.Warn("session replication failed",
				"region", regionID, "key", key, "err", err)
		}
	}
}

func (s *Store) unmarshalAndValidate(raw []byte) (*Session, error) {
	var sess Session
	if err := json.Unmarshal(raw, &sess); err != nil {
		return nil, fmt.Errorf("unmarshalling session: %w", err)
	}
	if sess.IsExpired() {
		return nil, ErrSessionNotFound
	}
	return &sess, nil
}

func sessionKey(id string) string {
	return "session:" + id
}

func generateSessionID() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}
```

---

### Junior -> FAANG: Session Consistency and the Login-Then-Read Pattern

The most common session consistency bug in multi-region systems is the login-then-immediate-read failure. A user logs in, the session is created in us-east-1 and asynchronously replicated to eu-west-1. The user's next request is routed to eu-west-1 (because they are in Europe). eu-west-1 does a local Redis lookup, finds no session (replication has not completed yet), and returns HTTP 401 Unauthorized. From the user's perspective they just logged in and are immediately logged out.

The `Store.Get` method in this section solves this with the remote fallback: if the local Redis misses, query all remote regions in parallel and warm the local cache with the result. This pattern is called read-repair and it is a standard technique in eventually consistent systems.

For interviews: the session store demonstrates the "local-first with remote fallback" pattern. Memorize the three latency tiers: local Redis hit (1-2ms), local Redis miss then remote Redis hit (30-100ms depending on cross-region network), remote Redis miss then user must re-authenticate (100ms+ plus user friction). The goal of cache warming is to make the second tier rare.

### Senior @ FAANG: Session Infrastructure at Platform Scale

**Asynchronous replication is a consistency decision, not just a performance choice.** The `replicateToRemotes` call is async (via a goroutine). This means session creation acknowledges to the user before replication completes. If the application process crashes between acknowledging and replicating, the session exists only in local Redis. After a region failover, the user is logged out. For most consumer applications this is acceptable (the user re-authenticates). For payment flows where session loss mid-checkout is costly, synchronous replication to at least one remote region before acknowledging login is the correct trade-off, at the cost of ~50-150ms additional login latency.

**Session invalidation races across regions.** The `Invalidate` method deletes from local Redis immediately and fires async goroutines to delete from remotes. During the async window, a request from a different region may successfully authenticate using the session that was "already" invalidated. This is a security concern for forced logout scenarios (compromised account, admin lockout). A production implementation uses a short-TTL global revocation list (separate from the session store) that is checked before every session validation. The revocation list is small (only invalidated sessions in the last N minutes) and can be replicated synchronously.

**Session affinity versus session roaming trade-offs.** Session affinity routes a user to the same region for the lifetime of their session, avoiding cross-region reads entirely at the cost of potentially routing them to a non-optimal region. Session roaming allows any region to serve any session but requires the remote fallback pattern shown above. At L6, you make this choice explicitly based on: (1) the read-repair miss rate you observe in production, (2) the user experience impact of the ~100ms fallback latency, and (3) the complexity cost of maintaining affinity routing (sticky sessions in load balancers). Document the choice in the service runbook.

**Redis Cluster versus standalone Redis for session storage.** A single Redis instance per region is a single point of failure within that region. A Redis Cluster (with at minimum 3 primary shards and 3 replicas) provides intra-region HA. However, cross-region session replication to a cluster requires awareness of the cluster topology. A production implementation uses a Redis Cluster SDK (rueidis, go-redis Cluster mode) and writes session data using the session ID as the cluster key, ensuring all replication writes for a given session go to the same shard.

**Key TTL management during session extension.** The current `Store.Get` warms the local cache using `time.Until(sess.ExpiresAt)` as TTL. If the session is near expiry (1 minute remaining), the warmed cache entry has a 1-minute TTL. If the session is then extended (rolling TTL on activity), the local cache entry still expires in 1 minute and requires another remote fallback. A production session store extends the TTL in Redis on every successful read (rolling expiry), and the remote fallback warm-up sets the TTL to the configured session duration, not the remaining time.
