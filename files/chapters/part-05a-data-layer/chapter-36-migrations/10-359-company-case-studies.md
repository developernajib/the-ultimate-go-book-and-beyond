## 36.9 Company Case Studies

### Stripe: Zero-Downtime Migrations at Scale

Stripe runs continuous deployments across hundreds of services sharing PostgreSQL clusters. Every schema change must be backward-compatible with the previous application version because old and new code run side by side during rolling deploys. The expand-contract pattern below shows how to rename a column safely using triggers for dual-write and batched backfill for existing data.

```go
// Stripe's expand-contract pattern implementation
package migrations

import (
    "context"
    "database/sql"
    "fmt"
    "log/slog"
    "time"
)

// ExpandContractMigration represents a multi-phase migration
type ExpandContractMigration struct {
    db     *sql.DB
    logger *slog.Logger
}

// Phase represents a migration phase
type Phase struct {
    Name        string
    SQL         string
    Reversible  bool
    RevertSQL   string
    PreCheck    func(ctx context.Context) error
    PostCheck   func(ctx context.Context) error
    Description string
}

// RenameColumnSafely performs a zero-downtime column rename
// This is the pattern Stripe uses for all schema changes
func (m *ExpandContractMigration) RenameColumnSafely(
    ctx context.Context,
    table, oldColumn, newColumn, columnType string,
) error {
    phases := []Phase{
        {
            Name: "expand_add_column",
            SQL: fmt.Sprintf(
                "ALTER TABLE %s ADD COLUMN IF NOT EXISTS %s %s",
                table, newColumn, columnType,
            ),
            Description: "Add new column (nullable)",
            Reversible:  true,
            RevertSQL: fmt.Sprintf(
                "ALTER TABLE %s DROP COLUMN IF EXISTS %s",
                table, newColumn,
            ),
        },
        {
            Name: "dual_write_trigger",
            SQL: fmt.Sprintf(`
                CREATE OR REPLACE FUNCTION sync_%s_%s()
                RETURNS TRIGGER AS $$
                BEGIN
                    IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
                        NEW.%s = COALESCE(NEW.%s, NEW.%s);
                    END IF;
                    RETURN NEW;
                END;
                $$ LANGUAGE plpgsql;

                DROP TRIGGER IF EXISTS sync_%s_%s_trigger ON %s;
                CREATE TRIGGER sync_%s_%s_trigger
                BEFORE INSERT OR UPDATE ON %s
                FOR EACH ROW EXECUTE FUNCTION sync_%s_%s();
            `, table, newColumn, newColumn, newColumn, oldColumn,
               table, newColumn, table, table, newColumn, table, table, newColumn),
            Description: "Create trigger for dual writes",
            Reversible:  true,
            RevertSQL: fmt.Sprintf(`
                DROP TRIGGER IF EXISTS sync_%s_%s_trigger ON %s;
                DROP FUNCTION IF EXISTS sync_%s_%s();
            `, table, newColumn, table, table, newColumn),
        },
        {
            Name: "backfill_data",
            SQL: fmt.Sprintf(`
                UPDATE %s SET %s = %s WHERE %s IS NULL
            `, table, newColumn, oldColumn, newColumn),
            Description: "Backfill existing data",
            PreCheck: func(ctx context.Context) error {
                // Estimate rows to update
                var count int64
                err := m.db.QueryRowContext(ctx, fmt.Sprintf(
                    "SELECT COUNT(*) FROM %s WHERE %s IS NULL",
                    table, newColumn,
                )).Scan(&count)
                if err != nil {
                    return err
                }
                m.logger.Info("backfill estimate",
                    "table", table,
                    "rows", count,
                )
                return nil
            },
        },
    }

    // Execute phases
    for i, phase := range phases {
        m.logger.Info("executing phase",
            "phase", phase.Name,
            "description", phase.Description,
            "step", fmt.Sprintf("%d/%d", i+1, len(phases)),
        )

        if phase.PreCheck != nil {
            if err := phase.PreCheck(ctx); err != nil {
                return fmt.Errorf("pre-check failed for %s: %w", phase.Name, err)
            }
        }

        if _, err := m.db.ExecContext(ctx, phase.SQL); err != nil {
            // Attempt revert
            if phase.Reversible && phase.RevertSQL != "" {
                m.logger.Warn("attempting revert", "phase", phase.Name)
                m.db.ExecContext(ctx, phase.RevertSQL)
            }
            return fmt.Errorf("phase %s failed: %w", phase.Name, err)
        }

        if phase.PostCheck != nil {
            if err := phase.PostCheck(ctx); err != nil {
                return fmt.Errorf("post-check failed for %s: %w", phase.Name, err)
            }
        }
    }

    return nil
}

// BatchBackfill performs batched backfill to avoid long locks
// Stripe uses this for large table migrations
func (m *ExpandContractMigration) BatchBackfill(
    ctx context.Context,
    table, sourceColumn, targetColumn, primaryKey string,
    batchSize int,
    sleepBetweenBatches time.Duration,
) error {
    var processed int64
    var lastID int64

    for {
        result, err := m.db.ExecContext(ctx, fmt.Sprintf(`
            UPDATE %s
            SET %s = %s
            WHERE %s IN (
                SELECT %s FROM %s
                WHERE %s IS NULL AND %s > $1
                ORDER BY %s
                LIMIT $2
            )
        `, table, targetColumn, sourceColumn,
           primaryKey, primaryKey, table, targetColumn, primaryKey, primaryKey),
            lastID, batchSize)

        if err != nil {
            return fmt.Errorf("batch update failed at id %d: %w", lastID, err)
        }

        affected, _ := result.RowsAffected()
        processed += affected

        if affected == 0 {
            break // No more rows to update
        }

        // Get last processed ID
        err = m.db.QueryRowContext(ctx, fmt.Sprintf(`
            SELECT MAX(%s) FROM %s WHERE %s IS NOT NULL AND %s > $1
        `, primaryKey, table, targetColumn, primaryKey), lastID).Scan(&lastID)
        if err != nil {
            return err
        }

        m.logger.Info("batch progress",
            "table", table,
            "processed", processed,
            "last_id", lastID,
        )

        // Throttle to reduce database load
        time.Sleep(sleepBetweenBatches)
    }

    m.logger.Info("backfill complete", "table", table, "total_rows", processed)
    return nil
}
```

**Key Lessons from Stripe:**
- Never run migrations that lock tables for more than a few seconds
- Use triggers for dual-write during transition periods
- Backfill data in batches with throttling
- Deploy application changes before and after schema changes

### GitHub: Ghost Migration System

GitHub developed `gh-ost` for zero-downtime schema migrations on large tables:

```go
// GitHub-style online schema change pattern
package migrations

import (
    "context"
    "database/sql"
    "fmt"
    "time"
)

// GhostStyleMigration implements online schema change
type GhostStyleMigration struct {
    db         *sql.DB
    sourceTable string
    ghostTable  string
    cutoverLock string
}

// OnlineSchemaChange performs table rebuild without blocking writes
// This mimics GitHub's gh-ost approach
func (g *GhostStyleMigration) OnlineSchemaChange(
    ctx context.Context,
    alterStatement string,
) error {
    g.ghostTable = g.sourceTable + "_ghost"

    // Step 1: Create ghost table with new schema
    createGhost := fmt.Sprintf(`
        CREATE TABLE %s AS SELECT * FROM %s WHERE 1=0
    `, g.ghostTable, g.sourceTable)

    if _, err := g.db.ExecContext(ctx, createGhost); err != nil {
        return fmt.Errorf("failed to create ghost table: %w", err)
    }
    defer g.cleanup(ctx)

    // Step 2: Apply schema change to ghost table
    alterGhost := fmt.Sprintf("ALTER TABLE %s %s", g.ghostTable, alterStatement)
    if _, err := g.db.ExecContext(ctx, alterGhost); err != nil {
        return fmt.Errorf("failed to alter ghost table: %w", err)
    }

    // Step 3: Create triggers to capture ongoing changes
    if err := g.createSyncTriggers(ctx); err != nil {
        return fmt.Errorf("failed to create triggers: %w", err)
    }

    // Step 4: Copy data from source to ghost in batches
    if err := g.copyData(ctx); err != nil {
        return fmt.Errorf("failed to copy data: %w", err)
    }

    // Step 5: Atomic cutover
    if err := g.atomicCutover(ctx); err != nil {
        return fmt.Errorf("failed to cutover: %w", err)
    }

    return nil
}

func (g *GhostStyleMigration) createSyncTriggers(ctx context.Context) error {
    // INSERT trigger
    insertTrigger := fmt.Sprintf(`
        CREATE OR REPLACE FUNCTION %s_insert_sync()
        RETURNS TRIGGER AS $$
        BEGIN
            INSERT INTO %s SELECT NEW.*;
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;

        CREATE TRIGGER %s_insert_trigger
        AFTER INSERT ON %s
        FOR EACH ROW EXECUTE FUNCTION %s_insert_sync();
    `, g.sourceTable, g.ghostTable, g.sourceTable, g.sourceTable, g.sourceTable)

    if _, err := g.db.ExecContext(ctx, insertTrigger); err != nil {
        return err
    }

    // UPDATE trigger
    updateTrigger := fmt.Sprintf(`
        CREATE OR REPLACE FUNCTION %s_update_sync()
        RETURNS TRIGGER AS $$
        BEGIN
            UPDATE %s SET * = NEW.* WHERE id = NEW.id;
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;

        CREATE TRIGGER %s_update_trigger
        AFTER UPDATE ON %s
        FOR EACH ROW EXECUTE FUNCTION %s_update_sync();
    `, g.sourceTable, g.ghostTable, g.sourceTable, g.sourceTable, g.sourceTable)

    if _, err := g.db.ExecContext(ctx, updateTrigger); err != nil {
        return err
    }

    // DELETE trigger
    deleteTrigger := fmt.Sprintf(`
        CREATE OR REPLACE FUNCTION %s_delete_sync()
        RETURNS TRIGGER AS $$
        BEGIN
            DELETE FROM %s WHERE id = OLD.id;
            RETURN OLD;
        END;
        $$ LANGUAGE plpgsql;

        CREATE TRIGGER %s_delete_trigger
        AFTER DELETE ON %s
        FOR EACH ROW EXECUTE FUNCTION %s_delete_sync();
    `, g.sourceTable, g.ghostTable, g.sourceTable, g.sourceTable, g.sourceTable)

    return g.db.QueryRowContext(ctx, deleteTrigger).Err()
}

func (g *GhostStyleMigration) copyData(ctx context.Context) error {
    // Copy in batches to avoid long-running transactions
    batchSize := 10000
    var lastID int64

    for {
        result, err := g.db.ExecContext(ctx, fmt.Sprintf(`
            INSERT INTO %s
            SELECT * FROM %s
            WHERE id > $1
            ORDER BY id
            LIMIT $2
            ON CONFLICT (id) DO NOTHING
        `, g.ghostTable, g.sourceTable), lastID, batchSize)

        if err != nil {
            return err
        }

        affected, _ := result.RowsAffected()
        if affected == 0 {
            break
        }

        // Get last copied ID
        g.db.QueryRowContext(ctx, fmt.Sprintf(
            "SELECT MAX(id) FROM %s WHERE id > $1",
            g.ghostTable,
        ), lastID).Scan(&lastID)

        // Small delay to reduce load
        time.Sleep(100 * time.Millisecond)
    }

    return nil
}

func (g *GhostStyleMigration) atomicCutover(ctx context.Context) error {
    // Use advisory lock for cutover
    _, err := g.db.ExecContext(ctx, "SELECT pg_advisory_lock($1)", 12345)
    if err != nil {
        return err
    }
    defer g.db.ExecContext(ctx, "SELECT pg_advisory_unlock($1)", 12345)

    // Atomic rename
    tx, err := g.db.BeginTx(ctx, nil)
    if err != nil {
        return err
    }
    defer tx.Rollback()

    oldTable := g.sourceTable + "_old"

    // Rename source to old
    if _, err := tx.ExecContext(ctx, fmt.Sprintf(
        "ALTER TABLE %s RENAME TO %s",
        g.sourceTable, oldTable,
    )); err != nil {
        return err
    }

    // Rename ghost to source
    if _, err := tx.ExecContext(ctx, fmt.Sprintf(
        "ALTER TABLE %s RENAME TO %s",
        g.ghostTable, g.sourceTable,
    )); err != nil {
        return err
    }

    return tx.Commit()
}

func (g *GhostStyleMigration) cleanup(ctx context.Context) {
    // Drop triggers
    g.db.ExecContext(ctx, fmt.Sprintf("DROP TRIGGER IF EXISTS %s_insert_trigger ON %s",
        g.sourceTable, g.sourceTable))
    g.db.ExecContext(ctx, fmt.Sprintf("DROP TRIGGER IF EXISTS %s_update_trigger ON %s",
        g.sourceTable, g.sourceTable))
    g.db.ExecContext(ctx, fmt.Sprintf("DROP TRIGGER IF EXISTS %s_delete_trigger ON %s",
        g.sourceTable, g.sourceTable))

    // Drop functions
    g.db.ExecContext(ctx, fmt.Sprintf("DROP FUNCTION IF EXISTS %s_insert_sync()",
        g.sourceTable))
    g.db.ExecContext(ctx, fmt.Sprintf("DROP FUNCTION IF EXISTS %s_update_sync()",
        g.sourceTable))
    g.db.ExecContext(ctx, fmt.Sprintf("DROP FUNCTION IF EXISTS %s_delete_sync()",
        g.sourceTable))
}
```

**Key Lessons from GitHub:**
- Create ghost tables for schema changes on large tables
- Use triggers to sync ongoing changes during migration
- Perform atomic cutover with minimal lock time
- Always have cleanup procedures for failed migrations

### Netflix: Feature-Flagged Migrations

Netflix uses feature flags to gradually roll out schema changes:

```go
// Netflix-style feature-flagged migration
package migrations

import (
    "context"
    "database/sql"
    "sync"
)

// FeatureFlaggedMigration supports gradual rollout of schema changes
type FeatureFlaggedMigration struct {
    db           *sql.DB
    featureFlags FeatureFlagService
    mu           sync.RWMutex
    activeReader string // "old" or "new"
}

// FeatureFlagService interface for feature flag integration
type FeatureFlagService interface {
    IsEnabled(flag string) bool
    GetPercentage(flag string) int
}

// Read reads from the appropriate column based on feature flag
func (m *FeatureFlaggedMigration) Read(
    ctx context.Context,
    query string,
    useNewSchema bool,
) (*sql.Rows, error) {
    m.mu.RLock()
    defer m.mu.RUnlock()

    // Netflix gradually shifts reads to new schema
    if useNewSchema && m.featureFlags.IsEnabled("use_new_schema") {
        return m.db.QueryContext(ctx, m.transformQueryForNewSchema(query))
    }
    return m.db.QueryContext(ctx, query)
}

// Write writes to both old and new columns during transition
func (m *FeatureFlaggedMigration) Write(
    ctx context.Context,
    oldQuery, newQuery string,
) error {
    tx, err := m.db.BeginTx(ctx, nil)
    if err != nil {
        return err
    }
    defer tx.Rollback()

    // Always write to old schema for backwards compatibility
    if _, err := tx.ExecContext(ctx, oldQuery); err != nil {
        return err
    }

    // If new schema is enabled, also write there
    if m.featureFlags.IsEnabled("dual_write_enabled") {
        if _, err := tx.ExecContext(ctx, newQuery); err != nil {
            // Log but don't fail - new schema is optional during rollout
            // Netflix logs these for monitoring
        }
    }

    return tx.Commit()
}

func (m *FeatureFlaggedMigration) transformQueryForNewSchema(query string) string {
    // Transform queries to use new column names
    // This would be more sophisticated in production
    return query
}

// MigrationPhase represents the current phase of a feature-flagged migration
type MigrationPhase int

const (
    PhaseOldSchemaOnly MigrationPhase = iota
    PhaseDualWrite
    PhaseDualRead
    PhaseNewSchemaOnly
)

// GetMigrationPhase returns the current migration phase based on feature flags
func (m *FeatureFlaggedMigration) GetMigrationPhase() MigrationPhase {
    if !m.featureFlags.IsEnabled("dual_write_enabled") {
        return PhaseOldSchemaOnly
    }
    if !m.featureFlags.IsEnabled("read_from_new_schema") {
        return PhaseDualWrite
    }
    if m.featureFlags.IsEnabled("old_schema_deprecated") {
        return PhaseNewSchemaOnly
    }
    return PhaseDualRead
}
```

**Key Lessons from Netflix:**
- Use feature flags to control migration rollout
- Support dual-write and dual-read phases
- Monitor error rates during each phase
- Have instant rollback capability via flag toggle

### Junior → FAANG: prerequisite gaps and first-job context

Reading case studies before you have shipped a migration yourself is like reading biographies of chess grandmasters before learning how the pieces move. The patterns are real but the prerequisite knowledge is doing the work at small scale first. Before you try to implement Stripe's expand-contract or GitHub's ghost-table approach, ship five boring additive migrations against a production database under supervision. Learn what lock contention feels like when you forget `lock_timeout`. Watch a `CREATE INDEX CONCURRENTLY` fail and leave an `INVALID` index. Then the case studies will read as solutions to problems you have felt, not as folklore from companies you will never work at.

Worked example for extracting value from case studies. Read GitHub's blog post "gh-ost: triggerless online schema migrations for MySQL" (2016, still the canonical reference). Do not try to implement gh-ost. Instead, ask yourself three questions. What problem did triggers cause that made them want to remove triggers (answer: writes paid trigger overhead during the copy, and triggers inside transactions interacted badly with MySQL's row-based replication). How did they replace triggers (answer: by reading the binlog directly and replaying changes from there, so no write path is modified). What constraint does this impose (answer: gh-ost needs binlog_format=ROW and replica-like binlog access, which is why it does not work unmodified on all managed MySQL offerings). Answering those three questions teaches you more about online DDL than reading all the code in this section. The pattern repeats for every case study: find the problem, find the constraint, understand the tradeoff.

Interview entry-point. When asked about zero-downtime migrations in a system design interview, naming Stripe's dual-write pattern and GitHub's gh-ost is table stakes. The differentiator is being able to explain when each is appropriate. Dual-write in application code is right when the schema change is simple (new column, rename) and the application team owns it end to end. Ghost-table online DDL is right when the change is structural (adding a new index on a huge table, changing a primary key type) and the overhead of dual-write in application code would multiply across too many call sites. Feature-flagged migration is right when the cutover needs to be gradual and observable at the traffic level, not at the schema level. The answer "it depends, here is the decision tree" beats any single named technique.

### Senior @ FAANG: a broader map of real-world schema change systems

The three case studies above are a starting point. A staff-level understanding of schema change in 2026 covers a wider landscape, and the patterns diverge more than the code in this chapter suggests.

GitHub's journey with gh-ost. Released 2016, adopted internally for MySQL schema changes of any consequence. The key insight was binlog-based replay rather than triggers, which eliminated write-path overhead and the interaction problems between triggers and row-based replication. gh-ost is still in active maintenance in 2026 and remains the reference for MySQL online DDL at companies that run their own MySQL. Companies on RDS or Aurora without binlog access fall back to Percona's pt-online-schema-change, which uses triggers, or to the native `ALGORITHM=INPLACE` path for changes that qualify. Block (formerly Square) released Spirit in 2023 as a gh-ost-class tool written in Go with better support for cloud-managed MySQL and better handling of the edge cases where gh-ost historically needed manual intervention. Spirit is worth watching in 2026 because it is positioning as the modern default for MySQL online DDL.

Meta/Facebook's online schema change. Internal tool, never open-sourced in a reusable form, but documented in engineering blog posts. The system runs schema changes as declarative YAML submitted to a control plane, with automatic shadow-DB validation (replay against a production snapshot), automatic throttling tied to MySQL replica lag, and automatic rollback if replication drift exceeds a threshold during copy. Meta's scale forces the operator model because a migration that would take 2 hours on a single database can take 2 weeks across the full fleet, and that duration cannot be coupled to a deploy.

Instagram's sharding migration. Famously documented in the "Sharding and IDs at Instagram" post (2012, still cited) and follow-ups covering the migration from unsharded Postgres to a sharded schema. The key pattern was logical sharding implemented via Postgres schemas (thousands of schemas per physical database), with a routing layer in application code that hashed user IDs to shards. The migration ran for months, with dual-writes bridging the unsharded and sharded versions, and the cutover happened per-feature rather than in one big bang.

Discord's Cassandra to ScyllaDB migration. Covered in the 2022-2023 blog series. Not strictly a schema migration, but a storage engine migration, which is a superset problem. The pattern was dual-write to both Cassandra and Scylla for months, shadow-read and compare (a comparison service that answered the same query against both and reported divergence), and a gradual traffic cutover by partition. The engineering investment was significant. The lesson for schema migrations is that divergence monitoring during dual-write is not optional at scale, it is the only way to gain confidence that the cutover will be safe.

Figma's Postgres sharding. Covered in the 2024 engineering blog. Figma horizontally sharded a single Postgres instance into multiple logical databases using a custom routing layer and a sequence of expand-contract migrations per table. The insight was that they sharded incrementally, one table family at a time, with each family behind a feature flag that let them roll back if something went wrong. The full migration took over a year, and the team held the position that "no multi-quarter migration ever finishes if it cannot be paused and resumed between quarters," which drove the feature-flag-per-table design.

Notion's block sharding. Notion sharded their primary `block` table in 2021, documented in a blog post. The pattern was a bespoke double-write layer in application code, a backfill service that copied blocks from the unsharded table to the sharded tables in parallel, and a router that checked the sharded tables first and fell back to the unsharded table for blocks not yet backfilled. Cutover was progressive per-workspace. Notable lesson: the fallback read to the unsharded table stayed in production for months after the apparent completion because long-tail data kept surfacing that had not been backfilled correctly. "Migration complete" is a claim that should be made with data, not with project-plan optimism.

Stripe's payments ledger migration. Not publicly documented in detail because of the financial compliance implications, but described at conferences. Stripe ran dual-writes to the old and new ledger schemas for an extended period before any read cutover, with a divergence monitoring service comparing every transaction written to both schemas and paging on any mismatch. The engineering cost was enormous and the timeline was glacial, but the blast radius of getting the ledger wrong in even a single edge case would have been a regulatory event, so the tradeoff was correct. Staff engineers considering a similar migration for financial data should assume this order of magnitude of investment, not an order of magnitude less.

Uber's Schemaless to MySQL migration (and back). Uber built Schemaless, a triplet-store layer on MySQL, then spent years migrating workloads onto it, then later migrated several workloads off it back onto native sharded MySQL. Lesson: migration direction is not one-way. A schema choice that was right in 2015 may be wrong in 2022, and the organization needs muscle memory for migrating off its own internal systems, not just onto them.

Vitess Online DDL. The production abstraction layer used by YouTube, Slack, HubSpot, Etsy, Square, Pinterest, and others. Vitess exposes `ALTER VITESS_MIGRATION` commands that the user submits as if they were SQL, and the Vitess control plane internally invokes gh-ost, pt-osc, or the native path depending on the change and configuration. Throttling is tied to replica lag across the full shard fleet. Cancellation is first-class. For organizations already on Vitess, Online DDL is the answer. For organizations not on Vitess but with MySQL at scale, Vitess Online DDL is worth studying as the reference for what an operator-led schema change API should look like.

The through-line across all these case studies is that schema change at scale is not a feature of a migration tool, it is a product with its own team, own on-call rotation, own observability, own audit requirements, and own release cadence. Staff and principal engineers working on platforms should treat "how do we change schemas" as a product question, not an engineering-hours question, and should expect the platform investment to be measured in engineer-years not engineer-weeks.

---
