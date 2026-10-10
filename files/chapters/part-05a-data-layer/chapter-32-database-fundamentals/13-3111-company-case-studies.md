## 32.11 Company Case Studies

### How Stripe Handles Database Operations

Stripe processes millions of payment transactions daily and has developed sophisticated database patterns:

**1. Idempotency Keys at the Database Level**

```go
// Stripe stores idempotency keys to prevent duplicate transactions
type IdempotentRequest struct {
    Key           string    `json:"key"`
    UserID        string    `json:"user_id"`
    RequestPath   string    `json:"request_path"`
    RequestParams []byte    `json:"request_params"`
    ResponseCode  int       `json:"response_code"`
    ResponseBody  []byte    `json:"response_body"`
    CreatedAt     time.Time `json:"created_at"`
    LockedAt      *time.Time `json:"locked_at"`
}

func (r *IdempotencyRepository) ExecuteIdempotent(
    ctx context.Context,
    key string,
    fn func() (*Response, error),
) (*Response, error) {
    // Try to get existing response
    existing, err := r.GetByKey(ctx, key)
    if err == nil && existing.ResponseBody != nil {
        // Return cached response
        var resp Response
        json.Unmarshal(existing.ResponseBody, &resp)
        return &resp, nil
    }

    // Lock the key
    if err := r.Lock(ctx, key); err != nil {
        return nil, fmt.Errorf("failed to lock idempotency key: %w", err)
    }
    defer r.Unlock(ctx, key)

    // Execute the operation
    resp, err := fn()
    if err != nil {
        return nil, err
    }

    // Store the response
    if err := r.StoreResponse(ctx, key, resp); err != nil {
        // Log but don't fail - the operation succeeded
        slog.Warn("failed to store idempotent response", "key", key, "error", err)
    }

    return resp, nil
}
```

**2. Optimistic Locking for Balance Updates**

```go
// Stripe uses version columns for optimistic locking
func (r *BalanceRepository) Debit(ctx context.Context, accountID string, amountCents int64) error {
    return r.db.TransactionWithRetry(ctx, 3, func(tx *sql.Tx) error {
        // Get current balance with version (minor units, e.g. cents)
        var balanceCents, version int64
        err := tx.QueryRowContext(ctx, `
            SELECT balance, version FROM accounts WHERE id = $1 FOR UPDATE
        `, accountID).Scan(&balanceCents, &version)
        if err != nil {
            return err
        }

        if balanceCents < amountCents {
            return ErrInsufficientBalance
        }

        // Update with version check
        result, err := tx.ExecContext(ctx, `
            UPDATE accounts
            SET balance = balance - $1, version = version + 1
            WHERE id = $2 AND version = $3
        `, amountCents, accountID, version)
        if err != nil {
            return err
        }

        rows, _ := result.RowsAffected()
        if rows == 0 {
            return ErrConcurrentModification
        }

        return nil
    })
}
```

### How Uber Scales Database Operations

Uber's ride platform handles millions of concurrent operations with strict latency requirements:

**1. Sharded Databases with Consistent Hashing**

```go
// Uber uses sharding for horizontal scaling
type ShardedDB struct {
    shards    []*sql.DB
    shardCount int
}

func (s *ShardedDB) GetShard(key string) *sql.DB {
    hash := fnv.New32a()
    hash.Write([]byte(key))
    shardID := hash.Sum32() % uint32(s.shardCount)
    return s.shards[shardID]
}

func (s *ShardedDB) GetUser(ctx context.Context, userID string) (*User, error) {
    db := s.GetShard(userID)

    var user User
    err := db.QueryRowContext(ctx, `
        SELECT id, name, email FROM users WHERE id = $1
    `, userID).Scan(&user.ID, &user.Name, &user.Email)

    return &user, err
}

// Cross-shard queries use scatter-gather
func (s *ShardedDB) SearchUsers(ctx context.Context, query string) ([]*User, error) {
    ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
    defer cancel()

    results := make(chan []*User, s.shardCount)
    errors := make(chan error, s.shardCount)

    // Query all shards in parallel
    for _, shard := range s.shards {
        go func(db *sql.DB) {
            users, err := queryShardUsers(ctx, db, query)
            if err != nil {
                errors <- err
                return
            }
            results <- users
        }(shard)
    }

    // Collect results
    var allUsers []*User
    for i := 0; i < s.shardCount; i++ {
        select {
        case users := <-results:
            allUsers = append(allUsers, users...)
        case err := <-errors:
            return nil, err
        case <-ctx.Done():
            return nil, ctx.Err()
        }
    }

    return allUsers, nil
}
```

**2. Read Replicas with Automatic Failover**

```go
// Uber routes read-heavy queries to replicas
type ReplicatedDB struct {
    primary  *sql.DB
    replicas []*sql.DB
    current  uint64
}

func (r *ReplicatedDB) Primary() *sql.DB {
    return r.primary
}

func (r *ReplicatedDB) Replica() *sql.DB {
    // Round-robin selection
    idx := atomic.AddUint64(&r.current, 1) % uint64(len(r.replicas))
    return r.replicas[idx]
}

func (r *ReplicatedDB) QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
    // Try replica first
    replica := r.Replica()
    rows, err := replica.QueryContext(ctx, query, args...)
    if err == nil {
        return rows, nil
    }

    // Fallback to primary on replica failure
    slog.Warn("replica query failed, falling back to primary", "error", err)
    return r.primary.QueryContext(ctx, query, args...)
}
```

### Database Resilience, Hystrix-Style

Netflix's Hystrix (Java) codified the resilience patterns the industry now applies to database calls in every language. In Go they look like this:

**1. Circuit Breaker for Database Calls**

```go
// Netflix uses Hystrix-style circuit breakers
type CircuitBreaker struct {
    name          string
    maxFailures   int
    resetTimeout  time.Duration
    failures      int64
    lastFailure   time.Time
    state         int32 // 0=closed, 1=open, 2=half-open
    mu            sync.RWMutex
}

func (cb *CircuitBreaker) Execute(fn func() error) error {
    if !cb.AllowRequest() {
        return ErrCircuitOpen
    }

    err := fn()
    cb.RecordResult(err)
    return err
}

func (cb *CircuitBreaker) AllowRequest() bool {
    state := atomic.LoadInt32(&cb.state)

    switch state {
    case 0: // Closed
        return true
    case 1: // Open
        cb.mu.RLock()
        elapsed := time.Since(cb.lastFailure)
        cb.mu.RUnlock()

        if elapsed > cb.resetTimeout {
            // Try half-open
            atomic.CompareAndSwapInt32(&cb.state, 1, 2)
            return true
        }
        return false
    case 2: // Half-open
        return true
    }
    return false
}

func (cb *CircuitBreaker) RecordResult(err error) {
    if err == nil {
        atomic.StoreInt32(&cb.state, 0) // Close circuit
        atomic.StoreInt64(&cb.failures, 0)
        return
    }

    failures := atomic.AddInt64(&cb.failures, 1)

    cb.mu.Lock()
    cb.lastFailure = time.Now()
    cb.mu.Unlock()

    if failures >= int64(cb.maxFailures) {
        atomic.StoreInt32(&cb.state, 1) // Open circuit
    }
}

// Usage with database
func (r *UserRepository) GetWithCircuitBreaker(ctx context.Context, id int64) (*User, error) {
    var user *User

    err := r.circuitBreaker.Execute(func() error {
        var err error
        user, err = r.GetByID(ctx, id)
        return err
    })

    if err == ErrCircuitOpen {
        // Fallback to cache or default
        return r.cache.Get(id)
    }

    return user, err
}
```

**2. Shadow Traffic for Database Testing**

```go
// Netflix tests new database configurations with shadow traffic
type ShadowDB struct {
    primary *sql.DB
    shadow  *sql.DB
    logger  *slog.Logger
}

func (s *ShadowDB) QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
    // Execute on primary synchronously
    rows, err := s.primary.QueryContext(ctx, query, args...)

    // Execute on shadow asynchronously for comparison
    go func() {
        shadowCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
        defer cancel()

        start := time.Now()
        shadowRows, shadowErr := s.shadow.QueryContext(shadowCtx, query, args...)
        duration := time.Since(start)

        if shadowErr != nil {
            s.logger.Warn("shadow query failed",
                "query", query,
                "error", shadowErr,
            )
        } else {
            shadowRows.Close()
            s.logger.Info("shadow query completed",
                "query", query,
                "duration", duration,
            )
        }
    }()

    return rows, err
}
```

### Junior to FAANG: Reading Case Studies Without Cargo Culting

When you read "Stripe uses idempotency keys" you should not run to your 3-engineer startup and replicate the full Stripe table. First understand what problem it solves. Idempotency keys exist because Stripe's clients retry on network errors and a duplicate charge is a customer-visible financial event. If your domain is a blog comment, a unique constraint on (user_id, post_id, created_minute) is already enough.

The first-job version of each pattern looks like this. For idempotency, add a request_id column with a unique index and a short-circuit check at the handler entry point. For optimistic locking, add a version integer and a WHERE version = ? clause. For sharding, do not. Vertical scale a single Postgres instance until you hit 2 TB or 20k QPS, then read this chapter again.

Interview entry-point question you will get at L3 and L4: "A user double-clicks Pay. How do you prevent the second charge?" The expected answer ladder is (1) client-side disable the button (not sufficient), (2) server-side dedupe on a natural key, (3) idempotency key supplied by the client and stored with the response. Skipping to (3) without naming (1) and (2) signals you have memorized rather than reasoned.

Why-did-this-fail reflex: when a Stripe-style ExecuteIdempotent call returns a stale response after a deploy that changed the response schema, you have a cache-poisoning problem, not an idempotency problem. The fix is to namespace the stored response with an API version, not to disable idempotency. Always ask "what invariant did this pattern protect, and is that invariant still true after my change?"

Worked example for a junior reading Uber's scatter-gather: implement it first with two shards in a dev harness, measure p99 latency against a single-shard baseline, and you will discover the tail-latency amplification problem on your own. Shard fan-out of N multiplies the probability of hitting one slow shard by roughly N. This is why real Uber code has hedged requests and per-shard timeouts, details the snippet above elides.

### Senior at FAANG: Case-Study Governance and Organizational Debt

At staff and principal level your job is not to implement these patterns. It is to decide which ones your org adopts, write the ADR, and own the multi-quarter migration. The following are the actual incidents and decisions behind the textbook patterns above.

GitHub October 2018 split-brain. A 43-second network partition between East Coast data centers caused Orchestrator to fail over the MySQL primary to a West Coast replica. Writes landed in both regions for 40 seconds. Recovery took 24 hours and required manual reconciliation of 5 minutes of writes. The staff-level lesson is that automated failover without a fencing token or a quorum-based consensus layer is a liability at scale. The ADR that should exist in every org running Postgres or MySQL: "Under what RPO and RTO do we accept automated failover, and who has the pager to authorize manual?" GitHub's answer post-incident was to require Orchestrator quorum across three regions and to prefer longer RTO over split-brain risk.

The Postgres migration-lock outage pattern. A schema migration that takes an ACCESS EXCLUSIVE lock (a naive `ALTER TABLE` that rewrites the table, or one that queues behind a long-running query and then blocks every query behind it) freezes all access to that table for the duration, and on a hot control-plane database that is a full outage. This failure mode has bitten many teams and it is entirely preventable. The staff-level lesson is that every org running Postgres at scale needs a schema-change ADR that mandates (a) lock_timeout and statement_timeout on all DDL, (b) pg_repack or pgroll for any change that rewrites a table, (c) a two-phase rollout (add column nullable, backfill in batches, add NOT NULL with a CHECK constraint promoted via ALTER TABLE VALIDATE CONSTRAINT). If you cannot name those three mechanics in an interview you are not ready for staff ownership of a Postgres fleet.

Slack's Vitess migration. Slack migrated from a monolithic MySQL to Vitess (horizontally sharded MySQL) over several years. Its public incidents make the general point: a hot keyspace, or a routing change that sends reads to a lagging replica, turns into a broad slowdown because the sharding layer now sits on the critical path of every query. The organizational lesson: sharding frameworks do not eliminate oncall, they move it from DBAs to platform engineers who now own a distributed query router. Staff engineers proposing Vitess adoption must budget a permanent two-person oncall rotation and a runbook for VTGate, VTTablet, and the topology service (etcd or Consul) separately.

Discord Cassandra to ScyllaDB migration (2022 to 2023). Discord ran 177 Cassandra nodes storing trillions of messages, hit GC pause cliffs, and migrated to ScyllaDB over 12 months. The ADR template that emerged: when do you pick a C++ rewrite of a JVM database? Criteria are (1) p99 tail latency dominated by GC pauses that tuning cannot fix, (2) operational cost of node count, (3) compaction throughput ceiling. If any two of three are true and the wire protocol is compatible, the migration is defensible. Otherwise you are rewriting for resume-driven reasons.

Uber Schemaless to Docstore. Schemaless was Uber's MySQL-sharded KV layer from 2014. By 2020 it could not support global secondary indexes and cross-shard transactions that the business needed. Docstore (built on MySQL + a new transaction layer) replaced it over 4 years. The staff lesson is that home-grown database abstractions have a 5-to-7-year half-life. Plan for the replacement before the original is in production.

Instagram sharding (ID generation). Instagram's 64-bit ID scheme packs a 41-bit millisecond timestamp, 13-bit logical shard ID, and 10-bit per-shard sequence. This is worth memorizing because at every staff interview at a consumer-scale company you will be asked to design a distributed ID. The answer ladder: UUIDv4 (bad for B-tree locality), UUIDv7 (acceptable), Snowflake (needs coordination), Instagram-style shard-embedded (needs shard map). Name all four and defend a choice given write throughput and shard count.

Notion block sharding (2021 and 2023). Notion sharded a single Postgres into 480 logical shards spread across 32 physical databases (2021), then re-resharded to 96 physical databases two years later while keeping the same 480 logical shards. The ADR lesson: resharding is never a one-time project. Your sharding abstraction must support online resharding via dual-write and backfill, or you will hit the wall again in 24 months.

Staff-engineer ADR template for sharding:

```
# ADR: Adopt Vitess for users_keyspace
Status: Proposed
Context: Single Postgres primary at 68% CPU, 1.2 TB, projected 2 TB in 9 months.
Decision drivers:
  - Write throughput ceiling of current primary: measured 8k TPS.
  - Team Postgres expertise: 3 engineers. Vitess expertise: 0.
  - Acceptable migration window: 18 months.
Options considered:
  1. Vertical scale to db.r7i.24xlarge. Buys 12 months. Cost $18k/mo.
  2. Citus on Postgres. Keeps Postgres expertise. Adds coordinator SPOF.
  3. Vitess on MySQL. Requires MySQL migration first. 24-month project.
  4. CockroachDB. Rewrites transaction semantics. Highest risk.
Decision: Option 1 now, begin Option 2 evaluation in Q3.
Consequences: Defers sharding cost. Requires capacity re-review at 85% CPU.
```

Maturity model for database operations at FAANG scale. Level 1: single primary, manual failover, nightly backups, no oncall rotation. Level 2: streaming replica, semi-automated failover, PITR, DBA oncall. Level 3: multi-region replicas, automated failover with fencing, schema-change review board, platform engineers oncall. Level 4: sharded with online resharding, shadow-traffic validation, chaos testing (simulated primary loss weekly), dedicated database platform team. Level 5: the database is a product with SLOs, tenants, cost allocation, and a roadmap. Know which level your org is at and which level the role you are interviewing for operates at.

---
