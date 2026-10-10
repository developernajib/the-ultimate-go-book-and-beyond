## Migration Pitfalls: When Schema Changes Break Production

### The Table Lock Outage

**The Incident**: A fintech company needed to add a new column to their 500-million-row transactions table. The migration ran `ALTER TABLE transactions ADD COLUMN category VARCHAR(50)`. In PostgreSQL, this acquired an ACCESS EXCLUSIVE lock. The table was locked for 45 minutes while the column was added. Every transaction in the system failed, API timeouts cascaded to all services, and the company had to issue a public apology for the outage.

```sql
-- WRONG: Blocks all reads and writes for hours on large tables
ALTER TABLE transactions ADD COLUMN category VARCHAR(50);

-- CORRECT: PostgreSQL 11+ instant column addition
ALTER TABLE transactions ADD COLUMN category VARCHAR(50);
-- Actually instant in PG11+ for nullable columns without defaults!

-- But if you need a default...
-- WRONG: This rewrites the entire table
ALTER TABLE transactions ADD COLUMN category VARCHAR(50) DEFAULT 'other';

-- CORRECT: Add nullable, then backfill
ALTER TABLE transactions ADD COLUMN category VARCHAR(50);
-- Then backfill in batches (see below)
```

```go
// WRONG: Single migration that locks table
func up20240101(ctx context.Context, tx *sql.Tx) error {
    _, err := tx.ExecContext(ctx, `
        ALTER TABLE transactions ADD COLUMN category VARCHAR(50) DEFAULT 'other'
    `)
    return err
}

// CORRECT: Expand-contract pattern with batched backfill
func up20240101_step1(ctx context.Context, tx *sql.Tx) error {
    // Step 1: Add nullable column (instant in PG11+)
    _, err := tx.ExecContext(ctx, `
        ALTER TABLE transactions ADD COLUMN category VARCHAR(50)
    `)
    return err
}

func up20240101_step2(ctx context.Context, db *sql.DB) error {
    // Step 2: Backfill in batches (outside transaction!)
    batchSize := 10000
    for {
        result, err := db.ExecContext(ctx, `
            UPDATE transactions
            SET category = 'other'
            WHERE category IS NULL
            AND id IN (
                SELECT id FROM transactions WHERE category IS NULL LIMIT $1
            )
        `, batchSize)
        if err != nil {
            return err
        }

        affected, _ := result.RowsAffected()
        if affected == 0 {
            break
        }

        // Rate limit to avoid overwhelming the database
        time.Sleep(100 * time.Millisecond)
    }
    return nil
}

func up20240101_step3(ctx context.Context, tx *sql.Tx) error {
    // Step 3: Add NOT NULL constraint (after backfill)
    _, err := tx.ExecContext(ctx, `
        ALTER TABLE transactions ALTER COLUMN category SET NOT NULL
    `)
    return err
}
```

### The Foreign Key Validation Freeze

**The Incident**: A team added a foreign key constraint to validate data integrity. The migration ran `ALTER TABLE ADD CONSTRAINT`. PostgreSQL scanned the entire 100-million-row table to validate existing data while holding a lock. The table was unavailable for 20 minutes during peak traffic.

```go
// WRONG: Adding constraint validates all existing data under lock
func addForeignKey(ctx context.Context, tx *sql.Tx) error {
    _, err := tx.ExecContext(ctx, `
        ALTER TABLE orders
        ADD CONSTRAINT fk_orders_user
        FOREIGN KEY (user_id) REFERENCES users(id)
    `)
    return err // Validates ALL rows while locked
}

// CORRECT: Add constraint as NOT VALID, then validate separately
func addForeignKeyStep1(ctx context.Context, tx *sql.Tx) error {
    // Step 1: Add constraint without validation (instant)
    _, err := tx.ExecContext(ctx, `
        ALTER TABLE orders
        ADD CONSTRAINT fk_orders_user
        FOREIGN KEY (user_id) REFERENCES users(id)
        NOT VALID
    `)
    return err
}

func addForeignKeyStep2(ctx context.Context, db *sql.DB) error {
    // Step 2: Validate in background (allows reads, minimal locking)
    ctx, cancel := context.WithTimeout(ctx, 2*time.Hour)
    defer cancel()

    _, err := db.ExecContext(ctx, `
        ALTER TABLE orders VALIDATE CONSTRAINT fk_orders_user
    `)
    return err
}
```

### The Index Creation Lock

**The Incident**: An index was needed for a slow query. The developer ran `CREATE INDEX` in a migration. This acquired a lock that blocked all writes to the table for 3 hours. Orders couldn't be created, and the e-commerce site effectively went read-only during a sale.

```go
// WRONG: Regular index creation blocks writes
func createIndex(ctx context.Context, tx *sql.Tx) error {
    _, err := tx.ExecContext(ctx, `
        CREATE INDEX idx_orders_created_at ON orders(created_at)
    `)
    return err // Blocks all INSERTs and UPDATEs
}

// CORRECT: Use CONCURRENTLY (outside transaction!)
func createIndexConcurrently(ctx context.Context, db *sql.DB) error {
    // CONCURRENTLY cannot run inside a transaction
    _, err := db.ExecContext(ctx, `
        CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_created_at
        ON orders(created_at)
    `)
    if err != nil {
        // If CONCURRENTLY fails, index is INVALID - must drop and retry
        db.ExecContext(ctx, "DROP INDEX CONCURRENTLY IF EXISTS idx_orders_created_at")
        return fmt.Errorf("index creation failed (index dropped): %w", err)
    }
    return nil
}

// Migration framework integration
type Migration struct {
    Version  int
    Up       func(context.Context, *sql.Tx) error
    UpNoTx   func(context.Context, *sql.DB) error // For CONCURRENTLY
    Down     func(context.Context, *sql.Tx) error
}

func runMigration(ctx context.Context, db *sql.DB, m Migration) error {
    if m.UpNoTx != nil {
        // Run outside transaction
        return m.UpNoTx(ctx, db)
    }

    // Run in transaction
    tx, err := db.BeginTx(ctx, nil)
    if err != nil {
        return err
    }
    defer tx.Rollback()

    if err := m.Up(ctx, tx); err != nil {
        return err
    }
    return tx.Commit()
}
```

### The Down Migration Data Loss

**The Incident**: A migration renamed a column from `user_name` to `username`. The down migration dropped `username` and renamed it back. When a rollback was needed due to an unrelated bug, all the data in the `username` column was lost because the down migration dropped the column instead of just renaming it.

```go
// WRONG: Down migration loses data
func up(ctx context.Context, tx *sql.Tx) error {
    _, err := tx.ExecContext(ctx, `ALTER TABLE users RENAME COLUMN user_name TO username`)
    return err
}

func down(ctx context.Context, tx *sql.Tx) error {
    // This loses all data if column was modified after migration!
    _, err := tx.ExecContext(ctx, `ALTER TABLE users RENAME COLUMN username TO user_name`)
    return err
}

// What if the column was modified? Data in the NEW format can't be reverted
// Example: up() also changed VARCHAR(50) to VARCHAR(100)
// down() changes it back, truncating data > 50 chars

// CORRECT: Down migrations should be reversible without data loss
func up(ctx context.Context, tx *sql.Tx) error {
    // Add new column, keep old one
    _, err := tx.ExecContext(ctx, `ALTER TABLE users ADD COLUMN username VARCHAR(100)`)
    if err != nil {
        return err
    }
    // Copy data
    _, err = tx.ExecContext(ctx, `UPDATE users SET username = user_name`)
    return err
}

func down(ctx context.Context, tx *sql.Tx) error {
    // Just drop the new column, old one still has data
    _, err := tx.ExecContext(ctx, `ALTER TABLE users DROP COLUMN username`)
    return err
}

// For column renames where down must work:
func upColumnRename(ctx context.Context, tx *sql.Tx) error {
    // Step 1: Add new column
    tx.ExecContext(ctx, `ALTER TABLE users ADD COLUMN username VARCHAR(100)`)
    // Step 2: Sync trigger (keeps both columns in sync)
    tx.ExecContext(ctx, `
        CREATE OR REPLACE FUNCTION sync_username() RETURNS TRIGGER AS $$
        BEGIN
            IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
                NEW.username = COALESCE(NEW.username, NEW.user_name);
                NEW.user_name = NEW.username;
            END IF;
            RETURN NEW;
        END $$ LANGUAGE plpgsql;

        CREATE TRIGGER sync_username_trigger
        BEFORE INSERT OR UPDATE ON users
        FOR EACH ROW EXECUTE FUNCTION sync_username();
    `)
    // Step 3: Backfill
    tx.ExecContext(ctx, `UPDATE users SET username = user_name WHERE username IS NULL`)
    return nil
}

func downColumnRename(ctx context.Context, tx *sql.Tx) error {
    // Remove sync mechanism, keep both columns with data intact
    tx.ExecContext(ctx, `DROP TRIGGER IF EXISTS sync_username_trigger ON users`)
    tx.ExecContext(ctx, `DROP FUNCTION IF EXISTS sync_username`)
    // Optionally drop new column
    tx.ExecContext(ctx, `ALTER TABLE users DROP COLUMN IF EXISTS username`)
    return nil
}
```

### The Dirty Migration State

**The Incident**: A migration failed halfway through due to a unique constraint violation. The migration tool marked it as "dirty." The next deploy tried to run the same migration, which failed again because half the changes were already applied. Manual intervention was required, but the on-call engineer didn't know which parts had succeeded, leading to more errors.

```go
// WRONG: Multi-statement migration without checkpoints
func up(ctx context.Context, tx *sql.Tx) error {
    tx.ExecContext(ctx, `ALTER TABLE users ADD COLUMN email VARCHAR(255)`)
    tx.ExecContext(ctx, `CREATE UNIQUE INDEX idx_users_email ON users(email)`) // Fails!
    tx.ExecContext(ctx, `ALTER TABLE users ADD COLUMN verified BOOLEAN DEFAULT false`)
    return nil // Never reached
}

// CORRECT: Idempotent migrations that can be re-run
func up(ctx context.Context, tx *sql.Tx) error {
    // Each statement is idempotent
    _, err := tx.ExecContext(ctx, `
        ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(255)
    `)
    if err != nil {
        return fmt.Errorf("add email column: %w", err)
    }

    _, err = tx.ExecContext(ctx, `
        CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)
    `)
    if err != nil {
        return fmt.Errorf("create email index: %w", err)
    }

    _, err = tx.ExecContext(ctx, `
        ALTER TABLE users ADD COLUMN IF NOT EXISTS verified BOOLEAN DEFAULT false
    `)
    if err != nil {
        return fmt.Errorf("add verified column: %w", err)
    }

    return nil
}

// Even better: Pre-flight checks
func up(ctx context.Context, tx *sql.Tx) error {
    // Check current state before making changes
    var hasEmail, hasVerified bool
    tx.QueryRowContext(ctx, `
        SELECT
            EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='email'),
            EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='verified')
    `).Scan(&hasEmail, &hasVerified)

    if !hasEmail {
        _, err := tx.ExecContext(ctx, `ALTER TABLE users ADD COLUMN email VARCHAR(255)`)
        if err != nil {
            return err
        }
    }

    // Handle partial unique index failure
    var indexValid bool
    tx.QueryRowContext(ctx, `
        SELECT indisvalid FROM pg_index WHERE indexrelid = 'idx_users_email'::regclass
    `).Scan(&indexValid)

    if !indexValid {
        // Drop invalid index before recreating
        tx.ExecContext(ctx, `DROP INDEX IF EXISTS idx_users_email`)
    }

    _, err := tx.ExecContext(ctx, `
        CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)
    `)
    if err != nil {
        return err
    }

    if !hasVerified {
        _, err := tx.ExecContext(ctx, `ALTER TABLE users ADD COLUMN verified BOOLEAN DEFAULT false`)
        if err != nil {
            return err
        }
    }

    return nil
}
```

### Quick Reference: Migration Pitfalls

| Pitfall | Symptom | Fix |
|---------|---------|-----|
| Table lock on ALTER | Long table unavailability | Add nullable columns, backfill in batches |
| FK validation lock | Writes blocked | Add NOT VALID, validate separately |
| Index creation lock | Writes blocked | CREATE INDEX CONCURRENTLY |
| Data loss on rollback | Cannot recover from rollback | Keep old columns during transition |
| Dirty state | Migration won't run | Idempotent statements, IF NOT EXISTS |
| Missing timeout | Migration runs forever | SET statement_timeout |
| No advisory lock | Multiple migrations run | Use pg_advisory_lock |
| Testing only up | Rollback fails | Always test down migrations |

### Junior to FAANG: how to read these incidents and build the "why did this fail?" reflex

Every table above hides a story, and the junior engineer who reads them as "rules to memorize" misses the real lesson. Read them as timelines instead. The fintech outage did not start with `ALTER TABLE`. It started three months earlier when somebody added `transactions` to the fast-growing tables list and nobody updated the migration-sizing doc. The index creation incident did not start when `CREATE INDEX` was typed. It started when the code author ran the migration locally against a 100-row test database and the timing felt fine.

Prerequisite gaps that make these incidents surprising. You should be able to articulate the following without looking them up: what `AccessExclusiveLock` blocks in Postgres (answer: everything, including `SELECT`), what `ShareUpdateExclusiveLock` blocks (answer: other DDL but not DML), why `CREATE INDEX CONCURRENTLY` exists and what its cost is (answer: two table scans and more total time, in exchange for not blocking writes), and what the difference is between a lock a statement waits *for* and a lock a statement is *holding*. When you read `pg_stat_activity` during an incident, you need to distinguish `wait_event_type = 'Lock'` (waiting for) from `query = 'ALTER ...'` (likely holding). Confusing these sends you down the wrong cancel path.

Worked example for learning the reflex. Take the "Down Migration Data Loss" incident and rewrite it as a timeline. 2026-02-01, migration 0087 renames `user_name` to `username`. 2026-02-05, an unrelated feature writes 40-character values into `username`. 2026-02-12, a bug in unrelated code requires a rollback of deploy 4217. The rollback includes running the down migration. The down migration drops `username` and renames `user_name` back, losing five days of writes. Now ask: what single decision earlier in the timeline would have prevented the outage? Answer: marking the migration as "forward-only, rollback via fix-forward" in the ADR, so the rollback script would not have touched the database. This is the thinking pattern to internalize.

First-job scenarios you will actually see. In your first 12 months you will hit three of these eight pitfalls. The most common for new engineers is the "dirty migration state" because it is the failure mode with the lowest blast radius and therefore the one they are most often asked to handle alone. Know the three steps cold: inspect `schema_migrations`, diff expected versus actual via `information_schema`, decide force-version versus re-run with guards. Write this runbook into your personal notes before your first on-call rotation.

Entry-point interview signal. When an interviewer shows you a pitfall scenario and asks "what went wrong," a junior answer names the immediate cause ("they forgot `CONCURRENTLY`"). A better answer names the systemic cause ("there was no lint rule and no staging replay"). A strong answer names the organizational cause ("the team shipped this without a migration ADR because the ADR process is opt-in"). Each level up earns you half a bar in interview calibration.

### Senior at FAANG: pitfalls as incident reports, maturity signals, and the postmortem discipline

The pitfalls above are textbook illustrations. The real learning at staff level is in canonical public incidents. Below is a compact reading list with the lesson each teaches, and how to use them in a bar-raiser loop.

GitHub, September 2012, the MySQL migration cascade. A seemingly safe database migration drove load high enough to trip the cluster's health checks, triggering replication lag and a bad failover that cascaded into a write outage. Lesson: even "safe" DDL has a cost proportional to the current traffic, and replication topology is part of your migration plan, not a background concern. Staff engineers cite this when arguing for per-table size manifests and replica-aware throttling.

GitHub, October 2018, the 24-hour network partition. Not strictly a migration incident but relevant to migrations: a brief network partition caused the orchestrator to fail over writes to a cross-region replica, and the subsequent recovery required hours of manual reconciliation. Lesson: your migration runbook must account for failovers occurring *during* the migration. A migration plan that assumes a stable primary is a plan that breaks during incidents.

GitLab, January 2017, the rm -rf on production. An engineer chasing a replication lag problem typed `rm -rf` into the wrong ssh session. Backups turned out to be unreliable across multiple mechanisms. Lesson: destructive commands during incidents are the highest-risk moments in your system's lifecycle. Migration rollbacks often happen during incidents, which is exactly when human error spikes. Senior engineers translate this into: no destructive migrations during an active incident without a second pair of eyes and a written authorization in the incident channel.

Cloudflare, July 2020, the backbone-config cascade. A single backbone router configuration change misrouted traffic and dropped roughly half the network. Lesson: foundational infrastructure changes need explicit blast-radius analysis and staged rollout. Staff engineers translate this into: foundational tables are an ops tier, not just a logical category, and require council review.

Datadog, March 2023, the multi-region outage. Root cause involved a `systemd` update but the recovery was dominated by data-plane catchup. Lesson: migrations that depend on background catchup processes are only as fast as the slowest region to recover, and your SLO budget must include recovery time, not just forward migration time.

Postgres `DROP COLUMN` ghost-data bug, various dates. When `DROP COLUMN` runs, Postgres marks the column `attisdropped` but does not reclaim physical storage until `VACUUM FULL` or a table rewrite. During rolling upgrades, logical and physical schema can diverge. Lesson: "drop column" is never complete until storage is reclaimed and every replica has converged. Treat drop-column as a two-phase operation even when the tool does not.

MySQL `gh-ost` cutover races, multiple public postmortems. The cutover step of `gh-ost` requires a brief metadata lock that can queue behind long-running transactions. Lesson: online schema tools are not magic. They have a critical second where correctness depends on no competing long transaction, and your pre-cutover checklist must confirm `information_schema.innodb_trx` is clean.

Maturity signal from pitfall frequency. The ratio of "pitfalls hit per migration" is itself an org-maturity metric. L1 organizations hit multiple pitfalls per migration, which is why they schedule downtime. L3 organizations hit one pitfall every few months and treat each as a postmortem. L5 organizations hit a pitfall only when doing something genuinely novel, because routine pitfalls are lint-blocked. A bar-raiser can calibrate your org by asking "what was your last migration incident" and listening to whether the story involves a known pattern or a novel failure.

Postmortem discipline. Every migration failure deserves a written postmortem with these six sections: timeline in UTC with minute-level precision for the hot window, detection path including who paged whom and how long detection took, mitigation actions with commands recorded verbatim, root cause split into trigger and contributing factors, blast radius in customer-impact minutes, and action items bucketed as prevent-recurrence (lint rule, code change), reduce-impact (runbook, alerting), and improve-detection (new SLO, new dashboard). Sign the postmortem with two names: the author and the reviewing staff engineer.

Staff-level on-call runbook for each pitfall category.

Table lock outage. Detect via `pg_locks` joined to `pg_stat_activity` filtered on `granted = false`. Decide within 2 minutes: if the holder is a DDL session and the queue is growing, cancel with `pg_cancel_backend` and let the migration plan be re-run with correct online pattern. Record the session, lock graph, and query text for the postmortem. Never `pg_terminate_backend` a DDL holder unless you have confirmed the statement is safe to abort mid-flight (most are, but assume nothing).

Foreign key validation freeze. Detect via the same query plus observing `VALIDATE CONSTRAINT` in `query`. Cancel and convert to `NOT VALID` plus later `VALIDATE`. Communicate to the on-call channel that the constraint is present-but-not-enforced and must be validated during the next low-traffic window.

Index creation lock. If `CREATE INDEX` (non-concurrent) is in progress, cancel. Expect an `INVALID` index to remain and `DROP INDEX` it. Re-run with `CONCURRENTLY`. If `CREATE INDEX CONCURRENTLY` is itself stuck, check for long-running transactions that block phase 2 of the concurrent build, because concurrent index builds wait for transactions older than their snapshot to finish.

Data-loss rollback. Stop the rollback immediately. Restore the affected column from the nearest PITR checkpoint. Write a fix-forward migration that reconstructs the intended state from the backup. This is always better than continuing a destructive rollback under incident pressure.

Dirty migration state. Acquire the advisory lock manually to prevent other pods from re-racing. Read `schema_migrations`. Diff intended schema against `information_schema`. Choose: force-version if the partial state is acceptable and the remaining statements will apply cleanly on re-run, or re-run-with-guards if idempotency is in doubt. Record the decision in the incident channel with the diff output attached.

Migration platform charter implication. Every pitfall in the table above should correspond to at least one automated control in your platform. Table-lock pitfall corresponds to a lint rule that rejects non-online ALTER on tables over a size threshold. FK-validation pitfall corresponds to a lint rule that requires `NOT VALID` for constraint additions on large tables. Index-creation pitfall corresponds to a lint rule that requires `CONCURRENTLY` and a must-run-outside-transaction flag in the migration file header. If your platform does not catch these at PR time, your L6 roadmap item is to add them, and the ROI is measured in avoided incident minutes.

Bar-raiser prompt. "Tell me about a migration pitfall you have personally hit, what the postmortem said, and what systemic control you added afterward." The strong answer names the specific pattern, shows the Git commit that added the lint rule or test, and quantifies the avoided incident minutes in the following quarters.

---
