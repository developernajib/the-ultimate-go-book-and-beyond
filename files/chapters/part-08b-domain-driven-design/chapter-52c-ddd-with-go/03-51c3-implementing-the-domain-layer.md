## 52C.3 Implementing the Domain Layer

### Domain Error Types

Domain errors are first-class citizens, not afterthoughts. Each sentinel error represents a specific business rule violation or invariant failure. The application and interface layers use `errors.Is()` to match these errors and decide how to respond, so naming and categorization matter.

```go
// internal/domain/order/errors.go

package order

import "errors"

// Sentinel errors for domain-specific failures.
// These are checked with errors.Is() in application and interface layers.
var (
    // Aggregate lifecycle errors
    ErrOrderNotFound             = errors.New("order not found")
    ErrOrderNotDraft             = errors.New("order must be in draft status for this operation")
    ErrOrderNotPending           = errors.New("order must be in pending status for this operation")
    ErrOrderNotConfirmed         = errors.New("order must be confirmed before fulfillment")
    ErrOrderAlreadyCanceled     = errors.New("order has already been canceled")
    ErrOrderAlreadyFulfilled     = errors.New("order has already been fulfilled")

    // Order invariant violations
    ErrEmptyOrder                = errors.New("order must contain at least one order line")
    ErrDuplicateOrderLine        = errors.New("product is already in the order")
    ErrOrderLineTooMany          = errors.New("order cannot exceed 50 order lines")
    ErrOrderLineNotFound         = errors.New("order line not found")

    // Business rule violations
    ErrCancellationWindowExpired = errors.New("order can only be canceled within 30 minutes of placement")

    // Concurrency
    ErrOptimisticConcurrencyConflict = errors.New("order was modified concurrently; please retry")

    // Value object validation
    ErrInvalidEmail              = errors.New("invalid email address format")
    ErrInvalidQuantity           = errors.New("quantity must be between 1 and 9999")
    ErrInvalidMoney              = errors.New("monetary amount cannot be negative")
    ErrCurrencyMismatch          = errors.New("cannot operate on money with different currencies")
    ErrInvalidShippingAddress    = errors.New("shipping address is incomplete or invalid")
)

// DomainError wraps a sentinel error with additional context.
// Use when you need to add context to a domain error without
// losing the ability to check the error type with errors.Is().
type DomainError struct {
    Sentinel error
    Detail   string
}

func (e *DomainError) Error() string {
    if e.Detail != "" {
        return e.Sentinel.Error() + ": " + e.Detail
    }
    return e.Sentinel.Error()
}

func (e *DomainError) Is(target error) bool {
    return e.Sentinel == target
}

func (e *DomainError) Unwrap() error {
    return e.Sentinel
}

// NewDomainError creates a DomainError with detail context.
func NewDomainError(sentinel error, detail string) error {
    return &DomainError{Sentinel: sentinel, Detail: detail}
}
```

### Entity Base Pattern in Go

Go has no inheritance, so there is no "base entity class" in the OOP sense. Instead, use composition with an embedded struct for common entity concerns:

```go
// internal/domain/order/entity.go

package order

import "time"

// AggregateBase provides common aggregate functionality via embedding.
// Aggregates embed this to get domain event recording and versioning.
type AggregateBase struct {
    version int
    events  []DomainEvent
}

// Version returns the current aggregate version for optimistic concurrency.
func (a *AggregateBase) Version() int { return a.version }

// IncrementVersion increments the version. Called by the repository after saving.
func (a *AggregateBase) IncrementVersion() { a.version++ }

// RecordEvent appends a domain event to the uncommitted events list.
func (a *AggregateBase) RecordEvent(event DomainEvent) {
    a.events = append(a.events, event)
}

// DomainEvents returns and clears the uncommitted domain events.
// Called by the repository after a successful save.
func (a *AggregateBase) DomainEvents() []DomainEvent {
    events := make([]DomainEvent, len(a.events))
    copy(events, a.events)
    a.events = nil
    return events
}

// HasUncommittedEvents returns true if there are unpublished domain events.
func (a *AggregateBase) HasUncommittedEvents() bool {
    return len(a.events) > 0
}
```

The `Order` aggregate embeds `AggregateBase`:

```go
type Order struct {
    AggregateBase             // embedded - Order "has" base aggregate behavior
    id              OrderID
    customerID      CustomerID
    lines           []OrderLine
    status          OrderStatus
    shippingAddress ShippingAddress
    placedAt        time.Time
}

// Now Order can call o.RecordEvent() and o.DomainEvents() directly
func (o *Order) Place() error {
    // ...
    o.RecordEvent(OrderPlaced{
        OrderID:    o.id,
        CustomerID: o.customerID,
        PlacedAt:   o.placedAt,
    })
    return nil
}
```

### Value Object Patterns with Functional Options

For complex value objects, functional options provide clean construction:

```go
// internal/domain/order/money.go

package order

import (
    "errors"
    "fmt"
)

// MoneyOption is a functional option for Money construction.
type MoneyOption func(*moneyConfig)

type moneyConfig struct {
    allowNegative bool
    maxAmount     int64
}

// AllowNegative permits negative Money values (e.g., for refunds).
func AllowNegative() MoneyOption {
    return func(c *moneyConfig) { c.allowNegative = true }
}

// WithMaxAmount sets a maximum allowed amount.
func WithMaxAmount(maxCents int64) MoneyOption {
    return func(c *moneyConfig) { c.maxAmount = maxCents }
}

// NewMoney creates a Money value object with validation.
func NewMoney(cents int64, currency string, opts ...MoneyOption) (Money, error) {
    cfg := &moneyConfig{
        allowNegative: false,
        maxAmount:     10_000_000_00, // $10M default maximum
    }
    for _, opt := range opts {
        opt(cfg)
    }

    if !cfg.allowNegative && cents < 0 {
        return Money{}, fmt.Errorf("%w: amount %d is negative", ErrInvalidMoney, cents)
    }
    if cfg.maxAmount > 0 && cents > cfg.maxAmount {
        return Money{}, fmt.Errorf("%w: amount %d exceeds maximum %d", ErrInvalidMoney, cents, cfg.maxAmount)
    }
    if currency == "" {
        return Money{}, errors.New("currency code is required")
    }
    return Money{Amount: cents, Currency: currency}, nil
}
```

### When NOT to Add an Interface

A frequent mistake is defining an interface for every struct in the domain layer "for testability". Go interfaces should be declared where they are *consumed*, not where they are *implemented*. If the Order aggregate has a single method `Total() Money`, do not wrap it in a `Totalizer` interface just because you imagine mocking it one day. Concrete types are fine until a second implementation is actually needed. Over-abstraction is a DDD anti-pattern as much as under-abstraction.

The rule: interfaces belong at the boundary between layers (application needs a `Repository` it can swap for tests) and inside the domain only when genuine polymorphism exists (a `PricingStrategy` with regular, promotional, and enterprise implementations). Everything else is a plain struct.

---

### Junior → FAANG: Making the Domain Layer Genuinely Pure

The most common failure mode for junior developers implementing a domain layer is importing convenience. It starts small: "I just need `encoding/json` for the event payload" or "I need `uuid` to generate the ID." Each import feels harmless individually, but the result is a domain package with a non-trivial import graph that can no longer be described as "pure business logic."

Concrete rule: run `go list -deps ./internal/domain/...` on your domain package. Every line should be a standard library package or a package you explicitly own and treat as part of the domain. If you see `github.com/google/uuid`, ask whether ID generation is a domain concern (sometimes it is, and then the dependency is justified) or an infrastructure concern (usually it is, and then the ID should be provided to the factory function as a parameter). If you see `database/sql` or any driver, something has leaked.

For interview preparation: know the three things a domain error sentinel needs in Go. First, it must be comparable with `errors.Is` so the application and HTTP layers can match it without string comparison. Second, it must carry enough information to log meaningfully. Third, it must not expose infrastructure details. A domain error that says "pq: duplicate key value violates unique constraint" is an infrastructure error impersonating a domain error.

The factory function pattern shown for `NewMoney` is the pattern to internalize: validate in the constructor, return `(T, error)`, and use sentinel errors so callers can handle specific failure cases. This is not just DDD style: it is the Go community's preferred way to model constructors with preconditions, and it appears in standard library design (see `time.Parse`, `net.ResolveTCPAddr`, `os.Open`).

### Senior @ FAANG: Domain Layer Design as a Specification of Business Rules

The domain layer is not primarily a technical artifact: it is an executable specification of business rules. At the staff level, the quality signal for a domain layer is whether a non-engineer (a product manager, a domain expert, a compliance officer) can read the domain error list and the aggregate method signatures and recognize the business rules they participated in defining.

**Error taxonomy governance.** A production domain layer accumulates sentinel errors over time. Without governance, the list becomes inconsistent: some errors are too granular (matching a specific database constraint), some are too vague (`ErrInvalidState`), and some are duplicates under different names. A Staff engineer reviewing a domain layer should ask: do the error names correspond to terms used by the business? Does `ErrCancellationWindowExpired` match how the support team describes the rule? If a product manager reads the errors file, would they recognize the business rules they wrote? If not, the domain has drifted from the ubiquitous language.

**Aggregate boundary correctness is a system property.** Identifying the right aggregate boundary is the hardest decision in DDD, and it cannot be made by reading a blog post. It requires understanding two things: (a) which business rules must be enforced atomically (they belong in the same aggregate), and (b) which data is queried together and modified together in practice (empirical, from actual use cases). A Staff engineer facilitates this conversation with domain experts, then encodes the decision in an ADR. The ADR must answer: what invariants does this aggregate protect? What triggers a version increment? What events does it emit? If the answers are vague, the boundary is not yet clear enough to implement.

**Value object design at scale.** In a platform with multiple contexts sharing a currency concept, the question arises: should `Money` be in the shared kernel or defined per context? The correct answer is context-dependent. If "money" means different things in the payment context (where cents precision is critical and currency conversion is a domain operation) than in the notification context (where money is display-only and always pre-formatted), then each context should have its own `Money` type, even if they have the same underlying structure. The shared kernel `Money` is a trap if the type evolves differently in different contexts. This is a L6-level judgment call, not a L4-level implementation question.

**Testing the domain layer as a contract.** The domain layer tests are, effectively, a test suite for the business rules. A high-quality domain test suite can be read by a product manager and serve as a source of truth for how the system behaves. Property-based testing (using `gopter` or `rapid`) is worth considering for complex value objects: instead of enumerating specific cases, you assert properties that must hold for all valid inputs. For `Money`, the property is "adding two non-negative USD amounts always produces a non-negative USD amount greater than or equal to each operand." Property tests find edge cases that example-based tests miss, and they are a bar-raiser signal in a technical interview.

---
