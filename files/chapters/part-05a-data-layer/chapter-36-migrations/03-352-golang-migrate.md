## 36.2 golang-migrate

### Installation

`golang-migrate` remains the most widely adopted migration tool in the Go ecosystem as of 2026, with first-class driver support for PostgreSQL, MySQL, CockroachDB, SQLite, ClickHouse, Spanner, and over a dozen others. Install it either as a standalone CLI tool or as a Go library dependency. The CLI is useful for running migrations from scripts and CI pipelines, while the library lets you run migrations programmatically at application startup.

```bash
# CLI
go install -tags 'postgres' github.com/golang-migrate/migrate/v4/cmd/migrate@latest

# As library
go get github.com/golang-migrate/migrate/v4
```

### Creating Migrations

The `migrate create` command generates a pair of up and down SQL files with a sequential version prefix. The up file contains the schema change, and the down file reverses it. Always write both files so that rollbacks work cleanly.

```bash
# Create new migration
migrate create -ext sql -dir migrations -seq create_users_table
```

Each migration consists of a matched pair of files. The up migration creates schema objects, and the down migration drops them. Use `IF EXISTS` guards in down migrations to make them idempotent.

```sql
-- migrations/000001_create_users_table.up.sql
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'active',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_status ON users(status);

-- migrations/000001_create_users_table.down.sql
DROP TABLE IF EXISTS users;
```

### Running Migrations

The CLI accepts a database URL and a path to the migrations directory. The `up` command applies all pending migrations in version order, while `down` rolls back. The `force` command manually sets the version number, which is useful for recovering from a dirty migration state where a previous run failed partway through.

```bash
# Run all pending migrations
migrate -path migrations -database "postgres://user:pass@localhost/db?sslmode=disable" up

# Run specific number of migrations
migrate -path migrations -database "..." up 1

# Rollback last migration
migrate -path migrations -database "..." down 1

# Rollback all
migrate -path migrations -database "..." down

# Go to specific version
migrate -path migrations -database "..." goto 3

# Check current version
migrate -path migrations -database "..." version

# Force version (for fixing issues)
migrate -path migrations -database "..." force 2
```

### Programmatic Migrations

Running migrations from Go code lets your application apply pending schema changes at startup, eliminating the need for a separate migration step in deployment scripts. The first example reads migration files from disk. The second uses `go:embed` to bundle them into the binary, which simplifies deployment to a single artifact with no external file dependencies. Note: for multi-replica deployments, running migrations at startup is only safe when combined with an advisory lock (see the Common Mistakes section). A more defensible pattern at scale is a dedicated migration Job (Kubernetes) or init container that runs before the app Deployment is rolled out. The app binary stays responsible for verifying the schema version matches what it expects, and refuses to start on a mismatch.

```go
package main

import (
    "database/sql"
    "embed"
    "log"

    "github.com/golang-migrate/migrate/v4"
    "github.com/golang-migrate/migrate/v4/database/postgres"
    "github.com/golang-migrate/migrate/v4/source/iofs"
    _ "github.com/golang-migrate/migrate/v4/source/file"
    _ "github.com/lib/pq"
)

func runMigrations(db *sql.DB) error {
    driver, err := postgres.WithInstance(db, &postgres.Config{})
    if err != nil {
        return err
    }

    m, err := migrate.NewWithDatabaseInstance(
        "file://migrations",
        "postgres",
        driver,
    )
    if err != nil {
        return err
    }

    if err := m.Up(); err != nil && err != migrate.ErrNoChange {
        return err
    }

    version, dirty, err := m.Version()
    if err != nil {
        return err
    }
    log.Printf("Migration version: %d, dirty: %v", version, dirty)

    return nil
}

// Embedded migrations
//go:embed migrations/*.sql
var migrationsFS embed.FS

func runEmbeddedMigrations(db *sql.DB) error {
    d, err := iofs.New(migrationsFS, "migrations")
    if err != nil {
        return err
    }

    driver, err := postgres.WithInstance(db, &postgres.Config{})
    if err != nil {
        return err
    }

    m, err := migrate.NewWithInstance("iofs", d, "postgres", driver)
    if err != nil {
        return err
    }

    return m.Up()
}
```

### Junior → FAANG: What the code above actually does at runtime

Walk through `runEmbeddedMigrations` line by line so the magic disappears. `iofs.New(migrationsFS, "migrations")` wraps the `embed.FS` in an `io/fs` source driver that scans for files matching the `NNNN_name.up.sql` / `NNNN_name.down.sql` pattern and sorts them by the numeric prefix. `postgres.WithInstance(db, &postgres.Config{})` wraps an existing `*sql.DB` so the migration tool reuses your connection pool rather than opening a second one (important because advisory locks are session-scoped and you want the lock held on a connection you control). `migrate.NewWithInstance` glues the source driver and database driver together. `m.Up()` reads the `schema_migrations` table, computes the set of pending versions, acquires a Postgres advisory lock (`pg_advisory_lock(<hashed_name>)`), and applies each pending migration inside its own transaction. If any migration fails, the transaction rolls back but the tool sets `dirty = true` in a separate write that survives the rollback. Before the next successful boot you must `migrate force <last_good_version>` to clear the flag.

Worked example: first PR as a new hire. You are asked to add a `last_login_at TIMESTAMPTZ` column to `users`. Run `migrate create -ext sql -dir db/migrations -seq add_users_last_login`. Edit the generated `00000N_add_users_last_login.up.sql` to contain `ALTER TABLE users ADD COLUMN last_login_at TIMESTAMPTZ;`. Edit the `.down.sql` to contain `ALTER TABLE users DROP COLUMN IF EXISTS last_login_at;`. Run `migrate -path db/migrations -database "$DATABASE_URL" up` against your local Dockerised Postgres. Verify with `\d users` in psql. Open a PR. The CI pipeline should run the same command against a fresh container and fail the build if the up fails, the down fails, or the up followed by down followed by up leaves the schema in a different state. If your CI does not do all three, that is your first infrastructure contribution.

Interview entry-point. "I see you used `go:embed` for migrations. Why not read from disk?" Answer: a single-binary deploy removes a whole class of "the migration file was not in the container image" bugs. The binary fingerprint now includes the migrations, so the image tag uniquely identifies the schema version it expects. At scale that is worth more than the flexibility of editing SQL without a rebuild.

Gotcha to internalize. `migrate.ErrNoChange` is returned when there are no pending migrations. You must treat it as success, not as an error. Every golang-migrate caller that forgets this check produces false-positive alerts on every pod restart after a clean deploy.

### Senior @ FAANG: Operational hardening for golang-migrate at scale

The 130 lines above are a starting point. What follows is the production hardening that separates a team that has used golang-migrate for six months from a team that has run it for six years.

Do not run `m.Up()` from application startup in production. The chapter body hints at this and it deserves an explicit recommendation. The multi-replica deploy pattern in Kubernetes is: a `Job` with the migration binary runs to completion, then the `Deployment` rolls out the application pods, then a readiness probe on the application pods verifies the schema version matches the embedded `schema_version` constant before accepting traffic. This gives you (a) a single writer during the DDL window, (b) a clear failure signal if migration fails (Job fails, Deployment is not triggered), (c) clean separation between schema state and application state. Argo Rollouts, Flux, and ArgoCD all support this with pre-sync hooks. The only reason to run migrations from the application binary is for local development and for single-replica services where the complexity of a separate Job is not justified.

Verify the schema version at boot. Even with a separate Job, the application pods should refuse to start if the schema version does not match. Embed the expected version as a compile-time constant (generated from the `max(version)` of the `migrations/` directory at build time), and at boot run `SELECT version, dirty FROM schema_migrations ORDER BY version DESC LIMIT 1`. If the version is less than expected, either the migration Job has not finished yet (retry with backoff for up to sixty seconds) or someone rolled out application pods ahead of the migration (crash loudly). If the version is greater than expected, you are in a rollback scenario where the previous deploy's migrations succeeded but the application rollback did not include the rollforward. Decide your policy explicitly: crash and refuse to run is safer, allow with a warning is faster but risks subtle bugs from the newer schema containing columns the old code does not know to populate.

Advisory lock pitfalls. golang-migrate calls `pg_advisory_lock(hashed("migrate"))`. If your application uses `pg_advisory_lock` for anything else (for example, leader election in a custom scheduler), collisions are possible. The mitigation is to pass a custom `LockID` or to use `pg_try_advisory_lock` with a dedicated bigint namespace that no other service in the cluster touches. On MySQL the lock is named rather than numeric but the same principle applies. On multi-node Spanner or CockroachDB there is no per-node advisory lock so golang-migrate falls back to an `INSERT INTO migrate_lock` row pattern that has subtle race windows, documented in the driver README. If you run CockroachDB in production, read that README carefully.

Non-transactional DDL and the `-- @NoTransaction` directive. golang-migrate wraps each migration in a transaction by default. For Postgres `CREATE INDEX CONCURRENTLY` you must begin the file with a comment directive that the Postgres driver recognizes (the driver historically used a different mechanism than goose). As of v4 the convention is to put the `CREATE INDEX CONCURRENTLY` in its own migration file with no other statements, and to accept that if it fails halfway the index will be left in `INVALID` state, which is queryable via `SELECT * FROM pg_index WHERE NOT indisvalid`. Drop the invalid index, fix the cause, re-run. Do not attempt to retry without dropping, because CREATE INDEX CONCURRENTLY refuses to run if an index of the same name exists.

Transactional DDL limits. Postgres allows DDL inside transactions, which is a rare and valuable property. It does not mean you should use long transactions. A long DDL transaction holds `AccessExclusive` on the affected relations for the full transaction duration, blocking readers and writers. Keep DDL transactions short, batch related DDL into the same file only when the whole batch is fast, and never mix DDL with long-running data backfills inside the same transaction. For data backfills that must touch millions of rows, split into chunks and commit per chunk using goose Go migrations or a standalone backfill job driven by an application-level worker, not a single `UPDATE` wrapped in a migration.

Source driver edge cases. The `iofs` source driver is the modern preferred source. The older `file` source works off a directory path and has platform-specific URL quirks on Windows (the famous `file://C:/migrations` vs `file:///C:/migrations` confusion). If you deploy to Windows build agents use `iofs`. The `github` source is tempting for sharing migrations across services but couples your deploy to github.com availability, which is unacceptable for disaster recovery. If you need to share migrations across services, vendor them into each service's repo at build time, or publish them as a Go module and use `iofs` with `embed.FS`.

Migration testing as a first-class deliverable. A migration test suite should run in CI and verify, for every migration, that: (1) `up` succeeds from an empty database, (2) `up` followed by `down` followed by `up` produces the same final schema as `up` alone (use `pg_dump --schema-only` and diff, or use `atlas schema inspect` for a structured comparison), (3) `up` completes within a budget (reject migrations that would take longer than, say, 30 seconds on the CI dataset fixture), (4) no statement requires `ACCESS EXCLUSIVE` on a table above a threshold size in the fixture (parse via pg_locks during execution). golang-migrate does not ship this test harness. Writing it is a staff deliverable and it pays for itself the first time it catches an unsafe migration before merge. The `testcontainers-go` library makes the CI wiring trivial: spin a fresh Postgres container per test, apply the migrations, assert.

Observability during migration runs. Every migration application should emit structured logs with the migration version, the statement text, the duration, the rows affected where applicable, and the session settings (`lock_timeout`, `statement_timeout`). Ship these to your log aggregator with a distinct log type so you can query "every migration run across the fleet in the last 24 hours." Emit metrics: `migration_duration_seconds` as a histogram labeled by version, `migration_failure_total` as a counter. Alert on any migration that exceeds its budget or fails. golang-migrate's `Logger` interface is spartan. Wrap it in a thin adapter that injects your correlation ID, tenant ID (for multi-tenant schemas), and build SHA.

When to replace golang-migrate. The tool is stable and simple, which are features. You grow out of it when (a) you need declarative schema-as-code with diff generation (move to Atlas), (b) you need data backfills expressed in Go alongside the SQL (move to goose or add a separate backfill pipeline), (c) you need multi-version schema coexistence (move to pgroll, Postgres only), or (d) you need cross-service schema refs (add Atlas Cloud or equivalent on top). Many large shops keep golang-migrate as the runner but use Atlas to generate the SQL files, getting the lint and diff benefits without changing the runtime. This is a perfectly defensible staff decision and worth capturing in the ADR.

---
