## 52B.5 Aggregates and Aggregate Roots

### What Aggregates Are

An **Aggregate** is a cluster of domain objects (entities and value objects) that are treated as a single unit for data changes and consistency enforcement. The aggregate defines a **consistency boundary**: all invariants that span multiple objects within the aggregate are enforced by the aggregate.

An **Aggregate Root** is the single entity in the aggregate that is the only entry point from outside. External code can only hold references to the aggregate root - never to the internal objects.

Consider an Order aggregate:

```
┌───────────────────────────────────────────────────────┐
│  Order Aggregate                                      │
│                                                       │
│  ┌────────────────────────────────────────────────┐   │
│  │  Order (Aggregate Root)                        │   │
│  │  - id: OrderID                                 │   │
│  │  - status: OrderStatus                         │   │
│  │  - shippingAddress: ShippingAddress (VO)       │   │
│  │  - totalAmount: Money (VO)                     │   │
│  └────────────────────────────────────────────────┘   │
│            │ 1                                        │
│            │ contains                                 │
│            │ *                                        │
│  ┌─────────────────────────────────────────────────┐  │
│  │  OrderLine (Entity within aggregate)            │  │
│  │  - id: OrderLineID                              │  │
│  │  - productSKU: ProductSKU (VO)                  │  │
│  │  - quantity: Quantity (VO)                      │  │
│  │  - unitPrice: Money (VO)                        │  │
│  └─────────────────────────────────────────────────┘  │
│                                                       │
└───────────────────────────────────────────────────────┘
```

### The Rules of Aggregates

1. **Only the root is accessible from outside the aggregate.** External objects can hold a reference to `Order`, but never directly to `OrderLine`. To add an item to an order, you call `order.AddLine(...)` - you do not manipulate the lines slice directly.

2. **The aggregate root enforces all invariants.** If there is a rule that says "an order can have at most 50 lines", that check lives in `Order.AddLine()`.

3. **Aggregates are loaded and saved atomically.** When you save an order, you save the order and all its lines in a single transaction. You never save an `OrderLine` in isolation.

4. **Cross-aggregate references use IDs only.** The `Order` aggregate does not contain an `Inventory` entity. It contains a `ProductSKU` value object that is the identifier of a product in the Inventory context.

### Implementing the Order Aggregate

An aggregate is a cluster of domain objects treated as a single unit for consistency. The aggregate root is the only entry point for mutations, ensuring all invariants are enforced before changes are persisted. The `Order` aggregate below enforces business rules (minimum line items, stock availability) inside its methods rather than in application services.

```go
// domain/order/order_line.go

package order

import (
    "errors"
    "fmt"
)

// OrderLineID is the identity of an order line within the order aggregate.
// It is only meaningful within the context of its parent order.
type OrderLineID string

// OrderLine represents a single product and quantity within an order.
// It is an entity within the Order aggregate.
type OrderLine struct {
    id        OrderLineID
    productSKU ProductSKU
    productName string
    quantity  Quantity
    unitPrice Money
}

// NewOrderLine creates a new order line.
func NewOrderLine(
    id OrderLineID,
    sku ProductSKU,
    name string,
    qty Quantity,
    price Money,
) (OrderLine, error) {
    if id == "" {
        return OrderLine{}, errors.New("order line ID is required")
    }
    if sku == "" {
        return OrderLine{}, errors.New("product SKU is required")
    }
    if qty.Value() <= 0 {
        return OrderLine{}, errors.New("quantity must be positive")
    }
    if price.IsZero() || price.Amount < 0 {
        return OrderLine{}, errors.New("unit price must be positive")
    }
    return OrderLine{
        id:          id,
        productSKU:  sku,
        productName: name,
        quantity:    qty,
        unitPrice:   price,
    }, nil
}

func (l OrderLine) ID() OrderLineID    { return l.id }
func (l OrderLine) ProductSKU() ProductSKU { return l.productSKU }
func (l OrderLine) ProductName() string { return l.productName }
func (l OrderLine) Quantity() Quantity  { return l.quantity }
func (l OrderLine) UnitPrice() Money    { return l.unitPrice }

// Subtotal returns the total price for this order line.
func (l OrderLine) Subtotal() Money {
    return l.unitPrice.Multiply(int64(l.quantity.Value()))
}

// Quantity value object
type Quantity struct {
    value int
}

func NewQuantity(v int) (Quantity, error) {
    if v <= 0 {
        return Quantity{}, fmt.Errorf("quantity must be positive, got %d", v)
    }
    if v > 9999 {
        return Quantity{}, fmt.Errorf("quantity cannot exceed 9999, got %d", v)
    }
    return Quantity{value: v}, nil
}

func (q Quantity) Value() int              { return q.value }
func (q Quantity) Equals(other Quantity) bool { return q.value == other.value }
```

Now let's add the `AddLine` and `RemoveLine` methods to the `Order` aggregate root:

```go
// Add these methods to the Order struct in order.go

const maxOrderLines = 50

var (
    ErrDuplicateOrderLine = errors.New("product is already in the order; update quantity instead")
    ErrOrderLineTooMany   = errors.New("order cannot have more than 50 lines")
    ErrOrderLineNotFound  = errors.New("order line not found")
    ErrOrderNotDraft      = errors.New("order lines can only be modified when in draft status")
)

// AddLine adds a product to the order.
// Invariant: cannot add the same product twice.
// Invariant: maximum 50 lines per order.
// Invariant: can only add lines while in Draft status.
func (o *Order) AddLine(line OrderLine) error {
    if o.status != OrderStatusDraft {
        return ErrOrderNotDraft
    }
    if len(o.lines) >= maxOrderLines {
        return ErrOrderLineTooMany
    }
    for _, existing := range o.lines {
        if existing.ProductSKU() == line.ProductSKU() {
            return ErrDuplicateOrderLine
        }
    }
    o.lines = append(o.lines, line)
    return nil
}

// RemoveLine removes a product from the order.
func (o *Order) RemoveLine(lineID OrderLineID) error {
    if o.status != OrderStatusDraft {
        return ErrOrderNotDraft
    }
    for i, line := range o.lines {
        if line.ID() == lineID {
            o.lines = append(o.lines[:i], o.lines[i+1:]...)
            return nil
        }
    }
    return ErrOrderLineNotFound
}
```

### Optimistic Concurrency with Version Numbers

In a distributed system, two requests might try to modify the same aggregate concurrently. Without concurrency control, you get lost updates. The aggregate tracks a `version` number that is incremented on every save. The repository uses this for optimistic locking:

```go
// When loading from the DB, the version is stored
// When saving, we check that the version hasn't changed

// In PostgreSQL:
// UPDATE orders SET status = $1, version = version + 1
// WHERE id = $2 AND version = $3
// If 0 rows affected, someone else updated it first - return a conflict error

var ErrOptimisticConcurrencyConflict = errors.New("order was modified by another process")
```

### Designing Aggregate Boundaries

Aggregate boundaries are one of the most consequential design decisions in DDD. The guiding principle is: **keep aggregates small.**

An aggregate should be as small as possible while still enforcing all invariants that require transactional consistency. Ask: "Do these two things absolutely need to change together, or can they be eventually consistent?"

- `Order` and `OrderLine`: **same aggregate.** You cannot enforce "total amount is correct" without accessing all lines.
- `Order` and `CustomerProfile`: **different aggregates.** Updating a customer's email does not need to be in the same transaction as updating an order status.
- `Order` and `Inventory`: **different aggregates.** Reserve inventory is a separate operation from placing an order, and eventual consistency (with a domain event) is acceptable.

### Junior → FAANG: Recognizing Aggregate Boundary Mistakes in Code Review

The most visible aggregate design mistake in real codebases is the god aggregate: an `Order` that directly contains `Customer`, `Product`, `Inventory`, and `Shipment` objects, each with their own full state. Loading this aggregate requires joining five or more tables and returning potentially hundreds of rows. The aggregate is never fully in memory in a useful way because modifications to any of its embedded objects require loading everything else.

The recognition pattern: if loading an aggregate requires loading objects that belong to conceptually distinct concerns, the aggregate boundary is wrong. In code review, look for repository implementations that perform more than two or three SQL joins to load a single aggregate. That is almost always a symptom of a bloated aggregate.

A common first-job confusion is between "belongs to" in the English sense and "belongs inside the aggregate" in the DDD sense. An order line belongs to an order. But does a product belong inside the order aggregate? No: the order line holds a `ProductSKU` (a value object that is the product's identity) and the unit price at the time of purchase (a snapshot). The full product record lives in the Inventory or Catalog bounded context and is referenced by ID. Understanding this ID-reference pattern is the practical entry point for cross-aggregate thinking.

For interviews: when asked to design an aggregate, always state your invariants explicitly before drawing the boundary. The boundary should be the smallest cluster that can enforce all of those invariants atomically. Everything that can be eventually consistent should be outside the boundary.

### Senior @ FAANG: Aggregate Boundaries as a Consistency and Scalability Decision

At the senior level, aggregate boundary decisions are performance decisions as much as they are design decisions. The aggregate defines the unit of transactional lock. Every concurrent write to the same aggregate requires either a database-level row lock (pessimistic) or a version check (optimistic). Under high write throughput, oversized aggregates become write bottlenecks.

**Measuring the cost of aggregate size.** In a production system, you can measure aggregate boundary correctness by tracking two metrics: the average number of entities loaded per aggregate read (a proxy for loading cost) and the optimistic concurrency conflict rate (a proxy for write contention). A conflict rate above two percent under normal load is a strong signal to split the aggregate. A loading cost above one hundred entities per read is a strong signal the aggregate is too large regardless of the conflict rate.

**The saga pattern as an alternative to large aggregates.** When two operations need coordination but strict transactional consistency is too costly, the senior-level tool is a saga: a sequence of local transactions, each within a single aggregate's boundary, coordinated by domain events and compensating transactions. The classic example is reserving inventory when an order is placed. Instead of putting inventory inside the order aggregate (so both can be updated atomically), the order aggregate emits `OrderPlaced`, the inventory aggregate handles it and either emits `InventoryReserved` or `InventoryReservationFailed`, and the order aggregate handles those events to transition to `Confirmed` or `Canceled`. This is eventual consistency, implemented explicitly, with compensating logic for the failure path. At the L6 bar, you are expected to design this saga including the failure compensation, not just the happy path.

**Optimistic concurrency implementation depth.** The version number on an aggregate is not just a DDD convention. It is a consistency protocol. The correct implementation: the version is incremented in the database on every successful write (`SET version = version + 1 WHERE id = $1 AND version = $2`). If the `WHERE version = $2` clause matches zero rows, another writer has modified the aggregate concurrently, and the current operation should return a concurrency conflict error to the application service, which can either retry the entire use case (load-modify-save) or surface the conflict to the caller. At scale, the retry strategy matters: naive immediate retry under high load amplifies the problem. Exponential backoff with jitter is the production pattern.

**Aggregate root as a consistency surface for audit and compliance.** One underappreciated property of the aggregate root pattern is that it provides a single surface for audit logging. Every state transition goes through an aggregate root method, which can record a domain event with the full context of the change (who initiated it, what the before and after state was, when it occurred). At FAANG-scale companies that operate in regulated industries (financial services, healthcare, e-commerce in the EU under GDPR), this auditability is not a nice-to-have. It is a compliance requirement. The aggregate's event log is the compliance record. Designing the aggregate and its events correctly from the start is significantly cheaper than retrofitting auditability after the fact.

---
