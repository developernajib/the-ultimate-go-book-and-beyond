## 36.6 Testing Migrations

### Migration Test Framework

Migration tests should run against a real database, not SQLite or an in-memory mock. The `dockertest` library spins up a PostgreSQL container for each test run, giving you an isolated, disposable database that matches your production engine. The tests below verify three properties: all migrations apply successfully (up), all migrations reverse cleanly (down), and the full up-down-up cycle produces the same result (idempotency).

```go
package migrations_test

import (
    "database/sql"
    "fmt"
    "testing"

    "github.com/golang-migrate/migrate/v4"
    "github.com/golang-migrate/migrate/v4/database/postgres"
    _ "github.com/golang-migrate/migrate/v4/source/file"
    "github.com/ory/dockertest/v3"
)

func TestMigrations(t *testing.T) {
    // Start PostgreSQL container
    pool, err := dockertest.NewPool("")
    if err != nil {
        t.Fatal(err)
    }

    resource, err := pool.Run("postgres", "15", []string{
        "POSTGRES_PASSWORD=test",
        "POSTGRES_DB=testdb",
    })
    if err != nil {
        t.Fatal(err)
    }
    defer pool.Purge(resource)

    // Wait for container
    var db *sql.DB
    if err := pool.Retry(func() error {
        var err error
        db, err = sql.Open("postgres", fmt.Sprintf(
            "postgres://postgres:test@localhost:%s/testdb?sslmode=disable",
            resource.GetPort("5432/tcp"),
        ))
        if err != nil {
            return err
        }
        return db.Ping()
    }); err != nil {
        t.Fatal(err)
    }

    // Run all migrations up
    m := setupMigrate(t, db)
    if err := m.Up(); err != nil && err != migrate.ErrNoChange {
        t.Fatalf("Migration up failed: %v", err)
    }

    // Test all migrations down
    if err := m.Down(); err != nil && err != migrate.ErrNoChange {
        t.Fatalf("Migration down failed: %v", err)
    }

    // Run up again to verify idempotency
    if err := m.Up(); err != nil && err != migrate.ErrNoChange {
        t.Fatalf("Second migration up failed: %v", err)
    }
}

func TestMigrationOrder(t *testing.T) {
    db := setupTestDB(t)
    m := setupMigrate(t, db)

    // Test each migration individually
    version, _, _ := m.Version()
    for {
        if err := m.Steps(1); err != nil {
            if err == migrate.ErrNoChange {
                break
            }
            t.Fatalf("Migration failed at version %d: %v", version, err)
        }

        newVersion, _, _ := m.Version()
        if newVersion == version {
            break
        }

        // Verify database state after each migration
        verifyDatabaseState(t, db, newVersion)
        version = newVersion
    }
}
```

### Schema Verification

After each migration step, verify the database state by querying `information_schema`. The helper functions below check for table existence, column existence, and foreign key presence. Wire these assertions into your migration tests so that a missing column or dropped constraint fails the test immediately rather than surfacing as a runtime error in staging.

```go
func verifyDatabaseState(t *testing.T, db *sql.DB, version uint) {
    switch version {
    case 1:
        // Verify users table exists
        assertTableExists(t, db, "users")
        assertColumnExists(t, db, "users", "id")
        assertColumnExists(t, db, "users", "email")

    case 2:
        // Verify posts table and foreign key
        assertTableExists(t, db, "posts")
        assertForeignKeyExists(t, db, "posts", "fk_posts_user")
    }
}

func assertTableExists(t *testing.T, db *sql.DB, table string) {
    t.Helper()
    var exists bool
    err := db.QueryRow(`
        SELECT EXISTS (
            SELECT FROM information_schema.tables
            WHERE table_name = $1
        )
    `, table).Scan(&exists)

    if err != nil {
        t.Fatalf("Error checking table: %v", err)
    }
    if !exists {
        t.Errorf("Table %s does not exist", table)
    }
}

func assertColumnExists(t *testing.T, db *sql.DB, table, column string) {
    t.Helper()
    var exists bool
    err := db.QueryRow(`
        SELECT EXISTS (
            SELECT FROM information_schema.columns
            WHERE table_name = $1 AND column_name = $2
        )
    `, table, column).Scan(&exists)

    if err != nil {
        t.Fatalf("Error checking column: %v", err)
    }
    if !exists {
        t.Errorf("Column %s.%s does not exist", table, column)
    }
}

func assertForeignKeyExists(t *testing.T, db *sql.DB, table, constraint string) {
    t.Helper()
    var exists bool
    err := db.QueryRow(`
        SELECT EXISTS (
            SELECT 1 FROM information_schema.table_constraints
            WHERE table_name = $1 AND constraint_name = $2 AND constraint_type = 'FOREIGN KEY'
        )
    `, table, constraint).Scan(&exists)
    if err != nil {
        t.Fatalf("Error checking foreign key: %v", err)
    }
    if !exists {
        t.Errorf("Foreign key %s on %s does not exist", constraint, table)
    }
}

func setupMigrate(t *testing.T, db *sql.DB) *migrate.Migrate {
    t.Helper()
    driver, err := postgres.WithInstance(db, &postgres.Config{})
    if err != nil {
        t.Fatal(err)
    }
    m, err := migrate.NewWithDatabaseInstance("file://migrations", "postgres", driver)
    if err != nil {
        t.Fatal(err)
    }
    return m
}

func setupTestDB(t *testing.T) *sql.DB {
    t.Helper()
    db, err := sql.Open("postgres", "postgres://postgres:test@localhost:5432/testdb?sslmode=disable")
    if err != nil {
        t.Fatal(err)
    }
    return db
}
```

### Junior → FAANG: prerequisite gaps and first-job context

The single biggest mental shift from homework migrations to production migrations is testing the down path. In school the up migration gets graded and the down migration is a formality. In production the down migration is the rollback plan, and an untested rollback plan is not a rollback plan, it is a wish. Every migration PR at a serious shop runs up, then down, then up again in CI. If the second up does not produce the same schema as the first, the test fails. That round-trip property catches an entire class of bugs where the down migration deletes a table but forgets to drop an index that referenced it, leaving orphan state that breaks the next up.

Worked example for your first real migration test suite. You inherit a repo with 80 migrations, no tests, and a story that says "add a feature." The first thing you do before touching the feature is stand up `testcontainers-go` against the exact Postgres minor version production runs (check it with `SELECT version()` on a read replica, not by asking in chat). Write one test that runs all 80 migrations up, records the schema with `pg_dump --schema-only`, runs them all down, runs them all up again, and diffs the schema dumps. On a typical legacy repo this test will fail on the first try because three of the 80 down migrations have bugs that nobody ever noticed. Fix them before you write a single line of feature code. That one afternoon of investment pays for itself the first time someone needs to roll back in production.

Interview entry-point. When an interviewer asks how you test migrations, the weak answer is "I run them locally and check if the app starts." The strong answer names the three properties tested here (up succeeds, down succeeds, up-down-up is idempotent) and adds one more the section does not mention explicitly: the migration must be tested against a database that already contains data. A migration that succeeds on an empty schema but fails on production data is not tested. The strongest answer mentions `pgtestdb` or `testcontainers-go` for per-test isolated databases and explains why `sqlmock` is wrong for this (it does not parse DDL, it cannot tell you if your ALTER TABLE is valid).

### Senior @ FAANG: shadow-DB testing, upgrade testing, and rollback drills

At FAANG scale the testing pyramid for schema changes has four layers and most engineers only know about the first two.

Layer 1, unit tests of the migration tooling and helpers. Standard Go table-driven tests against the migrator code itself. Not covered in this chapter because it is not interesting.

Layer 2, per-test isolated databases. The pattern in this section runs a single container for the whole test suite, which is fine for small projects but becomes the bottleneck once the suite has more than a few hundred tests that each need a clean schema. The FAANG-scale answer is `pgtestdb` (github.com/peterldowns/pgtestdb), which runs the migrations once into a template database at suite startup and then uses Postgres's `CREATE DATABASE ... TEMPLATE` feature to produce a fresh clone per test in under 50 milliseconds. For test suites with 5000 integration tests this is the difference between a 12 minute CI run and a 2 hour CI run. `testcontainers-go` is the more general tool and pairs well with `pgtestdb` (testcontainers starts the Postgres server, pgtestdb manages clones of it). `schemahero` is a declarative alternative that compares a desired schema to a live schema and generates the migration, useful for Kubernetes-native workflows where the schema is a CRD.

Layer 3, shadow-DB testing. Before a destructive migration goes to production, it is replayed against a shadow database that is a recent snapshot of production. The shadow is typically a restore of the previous night's base backup plus the WAL replayed to wall-clock time. The migration is run against the shadow under the same lock-timeout and statement-timeout that production enforces, and the test passes only if the migration completes within a target wall-clock budget. This is where you catch that `CREATE INDEX CONCURRENTLY` on a 500GB table takes 4 hours instead of the 20 minutes you guessed. Meta's schema change process is famously built around this pattern. Shopify runs a similar "production mirror" that accepts schema changes and emits an estimated cutover window before the change is approved.

Layer 4, upgrade testing across Postgres or MySQL versions. This is the layer most teams forget. If your production runs Postgres 17 and staging runs 18, your migration tests are not actually validating the path production will take. The discipline is to test migrations against every version in the supported range, and explicitly test the version upgrade itself (pg_upgrade 17 to 18, then replay the migration log). At Uber and Netflix the database team owns this pipeline and ships a matrix test that runs every new migration against Postgres 16, 17, and 18 before it is merged. The test matrix is the only way to catch changes where a syntax is valid in 15 but was introduced in 13 and will fail when production is finally upgraded from 12.

Rollback testing is its own discipline. The naive rollback test runs the down migration and asserts the schema reverts. That is necessary but not sufficient. The production-grade rollback test does the following. Run migration up. Write data representative of what production would write against the new schema (dual-writes, new columns populated). Run migration down. Read the remaining data and verify the application can still serve it without the new columns. This is the test that catches rollback-unsafe migrations like "add NOT NULL column, backfill, drop old column" where the down migration can technically reverse the DDL but the data is gone. For migrations that cross a rollback-impossible boundary (the `DROP COLUMN` has shipped), the test should explicitly assert that the down migration is the no-op documented as the forward-only cutover, not a silent data-loss path.

The review checklist that gates a migration PR at a mature shop. Up migration runs against empty schema. Up migration runs against a shadow-DB snapshot of production within the time budget. Down migration runs and schema round-trips. Migration is wrapped in `SET lock_timeout` and `SET statement_timeout`. Any `CREATE INDEX` uses `CONCURRENTLY` and is outside a transaction. Any `ADD CONSTRAINT` uses `NOT VALID` plus a separate `VALIDATE CONSTRAINT`. Any `DROP COLUMN` or destructive change has an explicit rollback window documented. The PR description names the feature flag that gates the application code for the new schema. The PR includes a `pg_stat_statements` query proving the old column has not been referenced in the last 14 days (for destructive changes only). If any checkbox is missing the PR does not merge, regardless of how innocuous the change looks.

---
