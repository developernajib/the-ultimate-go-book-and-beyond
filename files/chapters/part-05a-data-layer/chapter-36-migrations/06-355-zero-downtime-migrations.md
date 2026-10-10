## 36.5 Zero-Downtime Migrations

### Expand and Contract Pattern

The expand-and-contract pattern splits a schema change into three separate migrations deployed over multiple release cycles. First, expand the schema by adding the new column as nullable (no lock contention). Second, backfill data into the new column. Third, contract by adding constraints and removing the old column. Each phase is backward-compatible with the currently deployed application code, so there is no moment where the schema and the application disagree.

```sql
-- Phase 1: Expand (add new column, nullable)
-- migrations/000010_add_users_phone.up.sql
ALTER TABLE users ADD COLUMN phone VARCHAR(20);

-- Phase 2: Migrate data (backfill)
-- migrations/000011_backfill_phone.up.sql
UPDATE users SET phone = '' WHERE phone IS NULL;

-- Phase 3: Contract (add constraints)
-- migrations/000012_phone_not_null.up.sql
ALTER TABLE users ALTER COLUMN phone SET NOT NULL;
ALTER TABLE users ALTER COLUMN phone SET DEFAULT '';
```

### Safe Column Renames

PostgreSQL does not support renaming a column without briefly acquiring an ACCESS EXCLUSIVE lock, and even that brief lock can cause connection pileups on high-traffic tables. The safer approach is to add the new column, copy data, update the application to read/write both columns, then drop the old column once all application instances have been redeployed. This four-phase process avoids any moment where running queries reference a column that no longer exists.

```sql
-- Phase 1: Add new column
ALTER TABLE users ADD COLUMN full_name VARCHAR(255);

-- Phase 2: Copy data
UPDATE users SET full_name = name;

-- Phase 3: Application reads from both, writes to both
-- (deploy application code)

-- Phase 4: Drop old column (after all instances updated)
ALTER TABLE users DROP COLUMN name;
```

### Safe Index Creation

A regular `CREATE INDEX` acquires a SHARE lock that blocks all writes to the table until the index is built. On a table with millions of rows, this can take minutes or hours. PostgreSQL's `CONCURRENTLY` option builds the index without holding a write lock, at the cost of taking longer and requiring two table scans. Note that `CREATE INDEX CONCURRENTLY` cannot run inside a transaction, so migration tools that wrap each file in a transaction need special handling (e.g., a separate migration file marked as non-transactional). Set a `lock_timeout` for DDL operations that do require locks to prevent indefinite waits.

```sql
-- Create index concurrently (PostgreSQL)
CREATE INDEX CONCURRENTLY idx_users_name ON users(name);
-- If it fails, the index is left INVALID - DROP INDEX CONCURRENTLY before retrying
DROP INDEX CONCURRENTLY IF EXISTS idx_users_name;

-- For other operations requiring locks, set a short lock_timeout so the DDL
-- fails fast rather than blocking behind a long-running query and holding
-- the queue open for all subsequent queries (lock queue pileup).
SET lock_timeout = '2s';
SET statement_timeout = '30s';
ALTER TABLE users ADD COLUMN status VARCHAR(50);

-- MySQL 8 equivalent for online DDL:
-- ALTER TABLE users ADD COLUMN status VARCHAR(50),
--   ALGORITHM=INSTANT;             -- adds column with no rewrite on MySQL 8.0+
-- ALTER TABLE users ADD INDEX idx_users_name (name),
--   ALGORITHM=INPLACE, LOCK=NONE;  -- online index add, no write block
```

### Safe Foreign Key Validation

A foreign key constraint added with `ALTER TABLE ADD CONSTRAINT ... FOREIGN KEY` requires Postgres to scan every row in the referencing table to validate the constraint, and it holds a lock for the duration of that scan. On a 100M-row table this is minutes of write blocking. The safe pattern is to add the constraint with `NOT VALID` (which skips existing data and is effectively instant because only new writes are checked), then run `VALIDATE CONSTRAINT` in a separate statement. `VALIDATE CONSTRAINT` takes only a `SHARE UPDATE EXCLUSIVE` lock, which does not block reads or writes - just other schema changes on the same table.

```sql
-- Phase 1: add constraint NOT VALID (fast, only validates future writes)
ALTER TABLE orders
  ADD CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES users(id)
  NOT VALID;

-- Phase 2: validate existing data (no write block)
ALTER TABLE orders VALIDATE CONSTRAINT fk_orders_user;
```

The same `NOT VALID` trick applies to `CHECK` constraints. Add `NOT NULL` to an existing column the same way: add a `CHECK (col IS NOT NULL) NOT VALID` constraint, validate it, then in Postgres 12+ use `ALTER TABLE ... ALTER COLUMN ... SET NOT NULL` which can now use the validated `CHECK` as proof and skip the full scan.

### When to Reach for pgroll

The expand-and-contract pattern pushes coordination onto the application: the app code must know which phase of the migration is active and dual-write or dual-read accordingly. This works but requires discipline and cross-team deploy coordination. `pgroll` from Xata takes a fundamentally different approach: it creates a new virtual schema containing views on top of the physical tables, so the old and new schema versions are served simultaneously from the same database. Each application instance connects through a schema search path that pins it to one version, and cutover is a search-path change rather than an application redeploy. Backfills run in the background with triggers keeping the two views consistent. pgroll is Postgres-specific (it relies on schemas, views, and triggers in ways that do not translate to MySQL) but for Postgres workloads where application changes and schema changes need to be independently deployable, it eliminates entire categories of coordination bugs. It is written in Go, distributes as a single binary, and works against any Postgres (including RDS and Aurora).

```bash
# Start a pgroll migration from a YAML definition
pgroll start add_phone_column.yaml

# Applications can pin to schema version via search_path:
#   SET search_path = public_v2, public;
# Once all apps have migrated to the new version, complete the migration
pgroll complete
```

### Migration Helper

The `SafeMigrator` struct below wraps common zero-downtime operations into reusable Go methods. `AddColumnWithDefault` takes advantage of PostgreSQL 11+, which can add a column with a default value without rewriting the table. `CreateIndexConcurrently` runs outside a transaction and handles the `CONCURRENTLY` flag. `WithLockTimeout` sets a session-level lock timeout so that DDL statements fail fast rather than blocking indefinitely behind long-running queries.

```go
package migrations

import (
    "context"
    "database/sql"
    "fmt"
    "strings"
    "time"
)

type SafeMigrator struct {
    db           *sql.DB
    lockTimeout  time.Duration
    statementTimeout time.Duration
}

func NewSafeMigrator(db *sql.DB) *SafeMigrator {
    return &SafeMigrator{
        db:           db,
        lockTimeout:  10 * time.Second,
        statementTimeout: 60 * time.Second,
    }
}

func (m *SafeMigrator) AddColumnWithDefault(ctx context.Context, table, column, dataType string, defaultVal any) error {
    // PostgreSQL 11+ allows adding columns with defaults quickly as metadata
    query := fmt.Sprintf(
        "ALTER TABLE %s ADD COLUMN IF NOT EXISTS %s %s DEFAULT %v",
        table, column, dataType, defaultVal,
    )

    _, err := m.db.ExecContext(ctx, query)
    return err
}

func (m *SafeMigrator) CreateIndexConcurrently(ctx context.Context, indexName, table string, columns ...string) error {
    // Can't run in transaction
    query := fmt.Sprintf(
        "CREATE INDEX CONCURRENTLY IF NOT EXISTS %s ON %s (%s)",
        indexName, table, strings.Join(columns, ", "),
    )

    _, err := m.db.ExecContext(ctx, query)
    return err
}

func (m *SafeMigrator) WithLockTimeout(ctx context.Context, fn func() error) error {
    _, err := m.db.ExecContext(ctx, fmt.Sprintf("SET lock_timeout = '%dms'", m.lockTimeout.Milliseconds()))
    if err != nil {
        return err
    }

    return fn()
}

// ExecuteWithRetry attempts a DDL operation with a short lock_timeout, backing off
// and retrying on lock acquisition failure (PostgreSQL error code 55P03).
// This prevents the FIFO lock queue pileup where waiting DDL blocks concurrent readers.
func (m *SafeMigrator) ExecuteWithRetry(ctx context.Context, ddl string, maxRetries int, backoff time.Duration) error {
    for attempt := 1; attempt <= maxRetries; attempt++ {
        err := m.WithLockTimeout(ctx, func() error {
            _, execErr := m.db.ExecContext(ctx, ddl)
            return execErr
        })

        if err == nil {
            return nil
        }

        // Check for PostgreSQL 55P03 (lock_not_available)
        if strings.Contains(err.Error(), "55P03") || strings.Contains(err.Error(), "lock timeout") {
            if attempt == maxRetries {
                return fmt.Errorf("ddl failed after %d attempts: %w", maxRetries, err)
            }
            // Sleep before retrying to yield lock queue to live application traffic
            select {
            case <-time.After(backoff * time.Duration(attempt)):
            case <-ctx.Done():
                return ctx.Err()
            }
            continue
        }

        // Other non-lock errors fail immediately
        return err
    }
    return nil
}
```

### The FIFO Lock Queue Pileup: Why ALTER TABLE Still Causes Downtime

Even operations that require zero table rewrites (such as `ALTER TABLE ADD COLUMN` with a default in PostgreSQL 11+, or adding a foreign key with `NOT VALID`) can cause severe site outages if executed without lock timeouts, as documented by [The Backend Engineer (March 2026), "Why ALTER TABLE Still Takes Down Production Postgres in 2026"](https://medium.com/@thebackendengineer/why-alter-table-still-takes-down-production-postgres-in-2026) and [Database Reliability Engineering (May 2026), "Zero-Downtime Database Migrations: How to Alter 50M-Row Tables Without Locking Production"](https://medium.com/@dbre/zero-downtime-database-migrations-how-to-alter-50m-row-tables-without-locking-production).

```
1. Long SELECT starts (holds ACCESS SHARE lock)
   │
2. ALTER TABLE arrives (requests ACCESS EXCLUSIVE lock)
   │ ──► Blocks behind long SELECT in PostgreSQL lock queue
   │
3. New SELECT queries arrive (request ACCESS SHARE)
   │ ──► BLOCKED behind ALTER TABLE due to FIFO lock ordering!
   │
4. Connection pool saturates ──► Health checks fail ──► Cascading outage
```

The underlying mechanism is PostgreSQL's FIFO lock manager. To prevent writer starvation, a transaction waiting for an `ACCESS EXCLUSIVE` lock blocks all subsequent lock requests on that table, including simple `SELECT` queries that only need `ACCESS SHARE`. If an analytical query or reporting job runs for 30 seconds on the target table, a metadata-only `ALTER TABLE` will queue behind it for 30 seconds. Every incoming HTTP request touching that table queues behind the `ALTER TABLE`, quickly exhausting application connection pools (`too many connections`) and causing widespread 504 gateway timeouts.

*Remediation Rule*: Never issue an `ALTER TABLE` or DDL statement in production without a bounded `SET lock_timeout = '2s'`. If the lock cannot be acquired within 2 seconds, the statement aborts immediately with SQLSTATE `55P03`, freeing the lock queue for normal traffic, allowing the migration tool to back off and retry during a lower-traffic interval.


### Junior → FAANG: prerequisite gaps and first-job context

If you have only written migrations against a dev database where nobody else is connected, the phrase "zero downtime" probably sounds like marketing copy. It is not. The prerequisite concept is lock contention. When Postgres runs `ALTER TABLE users ADD COLUMN phone NOT NULL DEFAULT ''` on a pre-11 server, it rewrites every row and holds an `ACCESS EXCLUSIVE` lock for the duration. Every `SELECT`, every `INSERT`, every connection that tries to read `users` queues behind that lock. On a table with 200 million rows this is 40 minutes of outage, and because connections queue behind the lock, the queue itself saturates the connection pool and takes down unrelated endpoints. That is why the expand-migrate-contract dance exists. It is not pedantry, it is the only way to ship schema changes while real users are reading and writing.

Worked example for your first on-call rotation. You are asked to add a `deleted_at TIMESTAMP` column to a `posts` table with 50 million rows. The naive migration is one line. The safe migration is three files. File 1 runs `ALTER TABLE posts ADD COLUMN deleted_at TIMESTAMP NULL` which on Postgres 11+ is metadata-only and completes in milliseconds. File 2 is the application deploy that starts writing to `deleted_at` and treats `deleted_at IS NOT NULL` as a soft delete. No backfill is needed because historical rows are not deleted. File 3, shipped a week later once you are confident nothing rolls back, adds any index you need with `CREATE INDEX CONCURRENTLY idx_posts_deleted_at ON posts(deleted_at) WHERE deleted_at IS NOT NULL`. Notice the partial index. Indexing only non-null rows keeps the index tiny and the write amplification low.

Interview entry-point. The classic phone-screen question is "how do you rename a column in production." The wrong answer is `ALTER TABLE ... RENAME COLUMN`. The right answer is the four-phase pattern in this section: add new column, dual-write from the application, backfill, cut over reads, drop the old column in a later release. If you can explain why each phase is needed and what breaks if you skip one, you have cleared the bar for most backend roles. Follow-up questions usually target `CREATE INDEX CONCURRENTLY` failure modes (the index is left `INVALID` and must be dropped before retry) and lock queue behavior (a DDL statement waiting on an `ACCESS EXCLUSIVE` lock blocks every subsequent query even if those queries only want `ACCESS SHARE`, which is why `lock_timeout` is mandatory).

### Senior @ FAANG: expand-migrate-contract at scale, parallel-change, and operator-led DDL

At FAANG scale the three-phase pattern stretches into a multi-week choreography that involves the application, the schema, the data, and in many cases a fleet of shards. The canonical reference is Martin Fowler's parallel-change pattern, which generalizes expand-migrate-contract beyond databases into any interface change between two independently deployed components. Internally most big-tech migration playbooks are a direct application of parallel-change with operational guardrails bolted on.

The canonical multi-week sequence for a destructive change at a company like Stripe or Shopify. Week 1, expand. Add the new column or table, shadow-write from the application behind a feature flag rolled out to 1 percent of traffic. Week 2, shadow-read. Read from both old and new paths, compare results, emit a metric for mismatches, alert when the mismatch rate exceeds a threshold. Week 3, backfill. Run a chunked backfill job (typically a Go worker consuming a paginated cursor) that updates historical rows in batches of 1000 to 10000 with a deliberate sleep between batches so replication lag stays bounded. Week 4, flip reads. Change the feature flag to read from the new path, keep dual-writes. Week 5, stop dual-writes. Week 6 or later, drop the old column in a final migration. Notice that the actual `DROP COLUMN` is the last thing that happens, often more than a month after the feature shipped, and it is guarded by a checklist that verifies no production query has referenced the old column for 14 consecutive days (enforced by `pg_stat_statements` or the equivalent query log).

Dual-writes are the place junior engineers underestimate the blast radius. A dual-write is technically two writes, which means two failure modes. If the old write succeeds and the new write fails, you have silent divergence. If the new write succeeds and the old write fails, you have broken the rollback path. Production-grade dual-write code writes both inside the same transaction where possible, falls back to an outbox pattern (write to both the old table and an `outbox` table transactionally, then have a worker replay the outbox to the new table) when the writes cross database boundaries, and always emits a per-request divergence metric so drift is visible before cutover. A payments or ledger team may run dual-writes for months before cutting over reads, watching the divergence dashboard continuously until the mismatch rate is provably zero.

Postgres specifics every staff engineer should have internalized. `CREATE INDEX CONCURRENTLY` is not free. It does two full table scans and takes roughly 2x to 3x longer than the blocking version. On a 500GB table it can run for hours and it cannot run inside a transaction, which means it cannot be wrapped in the migration tool's default transaction envelope. Most Go migration libraries support a `-- +migrate NoTransaction` or equivalent directive for this. When `CREATE INDEX CONCURRENTLY` fails (the usual cause is a conflicting write hitting a deadlock during the second scan), the index is left in state `INVALID` and must be dropped with `DROP INDEX CONCURRENTLY` before retry. The retry is not free either because the first two scans are wasted work. For tables larger than a few hundred GB, `pg_repack` is the standard tool for rewriting the table online. It creates a shadow table, replays changes via triggers, and swaps names under a brief lock.

MySQL specifics. MySQL 8.0 introduced `ALGORITHM=INSTANT` for many schema changes, which is metadata-only and completes in constant time regardless of table size. Not every change qualifies (adding a column at a specific position or changing a column type usually does not), and the fallback is `ALGORITHM=INPLACE, LOCK=NONE` which rewrites the table online but still blocks certain concurrent DDL. For the cases neither covers, the industry-standard tools are GitHub's gh-ost and Percona's pt-online-schema-change. gh-ost is notable because it reads the binlog rather than using triggers, which means it imposes no write overhead on the source table during the copy. Block released Spirit in 2023, a gh-ost successor written in Go with better support for MySQL 8 and cloud-managed databases (RDS, Aurora, CloudSQL), and several FAANG-adjacent shops have standardized on it. Vitess users rely on Vitess Online DDL, which abstracts over gh-ost and pt-osc behind a single interface and is the default for YouTube, Slack, HubSpot, and Etsy.

Lock-timeout discipline is non-negotiable at scale. Every DDL statement at a FAANG-scale shop runs with `SET lock_timeout = '2s'` or shorter. The reason is the lock queue pileup. When a DDL statement waits on an `ACCESS EXCLUSIVE` lock, every subsequent query (even read-only ones) queues behind it, because the lock manager is FIFO. A single long-running read query can therefore cause a 30 minute DDL wait to become a 30 minute site outage. A 2 second lock timeout means the DDL fails fast, the queue drains, the oncall re-runs the migration in a window where the long query is not present. The migration framework should automatically wrap all DDL in `SET lock_timeout` and `SET statement_timeout` and the code review checklist should reject any raw `ALTER TABLE` that is not so wrapped.

Operator-led DDL is the modern pattern. Shopify's `ghostferry`, GitHub's `gh-ost`, and Vitess's Online DDL all share a model where the migration is declarative (YAML or SQL), submitted to a control plane, and executed by an operator that owns throttling, cutover, and rollback. The application never sees the raw `ALTER TABLE`. At GitHub a schema change is a pull request against a schema repository that gets merged and picked up by a scheduler which runs gh-ost with a throttle tied to replication lag. If replication lag exceeds a threshold, the migration pauses itself. If the host is under load, it slows the copy rate. Staff engineers designing a new migration pipeline in 2026 should assume operator-led execution with lag-aware throttling as the baseline, not the horizon.

Rollback is the half of the discipline nobody practices until it is too late. A migration that has run a 2TB backfill cannot be rolled back by running the down migration. The rollback plan for a destructive change is a separate document covering. What feature flag reverts reads to the old path. What happens to writes that have already hit the new schema. Whether the old column still contains enough data to serve reads, or whether it is stale and needs a reverse backfill. At what point rollback stops being possible (usually the moment the `DROP COLUMN` ships). Every migration PR at a mature shop has a "rollback window" field that states explicitly how many days or hours the change can be rolled back, and the change is not merged without it.

---
