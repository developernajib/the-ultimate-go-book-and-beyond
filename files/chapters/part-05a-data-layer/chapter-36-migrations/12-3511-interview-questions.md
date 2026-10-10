## 36.11 Interview Questions

### Question 1: How do you perform zero-downtime migrations?

**Answer:**
Zero-downtime migrations use the expand-contract pattern:

1. **Expand Phase**: Add new column/table without removing old one
2. **Migration Phase**: Dual-write to both, backfill data
3. **Contract Phase**: Remove old column after all code updated

```sql
// Example: Renaming column safely
// Phase 1: Add new column
ALTER TABLE users ADD COLUMN full_name VARCHAR(255);

// Phase 2: Create trigger for dual-write
CREATE TRIGGER sync_name BEFORE INSERT OR UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION sync_name_to_full_name();

// Phase 3: Backfill existing data
UPDATE users SET full_name = name WHERE full_name IS NULL;

// Phase 4: Deploy application reading from new column
// Phase 5: Drop old column and trigger
ALTER TABLE users DROP COLUMN name;
```

Key considerations:
- Never run migrations that lock tables during peak traffic
- Use `CREATE INDEX CONCURRENTLY` for large tables (Postgres) or `ALGORITHM=INPLACE, LOCK=NONE` (MySQL 8)
- Add FK/CHECK constraints with `NOT VALID` then `VALIDATE CONSTRAINT` separately
- Batch large data updates to avoid long-running transactions
- Have rollback procedures for each phase

**What FAANG expects:** A senior candidate should walk through every phase with specific attention to what *runs in parallel* with the schema change (the old binary, the new binary, long-running transactions) and what invariants hold across the boundary. They should know why `CREATE INDEX CONCURRENTLY` requires a second pass, why it cannot run in a transaction, and what happens when it fails mid-build (an `INVALID` index that must be dropped before retry). They should mention `lock_timeout` to prevent lock queue pileup, and for Postgres they should know about `pgroll` or view-based multi-version schemas as an alternative to application-side coordination. Bonus points for acknowledging that "zero downtime" for reads is easy. "zero downtime" for strict write consistency across a rename usually requires dual-write, not just dual-read.

Follow-ups:
- What happens on Postgres if `CREATE INDEX CONCURRENTLY` is interrupted halfway? (Answer: an `INVALID` index remains, must be dropped before retry.)
- Your app has 200 replicas and you deploy a migration that drops a column. What is the correct deploy order? (Deploy code that stops reading/writing the column first, verify zero traffic hitting it via observability, then drop the column in a later release.)
- How would you migrate a column from `INT` to `BIGINT` on a 500M-row table with zero downtime? (Expand-contract: add new bigint column, trigger-based dual-write, batched backfill, app switches reads, drop old column.)

### Question 2: How do you handle failed migrations?

**Answer:**
Failed migration handling involves dirty state management and recovery:

```go
func (m *Manager) RecoverFromFailure(ctx context.Context) error {
    // 1. Identify dirty migration
    var version int64
    err := m.db.QueryRowContext(ctx,
        "SELECT version FROM schema_migrations WHERE dirty = true",
    ).Scan(&version)
    if err != nil {
        return nil // No dirty migration
    }

    // 2. Assess the damage
    // Check what was applied vs what failed

    // 3. Options:
    // a) Fix manually and force version
    // b) Run down migration if possible
    // c) Reset to previous known-good state

    // 4. Clear dirty state after resolution
    _, err = m.db.ExecContext(ctx,
        "UPDATE schema_migrations SET dirty = false WHERE version = $1",
        version,
    )
    return err
}
```

Prevention strategies:
- Always test migrations in staging first
- Use transactions where possible (and know which DDL cannot be transactional: `CREATE INDEX CONCURRENTLY`, `VACUUM`, `ALTER TYPE ... ADD VALUE` on enums in older Postgres)
- Have pre-migration database backups or a PITR checkpoint
- Implement migration validation and `atlas migrate lint` in CI

**What FAANG expects:** A strong answer distinguishes between recoverable and unrecoverable dirty state. Recoverable: DDL statements are atomic per-statement in Postgres, so "dirty" usually means some-applied, some-not - idempotent `IF NOT EXISTS` guards make replay safe. Unrecoverable: a DML backfill that partially ran and whose progress is not tracked in a resumable checkpoint table. Senior candidates should propose design patterns that make failures cheap: resumable backfills that store `last_processed_id`, every DDL guarded with `IF [NOT] EXISTS`, and a clear runbook for on-call that specifies "inspect `schema_migrations`, diff intended vs actual via `information_schema`, then either force-version or re-run." They should also flag that running migrations at pod startup in Kubernetes with N replicas is a known foot-gun and requires an advisory lock or a dedicated Job.

Follow-ups:
- Why is `schema_migrations.dirty` usually set by the *tool*, not the database? (Because DDL in Postgres is transactional per-statement but the tool's bookkeeping insert runs in a separate transaction. The tool marks dirty before executing so a crash leaves the flag set.)
- Can you always roll back with a down migration? (No. Destructive operations like `DROP COLUMN` or `TRUNCATE` cannot be reversed without the data. That is why "forward-only" migrations with rollback via a new fix-forward migration is the preferred pattern at scale.)
- What would you put in your runbook for a 3 AM dirty migration on a customer-facing DB? (Stop new deploys, identify the dirty version, diff expected vs actual schema, decide force-version vs re-run-with-guards, execute, verify app health, then post-mortem.)

### Question 3: How do you test database migrations?

**Answer:**
Comprehensive migration testing includes:

```go
func TestMigrations(t *testing.T) {
    // 1. Test forward migrations
    t.Run("up migrations", func(t *testing.T) {
        db := setupTestDB(t)
        m := setupMigrator(t, db)

        if err := m.Up(); err != nil {
            t.Fatalf("up migration failed: %v", err)
        }

        // Verify schema is correct
        assertTableExists(t, db, "users")
        assertIndexExists(t, db, "idx_users_email")
    })

    // 2. Test down migrations (reversibility)
    t.Run("down migrations", func(t *testing.T) {
        db := setupTestDB(t)
        m := setupMigrator(t, db)

        m.Up()
        if err := m.Down(); err != nil {
            t.Fatalf("down migration failed: %v", err)
        }

        // Verify schema reverted
        assertTableNotExists(t, db, "users")
    })

    // 3. Test idempotency
    t.Run("idempotency", func(t *testing.T) {
        db := setupTestDB(t)
        m := setupMigrator(t, db)

        m.Up()
        m.Down()
        m.Up() // Should work without errors
    })

    // 4. Test with real data
    t.Run("data migration", func(t *testing.T) {
        db := setupTestDB(t)
        seedTestData(db)

        m := setupMigrator(t, db)
        m.Up()

        // Verify data integrity
        verifyDataIntegrity(t, db)
    })
}
```

**What FAANG expects:** Testing migrations means more than "up works." Senior answers include: (1) apply migrations to a *shadow database* seeded with a representative data sample and diff the resulting schema against the expected schema via `information_schema`, and (2) test that the application's current version still works against the post-migration schema (backward compatibility). (3) measure migration duration against production-sized row counts, not empty test tables. (4) test that down migrations do not silently destroy data. Good candidates mention `testcontainers-go` with pinned Postgres versions and point out that integration tests must run against the *same major version* as production. They also mention `atlas migrate lint` or `squawk` as static-analysis tools that catch unsafe migrations without execution.

Follow-ups:
- How would you test that a migration completes within a latency budget on production-sized data? (Restore a recent prod snapshot into a staging DB, time the migration, extrapolate. For truly large tables, use `EXPLAIN` or compute expected batch count from current row count.)
- How do you test backward compatibility between the old app binary and the new schema? (Spin up old app version against new schema, run smoke tests, then new app against new schema. The critical window during rolling deploy is covered by this.)
- What is the difference between testing the migration and testing the *migration strategy*? (Strategy = expand-contract plan including deploy sequencing. Cannot be tested with a single DB container - requires multi-step CI with deploy-phase gates.)

### Question 4: What's the difference between versioned and declarative migrations?

**Answer:**

| Aspect | Versioned (golang-migrate) | Declarative (Atlas) |
|--------|---------------------------|---------------------|
| Definition | Explicit up/down scripts | Desired end state |
| Control | Full control over changes | Engine computes diff |
| Data migrations | Easy to include | Requires separate handling |
| Drift detection | Manual | Automatic |
| Learning curve | Lower | Higher |
| Best for | Complex data transforms | Schema-only changes |

```hcl
// Versioned migration example (SQL)
// 0001_create_users.up.sql: CREATE TABLE users (id SERIAL PRIMARY KEY, email VARCHAR(255));

// Declarative example (Atlas HCL)
table "users" {
    column "id" { type = serial }
    column "email" { type = varchar(255) }
    primary_key { columns = [column.id] }
}
// Atlas generates migration: CREATE TABLE users...
```

**What FAANG expects:** Senior candidates know the trade-off is not "versioned vs declarative" but rather "who owns the truth." Versioned migrations make the *history of changes* the source of truth. declarative makes the *current desired schema* the source of truth. Declarative tools (Atlas, `pgroll` for Postgres, Liquibase, Flyway in some modes) are powerful for simple schema evolution but struggle with data migrations that cannot be derived from the schema diff alone (e.g., "split the `name` column into `first_name` and `last_name` using a natural-language rule"). Most mature teams use a hybrid: declarative for schema, imperative for data transforms. The Atlas workflow specifically supports this - you declare the desired schema and Atlas generates a versioned migration file you can then edit to add data-migration logic.

Follow-ups:
- Why can pure declarative tools not handle all migrations? (Data transforms cannot be inferred from schema diff. "Old column to two new columns" requires business logic.)
- How does `pgroll` compare to Atlas for Postgres zero-downtime migrations? (Atlas generates the SQL. pgroll serves both versions simultaneously via views, eliminating app-side coordination. They solve different problems.)
- When would you *not* use declarative migrations? (When you need to run data transforms mid-migration, when your DB has triggers/procedures not fully representable in the declarative language, or when auditability of individual changes matters more than end-state convergence.)

### Question 5: How do you handle migrations in a microservices environment?

**Answer:**
Microservices migration strategies:

1. **Database per service**: Each service manages its own migrations
2. **Shared database**: Use schema isolation (PostgreSQL schemas)
3. **Coordination**: Use distributed locks for multi-service migrations

```go
// Distributed migration coordinator
type DistributedMigrator struct {
    db       *sql.DB
    redis    *redis.Client
    lockKey  string
    lockTTL  time.Duration
}

func (m *DistributedMigrator) AcquireGlobalLock(ctx context.Context) error {
    // Use Redis for cross-service coordination
    acquired, err := m.redis.SetNX(ctx, m.lockKey, "locked", m.lockTTL).Result()
    if err != nil {
        return err
    }
    if !acquired {
        return fmt.Errorf("another service is running migrations")
    }
    return nil
}

func (m *DistributedMigrator) Migrate(ctx context.Context) error {
    if err := m.AcquireGlobalLock(ctx); err != nil {
        return err
    }
    defer m.redis.Del(ctx, m.lockKey)

    // Run service-specific migrations
    return m.runMigrations(ctx)
}
```

Key considerations:
- Version your migration dependencies
- Use schema namespacing for isolation
- Coordinate deployments across services
- Handle partial failures gracefully

**What FAANG expects:** The correct default is database-per-service: it eliminates cross-team coordination on schema changes entirely. Shared-database-with-schema-isolation is a valid second-best when Conway's-law forces teams onto the same physical database (e.g., reporting workloads that join across domains). Cross-service migrations that require coordinated schema changes are a design smell - they indicate that a domain boundary is in the wrong place. Senior candidates should mention that even with database-per-service, the *application* contract (e.g., an event schema published on Kafka) is itself a schema that needs its own expand-contract discipline, and tools like Confluent Schema Registry or Avro evolution rules are the equivalent of Atlas for event payloads.

Follow-ups:
- How do you handle a migration that requires coordinated schema changes across three services? (Sequence: each service adds new fields, deploys, then gradually cuts over via feature flags. Never do simultaneous migrations across services - stagger them with backward-compat contracts.)
- Your service publishes a Kafka event. How do you evolve the event schema without breaking consumers? (Same expand-contract: add new optional fields first, consumers handle both shapes, then contract. Use a schema registry to enforce compatibility rules in CI.)
- When is sharing a database across services actually the right call? (Almost never, but: true transactional boundaries that cannot be eventually-consistent, or when the team is small enough that service isolation adds more cost than it removes.)

### Junior to FAANG: prerequisite gaps, worked examples, and the "why did this fail?" reflex

If you are reading these questions cold and the phrase "expand-contract" felt like new vocabulary, that is the gap to close before your first on-site. Junior candidates routinely lose migration rounds not because they lack SQL skill but because they answer the wrong question. The interviewer asks "how do you add a column" and hears the candidate describe `ALTER TABLE ADD COLUMN`. The correct answer describes deploys. Migrations are a deploy problem disguised as a SQL problem, and once you see that framing the whole topic reorganizes.

Worked example for a first-job candidate. Imagine you have a `users` table with 40 million rows on Postgres 17 and product wants to record each user's preferred display name. Here is the junior answer you want to be able to deliver cleanly in under three minutes:

1. Write an idempotent migration that runs `ALTER TABLE users ADD COLUMN display_name VARCHAR(200)`. On Postgres 11 and newer this is metadata-only for nullable columns with no default, so it is effectively instant.
2. Deploy application code that writes to `display_name` on new signups and reads `COALESCE(display_name, username)` everywhere.
3. Run a batched backfill, not a single `UPDATE`. Something like `UPDATE users SET display_name = username WHERE id BETWEEN $1 AND $2 AND display_name IS NULL`, chunked by 5000 rows, with a sleep between batches.
4. Once the backfill finishes, deploy the version of the app that reads `display_name` directly and drops the `COALESCE`.

That is the baseline. The interviewer will then escalate. "What if the column is `NOT NULL`?" Now you need a default, and on older Postgres a `NOT NULL` default used to rewrite the entire table. "What if there is a `CHECK` constraint?" Use `NOT VALID` then `VALIDATE CONSTRAINT` so the validation scan does not hold an `AccessExclusiveLock`. "What if we need to rename the column?" That is a different shape of problem and is where expand-contract becomes mandatory.

Prerequisite gaps to patch before your first interview. You should be able to explain in plain English: what a `ShareUpdateExclusiveLock` is versus an `AccessExclusiveLock`, why `CREATE INDEX` blocks writes and `CREATE INDEX CONCURRENTLY` does not, what `lock_timeout` does, what `statement_timeout` does, why `idle_in_transaction_session_timeout` exists, and why long-running transactions interact badly with DDL. If any of those are fuzzy, stop and read the Postgres locking docs end-to-end before your loop. MySQL candidates need the equivalent: `ALGORITHM=INPLACE`, `LOCK=NONE`, online DDL limitations, and the gh-ost or pt-online-schema-change tools.

The "why did this fail?" reflex. When you are new, every migration looks the same: run the tool, hope it works. The reflex that separates a promotable junior from a stalled junior is the instinctive question "what did the database see at the moment this failed?" That means opening `pg_stat_activity`, reading the lock graph, correlating with the application log, and reconstructing the timeline. Practice this on a sandbox by deliberately causing failures: open a long transaction in one session, run a DDL in another, and watch the lock queue form. You will internalize why migrations fail during peak traffic and why they succeed at 3 AM on the same schema.

Interview entry point. For L3 and L4 loops, expect a 30-minute block where the interviewer hands you a schema and a product requirement and asks you to produce the migration plan on a whiteboard or shared doc. The rubric is rarely "did the SQL compile." It is "did the candidate ask about row count, traffic pattern, replication topology, and rollback, before writing a single ALTER." Open every migration question with those four clarifying questions and you will outperform half the pool.

### Senior at FAANG: the interview signal ladder, bar-raiser questions, and what staff answers sound like

At L5 and above the interview is no longer "can you write a safe migration." It is "can you run a migration program across a fleet." The signal ladder below is what bar-raisers use to calibrate level, based on how candidates answer the canonical prompt "walk me through adding a column to a 500 million row table without downtime."

L3 answer. "I would add the column with `ALTER TABLE`." Correct SQL, no awareness of operational constraints. Maps to new-grad.

L4 answer. "I would add the column nullable, then backfill in batches, then deploy code that reads from it. I would run `CREATE INDEX CONCURRENTLY` if I needed an index." Correct operationally, but treats the migration as a single-team activity. Maps to solid SDE.

L5 answer. Introduces the deploy-coordination dimension. "The migration is one step in a five-step sequence. Step one is the code deploy that tolerates both shapes of the schema. Step two is the additive DDL. Step three is the backfill, run as a background job with a resumable checkpoint table so if it dies at 2 AM we restart at the last committed batch, not from zero. Step four is the deploy that switches reads to the new column. Step five is the destructive cleanup, held behind a feature flag and a mandatory 7-day soak. Rollback at each phase is different and documented." This answer also acknowledges replication lag, failover during migration, and the `ANALYZE` step needed after large backfills so the planner does not pick bad plans. Maps to senior.

L6 answer. Widens the scope from "one migration" to "migration platform." "The question presumes this is a one-off. At our scale we run hundreds of migrations per week across thousands of services. The interesting design is not the SQL, it is the platform: a declarative schema registry, a lint pipeline that rejects unsafe patterns in CI, an autonomous executor that understands per-table SLAs and traffic windows, a shadow-read verifier, and an automated rollback on SLO breach. The 500 million row table is solved by the platform. A human should not be making per-migration decisions for this case." Maps to staff.

L7 answer. Treats the question as a proxy for organizational design. "Migration risk is a portfolio. You fund the platform investment by measuring migration-induced incident minutes and proving the platform reduces them. The harder question is governance: who approves schema changes for foundational tables like `users` or `accounts` that dozens of downstream consumers depend on? That requires a data contracts regime, a schema review council, and an explicit distinction between public and internal columns. The 500 million row table is easy. keeping 50 services from coupling to its internal columns is the real work." Maps to principal.

Bar-raiser questions I have seen in real loops:

1. "You need to add a `NOT NULL` column with a computed default to a foundational customer table replicated across three regions with eventually-consistent read replicas. The column backs a new compliance feature that has a regulatory deadline in 6 weeks. Walk me through the plan, the rollback, and the communication to the 50 teams that query this table." The bar-raiser is listening for: regional choreography, read-replica lag tolerance, contract-testing with the downstream consumers, explicit escalation to a schema review council, and a written ADR naming the accountable engineer.

2. "A migration has been running for 4 hours on a production table. Pager just fired because query latency p99 doubled. You have 5 minutes before customer-visible impact becomes a Sev 2. What do you do?" The bar-raiser wants the runbook: identify the migration session in `pg_stat_activity`, check if it is holding `AccessExclusiveLock`, decide between `pg_cancel_backend` versus `pg_terminate_backend`, confirm the migration is resumable, capture the lock graph for the postmortem, and only then decide whether to roll back the migration entirely or let it finish.

3. "Design a zero-downtime migration system for a schema change that must coordinate across 50 microservices." The bar-raiser wants: schema registry, consumer-driven contract tests, feature flags per phase, a central choreography service or saga, explicit recognition that simultaneous migration is never correct and must always be staged, and a discussion of how to detect "dead" columns (columns still defined but no longer queried) so you can reclaim them safely.

4. "Tell me about a migration that failed in production. What went wrong, what did you do, what changed afterward?" The bar-raiser is calibrating candor and learning velocity. Weak answers blame the database. Strong answers name the decision in the planning phase that made the failure possible and describe the systemic fix that prevented the next ten.

Pitfalls as incident reports. Senior candidates are expected to cite canonical failures and extract the lesson. GitHub's September 2012 outage, where a routine database migration drove load high enough to trip the cluster's health checks and cascade into a bad master failover, taught the industry to treat migration-induced load and failover choreography as first-class migration risks (and, separately, `AccessExclusiveLock` queue pileup is the canonical Postgres reason `lock_timeout` is mandatory on every DDL session). GitLab's January 2017 incident, where an engineer accidentally ran `rm -rf` on the primary while chasing a replication lag problem, taught the industry that backup verification is not optional and that cognitive load during incidents causes destructive action. Cloudflare's July 2020 outage, where a single backbone router configuration change misrouted traffic and dropped roughly half the network, taught the industry that change-management for foundational infrastructure needs blast-radius analysis before approval. The Postgres `DROP COLUMN` footgun where the column is marked `attisdropped` but physical storage remains, causing ghost data to survive in replicas during a partial upgrade, is the canonical reminder that logical and physical schema diverge.

Maturity model, L1 through L5.

- L1, manual-with-downtime. A DBA runs `psql` during a scheduled maintenance window. No tooling. No tests. Rollback means restoring from a backup. Typical of early startups and legacy enterprises.
- L2, scripted-with-downtime. Migrations live in a Git repo with sequential filenames. Someone on-call runs `migrate up` during deploys. Still downtime for anything non-trivial. A single shared schema-versioning table. Most Rails and Django shops before any scaling event.
- L3, zero-downtime-by-convention. Team has internalized expand-contract. Migrations run ahead of code deploys via a dedicated Job in Kubernetes with an advisory lock. Lint rules block `DROP COLUMN` without a two-release buffer. No platform, but strong discipline.
- L4, platform-assisted. Central migration service with scheduled execution, automated linting via `atlas migrate lint` or `squawk`, shadow-database verification in CI, automated rollback triggered by SLO breach, observability on migration duration and lock wait time. Humans write migrations but the platform runs and monitors them.
- L5, declarative-self-service. Developers declare desired schema, platform generates and executes the migration. Lint, review, test, deploy, observe, and rollback are all automated. Humans intervene only for exceptional cases. This is where the largest FAANG-scale organizations live, with internal tools that look like managed `pgroll` or Spanner's online schema evolution.

Migration platform team charter, a template you can use in a real L6 design interview. Mission: reduce migration-induced incident minutes to zero while enabling 1000+ migrations per week. Scope: schema registry, lint engine, execution runtime, rollback controller, observability, documentation. Boundaries: does not own application data models, does not own data quality, does not own backup and restore. SLOs: 99.9% of migrations complete without human intervention, median migration lead-time under 2 hours from PR to production, zero customer-visible impact from routine migrations. Staffing: 6 to 10 engineers plus 1 PM plus 1 technical writer, split across SQL analysis, runtime, and developer experience. Governance: a schema review council of 5 senior engineers approves changes to foundational tables and maintains the list of foundational tables.

Staff-level extensions for the exercises below. Build a migration lint tool that parses SQL with `pg_query_go` and flags `DROP COLUMN`, `ALTER TYPE`, and implicit table rewrites. Design a migration review ADR template that forces the author to name the affected row count, estimated duration, required locks, rollback plan, and the on-call engineer for the release window. Write a postmortem template that categorizes migration failures into "lint-preventable," "test-preventable," "platform-preventable," and "genuinely novel," because the ratio of these categories is your primary quality metric.

On-call runbook skeleton for migration failures. Page fires. Step 1, acknowledge within 2 minutes. Step 2, confirm scope: is the migration holding a lock, running long, or has the tool itself crashed? Query `pg_stat_activity` filtered by `query ILIKE '%schema_migrations%'` or by the session tag the platform attaches. Step 3, confirm blast radius: is customer traffic degraded, or is this purely a migration-internal problem? Check the service dashboard, not just the DB dashboard. Step 4, decide. Three options: let it complete (if ETA less than SLO budget), cancel with `pg_cancel_backend` (if resumable and not holding `AccessExclusiveLock`), or terminate with `pg_terminate_backend` (last resort, forces rollback). Step 5, record the lock graph and the `pg_stat_activity` snapshot for the postmortem before any state-changing action. Step 6, communicate: post in the incident channel within 5 minutes with intent, and update every 15 minutes until resolved. Step 7, after resolution, open a postmortem ticket within 24 hours and a platform-improvement ticket within 72 hours.

---
