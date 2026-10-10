## 52C.7 Testing DDD Go Code

### Unit Testing Domain Logic

Domain unit tests run without any infrastructure. They exercise aggregate methods, value object validation, and domain event emission using only in-process Go code. This makes them fast and deterministic.

```go
// internal/domain/order/order_test.go

package order_test

import (
    "testing"
    "time"

    "github.com/yourorg/ecommerce/order-service/internal/domain/order"
)

// testOrder is a test helper that creates a valid order with one line.
func testOrder(t *testing.T) *order.Order {
    t.Helper()

    addr, err := order.NewShippingAddress("Test User", "1 Test St", "Test City", "TX", "75001", "US")
    if err != nil {
        t.Fatalf("create shipping address: %v", err)
    }
    o, err := order.NewOrder("order-1", "customer-1", addr)
    if err != nil {
        t.Fatalf("create order: %v", err)
    }

    qty, _ := order.NewQuantity(1)
    price, _ := order.NewMoney(1000, "USD")
    line, _ := order.NewOrderLine("line-1", "SKU-001", "Test Product", qty, price)
    if err := o.AddLine(line); err != nil {
        t.Fatalf("add line: %v", err)
    }
    return o
}

func TestOrder_FullLifecycle(t *testing.T) {
    o := testOrder(t)

    // Place
    if err := o.Place(); err != nil {
        t.Fatalf("place order: %v", err)
    }
    if o.Status() != order.OrderStatusPending {
        t.Errorf("after Place: want pending, got %s", o.Status())
    }

    // Confirm
    if err := o.Confirm(); err != nil {
        t.Fatalf("confirm order: %v", err)
    }
    if o.Status() != order.OrderStatusConfirmed {
        t.Errorf("after Confirm: want confirmed, got %s", o.Status())
    }

    // Fulfill
    if err := o.Fulfill("TRACK123"); err != nil {
        t.Fatalf("fulfill order: %v", err)
    }
    if o.Status() != order.OrderStatusFulfilled {
        t.Errorf("after Fulfill: want fulfilled, got %s", o.Status())
    }
}

func TestOrder_CannotFulfillWithoutConfirmation(t *testing.T) {
    o := testOrder(t)
    _ = o.Place()
    // Skip Confirm - go directly to Fulfill
    err := o.Fulfill("TRACK123")
    if err == nil {
        t.Fatal("expected error when fulfilling unconfirmed order")
    }
    if err != order.ErrOrderNotConfirmed {
        t.Errorf("expected ErrOrderNotConfirmed, got %v", err)
    }
}

func TestOrder_DomainEventsAreEmitted(t *testing.T) {
    tests := []struct {
        name         string
        operation    func(*order.Order) error
        expectedEvent string
    }{
        {
            name: "Place emits OrderPlaced",
            operation: func(o *order.Order) error { return o.Place() },
            expectedEvent: "order.placed",
        },
        {
            name: "Confirm emits OrderConfirmed",
            operation: func(o *order.Order) error {
                _ = o.Place()
                _ = o.DomainEvents() // clear placed event
                return o.Confirm()
            },
            expectedEvent: "order.confirmed",
        },
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            o := testOrder(t)
            if err := tt.operation(o); err != nil {
                t.Fatalf("operation failed: %v", err)
            }
            events := o.DomainEvents()
            if len(events) == 0 {
                t.Fatal("expected at least one domain event")
            }
            found := false
            for _, e := range events {
                if e.EventName() == tt.expectedEvent {
                    found = true
                    break
                }
            }
            if !found {
                t.Errorf("expected event %q, got %v", tt.expectedEvent, events)
            }
        })
    }
}

// Table-driven tests for Money value object
func TestMoney_Operations(t *testing.T) {
    usd := func(cents int64) order.Money { return order.Money{Amount: cents, Currency: "USD"} }

    tests := []struct {
        name    string
        a, b    order.Money
        op      string
        wantErr bool
        want    order.Money
    }{
        {"add same currency", usd(100), usd(200), "add", false, usd(300)},
        {"subtract same currency", usd(500), usd(200), "sub", false, usd(300)},
        {"add different currency", usd(100), order.Money{Amount: 100, Currency: "EUR"}, "add", true, order.Money{}},
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            var result order.Money
            var err error
            switch tt.op {
            case "add":
                result, err = tt.a.Add(tt.b)
            case "sub":
                result, err = tt.a.Subtract(tt.b)
            }

            if (err != nil) != tt.wantErr {
                t.Errorf("wantErr=%v, got err=%v", tt.wantErr, err)
            }
            if !tt.wantErr && !result.Equals(tt.want) {
                t.Errorf("want %v, got %v", tt.want, result)
            }
        })
    }
}
```

### Integration Testing the Repository

Integration tests verify that the PostgreSQL repository correctly persists and reconstitutes aggregates. These tests require a running database, so they use a helper that skips the test when `TEST_DATABASE_URL` is not set. Each test creates its own data and cleans up after itself to avoid test interference.

```go
// internal/infrastructure/persistence/postgres_order_repo_test.go

package persistence_test

import (
    "context"
    "database/sql"
    "os"
    "testing"
    "time"

    _ "github.com/lib/pq"
    orderDomain "github.com/yourorg/ecommerce/order-service/internal/domain/order"
    "github.com/yourorg/ecommerce/order-service/internal/infrastructure/persistence"
)

// skipIfNoDatabase skips the test if the test database is not available.
func skipIfNoDatabase(t *testing.T) *sql.DB {
    t.Helper()
    dsn := os.Getenv("TEST_DATABASE_URL")
    if dsn == "" {
        t.Skip("TEST_DATABASE_URL not set, skipping integration test")
    }
    db, err := sql.Open("postgres", dsn)
    if err != nil {
        t.Fatalf("open test database: %v", err)
    }
    if err := db.Ping(); err != nil {
        t.Fatalf("ping test database: %v", err)
    }
    t.Cleanup(func() { db.Close() })
    return db
}

func TestPostgresOrderRepository_SaveAndFindByID(t *testing.T) {
    db := skipIfNoDatabase(t)

    eventBus := orderDomain.NewEventBus()
    repo := persistence.NewPostgresOrderRepository(db, eventBus)

    ctx := context.Background()

    // Create and save an order
    addr, _ := orderDomain.NewShippingAddress("Jane", "123 Main", "NYC", "NY", "10001", "US")
    o, _ := orderDomain.NewOrder("order-test-1", "customer-1", addr)

    qty, _ := orderDomain.NewQuantity(2)
    price := orderDomain.Money{Amount: 2999, Currency: "USD"}
    line, _ := orderDomain.NewOrderLine("line-1", "SKU-WIDGET", "Widget", qty, price)
    _ = o.AddLine(line)
    _ = o.Place()

    if err := repo.Save(ctx, o); err != nil {
        t.Fatalf("save order: %v", err)
    }

    // Retrieve and verify
    found, err := repo.FindByID(ctx, "order-test-1")
    if err != nil {
        t.Fatalf("find order: %v", err)
    }

    if found.ID() != o.ID() {
        t.Errorf("id mismatch: want %s, got %s", o.ID(), found.ID())
    }
    if found.Status() != orderDomain.OrderStatusPending {
        t.Errorf("status mismatch: want pending, got %s", found.Status())
    }
    if len(found.Lines()) != 1 {
        t.Errorf("lines count mismatch: want 1, got %d", len(found.Lines()))
    }

    // Cleanup
    t.Cleanup(func() {
        db.ExecContext(ctx, "DELETE FROM order_lines WHERE order_id = 'order-test-1'")
        db.ExecContext(ctx, "DELETE FROM orders WHERE id = 'order-test-1'")
    })
}
```

### Fakes vs. Mocks: Prefer Fakes

A small terminology correction up front: what most tutorials call a "mock" in Go is usually a **fake** - a hand-written struct that implements the repository interface with an in-memory map. A real mock (via `gomock` or `mockery`) uses generated code and records expected call sequences. For DDD, fakes are almost always the better choice:

- **Fakes let the domain drive the test.** You save an aggregate, then load it, and assert state. This exercises the full round-trip including any reconstitution logic a `mapstructure.Decode`-style mock would never execute.
- **Mocks couple tests to call order.** `expect(repo.Save).Before(repo.LoadLines)` breaks when the handler is refactored, even if behavior is correct. Fakes only care about end state.
- **Fakes are cheaper to maintain.** A 40-line in-memory map repository serves every test in the application layer.

Use real mocks only for interfaces with genuine side-effects that cannot be faked (an `EmailSender` that must assert exactly one email went out, a `Clock` for deterministic time).

### Application Service Tests with Fake Repositories

Application service tests use fake repositories to verify that command handlers call the right domain methods and persist results. Because the handler depends on a repository interface, you can substitute a lightweight fake that records calls and returns preconfigured results.

```go
// internal/application/order/place_order_test.go

package orderapp_test

import (
    "context"
    "errors"
    "testing"

    orderapp "github.com/yourorg/ecommerce/order-service/internal/application/order"
    "github.com/yourorg/ecommerce/order-service/internal/domain/order"
)

// mockOrderRepository is a mock for testing application services.
type mockOrderRepository struct {
    saved  []*order.Order
    findFn func(id order.OrderID) (*order.Order, error)
    saveErr error
}

func (m *mockOrderRepository) Save(_ context.Context, o *order.Order) error {
    if m.saveErr != nil {
        return m.saveErr
    }
    m.saved = append(m.saved, o)
    return nil
}

func (m *mockOrderRepository) FindByID(_ context.Context, id order.OrderID) (*order.Order, error) {
    if m.findFn != nil {
        return m.findFn(id)
    }
    return nil, order.ErrOrderNotFound
}

func (m *mockOrderRepository) FindByCustomer(_ context.Context, _ order.CustomerID) ([]*order.Order, error) {
    return nil, nil
}

func (m *mockOrderRepository) FindPendingOlderThan(_ context.Context, _ int) ([]*order.Order, error) {
    return nil, nil
}

func (m *mockOrderRepository) Delete(_ context.Context, _ order.OrderID) error {
    return nil
}

func TestPlaceOrderHandler_Handle_Success(t *testing.T) {
    repo := &mockOrderRepository{}
    handler := orderapp.NewPlaceOrderHandler(repo)

    cmd := orderapp.PlaceOrderCommand{
        CustomerID: "customer-1",
        Lines: []orderapp.OrderLineInput{
            {
                ProductSKU:  "SKU-001",
                ProductName: "Widget",
                Quantity:    2,
                UnitPrice:   2999,
                Currency:    "USD",
            },
        },
        ShippingAddress: orderapp.AddressInput{
            RecipientName: "Jane Doe",
            Street:        "123 Main St",
            City:          "New York",
            State:         "NY",
            PostalCode:    "10001",
            CountryCode:   "US",
        },
    }

    result, err := handler.Handle(context.Background(), cmd)
    if err != nil {
        t.Fatalf("handle place order: %v", err)
    }

    if result.OrderID == "" {
        t.Error("expected a non-empty order ID")
    }
    if len(repo.saved) != 1 {
        t.Errorf("expected 1 saved order, got %d", len(repo.saved))
    }
    if repo.saved[0].Status() != order.OrderStatusPending {
        t.Errorf("expected saved order to be pending, got %s", repo.saved[0].Status())
    }
}

func TestPlaceOrderHandler_Handle_RepositoryError(t *testing.T) {
    dbErr := errors.New("connection refused")
    repo := &mockOrderRepository{saveErr: dbErr}
    handler := orderapp.NewPlaceOrderHandler(repo)

    cmd := orderapp.PlaceOrderCommand{
        CustomerID: "customer-1",
        Lines: []orderapp.OrderLineInput{
            {ProductSKU: "SKU-001", ProductName: "Widget", Quantity: 1, UnitPrice: 1000, Currency: "USD"},
        },
        ShippingAddress: orderapp.AddressInput{
            RecipientName: "Jane", Street: "1 St", City: "NYC", State: "NY", PostalCode: "10001", CountryCode: "US",
        },
    }

    _, err := handler.Handle(context.Background(), cmd)
    if err == nil {
        t.Fatal("expected error when repository fails")
    }
    if !errors.Is(err, dbErr) {
        t.Errorf("expected wrapped db error, got %v", err)
    }
}
```

### Infrastructure Tests with Testcontainers

For repository tests, the gold standard in Go (2026) is `testcontainers-go`. It spins up a throwaway PostgreSQL container for the duration of the test, runs migrations, and tears it down. You get production-parity SQL behavior that no mock or `sqlmock` can match (triggers fire, constraints enforce, `gen_random_uuid()` actually works).

```go
// internal/infrastructure/persistence/postgres_order_repo_testcontainers_test.go

package persistence_test

import (
    "context"
    "database/sql"
    "testing"

    _ "github.com/lib/pq"
    "github.com/testcontainers/testcontainers-go/modules/postgres"
)

func setupPostgres(t *testing.T) *sql.DB {
    t.Helper()
    ctx := context.Background()

    container, err := postgres.Run(ctx,
        "postgres:18-alpine",
        postgres.WithDatabase("orders_test"),
        postgres.WithUsername("test"),
        postgres.WithPassword("test"),
        postgres.BasicWaitStrategies(),
    )
    if err != nil {
        t.Fatalf("start postgres container: %v", err)
    }
    t.Cleanup(func() { _ = container.Terminate(ctx) })

    dsn, err := container.ConnectionString(ctx, "sslmode=disable")
    if err != nil {
        t.Fatalf("get dsn: %v", err)
    }

    db, err := sql.Open("postgres", dsn)
    if err != nil {
        t.Fatalf("open db: %v", err)
    }
    if err := runMigrations(ctx, db); err != nil {
        t.Fatalf("run migrations: %v", err)
    }
    return db
}
```

Run rules for a healthy DDD project:

- **Domain tests** (`internal/domain/...`): no build tags, run on every `go test ./...`, finish in milliseconds
- **Application tests** with fakes: same - fast default path
- **Infrastructure tests** with testcontainers: gate behind `//go:build integration` and run in CI, or use a shared container pool with `t.Parallel()` to amortize startup
- **End-to-end tests** spanning HTTP/gRPC → application → infrastructure: a small number, typically one happy path plus a couple of failure modes per endpoint

The pyramid is wide at the bottom (thousands of fast domain tests), narrow at the top (a handful of e2e). Inverting this pyramid - all tests going through the HTTP layer - is how DDD codebases end up with a 20-minute test suite.

---

### Junior → FAANG: Building the Habit of Fast Domain Tests

The most important testing habit to develop early is this: your domain tests must run in milliseconds, not seconds. If a domain test takes more than 100 milliseconds, something is importing infrastructure that should not be there.

Run `go test -v -count=1 ./internal/domain/...` and look at the timing output. If any test in that suite is slow, trace it back to its imports. A domain test that is slow because it hits a real database is not a domain test: it is an integration test that wandered into the wrong package.

The fake repository pattern shown in this section is the most important testing pattern to internalize for DDD Go projects. The key properties of a good fake: it stores data in a map, it returns the same errors as the real implementation for the same conditions (`ErrOrderNotFound` when the ID is not in the map), and it is defined in the test file rather than production code. Defining it in production code tempts you to use it in production.

For interview preparation: know the difference between a fake and a mock without hesitation. A fake has working behavior (the in-memory repository actually stores and retrieves). A mock has expected behavior (you tell the mock what calls to expect and what to return). Fakes are better for command handlers because they exercise the full round-trip through the aggregate. Mocks are better for side-effect verification (assert exactly one email was sent).

### Senior @ FAANG: Test Architecture as a Platform Investment

At the staff level, the testing strategy for a DDD platform is a multi-year investment decision. The choices you make now about test granularity, shared test infrastructure, and CI speed compound over time.

**Contract tests for repository interfaces.** The most underused testing pattern in DDD Go projects is the repository contract test: a single test suite, written against the interface, that runs against both the fake implementation and the real PostgreSQL implementation. This guarantees that the fake is behaviorally equivalent to the real thing. Without this, you can have perfectly passing application-layer tests with the fake, and a production bug because the fake did not model a constraint or trigger correctly.

```go
// A contract test factory: the same suite runs against both implementations
func RunOrderRepositoryContractTests(t *testing.T, factory func() order.Repository) {
    t.Run("FindByID_returns_not_found_for_missing_id", func(t *testing.T) {
        repo := factory()
        _, err := repo.FindByID(context.Background(), order.OrderID("does-not-exist"))
        if !errors.Is(err, order.ErrOrderNotFound) {
            t.Errorf("expected ErrOrderNotFound, got %v", err)
        }
    })
    // ... more contract cases
}

// Run against the fake
func TestMemoryOrderRepository(t *testing.T) {
    RunOrderRepositoryContractTests(t, func() order.Repository {
        return persistence.NewMemoryOrderRepository()
    })
}

// Run against Postgres (integration build tag)
//go:build integration
func TestPostgresOrderRepository(t *testing.T) {
    db := setupPostgres(t)
    RunOrderRepositoryContractTests(t, func() order.Repository {
        return persistence.NewPostgresOrderRepository(db, orderDomain.NewEventBus())
    })
}
```

This pattern catches behavioral drift between the fake and the real implementation before it reaches production.

**Test speed as a CI contract.** A Staff engineer defines SLOs for the test suite: domain tests must complete in under 30 seconds, application tests (with fakes) in under 2 minutes, integration tests (with testcontainers) in under 10 minutes. These numbers go into the CI configuration as timeout values, not aspirations. When a test exceeds the timeout, the build fails. This prevents the gradual slowdown that makes developers stop running the full suite locally. Container reuse across tests (using `testcontainers-go` with the `Reuse` option) is a standard optimization: start one Postgres container per test binary invocation, truncate tables between tests, rather than starting a new container per test function.

**Observability in tests.** At scale, flaky tests are a platform health issue. A Staff engineer tracks flaky test rate as a metric: how often does a test fail on a re-run without code changes? A flaky test rate above 2% degrades developer trust in CI and causes real failures to be dismissed as "probably just flaky." Flaky domain tests typically indicate race conditions (concurrent test execution on shared state). Flaky integration tests typically indicate timing dependencies (waiting for the container to be ready, asserting on a time-sensitive operation). `go test -race` must run in CI. Infrastructure tests must use `t.Parallel()` carefully, with proper data isolation per test using unique IDs or table truncation.

**The test pyramid is a budget.** At the organization level, the test pyramid translates to a CI budget. Running 10,000 domain tests costs pennies. Running 200 integration tests with testcontainers costs real money and real developer time. A Staff engineer monitors the ratio quarterly and asks: are we getting signal from each layer proportional to its cost? A service with 50 domain tests and 500 integration tests has an inverted pyramid that costs 10x as much to run while providing less domain coverage. Correcting it is a multi-sprint investment in moving behavior into the domain layer and writing corresponding unit tests.

---
