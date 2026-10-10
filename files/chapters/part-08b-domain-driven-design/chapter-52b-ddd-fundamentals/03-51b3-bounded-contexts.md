## 52B.3 Bounded Contexts

### Defining Boundaries

A Bounded Context is an explicit boundary within which a particular domain model applies and the Ubiquitous Language is precise and consistent. Inside the boundary, every term has exactly one meaning. Outside the boundary, the same word may mean something completely different.

Consider the word "Customer" in an e-commerce platform:

- In the **Order Context**, a Customer is someone who places orders. We care about their shipping addresses and order history.
- In the **Marketing Context**, a Customer is a target for campaigns. We care about their demographics, purchase frequency, and email preferences.
- In the **Support Context**, a Customer is a person with a support ticket. We care about their issue history and satisfaction scores.

These are genuinely different models that happen to use the same word. Forcing them into a single "Customer" model produces a god object that satisfies nobody perfectly. Bounded Contexts let each area of the system have its own precise model.

```
┌──────────────────────────────────────────────────────────────────┐
│                    E-Commerce Platform                           │
│                                                                  │
│  ┌────────────────┐     ┌────────────────┐   ┌────────────────┐  │
│  │ Order Context  │     │Marketing       │   │Support         │  │
│  │                │     │Context         │   │Context         │  │
│  │ Customer {     │     │ Customer {     │   │ Customer {     │  │
│  │   ID           │     │   ID           │   │   ID           │  │
│  │   ShipAddrs    │     │   Segment      │   │   OpenTickets  │  │
│  │   OrderHistory │     │   CampaignPref │   │   SatScore     │  │
│  │ }              │     │ }              │   │ }              │  │
│  └────────────────┘     └────────────────┘   └────────────────┘  │
│                                                                  │
│  "Customer" means something different in each context            │
└──────────────────────────────────────────────────────────────────┘
```

### Context Mapping Patterns

Context Maps describe the relationships between bounded contexts. Eric Evans and later Martin Fowler and Sam Newman defined several relationship patterns:

#### Partnership

Two contexts evolve together. Teams coordinate tightly. Changes in one context require coordinated changes in the other.

```
┌─────────────┐  ←── coordinated evolution ───→  ┌─────────────┐
│ Order       │                                  │ Inventory   │
│ Context     │ ◄─────────────────────────────── │ Context     │
└─────────────┘                                  └─────────────┘
```

*Use when*: Two contexts must change together frequently and teams can coordinate closely.

#### Shared Kernel

Two contexts share a small, explicitly defined subset of the domain model. Both teams must agree before changing the shared code.

```go
// shared kernel - owned jointly, changed only by mutual agreement
package sharedkernel

type CustomerID string
type ProductSKU string
type Money struct {
    AmountCents int64
    Currency    string
}
```

*Use when*: The cost of translation between two similar models is too high, but the contexts are owned by teams who can coordinate.

#### Customer-Supplier

The upstream context (Supplier) provides data or services to the downstream context (Customer). The downstream defines what it needs, and the upstream tries to accommodate.

```
┌─────────────┐                          ┌─────────────┐
│ Inventory   │ ──── provides data ────► │ Order       │
│ (Upstream/  │                          │ (Downstream/│
│  Supplier)  │                          │  Customer)  │
└─────────────┘                          └─────────────┘
```

*Use when*: One team depends on another and there is a clear direction of dependency.

#### Conformist

The downstream context accepts the upstream model as-is, without translation. The downstream team conforms to whatever the upstream publishes.

*Use when*: The upstream team has no incentive to accommodate the downstream, and the downstream has no leverage.

#### Anti-Corruption Layer (ACL)

The downstream context builds a translation layer that converts the upstream model into its own model. The domain is protected from upstream changes.

```
┌─────────────┐    ┌─────────────────┐    ┌─────────────┐
│  External   │    │  Anti-Corruption│    │  Your       │
│  Payment    │───►│  Layer          │───►│  Domain     │
│  Gateway    │    │  (Translator)   │    │  Model      │
└─────────────┘    └─────────────────┘    └─────────────┘
```

*Use when*: The upstream model is poor quality, uses different language, or changes frequently in ways that would otherwise pollute your domain.

#### Open Host Service

The upstream context defines a formal protocol (API) that downstream contexts can use. The protocol is published and stable.

#### Published Language

Similar to Open Host Service but more formal - the upstream publishes a well-documented data exchange format (like an event schema or API specification) that downstream contexts consume.

### Bounded Contexts in Go Microservices

In a Go microservices architecture, the most common mapping is one bounded context per service, one Go module per service:

```
ecommerce/
├── order-service/          # Order Bounded Context
│   ├── go.mod
│   ├── internal/
│   │   ├── domain/
│   │   ├── application/
│   │   └── infrastructure/
│   └── cmd/
├── inventory-service/      # Inventory Bounded Context
│   ├── go.mod
│   ├── internal/
│   └── cmd/
├── payment-service/        # Payment Bounded Context
│   ├── go.mod
│   ├── internal/
│   └── cmd/
└── shared/                 # Shared Kernel (minimal!)
    ├── go.mod
    └── events/             # Published event schemas
```

The `internal/` directory enforces the bounded context boundary at the Go compiler level. No other service can import your domain types directly - they must go through your public API.

### Junior → FAANG: Reading a Context Map and Knowing Your Integration Pattern

The most common confusion for engineers new to DDD is treating every inter-service call as equivalent. Recognizing the pattern behind each call matters because it sets expectations about who is responsible for compatibility when something changes.

If your service is a Conformist with respect to an upstream, you accept that upstream's schema changes as-is and update your code accordingly. That is a low-leverage position, and knowing you are in it helps you argue for better API governance from the upstream team. If your service has an Anti-Corruption Layer, you own the translation code and the upstream can change more freely without breaking your domain logic. That is a more effective position but it costs translation maintenance.

For interviews, the context map question typically comes in the form of a design scenario: "Design the services for a food delivery platform." The entry-level answer names the services. The mid-level answer names the services and their relationships. The FAANG bar expects you to name the integration pattern for each relationship and justify it.

A concrete first-job skill: when you add a new external API call, ask explicitly which pattern you are implementing. If you are calling a third-party service, you need an ACL so its error codes and data shapes do not leak into your domain. If you are calling an internal service owned by another team, you need either a Customer-Supplier agreement (they commit to supporting your needs in their API roadmap) or an ACL on your side (you translate their model). Making this decision explicit in the code review prevents future breakage from being a surprise.

### Senior @ FAANG: Context Map Governance, Seam Discovery, and Decomposition Strategy

Bounded context design at the senior level is about organizational scalability as much as technical scalability. The context map is the architectural artifact that makes organizational decisions legible: who is responsible for what, who can break whom, and where integration risk concentrates.

**Seam discovery methodology.** The most reliable way to find bounded context boundaries in an existing system is linguistic analysis combined with change frequency analysis. Linguistic analysis: find every place the same word is used to mean different things. Change frequency analysis: group the files that change together in git log and the files that never change together. High co-change cohesion and low cross-group change coupling is a strong signal for a natural boundary. When these two analyses agree, the boundary is real. When they disagree, investigate: either the current code structure is not aligned with the natural domain structure, or the domain experts have more than one valid view of the boundary.

**Integration pattern selection criteria.** The choice of integration pattern is a risk and cost trade-off. Partnership has the highest coordination cost but the lowest translation cost. Conformist has zero upstream negotiation cost but creates downstream fragility. ACL has the highest implementation cost but the most downstream insulation. The senior engineer's job is to be explicit about this trade-off in the ADR and to revisit it when team structure changes (a Conformist relationship is fine when the upstream team is one Slack channel away. It is intolerable when that team is in a different business unit with a different roadmap).

**Shared Kernel governance.** The Shared Kernel is the most dangerous pattern in a microservices architecture because it creates a shared-ownership problem. Every team that imports the shared kernel has a veto on changes to it. At the L6 level, you should have a clear policy: the shared kernel contains only primitive domain identifiers (typed wrappers over UUIDs) and common value types with no behavior (Money, DateRange) that truly have no behavioral divergence across contexts. Any behavioral code that ends up in the shared kernel is a design smell indicating that the context boundaries were drawn incorrectly.

**Decomposition sequencing.** When a monolith needs to be broken into bounded contexts, the extraction order matters. Start with Generic subdomains (email, file storage): they have clear, stable interfaces, minimal domain entanglement, and teams feel the win quickly. Then extract Supporting subdomains at the boundaries that are already clean in the codebase. Extract Core Domain subdomains last and most carefully, because they carry the most complexity and the most organizational risk. The worst extraction mistake is carving out a Core Domain service from a monolith while leaving the data model shared. The new service calls back to the monolith's database or the monolith calls the new service's database, creating a distributed monolith with all the operational cost of microservices and none of the architectural independence. The rule: a context owns its data. If the data cannot be migrated at the time of extraction, the extraction is not ready.

**Bar-raiser context: identifying boundary smell in code review.** At the L6/L7 bar, candidates are expected to read a simplified architecture diagram or code sample and identify integration pattern violations. Common violations: a service directly importing domain types from another service's package (boundary violation), a shared database table written by two services (implicit Shared Kernel that is not governed), an event handler in Service A that calls Service B synchronously as part of processing (hidden coupling that turns eventual consistency into synchronous coupling). Naming these violations precisely, explaining their consequences, and proposing the correct pattern with implementation guidance is the L6 standard.

---
