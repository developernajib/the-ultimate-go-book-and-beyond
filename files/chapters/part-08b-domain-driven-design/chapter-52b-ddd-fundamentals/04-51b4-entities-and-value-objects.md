## 52B.4 Entities and Value Objects

These are the fundamental building blocks of tactical DDD. Understanding the distinction is critical.

### Entities: Identity Through Time

An **Entity** is an object defined by its identity, not by its attributes. An Order is an Order regardless of what items are in it, what its current status is, or when it was placed. The identity is stable, but the attributes change.

Key characteristics of entities:

1. **Unique identity**: Each entity has an identifier that distinguishes it from all other entities of the same type
2. **Mutable**: Entities change state over their lifecycle
3. **Lifecycle**: Entities are created, go through state changes, and may be deleted (or archived)
4. **Equality by identity**: Two entities are equal if and only if they have the same identity

In Go:

```go
// domain/order/order.go

package order

import (
    "errors"
    "time"
)

// OrderID is a strongly typed identifier - avoids passing a plain string
// where an OrderID is expected
type OrderID string

// OrderStatus represents the lifecycle state of an order
type OrderStatus string

const (
    OrderStatusDraft     OrderStatus = "draft"
    OrderStatusPending   OrderStatus = "pending"
    OrderStatusConfirmed OrderStatus = "confirmed"
    OrderStatusFulfilled OrderStatus = "fulfilled"
    OrderStatusCanceled OrderStatus = "canceled"
)

// Domain errors - expressed in the ubiquitous language
var (
    ErrOrderNotPending          = errors.New("order must be in pending status for this operation")
    ErrOrderNotConfirmed        = errors.New("order must be confirmed before fulfillment")
    ErrCancellationWindowExpired = errors.New("order can only be canceled within 30 minutes of placement")
    ErrOrderAlreadyCanceled    = errors.New("order has already been canceled")
    ErrEmptyOrder               = errors.New("order must contain at least one order line")
)

// Order is the aggregate root of the order aggregate.
// It is an Entity: its identity (id) is stable, its attributes change.
type Order struct {
    id         OrderID
    customerID CustomerID
    lines      []OrderLine
    status     OrderStatus
    shippingAddress ShippingAddress
    placedAt   time.Time
    version    int
    events     []DomainEvent
}

// NewOrder creates a new order in draft state.
// Factory function enforces invariants at creation time.
func NewOrder(id OrderID, customerID CustomerID, shipping ShippingAddress) (*Order, error) {
    if id == "" {
        return nil, errors.New("order ID cannot be empty")
    }
    if customerID == "" {
        return nil, errors.New("customer ID cannot be empty")
    }
    return &Order{
        id:              id,
        customerID:      customerID,
        status:          OrderStatusDraft,
        shippingAddress: shipping,
        lines:           []OrderLine{},
    }, nil
}

// ID returns the order's identity. Exported getter for immutable identity.
func (o *Order) ID() OrderID { return o.id }

// CustomerID returns the identity of the customer who placed the order.
func (o *Order) CustomerID() CustomerID { return o.customerID }

// Status returns the current order status.
func (o *Order) Status() OrderStatus { return o.status }

// Lines returns a copy of the order lines (defensive copy).
func (o *Order) Lines() []OrderLine {
    lines := make([]OrderLine, len(o.lines))
    copy(lines, o.lines)
    return lines
}

// Version returns the current version for optimistic concurrency.
func (o *Order) Version() int { return o.version }

// PlacedAt returns when the order was placed.
func (o *Order) PlacedAt() time.Time { return o.placedAt }

// Equality for entities is by identity only
func (o *Order) Equals(other *Order) bool {
    if other == nil {
        return false
    }
    return o.id == other.id
}

// Place transitions the order from Draft to Pending.
// Encodes the business rule: an order must have at least one line to be placed.
func (o *Order) Place() error {
    if o.status != OrderStatusDraft {
        return ErrOrderNotPending
    }
    if len(o.lines) == 0 {
        return ErrEmptyOrder
    }
    o.status = OrderStatusPending
    o.placedAt = time.Now()
    o.recordEvent(OrderPlaced{
        OrderID:    o.id,
        CustomerID: o.customerID,
        PlacedAt:   o.placedAt,
        TotalAmount: o.TotalAmount(),
    })
    return nil
}

// Confirm transitions the order from Pending to Confirmed.
// Called after successful payment processing.
func (o *Order) Confirm() error {
    if o.status != OrderStatusPending {
        return ErrOrderNotPending
    }
    o.status = OrderStatusConfirmed
    o.recordEvent(OrderConfirmed{
        OrderID:     o.id,
        ConfirmedAt: time.Now(),
    })
    return nil
}

// Fulfill transitions the order from Confirmed to Fulfilled.
// Called by the fulfillment team when the order is shipped.
func (o *Order) Fulfill(trackingNumber string) error {
    if o.status != OrderStatusConfirmed {
        return ErrOrderNotConfirmed
    }
    o.status = OrderStatusFulfilled
    o.recordEvent(OrderFulfilled{
        OrderID:       o.id,
        TrackingNumber: trackingNumber,
        FulfilledAt:   time.Now(),
    })
    return nil
}

// Cancel cancels the order. Business rule: only within 30 minutes of placement.
func (o *Order) Cancel(reason string) error {
    if o.status == OrderStatusCanceled {
        return ErrOrderAlreadyCanceled
    }
    if o.status != OrderStatusPending && o.status != OrderStatusConfirmed {
        return errors.New("order cannot be canceled in current state")
    }
    if o.status == OrderStatusPending && time.Since(o.placedAt) > 30*time.Minute {
        return ErrCancellationWindowExpired
    }
    o.status = OrderStatusCanceled
    o.recordEvent(OrderCanceled{
        OrderID:     o.id,
        Reason:      reason,
        CanceledAt: time.Now(),
    })
    return nil
}

// TotalAmount returns the sum of all order line amounts.
// Uses MustAdd because all lines within an order share the same currency.
func (o *Order) TotalAmount() Money {
    total := Money{Amount: 0, Currency: "USD"}
    for _, line := range o.lines {
        total = total.MustAdd(line.Subtotal())
    }
    return total
}

// DomainEvents returns uncommitted domain events and clears the internal list.
// Called by the repository after persisting the aggregate.
func (o *Order) DomainEvents() []DomainEvent {
    events := make([]DomainEvent, len(o.events))
    copy(events, o.events)
    o.events = nil
    return events
}

func (o *Order) recordEvent(event DomainEvent) {
    o.events = append(o.events, event)
}
```

### Value Objects: Defined by Attributes

A **Value Object** is an object with no identity. It is defined entirely by its attributes. Two value objects with the same attributes are equal, just like two instances of the number 42 are equal. Value objects are:

1. **Immutable**: Once created, they never change
2. **Equality by value**: Two value objects are equal if all their attributes are equal
3. **Replaceable**: You never mutate a value object. You replace it with a new one
4. **Side-effect-free**: Value object methods return new values and do not modify state

The canonical examples are `Money`, `Address`, `EmailAddress`, `PhoneNumber`, `DateRange`.

```go
// domain/order/value_objects.go

package order

import (
    "errors"
    "fmt"
    "math"
    "regexp"
    "strings"
)

// ============================================================
// Money - a classic value object
// ============================================================

// Money represents a monetary amount in a specific currency.
// It is immutable: all operations return a new Money value.
type Money struct {
    Amount   int64  // stored in minor units (cents) to avoid floating point errors
    Currency string // ISO 4217 currency code
}

var ErrCurrencyMismatch = errors.New("cannot operate on money with different currencies")

// NewMoney creates a Money value from a float amount and currency code.
// Internally stores as integer cents to avoid floating point arithmetic
// errors. The conversion MUST round rather than truncate: 19.99*100 is
// 1998.9999999999998 in float64, so a bare int64() would silently lose a
// cent. Prefer NewMoneyFromCents at system boundaries where you control
// the representation.
func NewMoney(dollars float64, currency string) (Money, error) {
    if currency == "" {
        return Money{}, errors.New("currency cannot be empty")
    }
    currency = strings.ToUpper(currency)
    cents := int64(math.Round(dollars * 100))
    return Money{Amount: cents, Currency: currency}, nil
}

// NewMoneyFromCents constructs Money without any float involvement.
func NewMoneyFromCents(cents int64, currency string) (Money, error) {
    if currency == "" {
        return Money{}, errors.New("currency cannot be empty")
    }
    return Money{Amount: cents, Currency: strings.ToUpper(currency)}, nil
}

// Add returns a new Money that is the sum of m and other.
// Returns an error if currencies differ - mixing currencies is a domain error.
func (m Money) Add(other Money) (Money, error) {
    if m.Currency != other.Currency {
        return Money{}, fmt.Errorf("%w: %s vs %s", ErrCurrencyMismatch, m.Currency, other.Currency)
    }
    return Money{Amount: m.Amount + other.Amount, Currency: m.Currency}, nil
}

// MustAdd is a convenience method that panics on currency mismatch.
// Use only when you have already validated currencies match.
func (m Money) MustAdd(other Money) Money {
    result, err := m.Add(other)
    if err != nil {
        panic(err)
    }
    return result
}

// Subtract returns a new Money that is m minus other.
func (m Money) Subtract(other Money) (Money, error) {
    if m.Currency != other.Currency {
        return Money{}, fmt.Errorf("%w: %s vs %s", ErrCurrencyMismatch, m.Currency, other.Currency)
    }
    return Money{Amount: m.Amount - other.Amount, Currency: m.Currency}, nil
}

// Multiply returns a new Money multiplied by a scalar.
func (m Money) Multiply(factor int64) Money {
    return Money{Amount: m.Amount * factor, Currency: m.Currency}
}

// IsGreaterThan returns true if m is greater than other.
func (m Money) IsGreaterThan(other Money) bool {
    return m.Amount > other.Amount
}

// IsZero returns true if the monetary amount is zero.
func (m Money) IsZero() bool {
    return m.Amount == 0
}

// Equals checks value equality - two Money values are equal if amount and currency match.
func (m Money) Equals(other Money) bool {
    return m.Amount == other.Amount && m.Currency == other.Currency
}

// String returns a human-readable representation.
func (m Money) String() string {
    return fmt.Sprintf("%s %.2f", m.Currency, float64(m.Amount)/100)
}

// ============================================================
// EmailAddress - validated value object
// ============================================================

var emailRegex = regexp.MustCompile(`^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$`)

// EmailAddress is a validated email address value object.
// It is impossible to hold an invalid EmailAddress in the domain.
type EmailAddress struct {
    value string
}

// NewEmailAddress creates an EmailAddress, returning an error if the format is invalid.
func NewEmailAddress(email string) (EmailAddress, error) {
    email = strings.TrimSpace(strings.ToLower(email))
    if !emailRegex.MatchString(email) {
        return EmailAddress{}, fmt.Errorf("invalid email address: %q", email)
    }
    return EmailAddress{value: email}, nil
}

func (e EmailAddress) String() string       { return e.value }
func (e EmailAddress) Equals(other EmailAddress) bool { return e.value == other.value }

// ============================================================
// ShippingAddress - composite value object
// ============================================================

// ShippingAddress is a value object representing a postal address for shipping.
// Note: it has no ID. Two addresses with identical fields are considered equal.
type ShippingAddress struct {
    recipientName string
    street        string
    city          string
    stateCode     string
    postalCode    string
    countryCode   string
}

// NewShippingAddress creates a validated ShippingAddress value object.
func NewShippingAddress(recipient, street, city, state, postal, country string) (ShippingAddress, error) {
    if strings.TrimSpace(recipient) == "" {
        return ShippingAddress{}, errors.New("recipient name is required")
    }
    if strings.TrimSpace(street) == "" {
        return ShippingAddress{}, errors.New("street address is required")
    }
    if strings.TrimSpace(city) == "" {
        return ShippingAddress{}, errors.New("city is required")
    }
    if len(strings.TrimSpace(postal)) < 3 {
        return ShippingAddress{}, errors.New("valid postal code is required")
    }
    if len(strings.TrimSpace(country)) != 2 {
        return ShippingAddress{}, errors.New("country must be a 2-letter ISO code")
    }
    return ShippingAddress{
        recipientName: strings.TrimSpace(recipient),
        street:        strings.TrimSpace(street),
        city:          strings.TrimSpace(city),
        stateCode:     strings.TrimSpace(state),
        postalCode:    strings.TrimSpace(postal),
        countryCode:   strings.ToUpper(strings.TrimSpace(country)),
    }, nil
}

// Getters - no setters because value objects are immutable
func (a ShippingAddress) RecipientName() string { return a.recipientName }
func (a ShippingAddress) Street() string        { return a.street }
func (a ShippingAddress) City() string          { return a.city }
func (a ShippingAddress) StateCode() string     { return a.stateCode }
func (a ShippingAddress) PostalCode() string    { return a.postalCode }
func (a ShippingAddress) CountryCode() string   { return a.countryCode }

// Equals returns true if both addresses have identical values.
func (a ShippingAddress) Equals(other ShippingAddress) bool {
    return a.recipientName == other.recipientName &&
        a.street == other.street &&
        a.city == other.city &&
        a.stateCode == other.stateCode &&
        a.postalCode == other.postalCode &&
        a.countryCode == other.countryCode
}

// WithRecipient returns a new ShippingAddress with the recipient name changed.
// This is how you "mutate" a value object - you replace it.
func (a ShippingAddress) WithRecipient(recipient string) (ShippingAddress, error) {
    return NewShippingAddress(recipient, a.street, a.city, a.stateCode, a.postalCode, a.countryCode)
}
```

### The Key Design Decisions

**Use strong types for IDs.** Instead of `string` or `uuid.UUID`, define domain-specific ID types:

```go
type OrderID     string
type CustomerID  string
type ProductSKU  string

// Now the compiler prevents you from passing a CustomerID where an OrderID is expected
func (o *Order) BelongsTo(customerID CustomerID) bool {
    return o.customerID == customerID
}
```

**Make invalid states unrepresentable.** The best bug prevention is making it impossible to create invalid values. Constructors that return errors enforce this:

```go
// It is impossible to have an Order with an empty customer ID
// because NewOrder validates and returns an error
order, err := NewOrder(id, "", shipping) // returns error
```

**Defensive copies for collections.** When returning slices from entities, return copies to prevent external mutation of the aggregate's internal state:

```go
func (o *Order) Lines() []OrderLine {
    lines := make([]OrderLine, len(o.lines))
    copy(lines, o.lines)
    return lines
}
```

### Junior → FAANG: Getting the Entity vs. Value Object Classification Right

The most common first-job mistake is treating everything as an entity. An address gets an `AddressID`. A phone number gets a `PhoneNumberID`. A price gets a `PriceID`. Each of these attracts its own repository, its own table, and its own lifecycle management, all for objects whose only meaningful question is "what are your attributes?"

The classification test is: "If I replaced this object with another object having exactly the same attributes, would anything break?" If the answer is no, it is a value object. A shipping address with street `123 Main St` is interchangeable with any other shipping address with the same fields. An `Order` with ID `abc-123` is not interchangeable with another order, even if both have the same items and total.

For Go specifically: value objects in Go should use value semantics (non-pointer receivers, returned by value). This means they copy automatically, participate in struct equality with `==` when all fields are comparable, and cannot be mutated through an alias. This is a concrete Go advantage over Java, where you have to consciously implement `equals()` and `hashCode()` for every value type.

The interview question to prepare for: "Where would you put validation: in the type constructor or in the application service?" The DDD answer is: validation of domain invariants belongs in the type constructor. `NewEmailAddress` should reject a malformed email. `NewQuantity` should reject zero or negative values. Application services handle request-shape validation (is the JSON field present) but not domain constraint validation (is the value meaningful in this domain context).

### Senior @ FAANG: Value Object Design for Distributed Systems and Long-Term Evolvability

At scale, the entity/value object distinction has consequences that go beyond code clarity. Value objects are safe to duplicate across services. Entities cannot be duplicated without consistency problems.

**Value object serialization contracts.** A value object is only immutable in memory. When it crosses a service boundary as JSON or Protobuf, it becomes a serialized representation, and that representation is a contract. Senior engineers enforce that value object serialization never exposes internal implementation details. `Money` serializes as `{"amount": 1050, "currency": "USD"}` regardless of whether the internal representation changes. The `MarshalJSON` / `UnmarshalJSON` methods on the value object act as an isolation layer. When the internal representation changes (e.g., switching from `int64` to a decimal library), only those two methods change, and the contract remains stable.

**Typed identifiers as a DDD boundary enforcement tool.** Using `type OrderID string` instead of bare `string` does more than prevent mixing up IDs: it creates a vocabulary that makes invalid cross-boundary calls visible at compile time. If an inventory service's `FindByID` accepts `InventoryItemID` and the order service's `ProductSKU` is a different type even though both are UUIDs internally, the compiler prevents the order service from accidentally calling inventory with its own internal IDs. At the staff level, you should establish a convention for ID types in the shared kernel (typed aliases, always validated at creation, never constructed from raw strings except in infrastructure layer reconstitution).

**Aggregate reconstitution vs. construction.** The distinction between `NewOrder` (a factory that enforces all invariants and records events) and `Reconstitute` (a factory that restores persisted state without triggering event recording) is a design decision with long-term consequences. At the L6/L7 level, you should be able to articulate: (1) why mixing the two is dangerous (you would re-emit domain events on every read from the database), (2) why the reconstitution function must still validate the persisted data (corrupt or migrated rows may violate invariants that were added after the row was written), and (3) how to test the reconstitution path in isolation from the construction path (a dedicated `TestReconstitute` suite that specifically tests edge cases like a `nil` events slice, a zero `PlacedAt`, and an unknown status value from a future migration).

**Value object evolution across database migrations.** Value objects stored as JSON columns (like `ShippingAddress`) require a migration strategy when the value object's structure changes. The senior-level approach is: never remove a JSON field immediately, add the new field and continue writing both old and new formats during a transition period, then remove the old field after verifying that all stored rows have been migrated. This is the same dual-write pattern used for integration events. The Go implementation requires that `UnmarshalJSON` handles both the old and new formats gracefully and that the reconstitution path logs a warning when it encounters the old format, allowing the migration progress to be monitored in production.

---
