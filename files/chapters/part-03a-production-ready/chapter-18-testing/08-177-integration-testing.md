## 18.7 Integration Testing

### Build Tags for Integration Tests

Build tags let you gate integration tests behind a compile-time condition so that `go test ./...` runs only fast unit tests by default, while the slower, infrastructure-dependent tests are opt-in. Placing `//go:build integration` at the top of a file excludes it from normal builds. Passing `-tags=integration` on the command line re-includes it. This separation keeps the default feedback loop quick while still allowing full end-to-end validation in CI.

```go
//go:build integration

package integration

import (
    "database/sql"
    "os"
    "testing"

    _ "github.com/lib/pq"
)

func TestDatabaseIntegration(t *testing.T) {
    db, err := sql.Open("postgres", os.Getenv("DATABASE_URL"))
    if err != nil {
        t.Fatalf("open: %v", err)
    }
    t.Cleanup(func() { db.Close() })

    // sql.Open does not dial. Ping is what proves the database is there.
    if err := db.PingContext(t.Context()); err != nil {
        t.Fatalf("ping: %v", err)
    }

    // Test database operations...
}
```

```bash
# Run integration tests
go test -tags=integration ./...
```

### Test Containers

The `testcontainers-go` library programmatically launches real Docker containers from within Go tests, giving each test run a fresh, isolated instance of a database or other service. The `WaitingFor` strategy blocks until the container emits a readiness signal, such as a log line or a successful TCP connection, so tests never begin before the service is fully initialized. Calling `container.Terminate` in a deferred function guarantees cleanup even when a test fails, preventing leaked containers from accumulating on the host.

```go
import (
    "context"
    "database/sql"
    "fmt"
    "testing"

    _ "github.com/lib/pq"
    "github.com/testcontainers/testcontainers-go"
    "github.com/testcontainers/testcontainers-go/wait"
)

func TestWithPostgres(t *testing.T) {
    ctx := context.Background()

    req := testcontainers.ContainerRequest{
        Image:        "postgres:15",
        ExposedPorts: []string{"5432/tcp"},
        Env: map[string]string{
            "POSTGRES_USER":     "test",
            "POSTGRES_PASSWORD": "test",
            "POSTGRES_DB":       "test",
        },
        WaitingFor: wait.ForLog("database system is ready to accept connections"),
    }

    container, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
        ContainerRequest: req,
        Started:          true,
    })
    if err != nil {
        t.Fatal(err)
    }
    // t.Cleanup, not defer: it also runs if a later t.Fatal unwinds the test,
    // and it works when this setup is moved into a helper.
    t.Cleanup(func() { _ = container.Terminate(ctx) })

    host, _ := container.Host(ctx)
    port, _ := container.MappedPort(ctx, "5432")

    // Note the mapped port. The container's 5432 is published on a RANDOM
    // host port, which is what lets tests run concurrently without collisions.
    dsn := fmt.Sprintf("postgres://test:test@%s:%s/test?sslmode=disable", host, port.Port())

    db, err := sql.Open("postgres", dsn)
    if err != nil {
        t.Fatal(err)
    }
    t.Cleanup(func() { db.Close() })
    if err := db.PingContext(ctx); err != nil {
        t.Fatal(err)
    }

    // Run tests against real PostgreSQL...
}
```

One caveat on `wait.ForLog` with Postgres specifically. The official Postgres image starts the server, runs initialization, then **restarts it**, so the line `database system is ready to accept connections` appears in the log *twice*. Waiting for the first occurrence can hand you a DSN pointing at a server that is about to bounce, producing an integration test that fails once in every few hundred CI runs and is miserable to diagnose. Either require both occurrences, or wait on something that tests the real thing:

```go
WaitingFor: wait.ForLog("database system is ready to accept connections").WithOccurrence(2),

// Or, more robustly, wait on an actual successful SQL connection.
// Note the port type comes from testcontainers' current dependency,
// so let your editor resolve the import rather than guessing it.
WaitingFor: wait.ForSQL("5432/tcp", "postgres", func(host string, port network.Port) string {
    return fmt.Sprintf("postgres://test:test@%s:%s/test?sslmode=disable", host, port.Port())
}),
```

The general lesson generalizes past Postgres: a log line is a proxy for readiness, and proxies drift. Where the library offers a strategy that verifies the actual protocol, prefer it.

### Share Containers Across Tests

Starting a container per test is slow. For a package of integration tests, start one container in `TestMain` and share it across all tests. Use transactions or reset scripts to isolate test state.

```go
func TestMain(m *testing.M) {
    ctx := context.Background()
    container := startPostgres(ctx)
    code := m.Run()
    // os.Exit skips deferred calls, so terminate explicitly before exiting.
    container.Terminate(ctx)
    os.Exit(code)
}
```

### Build Tag Separation

Separate unit and integration tests with build tags:

```go
//go:build integration

package user
```

Run unit tests by default, integration tests on demand:

```bash
go test ./...                    # unit only
go test -tags=integration ./...  # unit + integration
```

CI should run both tiers in parallel jobs. Unit tests give fast feedback, integration tests give realistic verification.

### Staff Lens: Integration Test Economics

Integration tests are slower and flakier than unit tests. Reserve them for genuinely integration-level concerns (database schemas, message broker semantics, HTTP wire format). Do not use them to test business logic that could be unit-tested. The wall-clock cost adds up fast, so keep the integration tier focused.

---
