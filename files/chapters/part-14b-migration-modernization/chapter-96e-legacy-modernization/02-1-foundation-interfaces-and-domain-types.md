## 1. Foundation: Interfaces and Domain Types

Every migration starts with defining clean abstractions. The interface is the contract that allows old and new implementations to coexist. In Go, you define an interface that both your legacy adapter and your new adapter implement. The service layer depends only on this interface, so it never knows or cares whether it is talking to the old system or the new one. This is the Dependency Inversion Principle applied at the architecture level: high-level business logic depends on an abstraction, not on a concrete database or service client. The domain types below are shared across both implementations, giving the strangler proxy a single canonical model to translate between old and new response formats.

```go
// file: internal/domain/types.go
package domain

import (
	"context"
	"time"
)

// UserID is a strongly typed identifier to prevent accidental mixing of IDs.
type UserID string

// OrderID is a strongly typed order identifier.
type OrderID string

// User represents the canonical domain model. Both legacy and new services
// map to this shared type, ensuring the strangler proxy can translate between them.
type User struct {
	ID        UserID    `json:"id"`
	Email     string    `json:"email"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
	Metadata  map[string]string `json:"metadata,omitempty"`
}

// Order represents a domain order entity.
type Order struct {
	ID         OrderID   `json:"id"`
	UserID     UserID    `json:"user_id"`
	TotalCents int64     `json:"total_cents"`
	Status     string    `json:"status"`
	CreatedAt  time.Time `json:"created_at"`
	UpdatedAt  time.Time `json:"updated_at"`
}

// UserRepository defines the port that both legacy and new adapters implement.
// This is the core of the branch-by-abstraction pattern.
type UserRepository interface {
	GetByID(ctx context.Context, id UserID) (*User, error)
	GetByEmail(ctx context.Context, email string) (*User, error)
	Create(ctx context.Context, u *User) error
	Update(ctx context.Context, u *User) error
	Delete(ctx context.Context, id UserID) error
	List(ctx context.Context, opts ListOptions) ([]*User, error)
}

// OrderRepository defines the port for order data access.
type OrderRepository interface {
	GetByID(ctx context.Context, id OrderID) (*Order, error)
	GetByUserID(ctx context.Context, userID UserID, opts ListOptions) ([]*Order, error)
	Create(ctx context.Context, o *Order) error
	Update(ctx context.Context, o *Order) error
}

// ListOptions provides pagination and filtering.
type ListOptions struct {
	Limit  int
	Offset int
	SortBy string
	Order  string // "asc" or "desc"
}

// MigrationError wraps errors with migration-specific context.
type MigrationError struct {
	Operation string
	Legacy    error
	New       error
}

func (e *MigrationError) Error() string {
	if e.Legacy != nil {
		return "legacy: " + e.Legacy.Error()
	}
	if e.New != nil {
		return "new: " + e.New.Error()
	}
	return "migration error in " + e.Operation
}
```

### Junior → FAANG: Interface Design as Migration Architecture

The interface-first approach in this section is one of the clearest demonstrations of Go's interface philosophy at the architecture level. Notice that the interface is defined where it is consumed (in the service layer), not where it is implemented (in the legacy adapter or new adapter). This is the key Go interface idiom: interfaces belong to the consumer.

For early-career engineers encountering this pattern for the first time: the reason this works is that Go interfaces are satisfied implicitly. The legacy adapter and the new adapter do not need to declare that they implement the interface. They just need to have the right method signatures. This makes it possible to write an adapter for a legacy system without modifying the legacy system code at all.

The domain types defined in this section are a critical design artifact. They represent the canonical model that the entire migration operates in. Getting these types right before building any adapters is worth significant upfront investment, because changing them later requires updating all adapters, the proxy, and the shadow mode comparison logic simultaneously.

### Senior @ FAANG: Interface Governance in Multi-Team Migration Projects

At senior level, the interfaces defined in this section are organizational contracts as much as technical ones. In a multi-team migration, different teams may own the legacy adapter, the new service, and the proxy. The interface definition is the boundary agreement that allows each team to work independently without coordination at the implementation level.

The governance practice: treat the interface definition as a versioned API. Any breaking change to the interface (adding a method, changing a method signature) requires a coordination protocol: create a new interface version, migrate all implementations to the new version, then remove the old version. This protocol prevents the migration from stalling because of interface churn.

The error type design in this section is worth examining at senior level. The `MigrationError` type carries operation context and signals whether the failure is related to the migration layer or the underlying business logic. At senior level, the error taxonomy for a migration system needs to distinguish between: errors from the legacy system (expected, the legacy system has bugs), errors from the new system (unexpected, should trigger rollback), and errors from the migration infrastructure itself (the proxy, the flag engine, the dual-write coordinator). Without this taxonomy, alerts and on-call responses during the migration will be confused and slow.

---
