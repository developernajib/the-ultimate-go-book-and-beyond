## 52B.11 Complete DDD Example: Order Management System

Let's assemble everything into a working system. The structure:

```
order-service/
├── cmd/
│   └── server/
│       └── main.go
├── internal/
│   ├── domain/
│   │   └── order/
│   │       ├── order.go           # Aggregate root
│   │       ├── order_line.go      # Entity within aggregate
│   │       ├── value_objects.go   # Money, ShippingAddress, etc.
│   │       ├── events.go          # Domain events
│   │       ├── event_bus.go       # In-process event bus
│   │       ├── repository.go      # Repository interface
│   │       ├── reconstitute.go    # Reconstitution factory
│   │       └── pricing_service.go # Domain service
│   ├── application/
│   │   └── order/
│   │       ├── place_order.go     # PlaceOrder command handler
│   │       ├── cancel_order.go    # CancelOrder command handler
│   │       └── get_order.go       # GetOrder query handler
│   └── infrastructure/
│       └── order/
│           ├── postgres_repo.go   # PostgreSQL repository
│           └── memory_repo.go     # In-memory repository (testing)
├── interfaces/
│   └── http/
│       └── order_handler.go       # HTTP handler (thin adapter)
└── go.mod
```

The HTTP handler is a thin adapter that translates HTTP requests into application commands and domain errors into HTTP status codes. It has no business logic. It only handles serialization, deserialization, and error mapping. This separation means you can swap HTTP for gRPC or CLI without touching any domain or application code.

```go
// interfaces/http/order_handler.go

package httphandler

import (
    "encoding/json"
    "errors"
    "net/http"

    orderapp "github.com/yourorg/ecommerce/order-service/internal/application/order"
    "github.com/yourorg/ecommerce/order-service/internal/domain/order"
)

// OrderHandler handles HTTP requests for the order domain.
type OrderHandler struct {
    placeOrder  *orderapp.PlaceOrderHandler
    cancelOrder *orderapp.CancelOrderHandler
    getOrder    *orderapp.GetOrderHandler
}

// NewOrderHandler creates a new HTTP order handler.
func NewOrderHandler(
    place *orderapp.PlaceOrderHandler,
    cancel *orderapp.CancelOrderHandler,
    get *orderapp.GetOrderHandler,
) *OrderHandler {
    return &OrderHandler{
        placeOrder:  place,
        cancelOrder: cancel,
        getOrder:    get,
    }
}

// PlaceOrder handles POST /orders
func (h *OrderHandler) PlaceOrder(w http.ResponseWriter, r *http.Request) {
    var req struct {
        CustomerID string `json:"customer_id"`
        Lines      []struct {
            ProductSKU  string  `json:"product_sku"`
            ProductName string  `json:"product_name"`
            Quantity    int     `json:"quantity"`
            UnitPriceCents int64 `json:"unit_price_cents"`
            Currency    string  `json:"currency"`
        } `json:"lines"`
        ShippingAddress struct {
            RecipientName string `json:"recipient_name"`
            Street        string `json:"street"`
            City          string `json:"city"`
            State         string `json:"state"`
            PostalCode    string `json:"postal_code"`
            CountryCode   string `json:"country_code"`
        } `json:"shipping_address"`
    }

    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        http.Error(w, "invalid request body", http.StatusBadRequest)
        return
    }

    cmd := orderapp.PlaceOrderCommand{
        CustomerID: req.CustomerID,
        ShippingAddress: orderapp.PlaceOrderAddressCommand{
            RecipientName: req.ShippingAddress.RecipientName,
            Street:        req.ShippingAddress.Street,
            City:          req.ShippingAddress.City,
            State:         req.ShippingAddress.State,
            PostalCode:    req.ShippingAddress.PostalCode,
            CountryCode:   req.ShippingAddress.CountryCode,
        },
    }
    for _, l := range req.Lines {
        cmd.Lines = append(cmd.Lines, orderapp.PlaceOrderLineCommand{
            ProductSKU:  l.ProductSKU,
            ProductName: l.ProductName,
            Quantity:    l.Quantity,
            UnitPriceCents: l.UnitPriceCents,
            Currency:    l.Currency,
        })
    }

    result, err := h.placeOrder.Handle(r.Context(), cmd)
    if err != nil {
        h.handleDomainError(w, err)
        return
    }

    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(http.StatusCreated)
    json.NewEncoder(w).Encode(result)
}

// handleDomainError translates domain errors to HTTP status codes.
// This is the ACL between domain errors and HTTP protocol.
func (h *OrderHandler) handleDomainError(w http.ResponseWriter, err error) {
    switch {
    case errors.Is(err, order.ErrOrderNotFound):
        http.Error(w, err.Error(), http.StatusNotFound)
    case errors.Is(err, order.ErrCancellationWindowExpired),
        errors.Is(err, order.ErrOrderAlreadyCanceled),
        errors.Is(err, order.ErrOrderNotPending),
        errors.Is(err, order.ErrEmptyOrder):
        http.Error(w, err.Error(), http.StatusUnprocessableEntity)
    case errors.Is(err, order.ErrOptimisticConcurrencyConflict):
        http.Error(w, "conflict: please retry", http.StatusConflict)
    default:
        http.Error(w, "internal server error", http.StatusInternalServerError)
    }
}
```

Because the domain layer has no infrastructure dependencies, tests run without a database, HTTP server, or any external service. The tests below exercise aggregate invariants, state transitions, domain events, and value object behavior using only pure Go constructs:

```go
// internal/domain/order/order_test.go

package order_test

import (
    "testing"
    "time"

    "github.com/yourorg/ecommerce/order-service/internal/domain/order"
)

func validShippingAddress(t *testing.T) order.ShippingAddress {
    t.Helper()
    addr, err := order.NewShippingAddress("Jane Doe", "123 Main St", "New York", "NY", "10001", "US")
    if err != nil {
        t.Fatalf("create test shipping address: %v", err)
    }
    return addr
}

func TestOrder_Place_SucceedsWithValidLines(t *testing.T) {
    o, err := order.NewOrder("order-1", "customer-1", validShippingAddress(t))
    if err != nil {
        t.Fatalf("create order: %v", err)
    }

    qty, _ := order.NewQuantity(2)
    price, _ := order.NewMoney(49.99, "USD")
    line, _ := order.NewOrderLine("line-1", "SKU-001", "Widget Pro", qty, price)

    if err := o.AddLine(line); err != nil {
        t.Fatalf("add line: %v", err)
    }

    if err := o.Place(); err != nil {
        t.Fatalf("place order: %v", err)
    }

    if o.Status() != order.OrderStatusPending {
        t.Errorf("expected status pending, got %s", o.Status())
    }

    events := o.DomainEvents()
    if len(events) != 1 {
        t.Fatalf("expected 1 domain event, got %d", len(events))
    }
    placed, ok := events[0].(order.OrderPlaced)
    if !ok {
        t.Fatalf("expected OrderPlaced event, got %T", events[0])
    }
    if placed.OrderID != "order-1" {
        t.Errorf("expected order ID order-1, got %s", placed.OrderID)
    }
}

func TestOrder_Cancel_FailsAfterCancellationWindow(t *testing.T) {
    o, _ := order.NewOrder("order-1", "customer-1", validShippingAddress(t))

    qty, _ := order.NewQuantity(1)
    price, _ := order.NewMoney(10.00, "USD")
    line, _ := order.NewOrderLine("line-1", "SKU-001", "Widget", qty, price)
    _ = o.AddLine(line)
    _ = o.Place()

    // Simulate the order being placed 31 minutes ago
    // by using reconstitute with a backdated placedAt
    old := order.Reconstitute(
        o.ID(), o.CustomerID(), order.OrderStatusPending,
        validShippingAddress(t), o.Lines(),
        time.Now().Add(-31*time.Minute), 1,
    )

    err := old.Cancel("changed mind")
    if err == nil {
        t.Fatal("expected cancellation to fail after window expired")
    }
    if err != order.ErrCancellationWindowExpired {
        t.Errorf("expected ErrCancellationWindowExpired, got %v", err)
    }
}

func TestOrder_AddLine_FailsForDuplicateSKU(t *testing.T) {
    o, _ := order.NewOrder("order-1", "customer-1", validShippingAddress(t))

    qty, _ := order.NewQuantity(1)
    price, _ := order.NewMoney(10.00, "USD")
    line1, _ := order.NewOrderLine("line-1", "SKU-001", "Widget", qty, price)
    line2, _ := order.NewOrderLine("line-2", "SKU-001", "Widget", qty, price)

    _ = o.AddLine(line1)
    err := o.AddLine(line2)
    if err != order.ErrDuplicateOrderLine {
        t.Errorf("expected ErrDuplicateOrderLine, got %v", err)
    }
}

func TestMoney_Add_FailsWithCurrencyMismatch(t *testing.T) {
    usd, _ := order.NewMoney(10.00, "USD")
    eur, _ := order.NewMoney(10.00, "EUR")

    _, err := usd.Add(eur)
    if err == nil {
        t.Fatal("expected error on currency mismatch")
    }
}
```

### Junior → FAANG: Reading a Full DDD Codebase for the First Time

The most disorienting thing about a complete DDD codebase for a junior engineer is the directory structure. Nothing is named `controllers`, `models`, or `services`. The layers are `domain`, `application`, `infrastructure`, and `interfaces`. Understanding what belongs in each layer is the prerequisite to contributing safely.

Use the dependency rule as your orientation compass: domain imports nothing from the other layers. Application imports domain. Infrastructure imports domain (to implement interfaces). Interfaces (HTTP, gRPC) import application and infrastructure, wired together in `main.go`. If you see an import that violates this graph, that is the bug to fix before adding any new code.

The test structure mirrors the application structure. Domain tests have no database or HTTP dependencies. Application tests use in-memory repository implementations. Infrastructure tests run against a real database in a Docker container. Interface tests use `httptest`. If a domain test imports `database/sql`, something is wrong.

For interviews at the entry level, being able to trace a single use case (e.g., "a customer places an order") through all four layers and name the type at each boundary (HTTP handler extracts JSON, constructs `PlaceOrderCommand`, passes to `PlaceOrderHandler`, which calls `order.NewOrder`, calls `order.AddLine`, calls `order.Place`, calls `repo.Save`, which writes to Postgres and publishes `OrderPlaced`) demonstrates you understand the full system, not just isolated pieces.

### Senior @ FAANG: Integration Testing Strategy and Deployment Readiness

A complete DDD system needs a testing strategy that spans all four layers with appropriate isolation at each level, and a deployment strategy that handles schema migrations, event schema evolution, and operational readiness simultaneously.

**Test pyramid for a DDD service.** The correct distribution: the majority of tests are domain unit tests (fast, no I/O, cover every invariant and state transition). A substantial layer of application service tests uses in-memory repositories and mock external adapters, covering every use case including failure paths and idempotency behavior. A smaller layer of infrastructure contract tests runs against real infrastructure (PostgreSQL in Docker, real Kafka or Rabbit for event publishing) and verifies that the repository implementation correctly handles optimistic concurrency, reconstitution, and event publication after commit. The smallest layer is integration tests that run the full HTTP handler through a real application against a seeded database. This distribution maximizes coverage speed at the domain level (where most bugs live) and minimizes the maintenance cost of the slow infrastructure tests (which cover the plumbing, not the rules).

**Deployment sequencing for schema changes.** DDD systems have three types of schema that evolve independently and must be deployed in the correct order: the database schema (aggregate state tables), the outbox schema (event staging table), and the integration event schema (published to the message bus). The deployment sequence for adding a new field to an aggregate: (1) deploy the database migration that adds the column with a default value (backward-compatible, old code still works). (2) deploy the new application code that reads and writes the new field. (3) optionally run a backfill job to populate the column for existing rows. Reversing steps 1 and 2 means the new code runs against an old schema, which crashes. The deployment sequence for deprecating a field follows the same pattern in reverse.

**Operational runbook as part of the design.** At the L6/L7 bar, a complete system design includes the day-two operational story: what alerts fire under load, what the on-call runbook says for each alert, how to replay a failed event from the outbox, how to roll back a deployment that introduced a bad aggregate invariant, and how to perform a zero-downtime database migration for a high-traffic aggregate table. These are not afterthoughts. They are design decisions that affect the aggregate structure (adding a `is_migrated` field to track backfill progress), the event bus configuration (setting consumer group names that support parallel replay), and the deployment pipeline (blue-green deployment with schema-version checks at startup). A candidate who designs the domain layer beautifully and leaves operational concerns to "we'll figure it out later" is not at the L6 bar.

---
