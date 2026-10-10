## 47.2 Service Design

### Domain-Driven Design

Domain-Driven Design provides the vocabulary for finding correct service boundaries: each bounded context (User, Order, Inventory, Shipping) becomes its own Go module with its own aggregate types. The key insight is that the same real-world concept (a customer) is intentionally modeled differently in each context - as a full `User` entity in the User context but only a `CustomerRef` in the Order context. This prevents the cross-context coupling that turns microservices back into a distributed monolith.

**Data ownership is the hard rule.** A bounded context does not merely expose an API - it owns the authoritative state for its aggregates. Nothing outside the context reads or writes that state directly. No shared schema, no read-replica subscriptions into the service's tables, no "for analytics only" SELECTs. When another context needs data, it either (a) calls the owning service's API, (b) subscribes to the owning service's published events and maintains a *local read model* that is eventually consistent, or (c) hits a dedicated read-model / CQRS projection that the owning service publishes explicitly. This is how you get independent deployability: if the Order service can rename a column tomorrow without breaking Shipping, you have a boundary. If it can't, you don't.

**Context mapping patterns** (Evans / Vernon terminology, still the standard vocabulary in 2026):

- **Customer/Supplier** - downstream context depends on upstream. upstream has an obligation to accommodate.
- **Conformist** - downstream adopts upstream's model verbatim (used when you have no leverage over the upstream team).
- **Anti-Corruption Layer (ACL)** - downstream translates the upstream model into its own vocabulary at the boundary. The `OrderService.GetCustomerRef` below is a minimal ACL.
- **Published Language** - a shared schema (e.g., CloudEvents) used for integration events between contexts without coupling internal models.
- **Separate Ways** - two contexts agree not to integrate. Users cross-reference manually.

```go
package domain

/*
Bounded Context Example: E-Commerce

User Context:
- User aggregate
- Profile, Preferences
- Authentication

Order Context:
- Order aggregate
- OrderItem, Payment
- Order lifecycle

Inventory Context:
- Product aggregate
- Stock, Warehouse
- Reservations

Shipping Context:
- Shipment aggregate
- Carrier, Tracking
- Delivery
*/

// User context - User aggregate
type User struct {
    ID        string
    Email     string
    Name      string
    Status    UserStatus
    CreatedAt time.Time
}

type UserStatus string

const (
    UserStatusActive   UserStatus = "active"
    UserStatusInactive UserStatus = "inactive"
)

// Order context - sees User differently
type CustomerRef struct {
    ID    string
    Email string
    Name  string
}

type Order struct {
    ID        string
    Customer  CustomerRef // Reference, not full User
    Items     []OrderItem
    Status    OrderStatus
    Total     Money
    CreatedAt time.Time
}

// Inventory context - sees Product
type Product struct {
    ID          string
    SKU         string
    Name        string
    Stock       int
    Reserved    int
    WarehouseID string
}

// Anti-Corruption Layer
type OrderService struct {
    userClient UserServiceClient // External service client
}

func (s *OrderService) GetCustomerRef(ctx context.Context, userID string) (*CustomerRef, error) {
    // Translate from User context to Order context
    user, err := s.userClient.GetUser(ctx, userID)
    if err != nil {
        return nil, err
    }

    return &CustomerRef{
        ID:    user.ID,
        Email: user.Email,
        Name:  user.Name,
    }, nil
}
```

### Service Boundaries

Identifying the right boundaries determines whether your microservices achieve independent deployability or collapse into a distributed monolith. Three heuristics work well together: business capability (what the organization does), subdomain classification (core, supporting, or generic), and team ownership (one team owns one service end-to-end). Below, the service interfaces define the public contracts for User and Order services. Each interface exposes only the operations relevant to its bounded context, and accepting interfaces rather than concrete types allows callers to be unit-tested in isolation.

```go
package design

/*
Good Service Boundaries:

1. Business Capability
   - Payment processing
   - User management
   - Notification delivery

2. Subdomain
   - Core: Order processing
   - Supporting: Reporting
   - Generic: Authentication

3. Team Ownership
   - One team owns service
   - Full lifecycle responsibility
   - Clear interfaces
*/

// Service interface design
type UserService interface {
    // CRUD operations
    CreateUser(ctx context.Context, input CreateUserInput) (*User, error)
    GetUser(ctx context.Context, id string) (*User, error)
    UpdateUser(ctx context.Context, id string, input UpdateUserInput) (*User, error)
    DeleteUser(ctx context.Context, id string) error

    // Business operations
    VerifyEmail(ctx context.Context, userID string, token string) error
    ResetPassword(ctx context.Context, email string) error
    UpdatePreferences(ctx context.Context, userID string, prefs Preferences) error
}

type OrderService interface {
    // Order lifecycle
    CreateOrder(ctx context.Context, input CreateOrderInput) (*Order, error)
    GetOrder(ctx context.Context, id string) (*Order, error)
    ConfirmOrder(ctx context.Context, id string) error
    CancelOrder(ctx context.Context, id string, reason string) error

    // Order operations
    AddItem(ctx context.Context, orderID string, item OrderItem) error
    RemoveItem(ctx context.Context, orderID string, itemID string) error
    ApplyDiscount(ctx context.Context, orderID string, code string) error
}
```

### Junior → FAANG: DDD Vocabulary as Interview Currency

Domain-Driven Design vocabulary is interview currency at FAANG companies. You do not need to have read Evans or Vernon cover to cover, but you need to be able to use the core terms correctly in a system design conversation.

Bounded context: a boundary within which a particular domain model is defined and applicable. Outside that boundary, the same concept may be modeled differently. In the code above, `User` in the User context and `CustomerRef` in the Order context are the same real-world person modeled differently. This is intentional and correct.

Aggregate: a cluster of domain objects treated as a single unit for data changes. An `Order` aggregate owns its `OrderItem`s. Nothing outside the aggregate writes directly to an `OrderItem`. This is how you prevent race conditions and enforce invariants.

Anti-Corruption Layer: a translation layer that converts between one context's model and another's. The `GetCustomerRef` method is a minimal ACL. In a real system, this layer also handles error translation, retry policy, and circuit breaking.

Context mapping: the practice of explicitly documenting how bounded contexts relate. In an interview, after you have drawn the services, say "let me also note the integration patterns between them" and sketch the context map. This alone signals DDD fluency.

Practical exercise: take any system design problem (ride-sharing, food delivery, e-commerce) and identify three to five bounded contexts. For each pair that needs to share data, write one sentence describing the context mapping pattern (Customer/Supplier, ACL, Published Language). Practice until this takes less than two minutes.

### Senior @ FAANG: Service Interface Governance and API Lifecycle

At L6/L7, the service interface is not just a Go interface definition. It is a governed artifact with a published version, a compatibility contract, a deprecation policy, and consumer-driven tests.

**Interface as a public API contract.** Every service interface that is called by another team should be published as a versioned protobuf or OpenAPI document in a central schema registry. The Go interface definition in this file is an internal implementation detail. The external contract is the proto. The two should be kept in sync by code generation, not by hand. Any divergence between the generated stub and the hand-written `UserService` interface is a latent bug.

**Consumer-driven contract testing.** Pact is the standard tool for this in 2026. Each consumer (Order service) defines a pact: a set of interactions it expects from the provider (User service). The provider runs the pact verifier in CI. If the User service changes `GetUser` in a way that breaks the Order service's pact, CI fails before any deployment. This gives independent deployability with verified compatibility.

**API versioning policy.** Staff engineers define the policy, not individual services. The standard: add fields freely (backwards compatible), deprecate old fields with a sunset header and a timeline, never change a field's type or semantics within a version, introduce breaking changes only under a new major version (`/v2` URL path or `user.v2` proto package). Services that call a deprecated endpoint receive a `Deprecation` response header with the sunset date, and the gateway can enforce a hard cut-off at the sunset date.

**Subdomain classification as a prioritization tool.** Evans's three subdomain types (core, supporting, generic) map directly to investment priority. Core subdomains (order processing, matching algorithm, payment) are where the company's competitive differentiation lives. They deserve the most engineering investment, the most thorough testing, and the most experienced engineers. Supporting subdomains (reporting, notifications) matter but are not differentiators. Generic subdomains (authentication, logging, CI/CD) should be bought or adopted from open-source rather than built. Staff engineers advocate for this prioritization in headcount and roadmap conversations, not just in architecture diagrams.

**Coupling metrics as a governance signal.** Large organizations track inter-service coupling quantitatively. The metrics: number of synchronous dependencies per service (target: under five), number of services that publish to or consume from a given event topic (track growth), and the "deploy-together ratio" (how often two services are deployed in the same change). A high deploy-together ratio between two services is a signal that their boundary is wrong. Measuring this quarterly and acting on outliers is a staff-level governance practice.

---
