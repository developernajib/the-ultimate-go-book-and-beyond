## 52B.9 Application Services

### Application Services as Orchestrators

An **Application Service** is the entry point into the application for a specific use case. It:

1. Receives a command (input DTO or struct)
2. Loads domain objects from repositories
3. Delegates to domain objects or domain services
4. Saves domain objects back to repositories
5. Returns a response DTO

Application services are **thin orchestrators**. They contain no domain logic. They coordinate domain objects to fulfill a use case.

The `PlaceOrderHandler` below demonstrates the pattern. It receives a command DTO from the HTTP or gRPC layer, translates it into domain types, delegates to the `Order` aggregate for business rules, and persists the result through the repository. Notice that the handler never checks order line limits or validates status transitions, those rules live in the aggregate.

```go
// application/order/place_order_handler.go

package orderapp

import (
    "context"
    "fmt"
    "github.com/google/uuid"

    "github.com/yourorg/ecommerce/order-service/internal/domain/order"
)

// PlaceOrderCommand contains the data needed to place an order.
type PlaceOrderCommand struct {
    CustomerID      string
    Lines           []PlaceOrderLineCommand
    ShippingAddress PlaceOrderAddressCommand
}

// PlaceOrderLineCommand is the input DTO for a single order line.
type PlaceOrderLineCommand struct {
    ProductSKU  string
    ProductName string
    Quantity    int
    UnitPriceCents int64
    Currency    string
}

// PlaceOrderAddressCommand is the input DTO for a shipping address.
type PlaceOrderAddressCommand struct {
    RecipientName string
    Street        string
    City          string
    State         string
    PostalCode    string
    CountryCode   string
}

// PlaceOrderResult is the output of placing an order.
type PlaceOrderResult struct {
    OrderID     string
    TotalAmount string
}

// PlaceOrderHandler handles the PlaceOrder use case.
type PlaceOrderHandler struct {
    orders order.OrderRepository
}

// NewPlaceOrderHandler creates a new PlaceOrderHandler.
func NewPlaceOrderHandler(orders order.OrderRepository) *PlaceOrderHandler {
    return &PlaceOrderHandler{orders: orders}
}

// Handle executes the PlaceOrder use case.
func (h *PlaceOrderHandler) Handle(ctx context.Context, cmd PlaceOrderCommand) (PlaceOrderResult, error) {
    // 1. Validate and translate input to domain types
    customerID := order.CustomerID(cmd.CustomerID)
    if customerID == "" {
        return PlaceOrderResult{}, fmt.Errorf("customer ID is required")
    }

    shipping, err := order.NewShippingAddress(
        cmd.ShippingAddress.RecipientName,
        cmd.ShippingAddress.Street,
        cmd.ShippingAddress.City,
        cmd.ShippingAddress.State,
        cmd.ShippingAddress.PostalCode,
        cmd.ShippingAddress.CountryCode,
    )
    if err != nil {
        return PlaceOrderResult{}, fmt.Errorf("invalid shipping address: %w", err)
    }

    // 2. Create the aggregate
    orderID := order.OrderID(uuid.New().String())
    o, err := order.NewOrder(orderID, customerID, shipping)
    if err != nil {
        return PlaceOrderResult{}, fmt.Errorf("create order: %w", err)
    }

    // 3. Add lines to the aggregate
    for _, lineCmd := range cmd.Lines {
        lineID := order.OrderLineID(uuid.New().String())
        qty, err := order.NewQuantity(lineCmd.Quantity)
        if err != nil {
            return PlaceOrderResult{}, fmt.Errorf("invalid quantity for %s: %w", lineCmd.ProductSKU, err)
        }
        price, err := order.NewMoneyFromCents(lineCmd.UnitPriceCents, lineCmd.Currency)
        if err != nil {
            return PlaceOrderResult{}, fmt.Errorf("invalid price for %s: %w", lineCmd.ProductSKU, err)
        }
        line, err := order.NewOrderLine(lineID, order.ProductSKU(lineCmd.ProductSKU), lineCmd.ProductName, qty, price)
        if err != nil {
            return PlaceOrderResult{}, fmt.Errorf("create order line: %w", err)
        }
        if err := o.AddLine(line); err != nil {
            return PlaceOrderResult{}, fmt.Errorf("add order line: %w", err)
        }
    }

    // 4. Execute domain operation
    if err := o.Place(); err != nil {
        return PlaceOrderResult{}, fmt.Errorf("place order: %w", err)
    }

    // 5. Persist
    if err := h.orders.Save(ctx, o); err != nil {
        return PlaceOrderResult{}, fmt.Errorf("save order: %w", err)
    }

    return PlaceOrderResult{
        OrderID:     string(o.ID()),
        TotalAmount: o.TotalAmount().String(),
    }, nil
}
```

### Junior → FAANG: Keeping Application Services Thin

The application service is the most tempting place to put business logic because it sits at the center of the call graph and has access to everything. Resisting that temptation is a core discipline of DDD.

The test for whether logic belongs in an application service or the domain: can a domain expert describe this rule? If yes, it belongs in the domain. "An order can only be canceled within 30 minutes" is a domain rule. "Deserialize the JSON body and extract the customer ID" is not.

A practical habit: keep application service methods to roughly five to ten lines of real logic. Load, validate input shape, delegate to aggregate, save, return. If a method is growing past twenty lines, something is wrong. Either a domain operation is leaking into the service, or the use case is doing too many things and should be split into two handlers.

For interviews, the application service is the answer to "what coordinates the domain objects?" The key points: it does not contain business rules, it depends on repository interfaces (not implementations), it translates between external data shapes (JSON, gRPC messages) and domain types, and it is the correct place for authorization checks (the domain does not know who the caller is).

The most common entry-level mistake is putting authorization inside the domain object: `order.CancelBy(userID)` that checks if the user is the owner. Authorization is a cross-cutting concern that depends on the calling context, not on the domain object's invariants. Application services are the right place for it.

### Senior @ FAANG: Application Service Design for Observability, Idempotency, and Long-Running Operations

At scale, application services are the primary unit of operational observability. They are where structured logging, metrics emission, distributed trace spans, and idempotency keys are applied.

**Structured logging and correlation ID propagation.** Every application service method receives a `context.Context`. Senior engineers enforce that the context carries a correlation ID (set at the HTTP or gRPC boundary) that is attached to every log line and every downstream call emitted by the service. In Go, this is implemented with a context middleware that injects a `RequestID` or `CorrelationID` into the context, and a logging helper that extracts it from the context before emitting structured log fields. Without this, debugging a production incident in a distributed system requires correlating log lines from five services across a time window, which is extremely expensive. With it, you search for the correlation ID and see the complete call chain in one query.

**Idempotency at the application service boundary.** Any application service that handles a command that can be retried (all of them, in a distributed system) should support idempotency keys. The pattern: the caller provides a client-generated `IdempotencyKey` in the command. The application service checks a short-lived store (Redis, or an idempotency table in the database) for that key before executing. If found, it returns the cached result. If not, it executes and stores the result. This prevents duplicate order placements when a client retries a request that timed out after the server had already processed it. At the L6 bar, not designing idempotency for commands that change state is a significant omission.

**Long-running operations and the process manager pattern.** Some use cases cannot complete in a single synchronous request: placing an order that requires inventory reservation and payment authorization may involve multiple external service calls, each of which can fail independently. The production pattern is a process manager (also called a saga orchestrator): a stateful object that tracks the progress of a multi-step use case, sends commands, listens for events, and applies compensating transactions on failure. In Go, a process manager is typically implemented as a domain aggregate (the saga state) plus an application service that handles the events and drives the next step. The process manager's state is persisted, so it survives process restarts. At the L6/L7 bar, you should be able to sketch the state machine of a saga for the scenario given in the interview, including all failure paths and their compensations.

**Metrics and SLO alignment.** Every application service method should emit at least three metrics: request count (split by success/failure), latency histogram (with p50/p95/p99 percentiles), and domain error count (split by error type, in the ubiquitous language). The domain error split is the one most commonly missing at the L5 level: knowing that `ErrCancellationWindowExpired` fired 500 times in an hour tells you something about user behavior and product design. Aggregating all errors under a generic `error` label tells you nothing. At the staff level, aligning application service metrics with published SLOs (e.g., "99th percentile order placement latency under 500ms") and setting alerts on SLO burn rate is expected as part of the service design, not as a follow-up operational task.

---
