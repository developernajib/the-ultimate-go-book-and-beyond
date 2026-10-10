## 17.7 Testing Organization

### Test File Placement

Go conventionally places unit test files alongside the source files they test, using the `_test.go` suffix. Integration and end-to-end tests are often collected under a top-level `test/` directory, which keeps them visibly separate from the code.

```
internal/user/
├── service.go
├── service_test.go      # Unit tests
├── repository.go
├── repository_test.go
├── handler.go
└── handler_test.go

test/
├── integration/         # Integration tests
│   ├── user_test.go
│   └── order_test.go
└── e2e/                 # End-to-end tests
    └── api_test.go
```

**The directory does not gate anything.** This is worth being blunt about, because it is a widely repeated myth: moving tests into `test/` does not exclude them from `go test ./...`. The `./...` pattern matches every package in the module, so those integration tests run on every developer's laptop and fail there the moment Postgres is not running:

```
$ go test ./...
ok      myproject/internal/user       0.002s
ok      myproject/test/e2e            0.002s
ok      myproject/test/integration    0.002s
```

Layout is for humans. If you want tests that only run on demand, you need a mechanism the toolchain actually understands. A build tag is the most common:

```go
//go:build integration

package integration
```

Now `go test ./...` skips the package entirely (it reports "matched no packages" if nothing else exists), and `go test -tags=integration ./...` runs it. The alternative is `testing.Short()`, where the test itself opts out:

```go
func TestUserRepository(t *testing.T) {
    if testing.Short() {
        t.Skip("requires postgres")
    }
    // ...
}
```

with `go test -short ./...` as the fast path. Build tags keep the code out of the build entirely, which is better when the test file imports heavy dependencies. `-short` keeps everything compiling, which catches rot in tests nobody runs. Pick one per repo and be consistent.

### Test Helpers

A shared `testutil` package centralizes the boilerplate that every database-backed test needs, opening a connection, registering cleanup, and wrapping operations in a transaction that rolls back automatically. Calling `t.Helper()` at the start of each helper ensures that when a test fails, the output points to the test function itself rather than deep inside the utility code.

```go
// internal/testutil/testutil.go
package testutil

import (
    "database/sql"
    "testing"

    _ "github.com/lib/pq" // registers the "postgres" driver
)

func SetupTestDB(t *testing.T) *sql.DB {
    t.Helper()
    db, err := sql.Open("postgres", "postgres://test:test@localhost/test?sslmode=disable")
    if err != nil {
        t.Fatalf("open db: %v", err)
    }
    t.Cleanup(func() { db.Close() })

    // sql.Open does not connect. Without this Ping, a down database
    // surfaces later as a confusing failure inside an unrelated query.
    if err := db.PingContext(t.Context()); err != nil {
        t.Fatalf("ping db: %v", err)
    }
    return db
}

func WithTransaction(t *testing.T, db *sql.DB, fn func(*sql.Tx)) {
    t.Helper()
    tx, err := db.Begin()
    if err != nil {
        t.Fatalf("begin transaction: %v", err)
    }
    // Rollback after fn, so the test leaves no rows behind. It also runs
    // if fn calls t.Fatal, because Fatal unwinds via runtime.Goexit and
    // deferred calls still execute.
    defer tx.Rollback()
    fn(tx)
}
```

The `Ping` is the part people leave out. `sql.Open` only validates the driver name and parses the DSN, it does not dial anything, so it returns a perfectly healthy `*sql.DB` pointed at a database that does not exist:

```
sql.Open SUCCEEDED against a port with no database listening
db.Ping() is what actually detects it: dial tcp [::1]:59999: connect: connection refused
```

A helper without the `Ping` makes the `t.Fatalf("connect to db")` line dead code for the failure it was written to catch. The test proceeds and blows up several lines later, in the query, with an error that reads like a bug in the code under test rather than a missing dependency.

### Test Pyramid

A healthy Go service has:

- Many unit tests (run in seconds, no external dependencies).
- Fewer integration tests (real database, real HTTP, seconds to run).
- Few end-to-end tests (full system, minutes to run).

Inverting this pyramid makes CI slow and flaky. Unit-test the pure business logic, integration-test the boundaries, and e2e-test the happy path.

### Staff Lens: Test Speed as a Team Asset

Fast tests mean engineers run them locally. Slow tests mean engineers skip them and rely on CI, which delays feedback and moves the discovery of a bug from seconds after writing it to twenty minutes later, in a different mental context.

So set an explicit budget and treat it as a real constraint. A reasonable starting point: the unit suite finishes in well under a minute, because that is the threshold below which people run it without thinking, and the integration suite finishes inside a coffee refill. The exact numbers matter less than having a number and noticing when you cross it. When the budget is blown, the fix is to make tests faster or move work down the pyramid, not to add a longer timeout.

### testing/synctest in Go 1.25+

For time-dependent code, Go 1.25's `testing/synctest` replaces flaky `time.Sleep`-based tests with deterministic ones. Use it for rate limiters, caches with TTL, retry policies. The test runs in microseconds instead of seconds. This is one of the highest-impact testing additions in recent Go releases.

---
