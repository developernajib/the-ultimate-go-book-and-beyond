## 37C.3 Schema Evolution Strategies

### The Expand-and-Contract Pattern

The safest approach for zero-downtime schema migrations:

```
Phase 1 - Expand: Add the new column/table/behavior (backward compatible)
Phase 2 - Migrate: Backfill data, run old and new code simultaneously
Phase 3 - Contract: Remove the old column/table/behavior
```

The key insight: each phase can be deployed independently. There is no "deployment window" where the old code and new schema are simultaneously in production.

### Adding a Column Safely

**Scenario**: Adding a required `timezone` column to `users`.

```sql
-- Phase 1: Add as nullable (backward compatible - old code doesn't send it)
ALTER TABLE users
    ADD COLUMN timezone text;  -- NULL allowed initially

-- Phase 2: Backfill existing rows
-- Use batching to avoid locking the table
DO $$
DECLARE
    batch_size int := 1000;
    offset_val int := 0;
    affected   int;
BEGIN
    LOOP
        UPDATE users
        SET timezone = 'UTC'  -- default for existing users
        WHERE id IN (
            SELECT id FROM users
            WHERE timezone IS NULL
            LIMIT batch_size
        );

        GET DIAGNOSTICS affected = ROW_COUNT;
        EXIT WHEN affected = 0;

        PERFORM pg_sleep(0.1);  -- brief pause to reduce lock contention
    END LOOP;
END $$;

-- Phase 3: Add NOT NULL constraint (safe after backfill + code deploys)
-- PostgreSQL 12+ can validate without full table lock using NOT VALID
ALTER TABLE users
    ADD CONSTRAINT users_timezone_not_null CHECK (timezone IS NOT NULL) NOT VALID;

-- Validate separately (uses ShareUpdateExclusiveLock, not full lock)
ALTER TABLE users VALIDATE CONSTRAINT users_timezone_not_null;

-- Then convert to actual NOT NULL
ALTER TABLE users ALTER COLUMN timezone SET NOT NULL;
ALTER TABLE users DROP CONSTRAINT users_timezone_not_null;
```

### Renaming Columns Without Downtime

You cannot rename a column instantly if live code uses the old name. The pattern:

```
1. Add new column (new_name)
2. Write: write to both old_name and new_name
3. Backfill: copy old_name → new_name for existing rows
4. Read: switch reads to new_name
5. Write: write only to new_name
6. Drop: remove old_name column
```

```sql
-- Step 1: Add new column
ALTER TABLE users ADD COLUMN full_name text;

-- Step 3: Backfill
UPDATE users SET full_name = name WHERE full_name IS NULL;

-- Step 6: Drop old column (after all code uses full_name)
ALTER TABLE users DROP COLUMN name;
```

The application code must coordinate with the schema changes. During the transition period, use a feature flag to control whether the code writes to both columns (dual-write phase) or reads from the new column. This allows rolling deploys where old and new application instances coexist safely.

```go
// Step 2/4: Code that handles the transition
// Deploy with WRITE_BOTH=true, READ_OLD=true first
// Then READ_OLD=false
// Then WRITE_BOTH=false

func (r *UserRepo) Create(ctx context.Context, u *User) error {
    // During transition: write to both columns
    if featureFlags.IsEnabled("user_name_migration_write_both") {
        _, err := r.db.Exec(ctx, `
            INSERT INTO users (id, name, full_name, email)
            VALUES ($1, $2, $2, $3)
        `, u.ID, u.FullName, u.Email)
        return err
    }

    // After transition: write only to new column
    _, err := r.db.Exec(ctx, `
        INSERT INTO users (id, full_name, email)
        VALUES ($1, $2, $3)
    `, u.ID, u.FullName, u.Email)
    return err
}
```

### Backfill Strategies for Large Tables

For tables with millions of rows, updating all rows at once causes:
- Long-running transactions that block other operations
- Replication lag (each row change must be replicated)
- Lock escalation

Batch backfill in Go:

```go
func BackfillUserTimezones(ctx context.Context, db *pgxpool.Pool) error {
    logger := slog.Default()
    batchSize := 1000
    totalUpdated := 0

    for {
        // Use a keyset-based batch to avoid OFFSET
        result, err := db.Exec(ctx, `
            WITH batch AS (
                SELECT id FROM users
                WHERE timezone IS NULL
                ORDER BY id
                LIMIT $1
                FOR UPDATE SKIP LOCKED  -- skip rows locked by other workers
            )
            UPDATE users
            SET timezone = 'UTC'
            WHERE id IN (SELECT id FROM batch)
        `, batchSize)
        if err != nil {
            return fmt.Errorf("batch update: %w", err)
        }

        affected := result.RowsAffected()
        if affected == 0 {
            break
        }

        totalUpdated += int(affected)
        logger.Info("backfill progress", "updated", totalUpdated)

        // Pause to reduce database load (tune based on replication lag)
        select {
        case <-ctx.Done():
            return ctx.Err()
        case <-time.After(50 * time.Millisecond):
        }
    }

    logger.Info("backfill complete", "total_updated", totalUpdated)
    return nil
}
```

### Online Index Creation

PostgreSQL creates indexes with a lock by default. `CONCURRENTLY` builds the index without blocking reads/writes:

```sql
-- This blocks reads and writes until complete - dangerous on large tables
CREATE INDEX idx_orders_user_id ON orders (user_id);

-- This takes longer but doesn't block
CREATE INDEX CONCURRENTLY idx_orders_user_id ON orders (user_id);

-- Drop also supports CONCURRENTLY
DROP INDEX CONCURRENTLY idx_orders_user_id;
```

Important: `CONCURRENTLY` cannot run inside a transaction. It can also fail and leave an INVALID index - always check:

```sql
-- Check for invalid indexes after CONCURRENTLY creation
SELECT indexname, indisvalid
FROM pg_indexes
JOIN pg_index ON pg_index.indexrelid = (
    SELECT oid FROM pg_class WHERE relname = indexname
)
WHERE tablename = 'orders'
  AND NOT indisvalid;

-- Rebuild invalid index
DROP INDEX CONCURRENTLY idx_orders_user_id;
CREATE INDEX CONCURRENTLY idx_orders_user_id ON orders (user_id);
```

### Migration Tooling in Go

**goose** is the most widely used Go migration tool:

```bash
# Install
go install github.com/pressly/goose/v3/cmd/goose@latest

# Create migration
goose -dir migrations create add_timezone_to_users sql
```

Each migration file contains an `Up` section (applied when migrating forward) and a `Down` section (applied when rolling back). Note that `CREATE INDEX CONCURRENTLY` cannot run inside a transaction, so goose runs it as a single statement outside the migration transaction automatically.

```sql
-- migrations/20240115120000_add_timezone_to_users.sql
-- +goose Up
ALTER TABLE users ADD COLUMN timezone text;

CREATE INDEX CONCURRENTLY idx_users_timezone ON users (timezone)
    WHERE timezone IS NOT NULL;

-- +goose Down
DROP INDEX IF EXISTS idx_users_timezone;
ALTER TABLE users DROP COLUMN IF EXISTS timezone;
```

For production Go services, embed migration files directly in the binary using `go:embed`. This eliminates the need to deploy SQL files alongside the binary and ensures that the migration version always matches the application version.

```go
// Embedding migrations in the binary
import (
    "embed"
    "github.com/pressly/goose/v3"
)

//go:embed migrations/*.sql
var migrations embed.FS

func RunMigrations(db *sql.DB) error {
    goose.SetBaseFS(migrations)

    if err := goose.SetDialect("postgres"); err != nil {
        return err
    }

    return goose.Up(db, "migrations")
}
```

### Junior → FAANG: The Six-Step Dance You Will Run Many Times

Memorize the expand-and-contract rhythm because you will run it dozens of times in your career. One, add the new shape nullable. Two, dual-write from the app. Three, backfill in batches. Four, switch reads. Five, stop writing to the old shape. Six, drop the old shape. Each step is a separate deploy. No step relies on instantaneous rollout. If you try to collapse two steps into one (for example, drop the old column in the same deploy that switches reads), you create a window where a rolling deploy has one instance on the old code and another on the new code, and one of them crashes.

Worked example and interview entry-point. You will be asked in an L4 loop how you would rename `users.name` to `users.full_name` on a table with 200 million rows and zero downtime. The answer follows the six steps literally. Add `full_name`. Deploy app code that writes to both. Backfill in 1000-row batches with `FOR UPDATE SKIP LOCKED` so parallel workers do not collide. Deploy app code that reads from `full_name`. Deploy app code that writes only to `full_name`. Drop `name`. Each deploy is reversible at any point before the drop. That reversibility is the property the interviewer is checking.

First-job context. If your migration tool is goose, golang-migrate, atlas, or sqldef, the same pattern applies, only the file format differs. Atlas and sqldef add declarative desired-state migrations which are convenient for dev but require the same expand-and-contract sequence in production. The danger is that declarative tools will happily emit a `DROP COLUMN` if the desired state removes it, and running that against a live database with old code reading the column will cause an outage. Always review the generated plan before applying.

### Senior @ FAANG: Schema Evolution as a Contract Problem

At staff level, schema evolution is not a SQL problem. It is a contract problem. The database is one endpoint. The event bus is another. Downstream data warehouses, feature stores, and analytics pipelines are more. Each of them is a consumer of a schema that your team owns. Expand-and-contract is the local tactic. The architecture is data contracts enforced by tooling.

Contract mechanics. For event-driven systems, the schema of every event must be registered with a schema registry. Confluent Schema Registry is the incumbent for Avro and JSON Schema over Kafka. Buf Schema Registry is the Protobuf equivalent with `buf breaking` for automated breaking-change detection in CI. The registry enforces compatibility modes (backward, forward, full, none) per subject and rejects producer registrations that violate the mode. For Protobuf the rules are well defined. Never renumber a field. Never change a wire type. Never reuse a deleted field number (reserve it explicitly with `reserved`). Never change a field from optional to required (in proto3 this is largely moot but still matters for semantic reasons). Adding a field is backward compatible. Removing a field is breaking unless you reserve the number. For Avro the resolution rules are stricter. Adding a field requires a default value. Removing a field requires the reader schema to tolerate its absence. For JSON Schema the rules depend on `additionalProperties` and `required` discipline.

Data contracts beyond the wire. Tools like data-contract-cli (Open Data Contract Standard from the Bitol project), Great Expectations (GX), and OpenMetadata encode the contract as YAML or code with owners, SLAs, quality assertions, and lineage. A data contract is not just a schema. It is a commitment about freshness, completeness, uniqueness, and statistical properties, enforced by automated tests in CI and by continuous checks in production. At Airbnb the Dataportal and data-quality framework play this role. At Netflix the data platform enforces similar contracts via the schema service and data warehouse metadata.

Online DDL at billion-row scale. PostgreSQL's native `ALTER TABLE` is mostly fast now (adding nullable columns with default is metadata-only since PG11, adding `NOT NULL` with a constant default is metadata-only since PG11, dropping a column is metadata-only always). The remaining dangers are `ALTER COLUMN TYPE` which rewrites the table, and long-running lock acquisition on busy tables. `lock_timeout` is mandatory in production migrations. Set it to 2 seconds, retry on timeout with exponential backoff, and never run a migration that holds an `AccessExclusiveLock` for more than a blink. For MySQL, `pt-online-schema-change` (Percona) and `gh-ost` (GitHub) are the industry standards for zero-downtime DDL. Both work by creating a shadow table, replicating changes via triggers (pt-osc) or binlog replication (gh-ost), and atomically swapping at the end. gh-ost is generally preferred because it decouples from the primary's write load by reading the binlog instead of installing triggers.

Backfill at scale. The Go snippet above is correct for tables up to a few hundred million rows. Past that, the pattern evolves. Use keyset pagination (`WHERE id > $last_id ORDER BY id LIMIT 1000`) instead of any form of OFFSET. Gate backfill throughput on replication lag metrics, not wall-clock time (if your read replicas fall behind by more than a few seconds, pause the backfill automatically). Write the backfill as an idempotent job so it can be killed and resumed. Emit progress to a metrics system with estimated-time-remaining so operators can decide whether to let it run or abort. At FAANG scale, a backfill is a week-long background job, not a migration-script side effect.

Breaking-change detection as a merge gate. The concrete setup. In your monorepo, every `.proto` file has a corresponding `buf.yaml` with breaking-change rules. CI runs `buf breaking --against '.git#branch=main'` on every pull request. Any breaking change is a hard block that requires explicit owner approval and a documented migration plan. The equivalent for SQL is harder but emerging. Atlas HCL with `atlas migrate lint` can detect dangerous changes (column drops, type changes, non-concurrent index creation on large tables). sqldef and skeema offer similar linting. At Meta, EntSQL is the schema-as-code layer that enforces review and compatibility. At Airbnb and Uber, custom CI jobs run against production schema snapshots to catch `ALTER TABLE` statements that would take locks longer than the agreed SLA.

Finally, the cultural point. Expand-and-contract works only if the team commits to completing the contract phase. The common failure mode is that teams run steps one through four, declare victory, and never drop the old column. Six months later the table has three legacy columns with ambiguous semantics and the next migration inherits the mess. The fix is process. Every expand migration creates a ticket for its contract, with an owner and a due date, tracked in the same backlog as feature work. At staff level your job is to install that process, not to write the SQL.

---
