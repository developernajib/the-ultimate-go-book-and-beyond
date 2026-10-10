## 52C.4 Implementing the Application Layer

### Command and Query Types

CQRS separation begins at the application layer. Commands change state, while queries read state:

```go
// internal/application/order/commands.go

package orderapp

import "time"

// PlaceOrderCommand is the input for placing a new order.
type PlaceOrderCommand struct {
    RequestID   string // idempotency key
    CustomerID  string
    Lines       []OrderLineInput
    ShippingAddress AddressInput
}

// CancelOrderCommand is the input for cancelling an order.
type CancelOrderCommand struct {
    RequestID string
    OrderID   string
    Reason    string
    RequestedBy string // who is cancelling: "customer" or "system"
}

// ConfirmOrderCommand is the input for confirming an order after payment.
type ConfirmOrderCommand struct {
    RequestID     string
    OrderID       string
    TransactionID string
}

// FulfillOrderCommand is the input for marking an order fulfilled.
type FulfillOrderCommand struct {
    RequestID      string
    OrderID        string
    TrackingNumber string
}

// OrderLineInput is the input DTO for a single order line.
type OrderLineInput struct {
    ProductSKU  string
    ProductName string
    Quantity    int
    UnitPrice   int64  // in cents
    Currency    string
}

// AddressInput is the input DTO for a shipping address.
type AddressInput struct {
    RecipientName string
    Street        string
    City          string
    State         string
    PostalCode    string
    CountryCode   string
}
```

Query types mirror this structure for read operations. Query results use flat, denormalized view types rather than domain aggregates, since read paths have different performance and shape requirements than write paths.

```go
// internal/application/order/queries.go

package orderapp

import "time"

// GetOrderQuery retrieves a single order.
type GetOrderQuery struct {
    OrderID string
}

// ListCustomerOrdersQuery lists all orders for a customer.
type ListCustomerOrdersQuery struct {
    CustomerID string
    PageSize   int
    PageToken  string
}

// OrderView is the read model returned by queries.
// It is a denormalized, display-oriented representation.
type OrderView struct {
    ID              string
    CustomerID      string
    Status          string
    Lines           []OrderLineView
    ShippingAddress AddressView
    TotalAmount     int64
    Currency        string
    PlacedAt        *time.Time
    CreatedAt       time.Time
}

// OrderLineView is the read model for a single order line.
type OrderLineView struct {
    ID          string
    ProductSKU  string
    ProductName string
    Quantity    int
    UnitPrice   int64
    Currency    string
    Subtotal    int64
}

// AddressView is the read model for an address.
type AddressView struct {
    RecipientName string
    Street        string
    City          string
    State         string
    PostalCode    string
    CountryCode   string
}
```

### Complete Command Handler: CancelOrder

A command handler follows a consistent pattern: check idempotency, load the aggregate, delegate to domain methods, persist, and mark the request as processed. The handler itself contains no business logic - all rules live in the domain layer.

```go
// internal/application/order/cancel_order.go

package orderapp

import (
    "context"
    "fmt"

    "github.com/yourorg/ecommerce/order-service/internal/domain/order"
)

// CancelOrderHandler handles the CancelOrder use case.
type CancelOrderHandler struct {
    orders     order.OrderRepository
    idempotency IdempotencyStore
}

// IdempotencyStore prevents duplicate command processing.
// The interface is defined in the application layer - infra implements it.
type IdempotencyStore interface {
    IsProcessed(ctx context.Context, requestID string) (bool, error)
    MarkProcessed(ctx context.Context, requestID string) error
}

// NewCancelOrderHandler creates a CancelOrderHandler with its dependencies.
func NewCancelOrderHandler(orders order.OrderRepository, idem IdempotencyStore) *CancelOrderHandler {
    return &CancelOrderHandler{orders: orders, idempotency: idem}
}

// Handle executes the CancelOrder use case.
func (h *CancelOrderHandler) Handle(ctx context.Context, cmd CancelOrderCommand) error {
    // Idempotency check: if this request was already processed, succeed silently
    if cmd.RequestID != "" {
        processed, err := h.idempotency.IsProcessed(ctx, cmd.RequestID)
        if err != nil {
            return fmt.Errorf("check idempotency: %w", err)
        }
        if processed {
            return nil // already processed, return success
        }
    }

    // Load the aggregate
    o, err := h.orders.FindByID(ctx, order.OrderID(cmd.OrderID))
    if err != nil {
        return fmt.Errorf("load order: %w", err)
    }

    // Delegate to domain - the domain enforces the business rules
    if err := o.Cancel(cmd.Reason); err != nil {
        return err // domain errors bubble up as-is
    }

    // Persist
    if err := h.orders.Save(ctx, o); err != nil {
        return fmt.Errorf("save order after cancellation: %w", err)
    }

    // Mark as processed after successful save
    if cmd.RequestID != "" {
        if err := h.idempotency.MarkProcessed(ctx, cmd.RequestID); err != nil {
            // Log but don't fail - the operation succeeded
            // The worst case is the command is processed twice if the client retries
        }
    }

    return nil
}
```

### Query Handler

Query handlers can bypass the domain layer entirely and read directly from optimized read models:

```go
// internal/application/order/get_order.go

package orderapp

import (
    "context"
    "fmt"

    "github.com/yourorg/ecommerce/order-service/internal/domain/order"
)

// OrderQueryRepository is a read-optimized interface for order queries.
// It may return denormalized views that do not go through the domain aggregate.
type OrderQueryRepository interface {
    FindOrderView(ctx context.Context, id order.OrderID) (*OrderView, error)
    ListOrderViewsByCustomer(ctx context.Context, customerID order.CustomerID, limit int, pageToken string) ([]*OrderView, string, error)
}

// GetOrderHandler handles the GetOrder query.
type GetOrderHandler struct {
    queryRepo OrderQueryRepository
}

// NewGetOrderHandler creates a GetOrderHandler.
func NewGetOrderHandler(queryRepo OrderQueryRepository) *GetOrderHandler {
    return &GetOrderHandler{queryRepo: queryRepo}
}

// Handle returns the order view for the given ID.
func (h *GetOrderHandler) Handle(ctx context.Context, q GetOrderQuery) (*OrderView, error) {
    view, err := h.queryRepo.FindOrderView(ctx, order.OrderID(q.OrderID))
    if err != nil {
        return nil, fmt.Errorf("get order view: %w", err)
    }
    return view, nil
}
```

### Application Handlers Should Stay Thin

Read the CancelOrder handler again. Strip comments and error-wrapping and you have four lines: check idempotency, load, delegate, save. That is the target shape. A good rule of thumb: if an application handler has `if customer.IsPremium() && order.Total().Amount > 10000` logic, that check belongs inside the domain - probably on the aggregate or a domain service. The application layer orchestrates. It never decides.

Things that legitimately belong in application handlers:

- Idempotency / request deduplication
- Transaction boundary management (begin / commit / rollback)
- Calling multiple repositories to hydrate inputs for the domain
- Publishing domain events through the outbox
- Translating input DTOs into domain value objects
- Authorization callouts to an external policy engine (the *decision* to check is infrastructure. The *rule being checked* is domain, but who-can-do-what usually sits outside the bounded context)

Things that do NOT belong:

- Validating business invariants (`if qty > maxQty` belongs in `NewQuantity`)
- Calculating totals, discounts, taxes (domain service)
- Deciding whether a transition is legal (aggregate method)
- Building SQL queries directly (infrastructure)

If a handler grows past ~60 lines of real logic, split it or push behavior down into the domain. Fat application services are the number-one symptom of DDD decay.

---

### Junior → FAANG: Command Handlers as Readable Use Case Scripts

When you look at a command handler for the first time, try to read it as a sentence: "Load the order, cancel it, save it." If you cannot summarize the handler in one sentence, the handler is doing too much. This is the litmus test that separates application-layer code from domain logic.

A common first-job mistake is putting authorization logic in the handler: `if cmd.RequestedBy != "admin" && order.CustomerID != cmd.UserID { return ErrForbidden }`. This feels natural because "only the customer or an admin can cancel" sounds like a business rule. But authorization is cross-cutting: it applies to many commands, it changes with product decisions, and it involves external policy systems. The right place for it is either a middleware on the HTTP layer or a dedicated authorization service callout, not inside the handler.

Another first-job mistake is constructing value objects inside the handler: `qty, err := domain.NewQuantity(cmd.Quantity)`. If the handler is doing this for every command field, it has become a validation layer, which belongs at the input boundary (HTTP handler or gRPC server) or inside the domain factory functions. The application handler should receive a command DTO that is structurally valid (fields are present and typed correctly) and trust the domain to enforce semantic validity (quantity must be positive and within range).

For interview prep: practice explaining CQRS without jargon. "Commands change state and return nothing meaningful except success or failure. Queries read state and return data without changing anything. Separating them means read paths can be optimized independently of write paths." This one-paragraph explanation, paired with the code examples in this section, is the entry-level interview answer. The follow-up question will be about eventual consistency on the read side.

### Senior @ FAANG: Application Layer Design as Organizational API

At the staff level, the application layer's command and query types are not just code: they are the API contract between the transport layer and the domain. Every new transport (REST, gRPC, CLI, message consumer) that gets added should be able to satisfy all use cases by calling command and query handlers. If adding a new transport requires touching the application layer, the layer is not transport-agnostic enough.

**Idempotency as a platform primitive.** The `IdempotencyStore` interface shown in this section is a single-service solution. At platform scale, idempotency is a cross-cutting concern that deserves a shared implementation: a distributed store (Redis with TTL, or a shared Postgres table with partition-by-service) that multiple services use with a consistent interface. A Staff engineer designs this once and provides it as a platform library, so each service's application layer can use it without implementing its own. The tricky part is key namespacing: two services must not collide on the same request ID. A composite key `{service-name}:{request-id}` is the standard solution.

**Transaction boundary ownership.** The question of where to open and close database transactions is subtle in a DDD application. The application handler owns the transaction: it begins before loading the aggregate, commits after saving. But the handler should not import `database/sql` to manage transactions. The clean solution is a `UnitOfWork` interface or a transactional repository pattern where the repository knows to wrap its operations in the ambient transaction. Designing this interface so it remains testable (the fake repository works without a real transaction) while providing real transactional guarantees in production is a Staff-level design problem. The common implementation: a `TransactionManager` interface in the application layer, implemented by a Postgres-aware struct in infrastructure, that wraps a handler invocation in a transaction.

**CQRS read model governance.** As the platform matures, read models multiply: one for list pages, one for detail pages, one for admin dashboards, one for mobile clients. Without governance, each read model is implemented ad-hoc by the team that needed it, leading to duplicated projection logic, inconsistent pagination approaches, and read models that embed business logic. A Staff engineer establishes a read model registry: each read model is documented with its purpose, update mechanism (synchronous from the write path, or event-driven projection), freshness guarantee, and owner. Freshness guarantees matter for product decisions: a listing page that is 500ms stale is acceptable, a payment confirmation that is 5 seconds stale is a customer complaint.

**The thin application layer invariant.** The 60-line rule mentioned earlier is a heuristic, not a law. The real invariant is that application handlers contain no business logic. A handler can grow to 150 lines if all of that length is orchestration: idempotency check, load three aggregates, translate DTOs, delegate to a domain service, persist all three, publish events through the outbox. A handler can violate the invariant at 30 lines if one of those lines is `if order.TotalAmount() > 10000 && customer.IsPremium()`. The review signal is not line count: it is "does this line represent a business rule or an orchestration step?"

---
