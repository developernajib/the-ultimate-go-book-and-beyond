## 36.10 Common Mistakes

### Mistake 1: Running Migrations Without Locks

When multiple application instances start simultaneously (common in Kubernetes deployments), each instance may attempt to run pending migrations at the same time. Without coordination, two instances can apply the same migration concurrently, leading to duplicate schema changes, constraint violations, or half-applied states. Use PostgreSQL advisory locks to ensure only one instance runs migrations at a time.

```go
// WRONG: No coordination between instances
func (m *Manager) UnsafeMigrate(ctx context.Context) error {
    migrations, _ := m.LoadMigrations()
    for _, mig := range migrations {
        // Multiple instances might run the same migration simultaneously
        m.db.ExecContext(ctx, mig.Content)
    }
    return nil
}

// CORRECT: Use advisory locks for coordination
const migrationLockID = 7629384756

func (m *Manager) SafeMigrate(ctx context.Context) error {
    // Acquire exclusive lock before migrating
    var locked bool
    err := m.db.QueryRowContext(ctx,
        "SELECT pg_try_advisory_lock($1)",
        migrationLockID,
    ).Scan(&locked)
    if err != nil {
        return fmt.Errorf("lock check failed: %w", err)
    }
    if !locked {
        return fmt.Errorf("another migration is in progress")
    }
    defer m.db.ExecContext(ctx, "SELECT pg_advisory_unlock($1)", migrationLockID)

    migrations, _ := m.LoadMigrations()
    for _, mig := range migrations {
        if err := m.applyMigration(ctx, mig); err != nil {
            return err
        }
    }
    return nil
}
```

### Mistake 2: Creating Indexes Without CONCURRENTLY

A standard `CREATE INDEX` acquires a SHARE lock on the table, blocking all INSERT, UPDATE, and DELETE operations until the index is fully built. On tables with millions of rows, this can take minutes to hours. Always use `CREATE INDEX CONCURRENTLY` in production migrations. The tradeoff is that concurrent index creation takes longer and cannot run inside a transaction.

```sql
-- WRONG: This locks the table for all writes during index creation
CREATE INDEX idx_users_email ON users(email);

-- CORRECT: Non-blocking index creation
CREATE INDEX CONCURRENTLY idx_users_email ON users(email);

-- Note: CONCURRENTLY cannot be used in a transaction
-- For golang-migrate, use separate migration file
```

```go
// In Go migrations, handle CONCURRENTLY specially
func (m *Manager) CreateIndexConcurrently(ctx context.Context, indexDDL string) error {
    // Cannot use transactions for CONCURRENTLY
    // Set a reasonable statement timeout
    _, err := m.db.ExecContext(ctx, "SET statement_timeout = '30min'")
    if err != nil {
        return err
    }

    _, err = m.db.ExecContext(ctx, indexDDL)
    return err
}
```

### Mistake 3: Adding NOT NULL Constraints Directly

Adding a column with `NOT NULL DEFAULT` in a single statement forces PostgreSQL (pre-11) to rewrite the entire table while holding an exclusive lock. Even on PostgreSQL 11+, combining the column addition with a default and NOT NULL in one migration makes it harder to recover from partial failures. Split it into three phases: add nullable, backfill, then constrain.

```sql
-- WRONG: This scans entire table and blocks writes
ALTER TABLE users ADD COLUMN phone VARCHAR(20) NOT NULL DEFAULT '';

-- CORRECT: Three-phase approach
-- Phase 1: Add nullable column
ALTER TABLE users ADD COLUMN phone VARCHAR(20);

-- Phase 2: Backfill with default (can be batched)
UPDATE users SET phone = '' WHERE phone IS NULL;

-- Phase 3: Add NOT NULL constraint
ALTER TABLE users ALTER COLUMN phone SET NOT NULL;
ALTER TABLE users ALTER COLUMN phone SET DEFAULT '';
```

### Mistake 4: Ignoring Dirty State

When a migration fails partway through, most tools mark it as "dirty" in the `schema_migrations` table. If your application ignores this flag and tries to run the next migration, the database is in an unknown state. Some statements from the dirty migration may have been applied and some may not. Always check for dirty state before applying new migrations, and require manual intervention to resolve it.

```go
// WRONG: Ignoring dirty migrations can lead to inconsistent state
func (m *Manager) BadMigrate(ctx context.Context) error {
    // Just run migrations without checking
    return m.Up(ctx)
}

// CORRECT: Check and handle dirty state
func (m *Manager) GoodMigrate(ctx context.Context) error {
    // Check for dirty migrations
    var dirty bool
    err := m.db.QueryRowContext(ctx,
        "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE dirty = true)",
    ).Scan(&dirty)
    if err != nil {
        return err
    }

    if dirty {
        version, _ := m.getDirtyVersion(ctx)
        return fmt.Errorf(
            "migration %d is in dirty state; "+
            "fix manually with: migrate force %d",
            version, version-1,
        )
    }

    return m.Up(ctx)
}
```

### Mistake 5: No Rollback Plan

Down migrations that do not truly reverse their up migration cause data loss during rollbacks. A common failure mode: the up migration adds a column and backfills it, but the down migration simply drops the column. If you need to roll back for an unrelated reason, all that backfilled data is gone. Validate that every down migration undoes the corresponding up migration without destroying data that was written after the migration ran.

```go
// WRONG: Down migration that doesn't reverse the up migration
// Up: ADD COLUMN with complex DEFAULT
// Down: Just DROP COLUMN (loses the default logic)

// CORRECT: Ensure down migrations are truly reversible
type Migration struct {
    Version int64
    Up      func(ctx context.Context, tx *sql.Tx) error
    Down    func(ctx context.Context, tx *sql.Tx) error
    // Add validation that down reverses up
    Validate func(up, down string) error
}

// Validate ensures the down migration reverses the up migration
func ValidateMigrationPair(up, down string) error {
    // Check CREATE TABLE has DROP TABLE
    createTables := regexp.MustCompile(`CREATE TABLE (\w+)`).FindAllStringSubmatch(up, -1)
    for _, match := range createTables {
        if !strings.Contains(down, fmt.Sprintf("DROP TABLE %s", match[1])) &&
           !strings.Contains(down, fmt.Sprintf("DROP TABLE IF EXISTS %s", match[1])) {
            return fmt.Errorf("down migration missing DROP TABLE for %s", match[1])
        }
    }
    return nil
}
```

### Junior → FAANG: prerequisite gaps and first-job context

The five mistakes above share a common root cause. They all come from reasoning about migrations as if the database has no concurrent traffic. In a laptop environment with one connection, every one of these mistakes is invisible. `CREATE INDEX` is fast because there are no writes to block. `NOT NULL DEFAULT` is fast because there is nothing else competing for the lock. Dirty state never happens because nothing fails. A missing rollback never hurts because you drop the local database and recreate it. The entire category of failures only manifests under concurrent traffic, which is exactly the condition production has and your dev machine does not. That is why these mistakes are so persistent. They pass every test that does not actively simulate concurrency.

Worked example for the most common rookie mistake. You write a migration that adds a `created_at TIMESTAMP NOT NULL DEFAULT NOW()` column to a table. It works in dev instantly because the table is empty. It works in staging in 200 milliseconds because the table has 10,000 rows. It runs for 47 minutes in production because the table has 300 million rows and the entire table is rewritten with an `ACCESS EXCLUSIVE` lock held the whole time, and every other query queues behind it, and the app goes down. The fix, in order: use Postgres 11+ where `ADD COLUMN ... DEFAULT` is metadata-only, set `lock_timeout` so the migration fails fast rather than causing an outage if the fast path does not apply, and split into three files if you are on older Postgres (add nullable, backfill in batches, add NOT NULL). Every production-experienced engineer has been bitten by this at least once. The lesson is that the migration test suite must run against a table with realistic row counts, not an empty schema.

Interview entry-point. Interviewers love the question "what would you review in a schema migration PR." A weak answer lists syntax. A strong answer walks a checklist. Is the change additive or destructive. If destructive, is there a feature flag gating the application code. Is `CREATE INDEX` concurrent. Is `ADD CONSTRAINT` using `NOT VALID`. Is `lock_timeout` and `statement_timeout` set. Does the down migration actually reverse the up, or is it a polite lie. Is there an advisory lock. Does the migration run under the same Postgres version as production. Is there a rollback window documented. The checklist is what separates someone who has read about migrations from someone who has operated them.

### Senior @ FAANG: the longer mistakes list and the review checklist

The five mistakes in the section are the greatest hits. A staff-level review catches a longer list of subtler errors that each have taken down production systems at companies that should have known better.

Mistake 6, forgotten rollback after a destructive change ships. The `DROP COLUMN` migration lands in production at 2pm. At 4pm someone reports a bug whose fix requires reading the now-dropped column. Rollback is not available because the down migration cannot recover the data. The review discipline is that any `DROP COLUMN` PR must include proof (a `pg_stat_statements` query, a log analysis, a code search across all consumer services) that no production code has referenced the column in the last N days, plus a "rollback window closed" field that makes the irreversibility explicit. Reviewers who approve a `DROP COLUMN` without that proof are complicit when it goes wrong.

Mistake 7, missing index on a foreign key column. Adding `FOREIGN KEY (user_id) REFERENCES users(id)` does not create an index on `user_id`. Postgres requires the index for efficient cascade deletes and for query planner decisions but does not auto-create it. Six months later someone deletes a user, the cascade triggers a full sequential scan on every child table that has a foreign key to `users`, and the delete takes 40 seconds holding locks the entire time. The fix is a linter that requires every `ADD FOREIGN KEY` PR to either include a `CREATE INDEX CONCURRENTLY` for the referencing column or explicitly justify its absence.

Mistake 8, inconsistent `ON DELETE` behavior across foreign keys pointing at the same parent. Some foreign keys to `users` are `ON DELETE CASCADE`, some are `ON DELETE SET NULL`, some are `ON DELETE RESTRICT`. Over time this produces a graph where deleting a user has surprising side effects that nobody can predict without reading every foreign key definition. The discipline is a style guide that mandates a single default (usually `RESTRICT` with application-layer cleanup) and requires any deviation to be called out in the migration PR description. Audit scripts that enumerate all foreign keys and flag inconsistencies belong in CI.

Mistake 9, the data-loss typo that survives code review because the diff looks plausible. `ALTER TABLE users DROP COLUMN phone_number` in the up migration. The reviewer glances and approves. In production, the table had a column named `phone_numbers` (plural) and the intended `DROP` was for a different column entirely. The statement succeeds because both columns exist, just dropping the wrong one. The protection is a pre-apply confirmation step where the migration is first run against the shadow DB and the operator is shown the exact list of objects that will be changed, with row counts. A human stares at "about to drop column `phone_number` with 2.1 million non-null values" and catches the typo. An automated pipeline without the confirmation step does not.

Mistake 10, migration that silently succeeds by doing nothing. A migration that does `ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(255)` and reports success even if the column already exists with a different type. The migration ledger records that the migration ran but the schema does not match what the author intended. The protection is schema assertion in the migration itself, either through an explicit post-condition check (for example, `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='email' AND data_type='character varying') THEN RAISE EXCEPTION 'schema mismatch'; END IF; END $$`) or through a generated Atlas-style declarative schema that is diffed post-apply.

Mistake 11, running migrations during peak traffic. The migration is safe, the lock timeout is set, the index is concurrent. It still takes the primary's CPU to 90 percent during the copy phase and that 10 percent headroom is what absorbs the daily traffic spike at 12:15pm EST. The oncall at 12:16pm sees the spike, does not know the migration is running because it was kicked off by a pipeline not a human, and starts debugging the wrong thing. The protection is time-window gating in CI/CD. Migrations do not run during business-hour peaks, do not run during quarterly earnings windows (for public companies), and do not run during incident freezes. A human override exists but must be justified in the PR.

Mistake 12, schema changes that outpace application deploys. The migration adds a column, the PR that uses the column is waiting on review, the migration ships anyway because the oncall merged it. The column sits unused for two weeks. Then someone else writes a migration to drop it, thinking it was abandoned, and the original feature breaks when it finally ships. The protection is the convention that schema changes ship with the application PR that uses them, not ahead of it, and any orphan column (column in the schema but not referenced in any code) gets flagged by the schema linter.

Mistake 13, replica lag blowing up during backfill. The backfill runs at full speed, generates 10 GB of WAL per minute, the read replica falls behind by 30 minutes, and every read-your-own-writes user experience breaks because the app reads from the lagging replica. The fix is lag-aware throttling. The backfill worker queries `pg_stat_replication` or the equivalent every N seconds, pauses when lag exceeds a threshold, resumes when lag drops. At scale this belongs in a shared backfill library, not copy-pasted per backfill.

Mistake 14, dirty-state recovery that assumes the wrong thing. The migration crashed halfway. The dirty flag is set. The operator clears the flag by running `migrate force`. But some of the statements in the migration succeeded and some did not, and the operator did not inspect which. The next migration assumes a clean base state that does not actually exist. The fix is a runbook entry that mandates inspection of the actual schema (not just the dirty flag) before clearing, and ideally a tool that diffs the live schema against the expected post-migration schema and reports any gaps.

The review checklist that a staff engineer applies to every migration PR. The change is additive or gated by an explicit feature flag. `lock_timeout` and `statement_timeout` are set. Any `CREATE INDEX` is `CONCURRENTLY` and outside a transaction. Any `ADD FOREIGN KEY` has a matching `CREATE INDEX` on the referencing column. Any `ADD CONSTRAINT` uses `NOT VALID` plus separate `VALIDATE CONSTRAINT`. Any `DROP COLUMN` has proof of 14 days of zero reads. The down migration genuinely reverses the up migration, or is documented as forward-only. An advisory lock coordinates concurrent runs. The migration has been tested against a shadow DB with realistic data volume. The CI pipeline ran up-down-up. The PR description names the feature flag, the rollback window, and the operator who will run it. If any box is unchecked, the PR does not merge, regardless of how urgent the feature shipping on top of it is.

---
