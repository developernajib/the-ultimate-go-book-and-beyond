## 52B.14 Interview Questions

Each question below is answered the way a senior engineer would in a FAANG-style system-design loop. The **What FAANG expects** note captures the bar the interviewer is actually grading against, and the **Follow-ups** anticipate the probes the interviewer will almost certainly ask next.

---

### Conceptual

**1. What is the difference between a domain event and an integration event?**

A **domain event** is a fact about something that happened inside a single bounded context, expressed in that context's ubiquitous language (`OrderPlaced`, `InventoryReserved`). It is typically consumed in-process by the same service that emitted it, carries rich domain detail, and can change shape freely because only one team owns it. An **integration event** is the public, versioned contract published to other bounded contexts - usually a subset of a domain event, translated into the shared kernel or published-language vocabulary, with a stable schema managed like any other API. Domain events are cheap and refactorable. Integration events require migrations and deprecation windows.

*What FAANG expects:* A crisp split between "internal fact" and "external contract", and awareness that breaking integration events breaks downstream teams. Candidates who treat the two as the same thing are flagged as junior.

*Follow-ups:*
- How do you prevent leaking internal aggregate structure into integration events? (Outbox + explicit translator. Never publish the raw domain event.)
- How do you evolve an integration event without breaking consumers? (Additive fields, new version topics, consumer-driven contracts, dual-publish during migration.)
- Where does the Outbox pattern fit, and why is it mandatory for at-least-once delivery?

---

**2. Why should cross-aggregate references use IDs instead of direct object references?**

Three reasons. First, **transactional consistency**: an aggregate is a consistency boundary, and embedding another aggregate inside it suggests you can update both atomically, which is exactly what DDD wants to forbid. Second, **loading cost**: direct references pull unbounded object graphs into memory and force the ORM to eagerly hydrate data the operation does not need. Third, **distribution**: aggregates often end up in separate services or databases. An ID reference still works across a service boundary, an in-process pointer does not. Concretely, `Order` holds `CustomerID` and `[]ProductSKU`, never `*Customer` or `*Product`.

*What FAANG expects:* The candidate must mention the **transactional boundary** reason first - the other two are bonus. Missing that is a strong signal they've read about DDD but not lived it.

*Follow-ups:*
- If you need to show the customer's name on an order page, where does the join happen? (Read model / CQRS projection, not the write model.)
- What happens if a referenced aggregate is deleted? (Eventual consistency via domain events. Never cascade deletes across aggregates.)
- How do you enforce this rule in Go? (Unexported aggregate types, ID-typed struct fields, code review, sometimes a linter.)

---

**3. What is the difference between an entity and a value object? Give three examples of each from a ride-sharing domain.**

An **entity** has an identity that persists across state changes - two entities with all attributes equal but different IDs are still different. A **value object** is defined entirely by its attributes, is immutable, and is compared structurally - two VOs with the same attributes *are* the same thing. The test is: "if I replace this object with a new one carrying the same attributes, does anything break?" If yes, it's an entity. If no, it's a value object.

Ride-sharing examples:

- **Entities:** `Rider`, `Driver`, `Trip` (each has a stable ID and evolves through states).
- **Value objects:** `GeoCoordinate(lat, lng)`, `Fare(amount, currency)`, `VehicleLicensePlate("ABC-1234")` (immutable, compared by value, interchangeable if attributes match).

*What FAANG expects:* Correctly classifying edge cases matters more than the definition. `Address`, `Money`, `DateRange`, `Email` should all be VOs. Candidates who make them entities betray anemic thinking.

*Follow-ups:*
- Is `PhoneNumber` an entity or value object? (VO - two people can share a number over time, but at any given moment the number itself has no identity.)
- How do you implement VO equality in Go without `equals()` methods? (Comparable struct types and `==`, or an explicit `Equals` method if the VO holds slices/maps.)
- When would you promote a value object to an entity? (When the business starts talking about its lifecycle - e.g., `Address` becomes an entity once it has a "validated / unvalidated" state that changes over time.)

---

**4. What is the Ubiquitous Language and why is it important for large teams?**

The Ubiquitous Language is a single, precise vocabulary shared by domain experts, product, and engineering inside a bounded context. It lives in conversations, tickets, docs, code, tests, database columns, and API paths. At scale it matters because every translation between business vocabulary and technical vocabulary is a place bugs enter: if "customer" means one thing to billing and another to support, the two teams will ship subtly incompatible features. Enforcing the language in code (package names, type names, method names) removes the translation step and makes the code reviewable by domain experts.

*What FAANG expects:* Candidates should connect ubiquitous language to **onboarding speed**, **defect rate**, and **cross-team coordination cost**, not just "it's clearer." Bonus for noting that the language is *context-specific* - the same word can legitimately mean different things in different bounded contexts.

*Follow-ups:*
- What do you do when two teams use the same word for different concepts? (Explicitly name the bounded contexts, add an ACL, publish an integration vocabulary, or unify if the concept really is the same.)
- How do you keep the language from drifting over time? (Domain expert attends design reviews. rename aggressively when the business vocabulary evolves. glossary lives next to the code.)
- Have you ever refused a product request because it violated the ubiquitous language? (Strong candidates have stories here.)

---

**5. How do you decide where to draw bounded context boundaries?**

Start with **linguistic analysis**: where does the same word mean different things? In e-commerce, "product" in Catalog (marketing copy, images, SEO) is a different object than "product" in Inventory (SKU, warehouse location, reorder level) or "product" in Pricing (base price, tax rules, promotion eligibility). That linguistic split is the primary signal. Secondary signals: team structure (Conway's Law), rate of change (volatile vs stable subdomains), and compliance boundaries (PCI, PII, GDPR). Modern teams validate the split with an **EventStorming** workshop: map the business timeline as domain events, group events that share a consistent vocabulary and pace of change, and the cluster boundaries are your bounded contexts.

*What FAANG expects:* Explicit mention of EventStorming or a comparable collaborative discovery technique, plus awareness that **bounded contexts are linguistic first and technical second**. Candidates who go straight to database schemas or microservice diagrams without mentioning language get downgraded.

*Follow-ups:*
- How does this interact with Conway's Law? (Contexts tend to align with team ownership. If they don't, either the teams or the contexts are wrong.)
- What's the difference between a bounded context and a microservice? (A microservice *implements* a bounded context. Contexts are conceptual, services are deployable units. One context can span multiple services, or one service can temporarily host two contexts.)
- How do you handle a concept that spans contexts, like `Customer`? (It's a different model in each - `BillingCustomer`, `SupportCustomer`, `MarketingCustomer` - linked by a shared ID, translated at the seam.)

---

**6. What is the difference between a domain service and an application service?**

A **domain service** holds business logic that doesn't naturally belong to any single entity or value object - for example, a `TransferService` that debits one `Account` and credits another, or a `PricingService` that combines a catalog price, a customer's loyalty tier, and a promotion. It is expressed in the ubiquitous language and has no idea about HTTP, transactions, or persistence. An **application service** is the use-case orchestrator: it loads aggregates from repositories, calls domain methods or domain services, commits the transaction, and publishes events. It is the boundary between the outside world and the domain.

*What FAANG expects:* The candidate should state "domain services are stateless and speak the domain language. Application services orchestrate and speak to infrastructure" without hedging, and give an example where mis-placing logic led to a bug.

*Follow-ups:*
- Where does validation live - domain or application service? (Domain invariants in the aggregate. Request-shape validation at the edge. authorization in the application service.)
- Can a domain service call a repository? (Controversial - many practitioners say no. Pass the aggregates in as parameters instead.)
- How do you keep an application service from becoming an anemic god object? (Keep it thin: load, delegate, save, publish. If it grows logic, push it down into the aggregate.)

---

### Design

**7. You are designing a hotel booking system. What are the main bounded contexts? Sketch the context map.**

Primary contexts: **Inventory** (rooms, room types, availability calendar), **Reservations** (a guest booking a specific room for specific dates), **Pricing** (rate plans, dynamic pricing, promotions), **Payments** (authorizations, captures, refunds), **Guest Profile** (identity, loyalty, preferences), **Housekeeping** (room status, cleaning schedules), **Reporting** (occupancy, revenue). Context map: Reservations is a **Customer** of Inventory (via a Published Language API for availability holds) and a **Customer** of Pricing. Payments is integrated via an **Anti-Corruption Layer** because it wraps a third-party PSP (Stripe/Adyen). Guest Profile is a **Conformist** to the identity provider. Reporting consumes domain events from everyone via an event bus - read-only **Open Host Service**.

*What FAANG expects:* The candidate produces a real context map with named integration patterns (Partnership, Customer-Supplier, Conformist, ACL, Published Language, Open Host Service), not just boxes and arrows. Bonus for identifying which context is the Core Domain (usually Pricing or Reservations, depending on the business model).

*Follow-ups:*
- Which context is your Core Domain, and how does that change investment? (Core gets senior engineers, custom code, rich modeling. Generic like Payments gets bought.)
- What happens if Inventory is down when a reservation is being created? (Idempotency + saga: hold on a best-effort basis, compensate with release event if confirmation fails.)
- How would you split Reservations further if it grew to 50 engineers? (By lifecycle stage: Booking, Check-In, Stay, Check-Out, each its own sub-context.)

---

**8. Design the `Reservation` aggregate for a hotel booking system. What entities and value objects does it contain? What invariants must it enforce?**

The `Reservation` aggregate root is an entity with a stable `ReservationID`. It contains one or more `StayNight` entities (each night is a unit of inventory) or, if stays are atomic, a single `StayPeriod` value object. Value objects: `DateRange(checkIn, checkOut)`, `GuestCount(adults, children)`, `RoomType`, `RatePlan`, `Money(amount, currency)`, `ConfirmationCode`. References by ID: `GuestID`, `PropertyID`, `PaymentIntentID`.

Invariants enforced by the root:

1. `checkOut > checkIn` and `checkIn >= today` at creation.
2. `GuestCount.adults >= 1` and total occupants `<= RoomType.maxOccupancy`.
3. State machine: `Held -> Confirmed -> CheckedIn -> CheckedOut -> Completed`, with `Canceled` reachable from `Held` and `Confirmed` only, subject to the cancellation policy window.
4. Total price is recomputed from `RatePlan` and `DateRange` whenever dates change. You cannot mutate price independently.
5. Modification after `CheckedIn` requires a compensating operation, not an in-place update.

*What FAANG expects:* Explicit invariants and a state machine. Candidates who describe only the data shape without the rules are treating the aggregate as a DTO.

*Follow-ups:*
- How do you keep the aggregate small? (Model the stay as a value object, not an entity with its own repository. push housekeeping into its own context.)
- How do you handle concurrent modifications? (Optimistic concurrency via a `version` field. On conflict, reload and retry or surface to the user.)
- What domain events does `Reservation` emit? (`ReservationHeld`, `ReservationConfirmed`, `ReservationCanceled`, `GuestCheckedIn`, `GuestCheckedOut` - all past tense, all immutable.)

---

**9. How would you implement an Anti-Corruption Layer between your order domain and a legacy ERP system?**

Three layers. (1) A **client adapter** that speaks SOAP/XML/whatever the ERP uses, handling auth, retries, and timeouts - lives in `infrastructure/erp/`. (2) A **translator** that converts ERP DTOs into clean domain value objects (`ERPOrderRecord` -> `Order` aggregate events, `ERPCustomerBlob` -> `CustomerID` + domain-shaped fields). (3) A **domain-facing interface** (`ERPOrderSink`, `ERPInventoryQuery`) defined in the domain package that the application service depends on. The domain never imports the ERP client. If the ERP changes its field names, only the translator changes. If the ERP goes down, the adapter returns a domain-typed error the domain already knows how to handle.

*What FAANG expects:* Clear separation of concerns across three layers, the interface defined **in** the domain package (Dependency Inversion), and graceful degradation strategy. A candidate who puts ERP types directly in domain methods fails.

*Follow-ups:*
- What if the ERP only supports synchronous calls but you want async? (Outbox + background worker. The domain emits a domain event, the worker drives the ERP call with retries.)
- How do you test the translator without the real ERP? (Contract tests against recorded fixtures. property tests for round-trip translation.)
- When would you *not* use an ACL? (When the external system already speaks your language and is under your control - then Shared Kernel or Conformist is cheaper.)

---

**10. A product manager says "the customer's loyalty tier affects how we price orders." Where does this logic live in a DDD design?**

Pricing is its own bounded context, so the logic lives there, not in Orders. The Orders context has a `CustomerID` and, at checkout, calls a `PricingService` (a domain service in the Pricing context, or its published API) that takes `(CustomerID, Cart, PromotionCode)` and returns a `Price` value object with a breakdown. Inside Pricing, a `LoyaltyTierPolicy` domain service resolves the customer's tier (from the Loyalty context, again via ID) and applies the matching rate rules. Orders stores the returned `Price` as a snapshot on the aggregate - you do not recompute price after the order is placed, because the ruleset may have changed.

*What FAANG expects:* Multi-context thinking. Candidates who put loyalty logic inside `Order.Cancel()` or `Customer.getDiscount()` show they haven't internalized bounded contexts. Bonus for the snapshot point - prices must be immutable once captured.

*Follow-ups:*
- What if the customer's tier changes mid-checkout? (Price is locked at cart confirmation. A later tier change does not retroactively change the order.)
- Who owns the `LoyaltyTier` enum - Loyalty, Pricing, or a shared kernel? (Loyalty owns it. Pricing consumes it via integration events or a read model to avoid coupling.)
- How do you test this without spinning up three services? (Domain services are pure. unit test `LoyaltyTierPolicy.Price(...)` in isolation with table-driven tests.)

---

### Go-specific

**11. How does Go's lack of class inheritance affect DDD implementation compared to Java/C#?**

It removes a trap rather than creating one. In Java/C#, DDD practitioners routinely build deep `Entity -> AbstractAggregateRoot -> Order` hierarchies that leak framework concerns into the domain and make refactoring painful. Go forces **composition** (`Order` embeds a small `Aggregate` struct that tracks uncommitted events) and **small interfaces** (`Repository[T]`, `DomainEventHandler`) defined where they are consumed. The result is a flatter, more explicit model. The cost is that you write a few lines of boilerplate per aggregate that an inherited base class would have given you - a trade most DDD practitioners now consider a feature, not a limitation.

*What FAANG expects:* The candidate should frame Go's lack of inheritance as a design *alignment* with DDD, not a shortcoming. Reference to "accept interfaces, return structs" and small-interface philosophy scores well.

*Follow-ups:*
- How do you share common aggregate behavior (event recording, versioning) across aggregates in Go? (Embedded struct like `eventemitter.Base`, or generics since Go 1.18.)
- Where do generics (Go 1.18+, refined through Go 1.27) fit into the Repository pattern? (`Repository[ID comparable, T AggregateRoot]` - typed `Save/Get` without code generation.)
- What's the risk of embedding? (Method promotion can accidentally widen the aggregate's public surface. Prefer composition of unexported fields.)

---

**12. How do you implement immutable value objects in Go?**

Three conventions. (1) Unexported fields + exported constructor (`NewMoney(amount int64, currency Currency) (Money, error)`) + accessor methods (no setters). (2) Value receivers on all methods - a VO should never hand out a pointer to itself. (3) Operations return new VOs instead of mutating (`m.Add(other) Money`). For VOs that hold slices or maps, copy on construction and on accessor to prevent aliasing. Use `type Money struct{...}` as a comparable value type so Go's `==` works for equality. Fall back to an explicit `Equals(other) bool` only when the VO contains non-comparable fields.

*What FAANG expects:* All three conventions, plus an understanding that Go cannot enforce immutability at the compiler level - discipline and code review do. Points off if the candidate suggests `sync.Once` or `atomic` to fake it.

*Follow-ups:*
- How do you serialize/deserialize a VO without leaking mutability? (Implement `MarshalJSON`/`UnmarshalJSON` on the VO, reconstruct via the validating constructor, never expose fields.)
- What about VOs that need validation (e.g., `Email`)? (Validate in the constructor, return `(Email, error)`, make the zero value invalid.)
- Is `time.Time` a value object? (Yes, and Go's `time.Time` follows the pattern - unexported fields, value receivers, returns new values from `Add`.)

---

**13. How do you prevent external packages from constructing your aggregate in an invalid state in Go?**

Unexported fields + a validating constructor is the core pattern:

```go
package order

type Order struct {
    id       OrderID
    status   OrderStatus
    lines    []OrderLine
    version  int
    events   []DomainEvent
}

// NewOrder is the only supported way to create an Order. Validation happens here.
func NewOrder(id OrderID, customerID CustomerID) (*Order, error) {
    if id.IsZero() {
        return nil, ErrInvalidOrderID
    }
    return &Order{
        id:         id,
        customerID: customerID,
        status:     OrderStatusDraft,
        version:    0,
    }, nil
}
```

For rehydration from the database, the repository lives in the same package (or a tightly coupled `orderinfra` package with a `package-internal` reconstruction function exposed via a dedicated `ReconstructOrder(...)` constructor that skips the "new order" invariants but still validates the loaded state). The zero value of `Order` should be unusable - if someone does `var o Order. o.Cancel()`, it must fail safely.

*What FAANG expects:* Unexported fields, a validating constructor, and a separate rehydration path that does not share code with the "new" constructor. Missing the rehydration point is the most common miss.

*Follow-ups:*
- How do you prevent the zero value being used? (Constructor returns a pointer. Methods check `o == nil` or `o.id.IsZero()` and return an explicit error.)
- How does this interact with JSON unmarshalling? (Don't unmarshal into domain aggregates directly - unmarshal into a DTO, then call the constructor.)
- What about test fixtures? (Expose a `_test.go` helper like `MustNewOrder(...)` so tests don't duplicate validation logic.)

---

**14. Explain how you would use Go interfaces to implement the Repository pattern following the Dependency Inversion Principle.**

The interface is declared *in the domain package*, where it is consumed, not in the infrastructure package where it is implemented:

```go
// internal/domain/order/repository.go
package order

type Repository interface {
    Save(ctx context.Context, o *Order) error
    FindByID(ctx context.Context, id OrderID) (*Order, error)
    FindPendingOlderThan(ctx context.Context, age time.Duration) ([]*Order, error)
}
```

Implementations - Postgres, in-memory, Redis - live in `internal/infrastructure/order/` and import the domain package to satisfy the interface. Application services depend only on `order.Repository`, never on `*orderinfra.PostgresRepository`. Wiring happens in `main.go`:

```go
repo := orderinfra.NewPostgresRepository(db)
svc := orderapp.NewService(repo, eventBus)
```

This gives you (a) trivial substitution for tests with a fake repository, (b) freedom to change storage technology without touching domain code, and (c) a clean acyclic dependency graph where domain depends on nothing, infrastructure depends on domain, and main wires them.

*What FAANG expects:* Interface in the domain package (this is the "accept interfaces" part of Go idiom), small focused methods on the interface (ISP), and a clean wiring story. Candidates who put the interface in `infra` or import `database/sql` from domain fail.

*Follow-ups:*
- Should `Repository` return rows or aggregates? (Aggregates, always. If you need a read-optimized view, that's a query service / read model, not a repository.)
- How do you handle transactions that span multiple repositories? (Unit of Work pattern, or a `Transactor` interface passed into the application service. The repository does not own the transaction.)
- How do you test the application service without a real database? (In-memory implementation of `order.Repository` in a `_test` helper package. Run the same contract tests against both the in-memory and Postgres implementations to catch drift.)

---

### Junior → FAANG: How to Prepare for These Questions

The fourteen questions above cover the full conceptual and Go-specific range of DDD interview questions at the FAANG bar. For entry-to-mid level preparation, the priority order is:

Start with questions 1, 2, and 3 (domain event vs. integration event, cross-aggregate references, entity vs. value object). These three are the most frequently asked screening questions. If you cannot answer them fluently with domain-specific examples, you will not reach the design questions.

For the design questions (7 through 10), practice sketching context maps with named integration patterns, not just boxes and arrows. Interviewers at Google, Meta, and Amazon explicitly look for pattern names. "These two services communicate" is not an answer. "This is a Customer-Supplier relationship because the Inventory team publishes a stable API that Orders depends on, and Orders negotiates new endpoints as needed" is an answer.

For the Go-specific questions (11 through 14), the key preparation is being able to write the code from memory: a value object with unexported fields and a validating constructor, a repository interface declared in the domain package, and the wiring in `main.go`. Being able to write these without hesitation signals that you have actually built DDD systems in Go, not just read about them.

A preparation exercise: take the hotel booking domain from question 7 and implement the `Reservation` aggregate from question 8 in Go from scratch. Then write the repository interface, the in-memory implementation, and the application service for "create a reservation." This end-to-end exercise surfaces every conceptual gap that flashcard preparation misses.

### Senior @ FAANG: Bar-Raiser Signals and Differentiation at L6/L7

The bar-raiser at FAANG is looking for evidence that you have operated DDD systems in production at scale, not just designed them. The differentiation between an L5 and an L6 answer is almost always in the operational and governance dimensions.

**Signal: naming failure modes before being asked.** An L6 candidate answers "how do you publish domain events reliably?" by immediately mentioning the two-phase-commit problem (write to DB, publish to bus, crash in between), the Outbox pattern as the solution, the idempotency requirement on consumers, and the DLQ strategy for failed deliveries. An L5 candidate describes the happy path and waits for the interviewer to probe the failure cases.

**Signal: citing real cost and trade-offs for every design decision.** An L6 candidate who proposes an Anti-Corruption Layer immediately notes its maintenance cost (the translator must be updated when the upstream changes) and how that cost is managed (contract tests against recorded fixtures, a deprecation notice process for upstream changes). An L5 candidate says "add an ACL" without acknowledging the ongoing cost.

**Signal: connecting architectural decisions to team and organizational structure.** An L6 candidate asked "how would you split this monolith?" starts with Conway's Law: "First, show me the org chart. The team boundaries will predict where the natural seams are, and if we draw context boundaries that don't align with team ownership, we'll get integration failures from misaligned incentives." An L5 candidate jumps straight to service decomposition without considering team structure.

**Signal: proposing governance mechanisms, not just patterns.** An L6 candidate does not just propose a context map. They describe how the context map is maintained (as a machine-readable artifact in the service catalog), who reviews it (an architecture forum), and what triggers a review (any new inter-service dependency proposal). An L5 candidate proposes a context map diagram without addressing how it stays accurate over time.

**The staff-level differentiation at L7.** Staff and principal-level candidates are expected to address the organization's DDD maturity as a whole: which teams are at which maturity level, what the migration path is from anemic models to rich domain models for teams that are not there yet, and how to make the architecture self-reinforcing (lint rules, contract tests, architecture review processes) so that the system does not regress after the initial design work is done. This platform-level thinking is what separates the L7 system design answer from the L6 system design answer.

---
