## 52B.1 What Is Domain-Driven Design?

### The Problem: Software That Stops Reflecting Reality

Imagine you join a company building an e-commerce platform. You open the codebase and find:

```
ProductService.CreateProduct()
ProductService.UpdateProduct()
ProductService.DeleteProduct()
OrderService.CreateOrder()
OrderService.UpdateOrder()
```

You ask the lead engineer: "Where does the logic live for reserving inventory when an order is placed?" They say: "Oh, that's in `OrderService.CreateOrder`, but some of it is also in the database trigger on the `inventory` table, and there's a cron job that reconciles discrepancies."

You ask: "What happens if a customer tries to place an order for an item that just sold out?" They say: "We have a check in the API handler, but honestly it's a bit racy. We sometimes oversell by a few units."

You ask: "Can you show me where the business rule is that says an order can only be canceled within 30 minutes of being placed?" They say: "Uh... I think that's handled in the frontend? And maybe there's something in the Stripe webhook handler."

This is the problem DDD solves. The domain logic - the rules, the invariants, the language of the business - has leaked everywhere. It is in API handlers, database triggers, cron jobs, and frontend JavaScript. No single piece of the codebase tells the full story. The software no longer reflects reality. It has become what Eric Evans called an **anemic domain model**: objects that look like domain objects but are really just data bags with no behavior, and all the behavior lives in procedural service classes.

### Anemic Domain Model vs Rich Domain Model

The anemic domain model is the default outcome when teams do not think about domain design:

```go
// Anemic domain model - just a data bag
type Order struct {
    ID         string
    CustomerID string
    Items       []OrderItem
    Status      string
    TotalAmountCents int64
    CreatedAt   time.Time
}

// All business logic in a "service" - this is actually a transaction script
type OrderService struct {
    db *sql.DB
}

func (s *OrderService) CancelOrder(orderID string) error {
    order, err := s.db.QueryRow("SELECT * FROM orders WHERE id = $1", orderID)
    // ...
    if order.Status != "pending" {
        return errors.New("cannot cancel")
    }
    if time.Since(order.CreatedAt) > 30*time.Minute {
        return errors.New("cancellation window expired")
    }
    // update database directly
    _, err = s.db.Exec("UPDATE orders SET status = 'canceled' WHERE id = $1", orderID)
    return err
}
```

The rich domain model puts business logic where it belongs - in the domain objects:

```go
// Rich domain model - behavior lives with the data
type Order struct {
    id         OrderID
    customerID CustomerID
    items       []OrderItem
    status      OrderStatus
    placedAt    time.Time
    version     int
    events      []DomainEvent
}

// Business rule enforced by the domain object itself
func (o *Order) Cancel() error {
    if o.status != OrderStatusPending {
        return ErrOrderNotCancellable
    }
    if time.Since(o.placedAt) > 30*time.Minute {
        return ErrCancellationWindowExpired
    }
    o.status = OrderStatusCanceled
    o.recordEvent(OrderCanceled{
        OrderID:     o.id,
        CanceledAt: time.Now(),
    })
    return nil
}
```

The second version is more than a style preference. When a business analyst asks "under what conditions can an order be canceled?", a developer can point directly at `Order.Cancel()` and read the answer. The code and the business rules are in sync. That synchronization is the goal of DDD.

### Strategic vs Tactical DDD

DDD operates at two levels that address different problems:

**Strategic DDD** deals with the macro architecture of a large system. Its primary concerns are:

- **Bounded Contexts**: What are the natural, coherent domains within the larger system? Where are the boundaries between them?
- **Ubiquitous Language**: What is the precise, shared language that both developers and domain experts use within each boundary?
- **Context Maps**: How do the bounded contexts relate to and communicate with each other?
- **Core Domain vs Supporting Subdomain vs Generic Subdomain**: Which parts of the system are truly differentiating (worth investing heavily in), which support the core (necessary but not differentiating), and which are generic (better bought than built)?

**Tactical DDD** deals with the implementation within a single bounded context. Its building blocks are:

- **Entities**: Objects with identity that persist through state changes
- **Value Objects**: Immutable objects defined entirely by their attributes
- **Aggregates**: Clusters of entities and value objects with consistency guarantees
- **Aggregate Roots**: The entry point into an aggregate
- **Domain Events**: Records of significant things that happened in the domain
- **Repositories**: Abstractions for storing and retrieving aggregates
- **Domain Services**: Operations that don't naturally belong to a single entity
- **Application Services**: Orchestrators that coordinate domain objects to fulfill use cases

Both levels are necessary. Strategic DDD without tactical DDD produces good architecture diagrams and poor code. Tactical DDD without strategic DDD produces well-structured code in the wrong places.

### When to Use DDD (and When Not To)

DDD is not always the right tool. It adds complexity - intentional complexity to manage accidental complexity. The investment pays off only when the domain itself is complex.

**Use DDD when:**

- The domain has complex, frequently changing business rules
- Domain experts have rich, specific language that differs from generic technical terms
- Multiple teams work on the same system and need clear boundaries
- The system has long-term business value and will evolve for years
- You need auditability, traceability, or temporal queries
- You are building the Core Domain - the part that differentiates your business

**Do not use DDD when:**

- The application is primarily data entry and display (CRUD)
- The domain is simple and unlikely to change significantly
- The team is small and the codebase is a single service
- Time-to-market pressure outweighs the long-term maintainability benefits
- The application is a generic subdomain (email delivery, PDF generation) - buy or use a library

A pragmatic approach: use DDD for your Core Domain, use simpler patterns (Active Record, Transaction Script) for supporting and generic subdomains.

### DDD in the Microservices Context

DDD and microservices are natural partners. A Bounded Context - a coherent area of the domain with its own Ubiquitous Language - maps naturally to a microservice. The principle "one service, one bounded context" is not a rigid rule, but it is a useful starting heuristic.

```
┌─────────────────────────────────────────────────────────────────┐
│                    E-Commerce Platform                          │
│                                                                 │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────────┐    │
│  │  Order        │  │  Inventory    │  │  Payment          │    │
│  │  Context      │  │  Context      │  │  Context          │    │
│  │               │  │               │  │                   │    │
│  │  Order        │  │  Product      │  │  Payment          │    │
│  │  Customer     │  │  Stock        │  │  Transaction      │    │
│  │  LineItem     │  │  Warehouse    │  │  Refund           │    │
│  └───────┬───────┘  └───────┬───────┘  └────────┬──────────┘    │
│          │                  │                   │               │
│          └──────────────────┴───────────────────┘               │
│                    Domain Events Bus                            │
└─────────────────────────────────────────────────────────────────┘
```

Each bounded context is a separate Go module with its own domain model, its own database, and its own service. They communicate through domain events on a message bus, not through shared databases or direct function calls.

### Junior → FAANG: Recognizing DDD Smells and the "Why" Behind the Pattern

The anemic domain model is not just a theoretical problem. It is the default output of engineers who think in CRUD. The easiest way to spot it on your first week on a codebase is to look at the service classes. If every method in `OrderService` reads state from the database, makes a decision, and writes state back directly, that is a transaction script, not a domain model. Business rules are invisible because they are scattered across service methods, database triggers, and background jobs.

The interview entry point for DDD is usually the question: "Have you worked with a complex domain, and how did you structure the code?" The answer interviewers want is not a list of patterns but a story: "We had a billing system where an invoice could be in draft, sent, partially paid, disputed, or written off. I moved the state machine into the `Invoice` aggregate so that every transition was an explicit method with a domain error if the precondition was not met, and we eliminated an entire class of bug where the service layer let you call operations in the wrong order."

Common first-job habits to build now: always name domain types after what the business calls them, not what they look like in the database. Always make state transitions explicit methods rather than setting a status field directly. Always write at least one test for each domain invariant that runs with no database or HTTP server.

For the "when to use DDD" question, the honest answer is: use it for your Core Domain only. If you are building an email notification system or a PDF generator, use a library or a SaaS. DDD overhead is only justified when the domain logic is complex enough that the team spends significant time understanding business rules rather than writing glue code.

### Senior @ FAANG: Core Domain Investment and Strategic Portfolio Thinking

At the senior level, the most consequential DDD decision is the Core/Supporting/Generic subdomain classification, because it directly governs where engineering investment goes.

**Core Domain identification.** The Core Domain is the part of the system that differentiates the business. For Stripe, it is the payment routing and fraud detection engine. For Uber, it is the dispatch and dynamic pricing engine. Core Domains should receive your best engineers, the most careful domain modeling, and the most investment in test coverage. They should never be outsourced or replaced by SaaS. If you are a principal engineer and you cannot name your company's Core Domain in one sentence, that is a problem worth escalating.

**Supporting subdomain governance.** Supporting subdomains are necessary but not differentiating. Notifications, reporting, user management: these are often built custom when they should be built with a thin wrapper over a commodity service. The cost of over-investing in a Supporting subdomain is that it draws senior talent away from the Core Domain. The architectural remedy is to model the supporting context with a simple interface (a `NotificationSender` interface in the domain package, a SendGrid adapter in infrastructure) so it can be replaced with minimal domain-layer impact.

**Strategic context decomposition timing.** One of the costliest mistakes in large-system DDD is extracting bounded contexts too early. The rule of thumb from Vaughn Vernon and later from Sam Newman's work on microservices: start with a modular monolith where each bounded context is a Go package under `internal/`, with explicit interfaces at the package boundary. Extract to a separate service only when you have a validated boundary (confirmed by months of the modular monolith running in production) and a concrete operational reason to extract (team autonomy, independent deployability, or polyglot persistence). Premature extraction produces distributed monoliths where services call each other synchronously in a request chain, which is strictly worse than a single process because it adds network latency and partial failure modes without any of the architectural clarity DDD promises.

**ADR template for Core Domain decisions.** A robust ADR for a new Core Domain component should include: the subdomain type classification and justification, the bounded context owner and their on-call ownership, the integration patterns with every adjacent context and the rationale for each, the aggregate design with explicit invariants listed, the event schema with a compatibility policy, and a migration plan for any data that was previously modeled differently. This artifact is what a staff or principal engineer presents to an architecture review board, and its quality signals technical leadership maturity.

**Conway's Law as a design constraint.** The most underappreciated input to context boundary design is team structure. If two teams own code in the same bounded context, that context will accumulate coupling at the seam between their ownership areas. If one team owns code across two contexts, those contexts will share abstractions they should not. The practical advice: draw your context map, then draw your team org chart on top of it. Every place where a context boundary does not align with a team boundary is a latent architectural risk. Resolving the misalignment either requires reorganizing the team (Inverse Conway Maneuver) or accepting that the boundary will erode over time and planning accordingly.

---
