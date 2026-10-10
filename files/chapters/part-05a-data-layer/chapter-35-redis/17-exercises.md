## Exercises

### Exercise 1: Build a Session Store with Security Features

Build a session store with device tracking and session limits.

**Solution**:

```go
package session

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"
)

type SecureSession struct {
	ID         string    `json:"id"`
	UserID     string    `json:"user_id"`
	DeviceID   string    `json:"device_id"`
	UserAgent  string    `json:"user_agent"`
	IPAddress  string    `json:"ip_address"`
	CreatedAt  time.Time `json:"created_at"`
	LastActive time.Time `json:"last_active"`
}

type SecureStore struct {
	rdb           *redis.Client
	prefix        string
	ttl           time.Duration
	maxSessions   int
}

func NewSecureStore(rdb *redis.Client, prefix string, ttl time.Duration, maxSessions int) *SecureStore {
	return &SecureStore{
		rdb:         rdb,
		prefix:      prefix,
		ttl:         ttl,
		maxSessions: maxSessions,
	}
}

func (s *SecureStore) Create(ctx context.Context, userID, deviceID, userAgent, ip string) (*SecureSession, error) {
	sessionID := generateSecureID()

	session := &SecureSession{
		ID:         sessionID,
		UserID:     userID,
		DeviceID:   deviceID,
		UserAgent:  userAgent,
		IPAddress:  ip,
		CreatedAt:  time.Now(),
		LastActive: time.Now(),
	}

	// Check existing sessions
	existingSessions, _ := s.GetUserSessions(ctx, userID)
	if len(existingSessions) >= s.maxSessions {
		// Remove oldest session
		oldest := existingSessions[0]
		for _, sess := range existingSessions {
			if sess.CreatedAt.Before(oldest.CreatedAt) {
				oldest = sess
			}
		}
		s.Delete(ctx, oldest.ID)
	}

	data, _ := json.Marshal(session)

	pipe := s.rdb.Pipeline()
	pipe.Set(ctx, s.prefix+"session:"+sessionID, data, s.ttl)
	pipe.SAdd(ctx, s.prefix+"user:"+userID+":sessions", sessionID)
	pipe.Expire(ctx, s.prefix+"user:"+userID+":sessions", s.ttl+time.Hour)

	_, err := pipe.Exec(ctx)
	if err != nil {
		return nil, err
	}

	return session, nil
}

func (s *SecureStore) GetUserSessions(ctx context.Context, userID string) ([]*SecureSession, error) {
	sessionIDs, err := s.rdb.SMembers(ctx, s.prefix+"user:"+userID+":sessions").Result()
	if err != nil {
		return nil, err
	}

	if len(sessionIDs) == 0 {
		return nil, nil
	}

	pipe := s.rdb.Pipeline()
	cmds := make([]*redis.StringCmd, len(sessionIDs))
	for i, id := range sessionIDs {
		cmds[i] = pipe.Get(ctx, s.prefix+"session:"+id)
	}
	pipe.Exec(ctx)

	var sessions []*SecureSession
	for _, cmd := range cmds {
		data, err := cmd.Bytes()
		if err != nil {
			continue
		}
		var session SecureSession
		json.Unmarshal(data, &session)
		sessions = append(sessions, &session)
	}

	return sessions, nil
}

func (s *SecureStore) Delete(ctx context.Context, sessionID string) error {
	session, err := s.Get(ctx, sessionID)
	if err != nil {
		return err
	}

	pipe := s.rdb.Pipeline()
	pipe.Del(ctx, s.prefix+"session:"+sessionID)
	pipe.SRem(ctx, s.prefix+"user:"+session.UserID+":sessions", sessionID)
	_, err = pipe.Exec(ctx)
	return err
}

func (s *SecureStore) Get(ctx context.Context, sessionID string) (*SecureSession, error) {
	data, err := s.rdb.Get(ctx, s.prefix+"session:"+sessionID).Bytes()
	if err == redis.Nil {
		return nil, errors.New("session not found")
	}
	if err != nil {
		return nil, err
	}

	var session SecureSession
	json.Unmarshal(data, &session)
	return &session, nil
}

func generateSecureID() string {
	b := make([]byte, 32)
	rand.Read(b)
	return base64.URLEncoding.EncodeToString(b)
}
```

### Exercise 2: Build a Real-Time Leaderboard with Percentiles

Create a leaderboard with percentile rankings and time-based decay.

**Solution**:

```go
package leaderboard

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

type AdvancedLeaderboard struct {
	rdb    *redis.Client
	prefix string
}

type LeaderboardEntry struct {
	UserID     string  `json:"user_id"`
	Score      float64 `json:"score"`
	Rank       int64   `json:"rank"`
	Percentile float64 `json:"percentile"`
}

func NewAdvancedLeaderboard(rdb *redis.Client, prefix string) *AdvancedLeaderboard {
	return &AdvancedLeaderboard{rdb: rdb, prefix: prefix}
}

// AddScoreWithDecay adds score that decays over time
func (l *AdvancedLeaderboard) AddScoreWithDecay(ctx context.Context, board, userID string, baseScore float64, timestamp time.Time) error {
	// Apply time decay (score decreases with age)
	age := time.Since(timestamp).Hours()
	decayFactor := 1.0 / (1.0 + age/24.0) // Half decay per day
	adjustedScore := baseScore * decayFactor

	return l.rdb.ZAdd(ctx, l.prefix+board, redis.Z{
		Score:  adjustedScore,
		Member: userID,
	}).Err()
}

// GetRankWithPercentile returns rank and percentile
func (l *AdvancedLeaderboard) GetRankWithPercentile(ctx context.Context, board, userID string) (*LeaderboardEntry, error) {
	pipe := l.rdb.Pipeline()
	rankCmd := pipe.ZRevRank(ctx, l.prefix+board, userID)
	scoreCmd := pipe.ZScore(ctx, l.prefix+board, userID)
	countCmd := pipe.ZCard(ctx, l.prefix+board)

	_, err := pipe.Exec(ctx)
	if err != nil && err != redis.Nil {
		return nil, err
	}

	rank := rankCmd.Val()
	score := scoreCmd.Val()
	count := countCmd.Val()

	percentile := 0.0
	if count > 0 {
		percentile = (1.0 - float64(rank)/float64(count)) * 100
	}

	return &LeaderboardEntry{
		UserID:     userID,
		Score:      score,
		Rank:       rank,
		Percentile: percentile,
	}, nil
}

// GetTopWithPercentiles returns top N with percentiles
func (l *AdvancedLeaderboard) GetTopWithPercentiles(ctx context.Context, board string, n int64) ([]LeaderboardEntry, error) {
	pipe := l.rdb.Pipeline()
	resultsCmd := pipe.ZRevRangeWithScores(ctx, l.prefix+board, 0, n-1)
	countCmd := pipe.ZCard(ctx, l.prefix+board)

	_, err := pipe.Exec(ctx)
	if err != nil {
		return nil, err
	}

	results := resultsCmd.Val()
	count := countCmd.Val()

	entries := make([]LeaderboardEntry, len(results))
	for i, r := range results {
		percentile := 0.0
		if count > 0 {
			percentile = (1.0 - float64(i)/float64(count)) * 100
		}

		entries[i] = LeaderboardEntry{
			UserID:     r.Member.(string),
			Score:      r.Score,
			Rank:       int64(i),
			Percentile: percentile,
		}
	}

	return entries, nil
}

// RefreshDecayedScores recalculates all scores with current decay
func (l *AdvancedLeaderboard) RefreshDecayedScores(ctx context.Context, board string) error {
	// This would typically read from a persistent store
	// For demo, we just apply decay to existing scores
	members, err := l.rdb.ZRangeWithScores(ctx, l.prefix+board, 0, -1).Result()
	if err != nil {
		return err
	}

	pipe := l.rdb.Pipeline()
	for _, m := range members {
		// Apply decay (reduce by 1% per refresh)
		newScore := m.Score * 0.99
		pipe.ZAdd(ctx, l.prefix+board, redis.Z{
			Score:  newScore,
			Member: m.Member,
		})
	}

	_, err = pipe.Exec(ctx)
	return err
}
```

### Junior to FAANG: Exercise Debrief and What to Practice Next

Exercises in this chapter are starting points. A junior engineer gets them working, runs the happy path, and moves on. A mid-level engineer extends them with failure modes, stress tests, and a code review checklist. The goal of this debrief is to show the gap and how to close it.

Session store exercise gaps to close:
- The error discarding on `rand.Read(b)` will silently produce a predictable ID if the entropy source fails. Check the error and fail closed.
- `pipe.Exec(ctx)` result is discarded in GetUserSessions. If the pipeline fails mid-execution, you return stale data. Handle the error.
- The maxSessions enforcement reads the full set, sorts in Go, and writes. Under concurrent session creation this is a classic TOCTOU race. Two logins at the same moment both see "limit not exceeded" and both create sessions, leaving N+1 sessions. Fix with a Lua script that atomically reads cardinality, evicts oldest if needed, and creates the new session.
- No pagination on GetUserSessions. A user with 1000 sessions returns 1000 entries every time. Add pagination or enforce a hard cap.
- No rate limiting on Create. A brute force login attempt bypasses session limits by attacking from multiple devices. Add per-user session creation rate limit at one per 5 seconds.

Leaderboard exercise gaps to close:
- Time decay applied at write time is a one-way function. Future reads do not re-decay. The RefreshDecayedScores batch reapplies decay but introduces drift because the decay function is not idempotent under repeated application. Decouple stored score from displayed score: store raw score plus last-updated timestamp, compute decayed score at read time.
- The leaderboard is a single sorted set. At 1B entries this breaks. The exercise should include a design note on shard-by-score-range or shard-by-user-bucket once cardinality exceeds 10M.
- No tie-breaking. Two users with the same score have non-deterministic rank. Use a composite score (base score times 1e6 plus reverse-timestamp) to stabilize ordering.
- RefreshDecayedScores uses ZRangeWithScores 0, -1 which materializes the entire set in memory on the client and issues one write per member. For 10M members this is an OOM risk on the client and a pipeline buffer blowout. Use ZSCAN with bounded batches and chunked pipelines.

Why did this fail reflex for exercises. When an exercise solution "works" in local testing but fails in production, the question to ask is "what assumption did the exercise make that production violates." Common answers: single client, single goroutine, bounded cardinality, no failures, no clock skew, no adversarial input. Every one of these is false in production. Training yourself to enumerate violated assumptions is the senior engineer's secret skill.

Interview entry-point. Both exercises map to bar-raiser questions from section 35.12. Session store connects to "design a chat system with Redis" (substitute session for chat message). Leaderboard connects directly to "design a leaderboard for 1B users." Practicing these exercises, identifying the gaps, and articulating the fixes is exactly the preparation a staff-level interview expects.

Next practice set for junior to mid transition:
- Implement a distributed rate limiter (token bucket) in Lua with atomic check-and-update. Verify correctness with two concurrent goroutines racing to consume the last token.
- Implement cache-aside with single-flight, TTL jitter, and proactive refresh for a synthetic backend with 500 ms latency. Measure p99 under a simulated stampede (1000 goroutines requesting the same key at the same moment after a TTL expiry).
- Implement a distributed lock with fencing tokens. Write a test that pauses the lock holder beyond the TTL and verifies the protected resource rejects the stale holder's write.
- Implement a Redis Cluster-aware Lua script that uses hashtags and verifies it passes CROSSSLOT validation across 10 keys.

### Senior at FAANG: Exercise Rubric, Code Review Checklist, and Extension to Production Scale

Staff and principal engineers do not just solve exercises. They review exercise solutions as if they were production code. Below is the review rubric used at bar-raiser level, applied to the two exercises in this section.

Code review rubric for Redis code:
- Error handling: every Redis call checks redis.Nil and other errors separately. Pipelines check Exec error. JSON unmarshal checks error. Score: 0/5/10 (none, some, all).
- Atomicity: any read-modify-write sequence is a Lua script or WATCH/MULTI/EXEC transaction. TOCTOU races across multiple Redis calls are identified and fixed. Score: 0/5/10.
- Cluster safety: multi-key operations use hashtags or are flagged as single-instance-only. No KEYS, no unbounded MGET. Score: 0/5/10.
- Memory discipline: every write has an explicit TTL or is justified as durable. Collection types (sets, hashes, sorted sets) have a documented max cardinality. Score: 0/5/10.
- Performance: operations have documented big-O complexity with respect to Redis command cost. ZRANGE 0, -1 flagged as O(N), ZRANGEBYSCORE with LIMIT as O(log N plus M). Score: 0/5/10.
- Observability: slow operations logged with the key and timing. Hit/miss rate tracked. Error rate tracked. Score: 0/5/10.
- Security: keys are namespaced per tenant. User input is not concatenated into keys without validation (key injection risk). ACL-aware access. Score: 0/5/10.
- Testability: data access is behind an interface. Tests cover error cases not just happy path. Integration tests use a real Redis (testcontainers), not a mock. Score: 0/5/10.

Session store exercise scored on the rubric. Error handling: 3 (pipeline errors discarded, rand.Read error discarded, json.Unmarshal errors discarded). Atomicity: 2 (maxSessions race condition). Cluster safety: 5 (keys use different prefixes but no hashtag discipline, would break in Cluster). Memory discipline: 7 (TTL set, but no cardinality bound on the user sessions set). Performance: 6 (GetUserSessions is O(N) in user's session count). Observability: 0 (no logging, no metrics). Security: 5 (SecureID generation is correct but not validated for replay, no lockout on brute force). Testability: 3 (no interface, struct is directly couple to redis.Client). Overall: 31/80. Not production-ready at L3+ maturity.

Leaderboard exercise scored on the rubric. Error handling: 5. Atomicity: 7 (AddScore is single op, RefreshDecayedScores is not atomic with concurrent writes). Cluster safety: 8 (single key per board, safe but not scalable). Memory discipline: 3 (no cardinality bound, no TTL on the leaderboard itself). Performance: 4 (RefreshDecayedScores is O(N) with client-side materialization). Observability: 0. Security: 5. Testability: 4. Overall: 36/80. Needs extension for production.

Extension to production scale. The gap between exercise and production is where the staff engineer earns their title. Concrete extensions:

Session store at production scale:
- Shard by tenant prefix when multi-tenant. Hashtag keys as `{tenant:T}:session:S` and `{tenant:T}:user:U:sessions` to colocate.
- Replace maxSessions race with Lua script that atomically acquires slot, evicts oldest, and creates new. Script is cluster-safe via hashtag.
- Add device fingerprint validation against stored IP/UserAgent with an anomaly score. Sessions with high anomaly require MFA reprompt.
- Add idempotency on session creation: the same login request arriving twice via retry produces one session, not two. Key the idempotency on a client-generated request ID with 60-second TTL.
- Add revocation list with server-generated revocation tokens. Logout does not just delete the session. It publishes the revocation to all gateway servers via Pub/Sub.
- Observability: hit rate on Get, duration histogram on Create, gauge for active sessions per user, counter for session evictions, counter for MFA challenges.
- SLOs: p99 Get under 2 ms, p99 Create under 10 ms, availability 99.99 percent.

Leaderboard at production scale:
- Sharded storage: hot top-10K users in a single sorted set, next 1M in 100 sharded sorted sets by user hash modulo, next 10M in cold storage queried lazily.
- Score computation decoupled from storage: raw score and event stream stored separately, decayed score computed at read time using a time-since-update multiplier.
- Aggregation: for "rank of user across all shards," maintain a summary sorted set updated asynchronously from the shard updates, accepting bounded staleness.
- Observability: gauge for total users, histogram for rank query latency, counter for shard fetch count, gauge for shard skew (max over median shard size).
- SLOs: p99 top 100 query under 5 ms, p99 rank-of-user query under 20 ms (potentially spanning multiple shards), update lag under 60 seconds.

ADR connection. Every exercise extension above corresponds to an ADR entry: why shard, how shard, when shard. The exercise is the learning vehicle. The ADR is the artifact that survives a team member leaving. A staff engineer's deliverable is not code. It is the ADR library that makes the code decisions reviewable and teachable.

Bar-raiser closing question on exercises. "Take the leaderboard exercise and walk me through what breaks at 1M users, at 100M users, and at 1B users, and what you change at each scale." The expected answer is not a single design. It is three designs with a migration path between them, cost trade-offs at each level, and an honest articulation of what you would skip until the data forces you to build it. Premature sharding is as bad as late sharding. Knowing when to invest is the senior signal.

---
