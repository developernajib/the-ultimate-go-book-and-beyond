## 90J.22 Performance Anti-Patterns That Kill Production

Production performance failures rarely come from exotic edge cases. They come from a small set of well-known
anti-patterns that every senior engineer should recognize on sight. Each of the following incidents represents
a pattern that has caused outages at hundreds of companies. The Go code provides battle-tested defenses.

### The Cache Stampede (Shopify Black Friday 2019)

During Black Friday 2019, Shopify experienced an 8-minute outage that cost merchants an estimated $10 million
in lost sales. The root cause was a **cache stampede** - also called "thundering herd" or "dog-pile."

A popular product page's cache entry expired at 11:42 AM, precisely during peak traffic. At that moment,
47,000 concurrent requests arrived for the same page. Since the cache was empty, all 47,000 requests passed
through to the database simultaneously. The database, sized to handle approximately 5,000 queries per second
for this table, received 47,000 queries in under a second. Connection pools exhausted, queries timed out,
and the cascade spread to other product pages as the overloaded database slowed all queries.

The fix is **singleflight**: ensuring that only one request computes the cache value while all others wait
for the result.

### The N+1 Query Bomb

A social media startup launched with an ORM that used lazy loading for relationships. In development with
10 users, loading a feed page executed 2 SQL queries (one for posts, one for authors). In production with
1,000 posts per page, each author lookup was a separate query: 1 query for posts + 1,000 queries for authors
= 1,001 queries per page load. The page took 12 seconds to render. The team spent weeks blaming the
database before a junior engineer added SQL query logging and discovered the pattern.

### Connection Pool Exhaustion (Clerk 2025)

In January 2025, Clerk (authentication-as-a-service) experienced recurring outages every 15 minutes. They
had upgraded their PostgreSQL connection pooler from PgBouncer to a newer solution. The old PgBouncer
configuration had implicitly rate-limited connections due to a conservative `default_pool_size` setting.
The new pooler removed this implicit limit, allowing bursts of connections that overwhelmed PostgreSQL's
`max_connections`. The pattern was "bus bunching" - connections arrived in waves, exhausting the pool, causing
timeouts, which released connections simultaneously, which created the next wave 15 minutes later.

### The Retry Storm (Coinbase 2020)

In November 2020, Coinbase experienced a 78-minute outage during a Bitcoin price surge. The initial trigger
was a TLS certificate rotation error that caused 502 errors for approximately 3 seconds. However, their
client SDK retried failed requests up to 5 times with no backoff. The 3-second error window generated a
5x traffic multiplier that persisted for 78 minutes because each wave of retries generated new failures,
which generated new retries. Even after the certificate was fixed at T+5 minutes, the retry storm
sustained itself for over an hour.

### Hot Partition (DynamoDB)

A gaming company stored player session data in DynamoDB using the partition key `game_id`. They had one
extremely popular game that received 95% of all traffic. Despite provisioning 50,000 write capacity units
at the table level, writes consistently throttled because DynamoDB distributes capacity across partitions
based on key distribution. One key receiving 95% of traffic meant one partition receiving 95% of writes,
far exceeding the per-partition limit of ~1,000 WCU.

### The Missing Index

A fintech company's transaction table grew to 47 million rows. Query performance degraded gradually until
a critical batch job started timing out. The operations team tripled the connection pool size and added
read replicas. Performance improved temporarily, then degraded again. After six months of whack-a-mole,
a database consultant ran `EXPLAIN ANALYZE` and discovered that the most frequent query - filtering by
`status` and `created_at` - was doing a full table scan because the composite index was in the wrong
column order (`created_at, status` instead of `status, created_at`). Adding the correct index reduced
query time from 4.2 seconds to 3 milliseconds.

### Go Implementation: Production Performance Defenses

Each of the six anti-patterns above has a precise mechanical fix. `StampedeProtectedCache` uses an in-process singleflight map so that only the first goroutine to miss the cache computes the value. The remaining concurrent callers block on a `sync.WaitGroup` and share the result, reducing N database round-trips to exactly one. TTL jitter (adding a random offset up to the configured `jitter` duration) staggers expiry across keys, preventing the synchronized cache-miss waves that triggered Shopify's outage. `RetryBudget` solves the Coinbase amplification loop by tracking the ratio of retries to original requests across a rolling window. Once that ratio crosses the configured ceiling (e.g., 20%), further retries are denied rather than allowed to cascade. `ShardedKey` decouples the logical partition key from the physical write key by appending a random shard index, distributing a hot key's writes across N partitions and resolving the DynamoDB per-partition write-capacity ceiling that no amount of table-level provisioning can overcome.

```go
package perfdefense

import (
	"context"
	"fmt"
	"math"
	"math/rand/v2"
	"sync"
	"sync/atomic"
	"time"
)

// -----------------------------------------------------------------------
// Cache stampede prevention with singleflight
// -----------------------------------------------------------------------

// StampedeProtectedCache wraps a cache with singleflight semantics.
// When a cache miss occurs, only one goroutine computes the new value
// while all others wait for the result.
type StampedeProtectedCache struct {
	cache    CacheBackend
	groups   map[string]*call
	mu       sync.Mutex
	jitter   time.Duration // random TTL variation to prevent synchronized expiry
}

// CacheBackend is the interface for the underlying cache store.
type CacheBackend interface {
	Get(ctx context.Context, key string) ([]byte, bool, error)
	Set(ctx context.Context, key string, value []byte, ttl time.Duration) error
}

type call struct {
	wg  sync.WaitGroup
	val []byte
	err error
}

// NewStampedeProtectedCache creates a cache wrapper that prevents
// stampedes through request coalescing.
func NewStampedeProtectedCache(cache CacheBackend, jitter time.Duration) *StampedeProtectedCache {
	return &StampedeProtectedCache{
		cache:  cache,
		groups: make(map[string]*call),
		jitter: jitter,
	}
}

// GetOrCompute returns the cached value for the key, or computes it
// using the provided function if the cache is empty. Only one concurrent
// caller computes; all others wait for the result.
func (c *StampedeProtectedCache) GetOrCompute(
	ctx context.Context,
	key string,
	ttl time.Duration,
	compute func(ctx context.Context) ([]byte, error),
) ([]byte, error) {
	// Try cache first.
	val, found, err := c.cache.Get(ctx, key)
	if err == nil && found {
		return val, nil
	}

	// Cache miss - use singleflight to prevent stampede.
	c.mu.Lock()
	if existing, ok := c.groups[key]; ok {
		// Another goroutine is already computing this key. Wait for it.
		c.mu.Unlock()
		existing.wg.Wait()
		return existing.val, existing.err
	}

	// This goroutine will compute the value.
	cl := &call{}
	cl.wg.Add(1)
	c.groups[key] = cl
	c.mu.Unlock()

	// Compute the value.
	cl.val, cl.err = compute(ctx)

	if cl.err == nil {
		// Add jitter to TTL to prevent synchronized expiration.
		jitteredTTL := ttl + time.Duration(rand.Int64N(int64(c.jitter)))
		_ = c.cache.Set(ctx, key, cl.val, jitteredTTL)
	}

	// Signal all waiting goroutines.
	cl.wg.Done()

	// Remove from in-flight map.
	c.mu.Lock()
	delete(c.groups, key)
	c.mu.Unlock()

	return cl.val, cl.err
}

// -----------------------------------------------------------------------
// N+1 query detection
// -----------------------------------------------------------------------

// QueryTracker detects N+1 query patterns by monitoring query patterns
// within a request context. If it sees the same query template executed
// more than a threshold number of times, it flags the pattern.
type QueryTracker struct {
	threshold     int
	mu            sync.Mutex
	queryCounts   map[string]*queryStats
	alertCallback func(pattern string, count int)
}

type queryStats struct {
	template string
	count    int
	firstAt  time.Time
	lastAt   time.Time
}

// NewQueryTracker creates a tracker that alerts when a query template
// is executed more than threshold times within a single request.
func NewQueryTracker(threshold int, alertCallback func(pattern string, count int)) *QueryTracker {
	return &QueryTracker{
		threshold:     threshold,
		queryCounts:   make(map[string]*queryStats),
		alertCallback: alertCallback,
	}
}

// Track records a query execution. The template should be the
// parameterized query (e.g., "SELECT * FROM users WHERE id = ?").
func (t *QueryTracker) Track(template string) {
	t.mu.Lock()
	defer t.mu.Unlock()

	stats, exists := t.queryCounts[template]
	if !exists {
		stats = &queryStats{template: template, firstAt: time.Now()}
		t.queryCounts[template] = stats
	}
	stats.count++
	stats.lastAt = time.Now()

	if stats.count == t.threshold {
		t.alertCallback(template, stats.count)
	}
}

// Reset clears the tracker, typically called at the end of a request.
func (t *QueryTracker) Reset() {
	t.mu.Lock()
	t.queryCounts = make(map[string]*queryStats)
	t.mu.Unlock()
}

// Report returns all queries that exceeded the threshold.
func (t *QueryTracker) Report() []string {
	t.mu.Lock()
	defer t.mu.Unlock()

	var violations []string
	for _, stats := range t.queryCounts {
		if stats.count >= t.threshold {
			violations = append(violations, fmt.Sprintf("%s (executed %d times)",
				stats.template, stats.count))
		}
	}
	return violations
}

// -----------------------------------------------------------------------
// Connection pool with jitter and backpressure
// -----------------------------------------------------------------------

// ResilientPool wraps a database connection pool with jitter on
// reconnection to prevent bus bunching, and backpressure signaling
// to prevent pool exhaustion.
type ResilientPool struct {
	maxConns    int
	activeConns atomic.Int32
	waitQueue   atomic.Int32
	maxWait     time.Duration
	baseBackoff time.Duration
	mu          sync.Mutex
	semaphore   chan struct{}
}

// NewResilientPool creates a connection pool that prevents the
// bus-bunching pattern through jittered reconnection.
func NewResilientPool(maxConns int, maxWait time.Duration) *ResilientPool {
	sem := make(chan struct{}, maxConns)
	for i := 0; i < maxConns; i++ {
		sem <- struct{}{}
	}
	return &ResilientPool{
		maxConns:    maxConns,
		maxWait:     maxWait,
		baseBackoff: 100 * time.Millisecond,
		semaphore:   sem,
	}
}

// Acquire obtains a connection from the pool. If the pool is exhausted,
// it waits with jittered backoff rather than all waiters waking
// simultaneously when a connection is returned.
func (p *ResilientPool) Acquire(ctx context.Context) (func(), error) {
	p.waitQueue.Add(1)
	defer p.waitQueue.Add(-1)

	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case token := <-p.semaphore:
		p.activeConns.Add(1)
		release := func() {
			// Jitter on release to prevent bus bunching.
			jitter := time.Duration(rand.Int64N(int64(p.baseBackoff)))
			time.Sleep(jitter)
			p.activeConns.Add(-1)
			p.semaphore <- token
		}
		return release, nil
	case <-time.After(p.maxWait):
		return nil, fmt.Errorf("connection pool exhausted: %d active, %d waiting",
			p.activeConns.Load(), p.waitQueue.Load())
	}
}

// Pressure returns the current utilization as a percentage (0-100).
// Callers can use this for backpressure signaling.
func (p *ResilientPool) Pressure() float64 {
	return float64(p.activeConns.Load()) / float64(p.maxConns) * 100
}

// -----------------------------------------------------------------------
// Retry with budget (prevents retry storms)
// -----------------------------------------------------------------------

// RetryBudget limits the total number of retries across all requests
// within a time window. This prevents the amplification loop where
// retries cause failures which cause more retries.
type RetryBudget struct {
	maxRetryPercent float64 // max retries as % of total requests (e.g., 0.20 = 20%)
	window          time.Duration
	mu              sync.Mutex
	totalRequests   int64
	totalRetries    int64
	windowStart     time.Time
	minRequestsForBudget int64 // minimum requests before budget applies
}

// NewRetryBudget creates a budget that limits retries to a percentage
// of total traffic within a rolling window.
func NewRetryBudget(maxRetryPercent float64, window time.Duration) *RetryBudget {
	return &RetryBudget{
		maxRetryPercent:      maxRetryPercent,
		window:               window,
		windowStart:          time.Now(),
		minRequestsForBudget: 100,
	}
}

// RecordRequest records a first-attempt request.
func (b *RetryBudget) RecordRequest() {
	b.mu.Lock()
	b.maybeRotateWindow()
	b.totalRequests++
	b.mu.Unlock()
}

// AllowRetry checks whether a retry should be permitted based on the
// current budget. Returns false if the retry budget is exhausted.
func (b *RetryBudget) AllowRetry() bool {
	b.mu.Lock()
	defer b.mu.Unlock()

	b.maybeRotateWindow()

	// Always allow retries when traffic is low (avoids division issues).
	if b.totalRequests < b.minRequestsForBudget {
		b.totalRetries++
		return true
	}

	currentRetryRate := float64(b.totalRetries) / float64(b.totalRequests)
	if currentRetryRate >= b.maxRetryPercent {
		return false
	}

	b.totalRetries++
	return true
}

func (b *RetryBudget) maybeRotateWindow() {
	if time.Since(b.windowStart) > b.window {
		b.totalRequests = 0
		b.totalRetries = 0
		b.windowStart = time.Now()
	}
}

// RetryRate returns the current retry rate as a percentage.
func (b *RetryBudget) RetryRate() float64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.totalRequests == 0 {
		return 0
	}
	return float64(b.totalRetries) / float64(b.totalRequests) * 100
}

// -----------------------------------------------------------------------
// Partition key design (prevents hot partitions)
// -----------------------------------------------------------------------

// ShardedKey generates partition keys that distribute traffic evenly
// across partitions, even when the logical key has skewed access patterns.
type ShardedKey struct {
	shardCount int
}

// NewShardedKey creates a key generator with the given number of shards.
// More shards = better distribution but more scatter-gather on reads.
func NewShardedKey(shardCount int) *ShardedKey {
	return &ShardedKey{shardCount: shardCount}
}

// Write returns the partition key for a write operation, appending a
// random shard suffix to distribute writes across partitions.
func (s *ShardedKey) Write(logicalKey string) string {
	shard := rand.IntN(s.shardCount)
	return fmt.Sprintf("%s#%d", logicalKey, shard)
}

// ReadAll returns all partition keys that must be queried to read all
// data for a logical key (scatter-gather pattern).
func (s *ShardedKey) ReadAll(logicalKey string) []string {
	keys := make([]string, s.shardCount)
	for i := 0; i < s.shardCount; i++ {
		keys[i] = fmt.Sprintf("%s#%d", logicalKey, i)
	}
	return keys
}

// -----------------------------------------------------------------------
// Example usage
// -----------------------------------------------------------------------

func ExamplePerformanceDefenses() {
	// 1. Cache stampede prevention.
	// Instead of 47K requests hitting the DB, only 1 computes while
	// 46,999 wait for the result.
	fmt.Println("=== Cache Stampede Prevention ===")
	fmt.Println("Without singleflight: 47,000 DB queries on cache miss")
	fmt.Println("With singleflight: 1 DB query, 46,999 coalesced")

	// 2. N+1 detection.
	tracker := NewQueryTracker(10, func(pattern string, count int) {
		fmt.Printf("N+1 DETECTED: %s executed %d times\n", pattern, count)
	})
	for i := 0; i < 100; i++ {
		tracker.Track("SELECT * FROM users WHERE id = ?")
	}

	// 3. Retry budget.
	budget := NewRetryBudget(0.20, 10*time.Second) // max 20% retries
	for i := 0; i < 100; i++ {
		budget.RecordRequest()
	}
	allowed := 0
	for i := 0; i < 500; i++ {
		if budget.AllowRetry() {
			allowed++
		}
	}
	fmt.Printf("Retry budget: %d of 500 retries allowed (budget: 20%%)\n", allowed)

	// 4. Sharded partition keys.
	shardedKey := NewShardedKey(10)
	writeKey := shardedKey.Write("popular-game-123")
	readKeys := shardedKey.ReadAll("popular-game-123")
	fmt.Printf("Write key: %s (1 of 10 shards)\n", writeKey)
	fmt.Printf("Read scatter: %d keys to query\n", len(readKeys))

	_ = math.MaxInt // avoid unused import
}
```

**The Lesson**: These six anti-patterns - cache stampedes, N+1 queries, connection pool exhaustion, retry storms,
hot partitions, and missing indexes - account for the vast majority of production performance incidents. They
share a common trait: they work perfectly in development and testing, where traffic volumes are low and access
patterns are uniform. They only manifest at production scale, often during the worst possible moment (peak
traffic, promotional events, market volatility). Building the defenses into your infrastructure from day one
is dramatically cheaper than diagnosing them during an outage.

---

### Junior → FAANG: Anti-Pattern Recognition as an Interview Competency

The six anti-patterns in this section are the most common source of production performance failures across all FAANG companies. For system design interviews, being able to proactively name these patterns and their mitigations is a strong signal of production experience. For cache stampedes: use probabilistic early expiration or a single-writer lock to prevent all requests from hitting the database simultaneously on cache miss. For N+1 queries: use database-level join or batch loading to retrieve all related records in a single query, never in a loop. For connection pool exhaustion: size the pool based on the database's connection limit divided by the number of application instances, and configure a connection acquisition timeout that fails fast rather than queuing indefinitely. For retry storms: implement exponential backoff with jitter so that all clients do not retry at the same moment. For hot partitions: include a shard ID in the partition key and scatter writes across N shards. For missing indexes: treat EXPLAIN output on any query that takes more than 50ms as a mandatory review before that query reaches production. Naming the specific mitigation for each pattern, with Go implementation details, demonstrates the depth of knowledge that FAANG performance interviews require.

### Senior @ FAANG: Anti-Pattern Detection as a Platform Quality Gate

At L6, the six anti-patterns should be detectable before they reach production, not after they cause an incident. The staff engineer's contribution is building detection into the development and CI pipeline as automated quality gates. For N+1 query detection: instrument the ORM or database client to log a warning when more than 5 queries are issued to the same table within a single request handler. A CI gate that fails when integration tests trigger N+1 warnings catches the pattern before it reaches production. For connection pool exhaustion detection: alert when pool utilization exceeds 80% for more than 60 seconds, and alert when connection acquisition wait time exceeds 100ms, so pool pressure is visible before it becomes a queue backlog. For hot partition detection: emit per-partition request count metrics and alert when any single partition receives more than 10x the mean partition traffic, so hot spots are detected before they saturate the partition. For retry storm detection: measure the ratio of retry requests to original requests per downstream service, and alert when the ratio exceeds 2.0 for more than 30 seconds. For cache stampede detection: measure the ratio of cache misses to cache hits per key, and alert when a high-cardinality key has a sustained miss rate above 50%. These detection patterns, implemented as platform instrumentation, convert the six anti-patterns from latent risks into visible signals that can be addressed before they cause outages. The investment in detection infrastructure is constant. The benefit is every production incident that does not happen as a result.

---
