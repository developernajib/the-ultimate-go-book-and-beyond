## 36.1 Migration Fundamentals

### Why Migrations?

Database migrations solve the fundamental challenge of evolving database schemas alongside application code. Without proper migration management, teams face inconsistent environments, manual intervention, and production incidents.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                      DATABASE MIGRATION ARCHITECTURE                         │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐    │
│  │                        MIGRATION SOURCES                             │    │
│  ├──────────────────────────────────────────────────────────────────────┤    │
│  │  SQL Files              Go Migrations           Schema-as-Code       │    │
│  │  ┌──────────┐          ┌──────────────┐        ┌─────────────────┐   │    │
│  │  │001_up.sql│          │ migration.go │        │ schema.hcl/sql  │   │    │
│  │  │ 001_down │          │ Up()/Down()  │        │ Declarative     │   │    │
│  │  │002_up.sql│          │ Programmatic │        │ Diff-based      │   │    │
│  │  └──────────┘          └──────────────┘        └─────────────────┘   │    │
│  └──────────────────────────────────────────────────────────────────────┘    │
│                                      │                                       │
│                                      ▼                                       │
│  ┌──────────────────────────────────────────────────────────────────────┐    │
│  │                        MIGRATION ENGINE                              │    │
│  ├──────────────────────────────────────────────────────────────────────┤    │
│  │                                                                      │    │
│  │  ┌────────────┐   ┌────────────┐   ┌────────────┐   ┌────────────┐   │    │
│  │  │   Parser   │──►│  Executor  │──►│  Tracker   │──►│  Reporter  │   │    │
│  │  │ SQL/Go/HCL │   │Transaction │   │ Version DB │   │ Status/Logs│   │    │
│  │  └────────────┘   └────────────┘   └────────────┘   └────────────┘   │    │
│  │                                                                      │    │
│  │  Features:                                                           │    │
│  │  • Version ordering (timestamp or sequential)                        │    │
│  │  • Transaction support per migration                                 │    │
│  │  • Locking (prevent concurrent migrations)                           │    │
│  │  • Dirty state handling                                              │    │
│  │  • Embedded file support (go:embed)                                  │    │
│  └──────────────────────────────────────────────────────────────────────┘    │
│                                      │                                       │
│                                      ▼                                       │
│  ┌──────────────────────────────────────────────────────────────────────┐    │
│  │                      TARGET DATABASE                                 │    │
│  ├──────────────────────────────────────────────────────────────────────┤    │
│  │                                                                      │    │
│  │  ┌─────────────────────────────────────────────────────────────┐     │    │
│  │  │                   schema_migrations                         │     │    │
│  │  │  ┌──────────┬──────────────┬─────────┬─────────────────┐    │     │    │
│  │  │  │ version  │ applied_at   │ dirty   │ execution_time  │    │     │    │
│  │  │  ├──────────┼──────────────┼─────────┼─────────────────┤    │     │    │
│  │  │  │    1     │ 2024-01-01   │  false  │    45ms         │    │     │    │
│  │  │  │    2     │ 2024-01-02   │  false  │    120ms        │    │     │    │
│  │  │  │    3     │ 2024-01-03   │  false  │    890ms        │    │     │    │
│  │  │  └──────────┴──────────────┴─────────┴─────────────────┘    │     │    │
│  │  └─────────────────────────────────────────────────────────────┘     │    │
│  │                                                                      │    │
│  │  Application Tables: users, posts, orders, payments, etc.            │    │
│  └──────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
├──────────────────────────────────────────────────────────────────────────────┤
│                           MIGRATION STRATEGIES                               │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Versioned (golang-migrate, goose)      │  Declarative (Atlas)               │
│  ─────────────────────────────────────  │  ───────────────────────────────   │
│  • Explicit up/down scripts             │  • Define desired state            │
│  • Full control over changes            │  • Engine computes diff            │
│  • Easy to understand                   │  • Automatic migration gen         │
│  • Manual data migrations               │  • Schema drift detection          │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐     │
│  │                    ZERO-DOWNTIME PATTERN                            │     │
│  │                                                                     │     │
│  │  Phase 1: EXPAND          Phase 2: MIGRATE       Phase 3: CONTRACT  │     │
│  │  ┌──────────────┐        ┌───────────────┐      ┌───────────────┐   │     │
│  │  │ Add new col  │   ──►  │ Dual-write    │  ──► │ Remove old    │   │     │
│  │  │ (nullable)   │        │ Backfill data │      │ Add constraint│   │     │
│  │  └──────────────┘        └───────────────┘      └───────────────┘   │     │
│  │       v1 app                v2 app                   v3 app         │     │
│  │       ↓                     ↓                        ↓              │     │
│  │  Old col only          Both cols               New col only         │     │
│  └─────────────────────────────────────────────────────────────────────┘     │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Core Benefits

- **Version Control**: Track schema changes in git alongside application code
- **Reproducibility**: Same schema across all environments (dev, staging, prod)
- **Team Collaboration**: Multiple developers can work on schema without conflicts
- **Rollback**: Undo problematic changes when issues arise
- **Automation**: CI/CD integration for reliable deployments

### Migration Principles

1. **Atomic**: Each migration does one thing - don't mix unrelated changes
2. **Reversible**: Include down migrations when possible for safe rollbacks
3. **Idempotent**: Safe to run multiple times (use IF NOT EXISTS, IF EXISTS)
4. **Sequential**: Ordered by timestamp or sequence number
5. **Tested**: Validate before production with automated tests

### Junior → FAANG: The mental model that unlocks the rest of the chapter

A migration framework is three moving parts. First a directory of ordered files (`0001_init.up.sql`, `0001_init.down.sql`, `0002_add_users.up.sql`, and so on). Second a tracking table inside the target database that records which files have been applied. Third a runner program that computes "applied set" minus "disk set" and applies the difference inside a transaction. Everything else (embedding via `go:embed`, Go-coded migrations, declarative schemas, linting) is a feature on top of these three parts. If you internalize this you will not be confused by any tool.

Worked example: resolving a dirty migration. You run migrations at service startup. Migration `0017_add_orders_index.up.sql` contains a statement that fails because a conflicting row already exists. The runner opens a transaction, marks the row in `schema_migrations` as `version = 17, dirty = true`, tries the SQL, gets an error, and rolls back the SQL but the `dirty` flag persists (golang-migrate writes the dirty flag in its own transaction before attempting the migration, so it survives the rollback). The service now crashloops because on boot the runner sees `dirty = true` and refuses to proceed. The junior recovery is to open psql, inspect what partially ran, manually undo it, and run `migrate force 16` to reset the tracker to the last clean version. Do not run `force 17` because that tells the tool the migration succeeded when it did not. Always `force` to the previous successful version and let the tool try again.

Interview entry-point. "Why does the tracker store a dirty flag instead of just a version number?" Answer: not all DDL is transactional. Postgres `CREATE INDEX CONCURRENTLY` and MySQL most online DDL cannot run inside a transaction, so a migration that is half-applied when the process dies leaves the database in an intermediate state that the tool cannot reconstruct from the file alone. The dirty flag forces human intervention, which is correct behavior because automatic rollforward from an unknown state is unsafe.

Another worked example: why down migrations are usually fictional. Your `0023_drop_legacy_column.up.sql` runs `ALTER TABLE users DROP COLUMN legacy_tenant_id`. The paired `0023_drop_legacy_column.down.sql` writes `ALTER TABLE users ADD COLUMN legacy_tenant_id INT`. This restores the column but not the data, because `DROP COLUMN` deleted the bytes. So "reversible" is schematic, not semantic. The senior habit is to treat down migrations as a convenience for development environments and to plan rollbacks as forward-motion migrations (`0024_restore_legacy_column_from_audit_log.up.sql`).

### Senior @ FAANG: Versioning strategy, ordering anomalies, and the ADR for tool selection

Sequential integer ordering (`0001`, `0002`) vs timestamp ordering (`20260422_103045`) is a real decision with real consequences. Sequential is easier to reason about and produces deterministic diffs, but two branches that both add `0042_...` collide on merge and one must be renamed. Timestamp ordering sidesteps the collision but introduces a new class of bug: the clock on the developer's laptop. A migration authored at `20260101_120000` on a laptop whose clock drifted backwards can land in the repo before a migration already merged with timestamp `20260102_090000`. The runner applies in timestamp order, so the drifted migration runs last in new environments and first in environments that were already past `20260102`. This produces environment-dependent schema divergence that is extremely hard to debug. Mitigation: enforce in CI that every new migration's timestamp is greater than the max timestamp already in `main`, and reject pull requests that violate the invariant. golang-migrate, goose, and dbmate all support both schemes, Atlas generates sequential integers by default, and for teams that deploy through long-lived feature branches the sequential scheme with a merge-time rebase is the only scheme that produces deterministic ordering.

Advisory locking for concurrent runners. When `kubectl rollout` brings up three replicas of your service, all three call `migrate.Up()` at boot. Without a lock, all three race to insert into `schema_migrations` and to execute DDL in parallel, producing partial states, duplicate inserts, and corruption. Postgres offers `pg_advisory_lock(bigint)` which is held for the session and released on disconnect, MySQL offers `GET_LOCK(name, timeout)`. golang-migrate acquires a lock automatically for Postgres and MySQL before running. The staff checkpoint is (a) verify the tool's lock implementation for your driver, because MySQL's `GET_LOCK` is session-scoped and can be dropped on a connection reset, (b) set a lock timeout so a crashed migration does not block forever, and (c) do not run migrations from the application binary in production if you can avoid it. The scaled-up pattern is a dedicated migration Job or init container that runs to completion before the application replicas start. Argo Rollouts and the Kubernetes `Job` with `ttlSecondsAfterFinished` are the standard pattern, and they cleanly separate "schema is at version N" from "application pod is running version N binary."

Dirty state recovery for non-transactional DDL. Postgres DDL that cannot run inside a transaction: `CREATE INDEX CONCURRENTLY`, `REINDEX CONCURRENTLY`, `CREATE DATABASE`, `ALTER TYPE ... ADD VALUE` (in older versions), `VACUUM`. When a migration contains one of these statements the tool either (a) refuses to wrap in a transaction, leaving you responsible for idempotency, or (b) errors out on the BEGIN. golang-migrate respects a `-- +migrate NoTransaction` hint in some drivers, goose supports `-- +goose NO TRANSACTION` explicitly. The senior discipline is: isolate non-transactional statements in their own migration file so that when they fail halfway you can drop the partially-created index by name (`DROP INDEX IF EXISTS idx_foo_bar;`), edit the retry, and reapply. Never mix transactional and non-transactional DDL in the same file.

Expand-and-contract in detail. The pattern is a six-step contract between application code and schema, not the three boxes in the diagram above. Step 1: add the new shape, nullable, backwards-compatible. Step 2: deploy code that writes to both old and new shapes (dual-write). Step 3: backfill historical rows to populate the new shape, using a paginated loop with a small batch size and a sleep between batches to bound replication lag and `WAL` growth. Step 4: deploy code that reads from the new shape and writes to both. Step 5: deploy code that reads and writes only the new shape. Step 6: drop the old shape. Every step crosses a deploy boundary, which means you need at least five deploys to complete one logical schema change, and the compatibility window spans the full duration. On a team that deploys six times a day this completes in a day. On a team with weekly releases this is a month-long project. Staff engineers own the scheduling spreadsheet for multi-month migrations and the runbook that describes what to do if the deploy of step 4 is rolled back after step 3 has already run (answer: you roll forward to a new migration that re-syncs, you do not attempt to undo the backfill).

pgroll and the case for view-based multi-version schemas. Xata's pgroll implements the expand-and-contract pattern inside Postgres by materializing both schema versions as views over the underlying tables with triggers that dual-write across the views. The application selects its version via `SET search_path`. The cost is non-trivial: views add planner overhead, triggers add write latency, and the capability is Postgres-only. The benefit is that rollback is instantaneous (drop the new view, restore search_path) and the compatibility window is owned by the database rather than by deploy orchestration. For teams that cannot deploy frequently enough to contract quickly, or for regulated environments where every deploy requires a change-advisory board, pgroll trades latency for reversibility and is the correct choice. reshape, by Fabian Lindfors, was the prototype for this model and remains worth reading. The staff ADR for tool choice should explicitly list reversibility requirements, deploy frequency, and the Postgres-only constraint as inputs.

ACCESS EXCLUSIVE LOCK avoidance in production Postgres. The hierarchy of Postgres locks, from weakest to strongest: ACCESS SHARE, ROW SHARE, ROW EXCLUSIVE, SHARE UPDATE EXCLUSIVE, SHARE, SHARE ROW EXCLUSIVE, EXCLUSIVE, ACCESS EXCLUSIVE. Every `SELECT` takes ACCESS SHARE. ACCESS EXCLUSIVE conflicts with every other mode, so any `ALTER TABLE` that acquires it blocks all reads and writes on the table for the duration. The staff mitigations: (1) always `SET lock_timeout = '3s'` in the migration session and retry with backoff rather than queue, (2) prefer ADD COLUMN without volatile defaults (Postgres 11+ stores constant defaults as metadata), (3) use ALTER TABLE ... ADD CONSTRAINT ... NOT VALID followed by ALTER TABLE ... VALIDATE CONSTRAINT (the NOT VALID form takes SHARE ROW EXCLUSIVE briefly, the VALIDATE takes SHARE UPDATE EXCLUSIVE which does not block reads or writes), (4) use CREATE INDEX CONCURRENTLY for any index on a populated table, (5) monitor `pg_stat_activity` and `pg_locks` during the migration window. `lock_timeout` is the most important single knob because it converts "migration causes 45-minute outage" into "migration fails and alerts," which is categorically better.

Staff ADR template for tool choice. The ADR should capture: selected tool, rejected alternatives and why, versioning scheme, expand-and-contract window length, lint policy with explicit rule list, approval workflow by blast radius (single reviewer, two reviewer, DBA sign-off), disaster recovery runbook for re-applying migrations into a fresh database from backup, schema registry strategy for cross-service refs, migration author training requirement, on-call rotation for migration-induced incidents. Review this ADR annually and after every migration-related incident.

---
