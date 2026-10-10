## Exercises

### Exercise 1: Build a Complete Repository with Caching

Build a user repository that implements:
- All CRUD operations
- Query caching with TTL
- Cache invalidation on writes
- Metrics for cache hit/miss rates

**Solution**:

```go
package repository

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"dbapp/internal/model"
)

// CachedUserRepository wraps UserRepository with caching
type CachedUserRepository struct {
	repo  *UserRepository
	cache *Cache
}

// Cache is a simple in-memory cache with TTL
type Cache struct {
	data    map[string]*cacheEntry
	mu      sync.RWMutex
	ttl     time.Duration
	hits    int64
	misses  int64
}

type cacheEntry struct {
	value     []byte
	expiresAt time.Time
}

func NewCache(ttl time.Duration) *Cache {
	c := &Cache{
		data: make(map[string]*cacheEntry),
		ttl:  ttl,
	}
	go c.cleanup()
	return c
}

func (c *Cache) Get(key string) ([]byte, bool) {
	c.mu.RLock()
	entry, ok := c.data[key]
	c.mu.RUnlock()

	if !ok || time.Now().After(entry.expiresAt) {
		atomic.AddInt64(&c.misses, 1)
		return nil, false
	}

	atomic.AddInt64(&c.hits, 1)
	return entry.value, true
}

func (c *Cache) Set(key string, value []byte) {
	c.mu.Lock()
	c.data[key] = &cacheEntry{
		value:     value,
		expiresAt: time.Now().Add(c.ttl),
	}
	c.mu.Unlock()
}

func (c *Cache) Delete(key string) {
	c.mu.Lock()
	delete(c.data, key)
	c.mu.Unlock()
}

func (c *Cache) DeletePrefix(prefix string) {
	c.mu.Lock()
	for key := range c.data {
		if strings.HasPrefix(key, prefix) {
			delete(c.data, key)
		}
	}
	c.mu.Unlock()
}

func (c *Cache) cleanup() {
	ticker := time.NewTicker(time.Minute)
	for range ticker.C {
		now := time.Now()
		c.mu.Lock()
		for key, entry := range c.data {
			if now.After(entry.expiresAt) {
				delete(c.data, key)
			}
		}
		c.mu.Unlock()
	}
}

func (c *Cache) Stats() (hits, misses int64) {
	return atomic.LoadInt64(&c.hits), atomic.LoadInt64(&c.misses)
}

func NewCachedUserRepository(repo *UserRepository, cacheTTL time.Duration) *CachedUserRepository {
	return &CachedUserRepository{
		repo:  repo,
		cache: NewCache(cacheTTL),
	}
}

func (r *CachedUserRepository) GetByID(ctx context.Context, id int64) (*model.User, error) {
	key := fmt.Sprintf("user:id:%d", id)

	// Try cache first
	if data, ok := r.cache.Get(key); ok {
		var user model.User
		if err := json.Unmarshal(data, &user); err == nil {
			return &user, nil
		}
	}

	// Query database
	user, err := r.repo.GetByID(ctx, id)
	if err != nil {
		return nil, err
	}

	// Cache result
	if data, err := json.Marshal(user); err == nil {
		r.cache.Set(key, data)
	}

	return user, nil
}

func (r *CachedUserRepository) Create(ctx context.Context, user *model.User) error {
	if err := r.repo.Create(ctx, user); err != nil {
		return err
	}

	// Cache the new user
	key := fmt.Sprintf("user:id:%d", user.ID)
	if data, err := json.Marshal(user); err == nil {
		r.cache.Set(key, data)
	}

	// Invalidate list cache
	r.cache.DeletePrefix("user:list:")

	return nil
}

func (r *CachedUserRepository) Update(ctx context.Context, id int64, update model.UserUpdate) error {
	if err := r.repo.Update(ctx, id, update); err != nil {
		return err
	}

	// Invalidate cache
	r.cache.Delete(fmt.Sprintf("user:id:%d", id))
	r.cache.DeletePrefix("user:list:")

	return nil
}

func (r *CachedUserRepository) Delete(ctx context.Context, id int64) error {
	if err := r.repo.Delete(ctx, id); err != nil {
		return err
	}

	// Invalidate cache
	r.cache.Delete(fmt.Sprintf("user:id:%d", id))
	r.cache.DeletePrefix("user:list:")

	return nil
}

func (r *CachedUserRepository) CacheStats() (hits, misses int64, hitRate float64) {
	hits, misses = r.cache.Stats()
	total := hits + misses
	if total > 0 {
		hitRate = float64(hits) / float64(total) * 100
	}
	return
}
```

### Exercise 2: Implement Database Connection Pool Benchmarking

Write a benchmark tool to find optimal pool settings for your workload.

**Solution**:

```go
package main

import (
	"context"
	"database/sql"
	"flag"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	"sort"
)

type BenchmarkResult struct {
	MaxOpenConns    int
	MaxIdleConns    int
	Concurrency     int
	TotalRequests   int64
	SuccessRequests int64
	FailedRequests  int64
	TotalDuration   time.Duration
	AvgLatency      time.Duration
	P50Latency      time.Duration
	P99Latency      time.Duration
	RequestsPerSec  float64
}

func main() {
	dsn := flag.String("dsn", "", "Database connection string")
	duration := flag.Duration("duration", 30*time.Second, "Test duration")
	flag.Parse()

	if *dsn == "" {
		fmt.Println("Usage: benchmark -dsn <connection_string>")
		return
	}

	configs := []struct {
		maxOpen     int
		maxIdle     int
		concurrency int
	}{
		{10, 5, 10},
		{25, 5, 25},
		{25, 10, 50},
		{50, 10, 50},
		{50, 25, 100},
		{100, 25, 100},
		{100, 50, 200},
	}

	fmt.Println("Database Connection Pool Benchmark")
	fmt.Println("===================================")
	fmt.Printf("Duration: %s\n\n", *duration)

	var bestResult *BenchmarkResult
	var bestRPS float64

	for _, cfg := range configs {
		result := runBenchmark(*dsn, cfg.maxOpen, cfg.maxIdle, cfg.concurrency, *duration)
		printResult(result)

		if result.RequestsPerSec > bestRPS {
			bestRPS = result.RequestsPerSec
			bestResult = result
		}
	}

	fmt.Println("\n=== BEST CONFIGURATION ===")
	printResult(bestResult)
}

func runBenchmark(dsn string, maxOpen, maxIdle, concurrency int, duration time.Duration) *BenchmarkResult {
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		panic(err)
	}
	defer db.Close()

	db.SetMaxOpenConns(maxOpen)
	db.SetMaxIdleConns(maxIdle)
	db.SetConnMaxLifetime(5 * time.Minute)

	// Warm up connection pool
	var wg sync.WaitGroup
	for i := 0; i < maxOpen; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			db.Ping()
		}()
	}
	wg.Wait()

	// Run benchmark
	var (
		total    int64
		success  int64
		failed   int64
		latencies []time.Duration
		mu       sync.Mutex
	)

	ctx, cancel := context.WithTimeout(context.Background(), duration)
	defer cancel()

	start := time.Now()

	for i := 0; i < concurrency; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-ctx.Done():
					return
				default:
					queryStart := time.Now()
					err := db.PingContext(ctx)
					latency := time.Since(queryStart)

					atomic.AddInt64(&total, 1)
					if err != nil {
						atomic.AddInt64(&failed, 1)
					} else {
						atomic.AddInt64(&success, 1)
					}

					mu.Lock()
					latencies = append(latencies, latency)
					mu.Unlock()
				}
			}
		}()
	}

	wg.Wait()
	elapsed := time.Since(start)

	// Calculate percentiles
	sort.Slice(latencies, func(i, j int) bool {
		return latencies[i] < latencies[j]
	})

	var avgLatency, p50, p99 time.Duration
	if len(latencies) > 0 {
		var sum time.Duration
		for _, l := range latencies {
			sum += l
		}
		avgLatency = sum / time.Duration(len(latencies))
		p50 = latencies[len(latencies)*50/100]
		p99 = latencies[len(latencies)*99/100]
	}

	return &BenchmarkResult{
		MaxOpenConns:    maxOpen,
		MaxIdleConns:    maxIdle,
		Concurrency:     concurrency,
		TotalRequests:   total,
		SuccessRequests: success,
		FailedRequests:  failed,
		TotalDuration:   elapsed,
		AvgLatency:      avgLatency,
		P50Latency:      p50,
		P99Latency:      p99,
		RequestsPerSec:  float64(total) / elapsed.Seconds(),
	}
}

func printResult(r *BenchmarkResult) {
	fmt.Printf("Config: MaxOpen=%d, MaxIdle=%d, Concurrency=%d\n",
		r.MaxOpenConns, r.MaxIdleConns, r.Concurrency)
	fmt.Printf("  Requests: %d total, %d success, %d failed\n",
		r.TotalRequests, r.SuccessRequests, r.FailedRequests)
	fmt.Printf("  Throughput: %.2f req/sec\n", r.RequestsPerSec)
	fmt.Printf("  Latency: avg=%v, p50=%v, p99=%v\n",
		r.AvgLatency, r.P50Latency, r.P99Latency)
	fmt.Println()
}
```

### Junior to FAANG: Additional Entry-Level Exercises with Guided Solutions

Exercise 3: Diagnose a pool-starvation repro. Start a Postgres in Docker with max_connections=20. Write a Go program that opens sql.DB with MaxOpenConns=20. Spawn 30 goroutines that each BEGIN, sleep 30 seconds, then COMMIT. Spawn another 30 goroutines that do SELECT 1 in a tight loop. Observe the SELECT goroutines blocking. Capture db.Stats() every second and plot WaitCount and WaitDuration. The expected learning is that WaitCount climbs linearly while BEGIN transactions are sleeping. Fix by reducing the sleep, adding an acquire timeout via context, or splitting pools. This is the smallest reproducer of the Black Friday incident in chapter section 16.

Exercise 4: Build a rows-leak detector. Write a wrapper around *sql.DB that counts Query calls and rows.Close calls. The wrapper returns a wrapped Rows whose Close increments a closed counter. Every 5 seconds, log the difference (opened - closed) as "rows leaked." Use the wrapper in a test that deliberately forgets defer rows.Close on one code path. Confirm the leak counter grows. This is how sqlclosecheck works conceptually and is a good exercise to internalize the mechanism.

Exercise 5: Context propagation audit. Given a small service (you can use the repository from exercise 1), write a linter using golang.org/x/tools/go/analysis that rejects any call to db.Query, db.Exec, db.QueryRow, or tx.Exec. Configure it to allow only the Context variants. Run it on real open-source Go code (for example any repo that has not migrated) and count the violations. The goal is to see how common the mistake is and to understand why a linter is more scalable than code review.

Exercise 6: Transaction isolation experiment. Open two psql sessions to the same Postgres. In session 1, BEGIN ISOLATION LEVEL REPEATABLE READ, SELECT * FROM accounts WHERE id = 1. In session 2, UPDATE accounts SET balance = balance + 100 WHERE id = 1, COMMIT. In session 1, SELECT the row again and observe the old value. COMMIT session 1. Now repeat with SERIALIZABLE and observe that session 1 may fail with SQLSTATE 40001 on commit if you introduce a write that conflicts. The learning: isolation level is not free and requires retry logic.

Exercise 7: NULL audit. Given a Go struct with 10 fields and a Postgres table with 10 columns, write a script that queries INFORMATION_SCHEMA.COLUMNS for is_nullable and compares to the Go field types. Print mismatches. Example output: "field Phone is string but column phone is nullable." This is roughly what sqlc does at code-gen time.

Exercise 8: N+1 detection via trace counting. Add OpenTelemetry tracing to a Go service. For every HTTP request, count the child db.client spans. If the count exceeds 10, log a warning with the request path. Run a load test and identify the worst-offending endpoints. This is how Datadog APM and Honeycomb detect N+1 at scale.

For each exercise, the first-job deliverable is a working repro and a 200-word summary of what you learned. Submit these in a personal GitHub repo and reference them in interview prep. Being able to say "I built a pool-starvation reproducer and measured it" is an L4 signal that separates from candidates who only read blog posts.

Interview entry-point related to exercises: "Describe a time you reproduced a production incident in a test environment." If you have done the exercises above, you have three stories ready.

### Senior at FAANG: Staff-Level Exercises That Map to Real Org Problems

At staff level the exercises above are too small. The following exercises map to real multi-quarter initiatives and are the kind of work you would own as L6 or L7.

Staff exercise A: Schema-change framework ADR and prototype. Pick one of pgroll, gh-ost, pg_repack, or Atlas. Write an ADR (using the template from section 14) that selects one for a hypothetical 200-service monolith. Prototype the integration: a CLI that wraps the tool, enforces the 8-question schema-change checklist, and refuses any migration that does not answer all questions. Deploy it to a sandbox environment. The deliverable is the ADR plus a working CLI plus a demo of rejecting a bad migration. This is a 1-quarter piece of work in a real org and is the single strongest L6 portfolio artifact.

Staff exercise B: Vitess evaluation spike. Given a hypothetical Postgres instance at 68% CPU with projected 2 TB in 9 months, write a 2-week evaluation plan that measures whether Vitess (or Citus, given the Postgres substrate) is the right next step. Specify: what queries to benchmark, what failure modes to inject, what team-training budget is required, what operational runbooks must exist before go-live. The deliverable is a written plan plus a go or no-go recommendation. Most L6 interviews at consumer-scale companies include a question shaped like this.

Staff exercise C: Oncall rotation redesign. Given a 40-team org with 200 Postgres instances and a single shared DBA oncall, propose a redesign. Questions to answer: who is paged for what class of incident, how is escalation modeled, what runbooks exist per class, what is the budget for the platform team. Deliverable: an org-structure diagram, an escalation matrix, and three sample runbooks (primary loss, replica promotion, vacuum emergency). This is the work you would do in your first 90 days as a new database platform lead.

Staff exercise D: Cross-database migration planning. Given a 2 TB MySQL instance with 500 writes/s and 20k reads/s, write a migration plan to Vitess. Phase the work into (1) schema discovery and sharding-key selection, (2) dual-write framework, (3) CDC backfill, (4) shadow-read validation, (5) cutover, (6) decommission. Estimate duration and team size per phase. Name the specific failure modes you would stage-test (VTGate config push, VTTablet failover, topology service partition). Slack's Vitess migration took several years. A plan that estimates 6 months is a signal you have not thought hard enough.

Staff exercise E: Runbook rehearsal and game-day design. Write a game-day scenario for "primary Postgres instance becomes unreachable for 120 seconds, then returns." Specify who is paged, what Slack channels open, what commands are run in what order, what the expected RTO and RPO are, and what post-incident artifacts are required (timeline, contributing factors, action items). Run the game-day with your team quarterly. The deliverable is the scenario plus a retro of one actual rehearsal.

Staff exercise F: Cost-allocation telemetry. Given a multi-tenant Postgres, write a design for per-tenant cost allocation: query-count per tenant, bytes-read per tenant, lock-wait time per tenant. Propose instrumentation (pg_stat_statements plus application labels, or a proxy like pgbouncer with per-tenant pools). Deliver a dashboard mockup. This is Level 5 maturity and is rare outside of Snowflake, Databricks, Shopify, and a handful of others.

Staff exercise G: Bar-raiser question rehearsal. Write ten questions you would ask an L5 candidate for a database-platform role. For each, specify the signal ladder (L3 to L7 expected answer) and three common wrong answers. Use these in real interviews and calibrate against real candidates. This exercise is how FAANG bar-raisers improve over time.

Maturity ladder self-assessment. Rate your current role against the 5-level maturity model in section 13. For each level you are below, identify the one mechanism that is missing (automated failover, schema-change framework, sharding abstraction, tenant SLOs). Propose the quarter where your team would add that mechanism. Bring this document to your next calibration. Staff engineers own the road to the next maturity level for their area.

---
