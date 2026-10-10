## 99.9 Advanced Testing in CI

### Comprehensive Test Matrix

Running your test suite against a single platform and Go version is rarely sufficient for production-grade libraries and services. GitHub Actions' matrix strategy lets you cross-multiply operating systems and Go versions in a single workflow file, catching platform-specific bugs and compatibility regressions automatically. The workflow below runs the full test suite with the race detector enabled across Linux, macOS, and Windows, and collects a coverage report only for the designated primary configuration to avoid redundant uploads.

```yaml
# .github/workflows/test-matrix.yaml
name: Test Matrix

on: [push, pull_request]

jobs:
  test:
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
        go-version: ['1.25', '1.26', '1.27']
        include:
          - os: ubuntu-latest
            go-version: '1.27'
            coverage: true
        exclude:
          - os: windows-latest
            go-version: '1.27'  # Skip older Go on Windows

    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4

      - name: Setup Go
        uses: actions/setup-go@v5
        with:
          go-version: ${{ matrix.go-version }}

      - name: Run tests
        run: |
          if [ "${{ matrix.coverage }}" = "true" ]; then
            go test -v -race -coverprofile=coverage.out ./...
          else
            go test -v -race ./...
          fi
        shell: bash

      - name: Upload coverage
        if: matrix.coverage
        uses: codecov/codecov-action@v4
        with:
          files: coverage.out
```

### Integration Tests with Testcontainers

Testing against real databases and caches in CI traditionally required pre-provisioned services or complex Docker Compose setups. The `testcontainers-go` library solves this by spinning up ephemeral Docker containers programmatically inside `TestMain`, giving each test run a clean, isolated environment without any external infrastructure. The Go test below uses the `integration` build tag so that these heavier tests are opt-in and do not slow down the regular unit-test pass.

```go
// integration/integration_test.go
//go:build integration

package integration

import (
    "context"
    "database/sql"
    "os"
    "testing"
    "time"

    "github.com/testcontainers/testcontainers-go"
    "github.com/testcontainers/testcontainers-go/modules/postgres"
    "github.com/testcontainers/testcontainers-go/modules/redis"
    _ "github.com/lib/pq"
)

var testDB *sql.DB

func TestMain(m *testing.M) {
    ctx := context.Background()

    // Start PostgreSQL container
    pgContainer, err := postgres.RunContainer(ctx,
        testcontainers.WithImage("postgres:18-alpine"),
        postgres.WithDatabase("testdb"),
        postgres.WithUsername("test"),
        postgres.WithPassword("test"),
    )
    if err != nil {
        panic(err)
    }
    defer pgContainer.Terminate(ctx)

    // Start Redis container
    redisContainer, err := redis.RunContainer(ctx,
        testcontainers.WithImage("redis:8-alpine"),
    )
    if err != nil {
        panic(err)
    }
    defer redisContainer.Terminate(ctx)

    // Get connection strings
    connStr, _ := pgContainer.ConnectionString(ctx)
    testDB, _ = sql.Open("postgres", connStr)

    redisHost, _ := redisContainer.Host(ctx)
    redisPort, _ := redisContainer.MappedPort(ctx, "6379")
    _ = redisHost
    _ = redisPort

    // Run tests
    os.Exit(m.Run())
}

func TestUserCreation(t *testing.T) {
    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    // Test with real database
    _, err := testDB.ExecContext(ctx,
        "INSERT INTO users (name, email) VALUES ($1, $2)",
        "Test User", "test@example.com",
    )
    if err != nil {
        t.Fatalf("Failed to create user: %v", err)
    }

    var count int
    testDB.QueryRowContext(ctx, "SELECT COUNT(*) FROM users").Scan(&count)
    if count != 1 {
        t.Errorf("Expected 1 user, got %d", count)
    }
}
```

```yaml
# .github/workflows/integration.yaml
name: Integration Tests

on:
  pull_request:
    branches: [main]

jobs:
  integration:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Go
        uses: actions/setup-go@v5
        with:
          go-version: '1.27'

      - name: Run integration tests
        run: |
          go test -v -tags=integration -timeout=10m ./integration/...

  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Start services
        run: docker compose up -d

      - name: Wait for services
        run: |
          timeout 60 bash -c 'until curl -s http://localhost:8080/health; do sleep 1; done'

      - name: Run E2E tests
        run: |
          go test -v -tags=e2e -timeout=15m ./e2e/...

      - name: Collect logs on failure
        if: failure()
        run: docker compose logs > docker-logs.txt

      - name: Upload logs
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: docker-logs
          path: docker-logs.txt
```

### Benchmark Tests in CI

Running Go benchmarks in CI lets you catch performance regressions before they reach production, treating throughput and allocations as first-class code quality metrics alongside correctness. The workflow below executes the full benchmark suite with `-benchmem`, stores the results in a cache keyed to the base branch, and then uses `benchmark-action` to compare against the historical baseline. If any benchmark degrades by more than 50%, the action posts a comment on the pull request and fails the check.

```yaml
# .github/workflows/benchmark.yaml
name: Benchmark

on:
  pull_request:
    branches: [main]

jobs:
  benchmark:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Go
        uses: actions/setup-go@v5
        with:
          go-version: '1.27'

      - name: Run benchmarks
        run: |
          go test -bench=. -benchmem -run=^$ ./... | tee benchmark.txt

      - name: Download previous benchmark
        uses: actions/cache@v4
        with:
          path: ./cache
          key: benchmark-${{ github.base_ref }}
          restore-keys: |
            benchmark-main

      - name: Compare benchmarks
        uses: benchmark-action/github-action-benchmark@v1
        with:
          tool: 'go'
          output-file-path: benchmark.txt
          external-data-json-path: ./cache/benchmark-data.json
          fail-on-alert: true
          alert-threshold: '150%'  # Fail if 50% slower
          comment-on-alert: true
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

### Mutation Testing

High code coverage tells you which lines were executed during tests, but it does not tell you whether the tests would actually catch a bug if the logic were wrong. Mutation testing addresses this gap by automatically introducing small code mutations, flipping a `<` to `<=`, removing a return value, and verifying that at least one test fails for each mutation. The workflow below runs `go-mutesting` against the `internal` package and enforces a minimum mutation score of 60%, failing the build if tests are too weak to detect injected defects.

```yaml
# .github/workflows/mutation.yaml
name: Mutation Testing

on:
  pull_request:
    branches: [main]

jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Go
        uses: actions/setup-go@v5
        with:
          go-version: '1.27'

      - name: Install go-mutesting
        run: go install github.com/zimmski/go-mutesting/cmd/go-mutesting@latest

      - name: Run mutation tests
        run: |
          go-mutesting ./internal/... 2>&1 | tee mutation-report.txt

      - name: Check mutation score
        run: |
          SCORE=$(grep -oP 'Score: \K[\d.]+' mutation-report.txt || echo "0")
          echo "Mutation score: $SCORE%"
          if (( $(echo "$SCORE < 60" | bc -l) )); then
            echo "Mutation score too low (< 60%)"
            exit 1
          fi
```

---

### Junior → FAANG: Advanced Testing in CI as Career Differentiation

Many junior engineers know how to write unit tests and run them in CI. Fewer know how to write integration tests that run against real infrastructure in CI, handle flakiness systematically, or use the race detector and coverage profiler. These gaps are visible in code reviews and in interviews.

The `-race` flag is the most important flag in the Go test runner for concurrent code. It detects data races at runtime by tracking memory access patterns. It runs approximately 5-10x slower than without the flag, which is why it sometimes gets disabled in CI for speed. This is a mistake: data races are among the most difficult bugs to debug in production. Always run with `-race` in CI, and if it is too slow, parallelize the test suite rather than disabling the detector.

Integration tests with testcontainers (Docker-based real infrastructure) are significantly more reliable than mocked tests for database interactions, message queue interactions, and external API interactions. The additional CI complexity is worth it for the confidence that the code works against real systems.

### Senior @ FAANG: Test Infrastructure as Platform Investment

At staff level, the test infrastructure is as important as the application code itself. Flaky tests are the primary source of CI unreliability, and managing them requires a systematic approach: automated detection (a test that fails in CI but passes locally more than twice in a week is a flake), automated quarantine (flaky tests are moved to a quarantine suite that runs but does not block merges), and ownership (each flaky test has an assigned owner who is responsible for fixing it).

The test parallelization strategy for large test suites requires careful design. Distributing tests across multiple runners (using tools like gotestsum with JSON output and a custom splitter, or the `--split-index` pattern) can reduce test execution time from 20 minutes to under 5 minutes with sufficient parallelism. But naive parallelization can cause test interference (shared state, port conflicts, database connection exhaustion). The platform's testing infrastructure should provide isolated test environments (separate test databases per runner, dynamic port allocation) to enable safe parallelization.

Test coverage as a platform metric requires nuance. 80% line coverage does not mean 80% of the critical paths are tested. The senior perspective is to define meaningful coverage targets for different code categories: 90%+ for business logic and security-critical code, lower thresholds for infrastructure code that is hard to test without significant setup, and mutation testing for the most critical code to verify that tests actually detect the bugs they are supposed to catch.
