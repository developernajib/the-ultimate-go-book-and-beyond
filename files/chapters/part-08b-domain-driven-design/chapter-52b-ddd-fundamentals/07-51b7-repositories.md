## 52B.7 Repositories

### The Repository Pattern

A **Repository** is an abstraction that mediates between the domain and the data mapping layers. From the domain's perspective, a repository is a collection of aggregates that can be queried and persisted. The repository hides all database technology from the domain.

Key principles:
- The repository **interface** is defined in the **domain layer**
- The repository **implementation** lives in the **infrastructure layer**
- The domain never imports infrastructure packages

### Repository Interface in Go

The Repository pattern provides a collection-like interface for accessing aggregates, hiding persistence mechanics behind a domain-facing abstraction. The interface and PostgreSQL implementation below allow the domain layer to remain ignorant of SQL while the infrastructure layer handles all mapping between domain types and database rows.

```go
// domain/order/repository.go

package order

import (
    "context"
    "errors"
)

// ErrOrderNotFound is returned when an order cannot be found.
var ErrOrderNotFound = errors.New("order not found")

// OrderRepository defines the contract for persisting and retrieving orders.
// This interface is owned by the domain. Infrastructure implements it.
type OrderRepository interface {
    // Save persists an order (insert or update).
    // Implementations must handle optimistic concurrency using the version field.
    Save(ctx context.Context, order *Order) error

    // FindByID retrieves an order by its identity.
    // Returns ErrOrderNotFound if no such order exists.
    FindByID(ctx context.Context, id OrderID) (*Order, error)

    // FindByCustomer retrieves all orders for a given customer.
    FindByCustomer(ctx context.Context, customerID CustomerID) ([]*Order, error)

    // FindPendingOlderThan retrieves pending orders older than a duration,
    // used by the background job that auto-cancels stale orders.
    FindPendingOlderThan(ctx context.Context, ageMinutes int) ([]*Order, error)

    // Delete removes an order. Used only for data compliance (GDPR).
    // Requires explicit approval - most operations should use Cancel instead.
    Delete(ctx context.Context, id OrderID) error
}
```

### In-Memory Repository for Testing

The in-memory implementation is more than a testing convenience - it demonstrates how DDD enables testing domain logic entirely without infrastructure:

```go
// infrastructure/order/memory_repository.go

package orderinfra

import (
    "context"
    "sync"
    "time"

    "github.com/yourorg/ecommerce/order-service/internal/domain/order"
)

// MemoryOrderRepository is an in-memory implementation of OrderRepository.
// Used in tests and potentially in development environments.
type MemoryOrderRepository struct {
    mu     sync.RWMutex
    orders map[order.OrderID]*order.Order
}

// NewMemoryOrderRepository creates a new in-memory order repository.
func NewMemoryOrderRepository() *MemoryOrderRepository {
    return &MemoryOrderRepository{
        orders: make(map[order.OrderID]*order.Order),
    }
}

func (r *MemoryOrderRepository) Save(ctx context.Context, o *order.Order) error {
    r.mu.Lock()
    defer r.mu.Unlock()
    // In a real implementation, check version for optimistic concurrency
    r.orders[o.ID()] = o
    return nil
}

func (r *MemoryOrderRepository) FindByID(ctx context.Context, id order.OrderID) (*order.Order, error) {
    r.mu.RLock()
    defer r.mu.RUnlock()
    o, ok := r.orders[id]
    if !ok {
        return nil, order.ErrOrderNotFound
    }
    return o, nil
}

func (r *MemoryOrderRepository) FindByCustomer(ctx context.Context, customerID order.CustomerID) ([]*order.Order, error) {
    r.mu.RLock()
    defer r.mu.RUnlock()
    var results []*order.Order
    for _, o := range r.orders {
        if o.CustomerID() == customerID {
            results = append(results, o)
        }
    }
    return results, nil
}

func (r *MemoryOrderRepository) FindPendingOlderThan(ctx context.Context, ageMinutes int) ([]*order.Order, error) {
    r.mu.RLock()
    defer r.mu.RUnlock()
    threshold := time.Now().Add(-time.Duration(ageMinutes) * time.Minute)
    var results []*order.Order
    for _, o := range r.orders {
        if o.Status() == order.OrderStatusPending && o.PlacedAt().Before(threshold) {
            results = append(results, o)
        }
    }
    return results, nil
}

func (r *MemoryOrderRepository) Delete(ctx context.Context, id order.OrderID) error {
    r.mu.Lock()
    defer r.mu.Unlock()
    if _, ok := r.orders[id]; !ok {
        return order.ErrOrderNotFound
    }
    delete(r.orders, id)
    return nil
}
```

### PostgreSQL Repository Implementation

The production implementation maps domain types to database rows and back. This PostgreSQL repository uses optimistic concurrency control via the `version` column, publishes domain events after a successful commit, and uses DTOs to keep SQL concerns out of the domain layer.

```go
// infrastructure/order/postgres_repository.go

package orderinfra

import (
    "context"
    "database/sql"
    "encoding/json"
    "errors"
    "fmt"
    "time"

    "github.com/lib/pq"
    "github.com/yourorg/ecommerce/order-service/internal/domain/order"
)

// PostgresOrderRepository implements OrderRepository using PostgreSQL.
type PostgresOrderRepository struct {
    db       *sql.DB
    eventBus *order.EventBus
}

// NewPostgresOrderRepository creates a new PostgreSQL-backed order repository.
func NewPostgresOrderRepository(db *sql.DB, eventBus *order.EventBus) *PostgresOrderRepository {
    return &PostgresOrderRepository{db: db, eventBus: eventBus}
}

// Save persists an order with optimistic concurrency control.
func (r *PostgresOrderRepository) Save(ctx context.Context, o *order.Order) error {
    tx, err := r.db.BeginTx(ctx, nil)
    if err != nil {
        return fmt.Errorf("begin transaction: %w", err)
    }
    defer tx.Rollback()

    // Check if this is an insert or update
    var exists bool
    err = tx.QueryRowContext(ctx,
        "SELECT EXISTS(SELECT 1 FROM orders WHERE id = $1)", string(o.ID()),
    ).Scan(&exists)
    if err != nil {
        return fmt.Errorf("check order existence: %w", err)
    }

    if !exists {
        err = r.insert(ctx, tx, o)
    } else {
        err = r.update(ctx, tx, o)
    }
    if err != nil {
        return err
    }

    // Save order lines
    if err := r.saveLines(ctx, tx, o); err != nil {
        return err
    }

    if err := tx.Commit(); err != nil {
        return fmt.Errorf("commit transaction: %w", err)
    }

    // Publish domain events AFTER successful commit
    // Events are only published if the persistence succeeded
    events := o.DomainEvents()
    if err := r.eventBus.PublishAll(ctx, events); err != nil {
        // Log but don't fail - the data is saved - event delivery is best-effort
        // In production, use an outbox pattern for guaranteed delivery
        return fmt.Errorf("publish domain events: %w", err)
    }

    return nil
}

func (r *PostgresOrderRepository) insert(ctx context.Context, tx *sql.Tx, o *order.Order) error {
    shippingJSON, err := json.Marshal(shippingAddressToDTO(o.ShippingAddress()))
    if err != nil {
        return fmt.Errorf("marshal shipping address: %w", err)
    }

    _, err = tx.ExecContext(ctx, `
        INSERT INTO orders (id, customer_id, status, shipping_address, placed_at, version, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `,
        string(o.ID()),
        string(o.CustomerID()),
        string(o.Status()),
        shippingJSON,
        o.PlacedAt(),
        o.Version(),
        time.Now(),
        time.Now(),
    )
    if err != nil {
        return fmt.Errorf("insert order: %w", err)
    }
    return nil
}

func (r *PostgresOrderRepository) update(ctx context.Context, tx *sql.Tx, o *order.Order) error {
    shippingJSON, err := json.Marshal(shippingAddressToDTO(o.ShippingAddress()))
    if err != nil {
        return fmt.Errorf("marshal shipping address: %w", err)
    }

    result, err := tx.ExecContext(ctx, `
        UPDATE orders
        SET status = $1, shipping_address = $2, placed_at = $3,
            version = version + 1, updated_at = $4
        WHERE id = $5 AND version = $6
    `,
        string(o.Status()),
        shippingJSON,
        o.PlacedAt(),
        time.Now(),
        string(o.ID()),
        o.Version(),
    )
    if err != nil {
        return fmt.Errorf("update order: %w", err)
    }
    rows, err := result.RowsAffected()
    if err != nil {
        return fmt.Errorf("get rows affected: %w", err)
    }
    if rows == 0 {
        return order.ErrOptimisticConcurrencyConflict
    }
    return nil
}

func (r *PostgresOrderRepository) saveLines(ctx context.Context, tx *sql.Tx, o *order.Order) error {
    // Delete existing lines and reinsert - simple but correct
    _, err := tx.ExecContext(ctx, "DELETE FROM order_lines WHERE order_id = $1", string(o.ID()))
    if err != nil {
        return fmt.Errorf("delete order lines: %w", err)
    }

    for _, line := range o.Lines() {
        _, err := tx.ExecContext(ctx, `
            INSERT INTO order_lines (id, order_id, product_sku, product_name, quantity, unit_price_amount, unit_price_currency)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
        `,
            string(line.ID()),
            string(o.ID()),
            string(line.ProductSKU()),
            line.ProductName(),
            line.Quantity().Value(),
            line.UnitPrice().Amount,
            line.UnitPrice().Currency,
        )
        if err != nil {
            return fmt.Errorf("insert order line: %w", err)
        }
    }
    return nil
}

// FindByID retrieves an order and all its lines from PostgreSQL.
func (r *PostgresOrderRepository) FindByID(ctx context.Context, id order.OrderID) (*order.Order, error) {
    row := r.db.QueryRowContext(ctx, `
        SELECT id, customer_id, status, shipping_address, placed_at, version
        FROM orders WHERE id = $1
    `, string(id))

    dto := &orderDTO{}
    var shippingJSON []byte
    var placedAt sql.NullTime

    err := row.Scan(&dto.ID, &dto.CustomerID, &dto.Status, &shippingJSON, &placedAt, &dto.Version)
    if err != nil {
        if errors.Is(err, sql.ErrNoRows) {
            return nil, order.ErrOrderNotFound
        }
        return nil, fmt.Errorf("query order: %w", err)
    }

    if err := json.Unmarshal(shippingJSON, &dto.ShippingAddress); err != nil {
        return nil, fmt.Errorf("unmarshal shipping address: %w", err)
    }

    lines, err := r.findLines(ctx, id)
    if err != nil {
        return nil, err
    }
    dto.Lines = lines
    if placedAt.Valid {
        dto.PlacedAt = placedAt.Time
    }

    return dtoToOrder(dto)
}

func (r *PostgresOrderRepository) findLines(ctx context.Context, orderID order.OrderID) ([]orderLineDTO, error) {
    rows, err := r.db.QueryContext(ctx, `
        SELECT id, product_sku, product_name, quantity, unit_price_amount, unit_price_currency
        FROM order_lines WHERE order_id = $1
    `, string(orderID))
    if err != nil {
        return nil, fmt.Errorf("query order lines: %w", err)
    }
    defer rows.Close()

    var lines []orderLineDTO
    for rows.Next() {
        var line orderLineDTO
        if err := rows.Scan(&line.ID, &line.ProductSKU, &line.ProductName,
            &line.Quantity, &line.UnitPriceAmount, &line.UnitPriceCurrency); err != nil {
            return nil, fmt.Errorf("scan order line: %w", err)
        }
        lines = append(lines, line)
    }
    return lines, rows.Err()
}

func (r *PostgresOrderRepository) FindByCustomer(ctx context.Context, customerID order.CustomerID) ([]*order.Order, error) {
    rows, err := r.db.QueryContext(ctx, `
        SELECT id FROM orders WHERE customer_id = $1 ORDER BY created_at DESC
    `, string(customerID))
    if err != nil {
        return nil, fmt.Errorf("query orders by customer: %w", err)
    }
    defer rows.Close()

    var orders []*order.Order
    for rows.Next() {
        var id string
        if err := rows.Scan(&id); err != nil {
            return nil, fmt.Errorf("scan order id: %w", err)
        }
        o, err := r.FindByID(ctx, order.OrderID(id))
        if err != nil {
            return nil, err
        }
        orders = append(orders, o)
    }
    return orders, rows.Err()
}

func (r *PostgresOrderRepository) FindPendingOlderThan(ctx context.Context, ageMinutes int) ([]*order.Order, error) {
    threshold := time.Now().Add(-time.Duration(ageMinutes) * time.Minute)
    rows, err := r.db.QueryContext(ctx,
        "SELECT id FROM orders WHERE status = 'pending' AND placed_at < $1",
        threshold,
    )
    if err != nil {
        return nil, fmt.Errorf("query stale pending orders: %w", err)
    }
    defer rows.Close()

    var orders []*order.Order
    for rows.Next() {
        var id string
        if err := rows.Scan(&id); err != nil {
            return nil, fmt.Errorf("scan order id: %w", err)
        }
        o, err := r.FindByID(ctx, order.OrderID(id))
        if err != nil {
            return nil, err
        }
        orders = append(orders, o)
    }
    return orders, rows.Err()
}

func (r *PostgresOrderRepository) Delete(ctx context.Context, id order.OrderID) error {
    result, err := r.db.ExecContext(ctx, "DELETE FROM orders WHERE id = $1", string(id))
    if err != nil {
        return fmt.Errorf("delete order: %w", err)
    }
    rows, _ := result.RowsAffected()
    if rows == 0 {
        return order.ErrOrderNotFound
    }
    return nil
}

// DTO types for database mapping
type orderDTO struct {
    ID              string
    CustomerID      string
    Status          string
    ShippingAddress shippingAddressDTO
    Lines           []orderLineDTO
    PlacedAt        time.Time
    Version         int
}

type shippingAddressDTO struct {
    RecipientName string `json:"recipient_name"`
    Street        string `json:"street"`
    City          string `json:"city"`
    StateCode     string `json:"state_code"`
    PostalCode    string `json:"postal_code"`
    CountryCode   string `json:"country_code"`
}

type orderLineDTO struct {
    ID                string
    ProductSKU        string
    ProductName       string
    Quantity          int
    UnitPriceAmount   int64
    UnitPriceCurrency string
}

func shippingAddressToDTO(a order.ShippingAddress) shippingAddressDTO {
    return shippingAddressDTO{
        RecipientName: a.RecipientName(),
        Street:        a.Street(),
        City:          a.City(),
        StateCode:     a.StateCode(),
        PostalCode:    a.PostalCode(),
        CountryCode:   a.CountryCode(),
    }
}

// dtoToOrder reconstructs an Order aggregate from its database representation.
// This is the reconstitution factory - it bypasses normal construction
// to restore persisted state.
func dtoToOrder(dto *orderDTO) (*order.Order, error) {
    shipping, err := order.NewShippingAddress(
        dto.ShippingAddress.RecipientName,
        dto.ShippingAddress.Street,
        dto.ShippingAddress.City,
        dto.ShippingAddress.StateCode,
        dto.ShippingAddress.PostalCode,
        dto.ShippingAddress.CountryCode,
    )
    if err != nil {
        return nil, fmt.Errorf("reconstruct shipping address: %w", err)
    }

    var lines []order.OrderLine
    for _, lineDTO := range dto.Lines {
        qty, err := order.NewQuantity(lineDTO.Quantity)
        if err != nil {
            return nil, fmt.Errorf("reconstruct quantity: %w", err)
        }
        price := order.Money{Amount: lineDTO.UnitPriceAmount, Currency: lineDTO.UnitPriceCurrency}
        line, err := order.NewOrderLine(
            order.OrderLineID(lineDTO.ID),
            order.ProductSKU(lineDTO.ProductSKU),
            lineDTO.ProductName,
            qty,
            price,
        )
        if err != nil {
            return nil, fmt.Errorf("reconstruct order line: %w", err)
        }
        lines = append(lines, line)
    }

    return order.Reconstitute(
        order.OrderID(dto.ID),
        order.CustomerID(dto.CustomerID),
        order.OrderStatus(dto.Status),
        shipping,
        lines,
        dto.PlacedAt,
        dto.Version,
    ), nil
}
```

The `Reconstitute` function below is an exported factory in the domain package that bypasses normal constructors to restore persisted state. It exists because the repository needs to rebuild aggregates from database rows without triggering domain event recording or validation that applies only to new operations:

```go
// domain/order/reconstitute.go

package order

import "time"

// Reconstitute restores an Order from its persisted state.
// This bypasses the normal NewOrder factory and state machine,
// used exclusively by the repository layer.
func Reconstitute(
    id OrderID,
    customerID CustomerID,
    status OrderStatus,
    shipping ShippingAddress,
    lines []OrderLine,
    placedAt time.Time,
    version int,
) *Order {
    return &Order{
        id:              id,
        customerID:      customerID,
        status:          status,
        shippingAddress: shipping,
        lines:           lines,
        placedAt:        placedAt,
        version:         version,
        events:          nil,
    }
}
```

### Junior → FAANG: Using the Repository Interface Correctly from Day One

The biggest repository mistake junior engineers make is adding query methods to the interface that serve the read side of the application. The repository interface for an aggregate should only expose operations that are needed to load and save the aggregate for write operations. Adding `FindAllOrdersByStatusAndDateRange(...)` to `OrderRepository` is a code smell: that query is for a list view, not for a domain operation. Read queries belong in a separate query service or read model, not in the aggregate repository.

A related mistake is reaching for the repository inside a domain method: `Order.Cancel()` should never call a repository. Domain methods operate on the data already loaded into the aggregate. If canceling an order requires checking another aggregate (e.g., verifying a refund policy from a separate policy store), that coordination belongs in the application service, which loads both, not in the domain method.

The in-memory repository is not just a testing convenience. It is the first implementation you should write, before the database implementation. If the in-memory implementation is awkward to write, the interface is wrong. If the in-memory implementation is simple and the tests using it are readable, the interface is right.

For interviews: when asked how you test domain logic without a database, the answer is straightforward: implement the repository interface in-memory, inject it into the application service, and run the full use case test without any infrastructure. This also demonstrates that the Dependency Inversion Principle is applied correctly, because if the domain imported database packages you could not swap the implementation.

### Senior @ FAANG: Repository Design for Performance, Scalability, and Long-Term Maintainability

The repository pattern hides persistence, but the persistence choice still affects the interface. At the senior level, the tension is between a clean domain interface and the practical query capabilities of the underlying store.

**Pagination and cursor design.** A repository method that returns all orders for a customer (`FindByCustomer(ctx, customerID) ([]*Order, error)`) is correct for small datasets and incorrect at scale. At FAANG scale, that method returns potentially millions of rows. The production interface uses cursor-based pagination: `FindByCustomer(ctx, customerID, after Cursor, limit int) (Page[*Order], error)`. The `Cursor` type is an opaque value object that encodes the position in the result set without exposing database internals (no raw SQL offsets, no raw primary key values visible to callers). Designing this interface from the start avoids a breaking change later.

**CQRS separation at the repository boundary.** The most important architectural decision at scale is separating the write model repository (which loads full aggregates with all their invariant-enforcing behavior) from the read model query service (which executes optimized projections directly against a read-optimized store). The write repository is slow by design: it loads the full aggregate, all its child entities, and reconstructs the domain model. The read query service is fast by design: it issues a single SQL query that returns exactly the fields needed for the view. At companies like Shopify and Uber, the write and read paths are served by different infrastructure: the write path uses a strongly consistent relational store, and the read path uses a denormalized read replica or a secondary store (Elasticsearch, Redis) that is updated by domain event handlers. Senior engineers design the interface boundary between these two paths explicitly, ensuring that read models never write through the aggregate (which would bypass domain invariants) and that write models never use read model projections (which would bypass consistency guarantees).

**Transaction scope and the Unit of Work pattern.** The repository's `Save` method hides a transaction. But what happens when a single use case needs to save two aggregates atomically? The naive answer is to pass a transaction handle into both `Save` calls. The DDD-correct answer is: if two aggregates must be saved atomically, you have drawn the aggregate boundary incorrectly and they should be one aggregate. If they genuinely are separate aggregates with separate consistency requirements, use the Outbox pattern to coordinate them eventually. If you must violate this for pragmatic reasons (a legacy system or a transaction that spans two tables in the same database), use a Unit of Work interface that the application service controls and that the repositories participate in, without the repositories knowing about each other.

**Contract testing the repository.** The in-memory and database implementations of a repository interface should pass the same test suite. This is the repository contract test pattern: a `testRepository(t, repo OrderRepository)` function that exercises every interface method against both implementations. Contract tests catch drift: if the PostgreSQL implementation handles a `FindByCustomer` call differently from the in-memory implementation (different sort order, different nil handling), the contract test surfaces it. At the L6 bar, proposing in-memory fakes without contract tests that verify equivalence is a half-answer. The full answer includes both.

---
