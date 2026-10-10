## 36.12 Guided Exercises and Solutions

### Exercise 1: Build a Migration Versioning System

Build a complete migration system with version tracking:

**Requirements:**
- Support SQL and Go migrations
- Track applied migrations with checksums
- Support dry-run mode
- Implement status reporting

**Solution:**

```go
package main

import (
    "context"
    "crypto/sha256"
    "database/sql"
    "encoding/hex"
    "fmt"
    "io/fs"
    "log/slog"
    "sort"
    "strings"
    "time"
)

// MigrationSystem implements complete migration management
type MigrationSystem struct {
    db        *sql.DB
    logger    *slog.Logger
    tableName string
}

// MigrationRecord represents a recorded migration
type MigrationRecord struct {
    Version     int64
    Name        string
    Checksum    string
    AppliedAt   time.Time
    ExecutionMs int64
    Dirty       bool
}

// NewMigrationSystem creates a new migration system
func NewMigrationSystem(db *sql.DB, logger *slog.Logger) (*MigrationSystem, error) {
    ms := &MigrationSystem{
        db:        db,
        logger:    logger,
        tableName: "schema_migrations",
    }

    // Create migrations table
    if err := ms.ensureTable(); err != nil {
        return nil, err
    }

    return ms, nil
}

func (ms *MigrationSystem) ensureTable() error {
    _, err := ms.db.Exec(fmt.Sprintf(`
        CREATE TABLE IF NOT EXISTS %s (
            version BIGINT PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            checksum VARCHAR(64) NOT NULL,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            execution_ms BIGINT NOT NULL DEFAULT 0,
            dirty BOOLEAN NOT NULL DEFAULT false
        )
    `, ms.tableName))
    return err
}

// Migrate runs all pending migrations
func (ms *MigrationSystem) Migrate(ctx context.Context, migrations fs.FS, dryRun bool) error {
    // Load migrations
    files, err := ms.loadMigrations(migrations)
    if err != nil {
        return err
    }

    // Get applied versions
    applied, err := ms.getApplied(ctx)
    if err != nil {
        return err
    }

    // Find pending
    pending := ms.filterPending(files, applied)

    if len(pending) == 0 {
        ms.logger.Info("no pending migrations")
        return nil
    }

    // Apply each
    for _, mig := range pending {
        if err := ms.applyMigration(ctx, mig, dryRun); err != nil {
            return err
        }
    }

    return nil
}

type migrationFile struct {
    version  int64
    name     string
    content  string
    checksum string
}

func (ms *MigrationSystem) loadMigrations(fsys fs.FS) ([]migrationFile, error) {
    entries, err := fs.ReadDir(fsys, ".")
    if err != nil {
        return nil, err
    }

    var migrations []migrationFile
    for _, entry := range entries {
        if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".up.sql") {
            continue
        }

        content, err := fs.ReadFile(fsys, entry.Name())
        if err != nil {
            return nil, err
        }

        // Parse version from filename (e.g., 0001_create_users.up.sql)
        var version int64
        var name string
        fmt.Sscanf(entry.Name(), "%d_%s", &version, &name)
        name = strings.TrimSuffix(name, ".up.sql")

        // Calculate checksum
        hash := sha256.Sum256(content)
        checksum := hex.EncodeToString(hash[:])

        migrations = append(migrations, migrationFile{
            version:  version,
            name:     name,
            content:  string(content),
            checksum: checksum,
        })
    }

    // Sort by version
    sort.Slice(migrations, func(i, j int) bool {
        return migrations[i].version < migrations[j].version
    })

    return migrations, nil
}

func (ms *MigrationSystem) getApplied(ctx context.Context) (map[int64]MigrationRecord, error) {
    rows, err := ms.db.QueryContext(ctx, fmt.Sprintf(
        "SELECT version, name, checksum, applied_at, execution_ms, dirty FROM %s",
        ms.tableName,
    ))
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    applied := make(map[int64]MigrationRecord)
    for rows.Next() {
        var r MigrationRecord
        if err := rows.Scan(&r.Version, &r.Name, &r.Checksum, &r.AppliedAt, &r.ExecutionMs, &r.Dirty); err != nil {
            return nil, err
        }
        applied[r.Version] = r
    }

    return applied, rows.Err()
}

func (ms *MigrationSystem) filterPending(files []migrationFile, applied map[int64]MigrationRecord) []migrationFile {
    var pending []migrationFile
    for _, f := range files {
        record, ok := applied[f.version]
        if !ok {
            pending = append(pending, f)
            continue
        }

        // Check for checksum mismatch (migration was modified)
        if record.Checksum != f.checksum {
            ms.logger.Warn("migration checksum mismatch",
                "version", f.version,
                "expected", record.Checksum,
                "actual", f.checksum,
            )
        }
    }
    return pending
}

func (ms *MigrationSystem) applyMigration(ctx context.Context, mig migrationFile, dryRun bool) error {
    ms.logger.Info("applying migration",
        "version", mig.version,
        "name", mig.name,
        "dry_run", dryRun,
    )

    if dryRun {
        fmt.Printf("-- Migration %d: %s\n%s\n\n", mig.version, mig.name, mig.content)
        return nil
    }

    start := time.Now()

    // Mark dirty
    _, err := ms.db.ExecContext(ctx, fmt.Sprintf(
        "INSERT INTO %s (version, name, checksum, dirty) VALUES ($1, $2, $3, true)",
        ms.tableName,
    ), mig.version, mig.name, mig.checksum)
    if err != nil {
        return fmt.Errorf("failed to mark dirty: %w", err)
    }

    // Execute migration
    if _, err := ms.db.ExecContext(ctx, mig.content); err != nil {
        return fmt.Errorf("migration failed: %w", err)
    }

    // Mark complete
    executionMs := time.Since(start).Milliseconds()
    _, err = ms.db.ExecContext(ctx, fmt.Sprintf(
        "UPDATE %s SET dirty = false, execution_ms = $1, applied_at = NOW() WHERE version = $2",
        ms.tableName,
    ), executionMs, mig.version)
    if err != nil {
        return fmt.Errorf("failed to record: %w", err)
    }

    ms.logger.Info("migration complete",
        "version", mig.version,
        "duration_ms", executionMs,
    )

    return nil
}

// Status returns migration status
func (ms *MigrationSystem) Status(ctx context.Context) ([]MigrationRecord, error) {
    return ms.getAppliedList(ctx)
}

func (ms *MigrationSystem) getAppliedList(ctx context.Context) ([]MigrationRecord, error) {
    rows, err := ms.db.QueryContext(ctx, fmt.Sprintf(
        "SELECT version, name, checksum, applied_at, execution_ms, dirty FROM %s ORDER BY version",
        ms.tableName,
    ))
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    var records []MigrationRecord
    for rows.Next() {
        var r MigrationRecord
        if err := rows.Scan(&r.Version, &r.Name, &r.Checksum, &r.AppliedAt, &r.ExecutionMs, &r.Dirty); err != nil {
            return nil, err
        }
        records = append(records, r)
    }

    return records, rows.Err()
}
```

### Exercise 2: Implement Zero-Downtime Column Migration

Implement a safe column migration with the expand-contract pattern:

**Requirements:**
- Add a new column with a default value
- Backfill existing data in batches
- Add NOT NULL constraint after backfill
- Support rollback at each phase

**Solution:**

```go
package migrations

import (
    "context"
    "database/sql"
    "fmt"
    "log/slog"
    "time"
)

// ZeroDowntimeMigrator handles zero-downtime schema changes
type ZeroDowntimeMigrator struct {
    db     *sql.DB
    logger *slog.Logger
}

// AddColumnSafely adds a column with zero downtime
func (m *ZeroDowntimeMigrator) AddColumnSafely(
    ctx context.Context,
    table, column, colType string,
    defaultValue any,
    batchSize int,
) error {
    // Phase 1: Add nullable column
    m.logger.Info("phase 1: adding nullable column", "table", table, "column", column)

    addCol := fmt.Sprintf(
        "ALTER TABLE %s ADD COLUMN IF NOT EXISTS %s %s",
        table, column, colType,
    )
    if _, err := m.db.ExecContext(ctx, addCol); err != nil {
        return fmt.Errorf("failed to add column: %w", err)
    }

    // Phase 2: Backfill in batches
    m.logger.Info("phase 2: backfilling data", "batch_size", batchSize)

    if err := m.backfillColumn(ctx, table, column, defaultValue, batchSize); err != nil {
        return fmt.Errorf("backfill failed: %w", err)
    }

    // Phase 3: Add NOT NULL constraint
    m.logger.Info("phase 3: adding NOT NULL constraint")

    setNotNull := fmt.Sprintf(
        "ALTER TABLE %s ALTER COLUMN %s SET NOT NULL",
        table, column,
    )
    if _, err := m.db.ExecContext(ctx, setNotNull); err != nil {
        return fmt.Errorf("failed to set NOT NULL: %w", err)
    }

    // Phase 4: Set default for future inserts
    m.logger.Info("phase 4: setting default value")

    setDefault := fmt.Sprintf(
        "ALTER TABLE %s ALTER COLUMN %s SET DEFAULT %v",
        table, column, defaultValue,
    )
    if _, err := m.db.ExecContext(ctx, setDefault); err != nil {
        return fmt.Errorf("failed to set default: %w", err)
    }

    m.logger.Info("migration complete", "table", table, "column", column)
    return nil
}

func (m *ZeroDowntimeMigrator) backfillColumn(
    ctx context.Context,
    table, column string,
    defaultValue any,
    batchSize int,
) error {
    var totalUpdated int64

    for {
        // Update batch
        result, err := m.db.ExecContext(ctx, fmt.Sprintf(`
            UPDATE %s SET %s = $1
            WHERE ctid IN (
                SELECT ctid FROM %s
                WHERE %s IS NULL
                LIMIT $2
            )
        `, table, column, table, column), defaultValue, batchSize)

        if err != nil {
            return fmt.Errorf("batch update failed: %w", err)
        }

        affected, _ := result.RowsAffected()
        totalUpdated += affected

        if affected == 0 {
            break // No more rows to update
        }

        m.logger.Debug("batch complete",
            "updated", affected,
            "total", totalUpdated,
        )

        // Small delay to reduce load
        time.Sleep(50 * time.Millisecond)
    }

    m.logger.Info("backfill complete", "total_rows", totalUpdated)
    return nil
}

// RollbackColumnAdd removes a column added by AddColumnSafely
func (m *ZeroDowntimeMigrator) RollbackColumnAdd(
    ctx context.Context,
    table, column string,
) error {
    m.logger.Info("rolling back column addition", "table", table, "column", column)

    dropCol := fmt.Sprintf(
        "ALTER TABLE %s DROP COLUMN IF EXISTS %s",
        table, column,
    )
    _, err := m.db.ExecContext(ctx, dropCol)
    return err
}

// RenameColumnSafely renames a column with zero downtime
func (m *ZeroDowntimeMigrator) RenameColumnSafely(
    ctx context.Context,
    table, oldColumn, newColumn, colType string,
    batchSize int,
) error {
    // Phase 1: Add new column
    m.logger.Info("phase 1: adding new column", "column", newColumn)

    addCol := fmt.Sprintf(
        "ALTER TABLE %s ADD COLUMN IF NOT EXISTS %s %s",
        table, newColumn, colType,
    )
    if _, err := m.db.ExecContext(ctx, addCol); err != nil {
        return fmt.Errorf("failed to add column: %w", err)
    }

    // Phase 2: Create sync trigger
    m.logger.Info("phase 2: creating sync trigger")

    if err := m.createSyncTrigger(ctx, table, oldColumn, newColumn); err != nil {
        return fmt.Errorf("failed to create trigger: %w", err)
    }

    // Phase 3: Backfill
    m.logger.Info("phase 3: backfilling data")

    if err := m.copyColumnData(ctx, table, oldColumn, newColumn, batchSize); err != nil {
        return fmt.Errorf("backfill failed: %w", err)
    }

    m.logger.Info("rename preparation complete",
        "note", "deploy application to read from new column, then drop old column",
    )

    return nil
}

func (m *ZeroDowntimeMigrator) createSyncTrigger(
    ctx context.Context,
    table, oldColumn, newColumn string,
) error {
    triggerName := fmt.Sprintf("sync_%s_%s_to_%s", table, oldColumn, newColumn)
    funcName := triggerName + "_func"

    // Create function
    createFunc := fmt.Sprintf(`
        CREATE OR REPLACE FUNCTION %s()
        RETURNS TRIGGER AS $$
        BEGIN
            NEW.%s = COALESCE(NEW.%s, NEW.%s);
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
    `, funcName, newColumn, newColumn, oldColumn)

    if _, err := m.db.ExecContext(ctx, createFunc); err != nil {
        return err
    }

    // Create trigger
    createTrigger := fmt.Sprintf(`
        DROP TRIGGER IF EXISTS %s ON %s;
        CREATE TRIGGER %s
        BEFORE INSERT OR UPDATE ON %s
        FOR EACH ROW EXECUTE FUNCTION %s();
    `, triggerName, table, triggerName, table, funcName)

    _, err := m.db.ExecContext(ctx, createTrigger)
    return err
}

func (m *ZeroDowntimeMigrator) copyColumnData(
    ctx context.Context,
    table, sourceCol, targetCol string,
    batchSize int,
) error {
    var totalCopied int64

    for {
        result, err := m.db.ExecContext(ctx, fmt.Sprintf(`
            UPDATE %s SET %s = %s
            WHERE ctid IN (
                SELECT ctid FROM %s
                WHERE %s IS NULL AND %s IS NOT NULL
                LIMIT $1
            )
        `, table, targetCol, sourceCol, table, targetCol, sourceCol), batchSize)

        if err != nil {
            return err
        }

        affected, _ := result.RowsAffected()
        totalCopied += affected

        if affected == 0 {
            break
        }

        time.Sleep(50 * time.Millisecond)
    }

    m.logger.Info("data copy complete", "total_rows", totalCopied)
    return nil
}
```

### Junior to FAANG: worked extensions, common first-job traps, and how to debug these exercises

If you are learning this material toward a first industry role, do not stop at "my code compiles." Extend both exercises with the additional requirements below, and treat each extension as a mini-interview where you defend your design choice.

Extension 1A. The `MigrationSystem` as written uses a single `INSERT` to mark a row as dirty and a single `UPDATE` to clear it. Under what circumstance does this fail? Answer: if two pods start simultaneously in Kubernetes, both race to insert, and one gets a primary-key violation. Add a Postgres advisory lock with `pg_try_advisory_lock(hashtext('schema_migrations'))` that the migrator holds for the duration of `Migrate`. The lock is automatically released when the session ends, which means a crashed pod does not leave the database wedged. This is the kind of subtle correctness that separates a working exercise from production-ready code, and the exact issue that appears on L4 take-home reviews.

Extension 1B. The checksum mismatch handler only logs a warning. Real systems reject the migration entirely unless an operator passes an explicit `--allow-mismatch` flag, because a silent mismatch means someone edited a migration after it was applied, which breaks the reproducibility contract. Add this guard and write a test that proves the system rejects tampered files.

Extension 1C. Add a `Status` command that reports four counts: applied-clean, applied-dirty, pending, and drifted (applied but checksum changed). Practice formatting the output as a table the user can read at a glance. This is the skill interviewers assess when they ask you to build "an ops-friendly CLI."

Extension 2A. The `AddColumnSafely` implementation runs phases 1 through 4 in a single Go function. This is wrong for production, because the correct pattern requires a *code deploy* between phases 3 and 4. Refactor the function into four separate methods, each safe to call idempotently, and write a "phase plan" struct that records which phase was last completed so the operator can resume after a failure.

Extension 2B. The backfill uses `time.Sleep(50 * time.Millisecond)` as a crude throttle. Replace it with adaptive throttling based on replication lag. Query `pg_stat_replication` each loop, compare `write_lag` against a threshold, and sleep longer when the primary is outpacing replicas. This is how real backfills are written at scale and is exactly the follow-up a bar-raiser will ask after you present the naive version.

Common first-job traps to internalize.

Trap 1. Running `UPDATE ... WHERE column IS NULL` without a batch boundary on a 50M row table. This produces a 50M-row transaction that holds row locks for hours. The `LIMIT` inside the subquery in exercise 2 avoids this, but many juniors delete the `LIMIT` during a "cleanup" pass because it "looks redundant."

Trap 2. Treating the migrations table as just another application table. It is not. It is the durable record of deployment state. Never let application code modify it. Never store business data in it. Never let an ORM auto-migrate it.

Trap 3. Calling `migrate up` from pod startup without a lock. In a 20-pod deploy all 20 pods race. Some tools handle this internally, but rolling your own means you must add the advisory lock or a dedicated Kubernetes Job with parallelism 1.

Debugging flow for failing exercises. If exercise 1 fails during apply, open a `psql` session and run `SELECT * FROM schema_migrations` to see the dirty state. If exercise 2 backfill hangs, run `SELECT pid, state, wait_event_type, wait_event, query FROM pg_stat_activity WHERE state != 'idle'` to see what is blocking. Build the habit of correlating application logs with database state. It is the single most effective skill you can develop before your first on-call shift.

Interview entry point for these exercises. In a 45-minute coding round you will not finish exercise 1 completely. The interviewer knows this. What they grade is the order in which you build: schema first, table creation idempotent, then dry-run path before write path, then happy path, then error handling, then concurrency. If you are implementing features in that order while narrating your reasoning, you are passing regardless of whether the final function compiles.

### Senior at FAANG: staff-level extensions, ADR templates, and building a migration platform from these primitives

These two exercises, taken together, are a toy version of the core engine every migration platform is built on. At staff level the interesting work is not extending the code. It is extending the *surrounding system*. Below are four staff-level extensions I would expect to see in an L6 or L7 design loop, each phrased as a two-week project a small team could execute.

Staff extension 1. Build an automated migration lint tool on top of `pg_query_go`. Parse every migration file in CI, produce an AST, and fail the PR if the AST contains any of: `ALTER TABLE ... DROP COLUMN` not preceded by a two-release marker comment, `ALTER TABLE ... ALTER COLUMN TYPE` without `USING` clause evidence that the rewrite was intentional, `CREATE INDEX` without `CONCURRENTLY` on tables marked "large" in a manifest file, or any DDL that touches a table tagged "foundational" without explicit approval from a schema review council group. The lint tool is not the interesting part. The interesting part is the manifest of table annotations and how it stays in sync with reality. Annotate tables with size buckets, traffic tiers, and foundational-or-not, and build a nightly job that detects drift between the manifest and the actual production schema.

Staff extension 2. Design a migration review ADR template and embed it in the PR template for any migration file change. The ADR must capture: affected tables and their row counts at time of writing, estimated migration duration derived from a staging-replay benchmark, required locks and their expected hold times, the expand-contract phase this migration represents, the rollback plan explicit about "can we reverse this, or must we fix-forward," the on-call engineer for the release window, the downstream consumers notified, and the SLO impact budget consumed. The ADR is not a formality. It is the forcing function that makes authors think before they type.

Here is an ADR template you can paste into a repo tomorrow.

```markdown
# ADR: Migration {version} - {short description}

## Context
- Tables affected: {table list with row counts from last snapshot}
- Foundational tier: {L0 foundational, L1 core, L2 peripheral}
- Traffic tier: {hot, warm, cold}
- Related change request or ticket: {link}

## Decision
- Phase of expand-contract: {expand, migrate, contract}
- DDL statements: {list}
- Required locks: {list with expected hold times}
- Estimated duration from staging replay: {value}

## Consequences
- Reversibility: {reversible with down migration, or fix-forward only with reason}
- Downstream consumers notified: {service list, notification date}
- SLO budget expected to consume: {minutes}

## Rollback Plan
- Detection: {how we know the migration failed}
- Action: {specific commands, not "run rollback"}
- Recovery time objective: {minutes}

## Reviewers
- Schema review council approval for foundational tables: {name, date}
- On-call engineer for release window: {name, dates}
```

Staff extension 3. Write a postmortem for a production migration failure. Real postmortems follow a template: timeline with UTC timestamps, detection path, mitigation actions, root causes split into trigger and contributing factors, blast radius with customer impact minutes, action items categorized as prevent-recurrence versus reduce-impact versus improve-detection. The staff-level move is to then classify every migration postmortem you have written in the last 12 months into four buckets: lint-preventable, test-preventable, platform-preventable, and genuinely novel. The ratio of these buckets is your quality trend. If lint-preventable is more than 10% of incidents, your lint tool is under-invested. If test-preventable is more than 30%, your staging environment is not representative. If genuinely-novel is more than 50%, you are writing too many unusual migrations and your abstractions are weak. Present this ratio to leadership every quarter.

Staff extension 4. Extend the `ZeroDowntimeMigrator` into a phase-aware choreographer. Each phase becomes a signed, idempotent step in a durable workflow engine such as Temporal or a Postgres-backed state machine. The operator kicks off "migrate column X to column Y" and the workflow coordinates: add column, wait for code deploy flag A, install trigger, backfill with adaptive throttle, wait for code deploy flag B, remove trigger, drop old column. The workflow is resumable, inspectable, and cancellable. This primitive is what lets a 50-service organization run hundreds of simultaneous migrations safely. Build this and you are doing platform engineering rather than schema engineering.

Governance overlay. Around the code you build, the staff engineer also builds the human systems: a schema review council that meets weekly to approve foundational table changes, a rotating "migration commander" role during large campaigns, a "migration freeze" protocol that blocks non-emergency DDL during product launches, and a quarterly review of the migration maturity model to identify which rung your organization currently occupies and what the next step costs. None of these are Go code. All of them determine whether your Go code succeeds in production.

Bar-raiser signal. When you present these extensions in an interview, the signal the bar-raiser is calibrating is "does this candidate think in systems or in snippets." Exercise 1 as written is a snippet. Exercise 1 plus advisory locking plus drift detection plus lint tooling plus ADR template plus postmortem cadence is a system. The difference is whether you can staff a team to own it for five years.

---
