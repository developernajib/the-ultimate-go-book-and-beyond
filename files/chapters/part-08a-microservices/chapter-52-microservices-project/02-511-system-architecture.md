## 52.1 System Architecture

### Architecture Overview

The architecture diagram below provides a high-level view of the system's components and their interactions. Understanding this structure clarifies the data flow, the points where failures can occur, and where each cross-cutting concern (security, observability, caching) should be applied.

**Communication rules of thumb (2026).** Use **gRPC** (HTTP/2 + protobuf) for synchronous service-to-service queries where the caller genuinely needs an answer to continue, for example, the order service asking the product service for a current price during checkout. Use **asynchronous events** (Kafka or NATS JetStream) for everything that expresses a state change the rest of the system should react to, `OrderCreated`, `PaymentProcessed`, `InventoryReserved`. Async events decouple producers from the number and identity of consumers, absorb traffic spikes, and make compensation (the saga's rollback path) natural to express. If you find yourself doing a fan-out of synchronous calls across more than two services, that is almost always a signal to flip the interaction to events and let each consumer subscribe.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              API Gateway                                │
│                         (Authentication, Routing)                       │
└─────────────────────────────────────────────────────────────────────────┘
                                      │
        ┌─────────────┬───────────────┼───────────────┬─────────────┐
        ▼             ▼               ▼               ▼             ▼
┌──────────────┐┌──────────────┐┌──────────────┐┌──────────────┐┌──────────────┐
│    User      ││   Product    ││  Inventory   ││    Cart      ││    Order     │
│   Service    ││   Service    ││   Service    ││   Service    ││   Service    │
│              ││              ││              ││              ││   (Saga)     │
│  PostgreSQL  ││  PostgreSQL  ││  PostgreSQL  ││    Redis     ││  PostgreSQL  │
└──────────────┘└──────────────┘└──────────────┘└──────────────┘└──────────────┘
        │             │               │               │             │
        └─────────────┴───────────────┴───────────────┴─────────────┘
                                      │
                         ┌────────────┴────────────┐
                         ▼                         ▼
                  ┌──────────────┐          ┌──────────────┐
                  │   Payment    │          │ Notification │
                  │   Service    │          │   Service    │
                  │              │          │              │
                  │  PostgreSQL  │          │  PostgreSQL  │
                  └──────────────┘          └──────────────┘
                                      │
                         ┌────────────┴────────────┐
                         ▼                         ▼
                  ┌──────────────┐          ┌──────────────┐
                  │    Kafka     │          │   Consul     │
                  │  (Events)    │          │  (Discovery) │
                  └──────────────┘          └──────────────┘
```

### Project Structure

The directory layout below reflects a clean separation of concerns: commands and entry points live under `cmd/`, reusable packages under `internal/`, and public APIs under `pkg/`. This structure scales from a small tool to a production codebase by keeping each package focused on a single responsibility.

```
ecommerce/
├── cmd/
│   ├── gateway/
│   │   └── main.go
│   ├── user-service/
│   │   └── main.go
│   ├── product-service/
│   │   └── main.go
│   ├── inventory-service/
│   │   └── main.go
│   ├── cart-service/
│   │   └── main.go
│   ├── order-service/
│   │   └── main.go
│   ├── payment-service/
│   │   └── main.go
│   └── notification-service/
│       └── main.go
├── internal/
│   ├── user/
│   │   ├── handler.go
│   │   ├── service.go
│   │   ├── repository.go
│   │   └── model.go
│   ├── product/
│   ├── inventory/
│   ├── cart/
│   ├── order/
│   ├── payment/
│   └── notification/
├── pkg/
│   ├── events/
│   │   ├── types.go
│   │   ├── producer.go
│   │   └── consumer.go
│   ├── gateway/
│   ├── saga/
│   └── common/
│       ├── config.go
│       ├── logger.go
│       └── middleware.go
├── proto/
│   ├── user.proto
│   ├── product.proto
│   ├── inventory.proto
│   └── order.proto
├── deployments/
│   ├── docker-compose.yml
│   └── k8s/
└── go.mod
```

### Junior → FAANG: Reading Architecture Diagrams as Design Decisions

The diagram above is not decoration. Every connection and every absence of a connection is a design decision. Training yourself to read architecture diagrams as a series of decisions is one of the most transferable skills for FAANG system design interviews.

**What each connection type tells you.** The API gateway connects to every service: this is a single ingress point, which centralizes authentication, rate limiting, and routing but also creates a single point of failure. Each service connects to its own database: this enforces data ownership but means you cannot write a join across the user table and the order table at the database level. The Kafka bus appears below all services: this means events are the integration mechanism for state changes, not direct calls.

**What the absence of connections tells you.** The notification service has no outbound synchronous calls. It only reacts to events. This means the notification service can be taken down for maintenance without affecting order creation. This is the resilience win that async communication provides.

**Reading the project structure.** The `cmd/` layout puts each service entry point in its own directory. This means a single Go module can produce eight binaries, one `go build ./cmd/user-service/...` per service. The `internal/` layout prevents importing one service's code from another, enforcing the boundary at the compiler level. The `pkg/` layout signals shared library code that multiple services import, the events package and the common middleware.

**First-job habit: draw this diagram for your own systems.** Before your next code review, sketch the service graph for the feature you are building. Identify every synchronous call and every event. Then ask: which calls are on the critical path, and which could be made async to improve resilience?

For an interview warm-up, practice explaining this diagram in under two minutes: "We have eight services, each with its own database. The API gateway is the single external ingress. Services communicate synchronously via gRPC for queries where the caller needs an immediate answer, and asynchronously via Kafka for state changes. The order service uses a saga to coordinate the distributed checkout transaction."

### Senior @ FAANG: Architecture as an Organizational Artifact

At staff level, an architecture diagram carries organizational information as much as technical information. The connections between services describe not just data flow but team dependency, on-call blast radius, and deployment coupling.

**Blast radius analysis.** For each service in the diagram, identify the maximum number of user-facing features that degrade if that service goes down. The API gateway going down degrades everything. The notification service going down degrades only notification delivery, not checkout. This blast radius analysis drives SLO tiering: services with a higher blast radius warrant more redundancy, more aggressive circuit breaking, and a more conservative change management process.

**Identifying hidden coupling in the project layout.** The `internal/order/service.go` file imports `example.com/ecommerce/internal/inventory` and `example.com/ecommerce/internal/cart`. This is an in-process dependency. In this project that is intentional, the services share a binary for simplicity. In production, each service is a separate binary and these imports become network calls. The project layout is a useful intermediate step, but the moment you split deployments, the Go import graph stops enforcing the boundary and you need interface contracts and integration tests to prevent regression.

**Evaluating the structure for a real ADR.** A staff engineer writing the ADR for this project layout would note: the monorepo structure (single `go.mod`) makes it easy to share the `pkg/events` package without versioning, and easy to run integration tests across services. The cost is that a build break in one service's dependencies blocks all services. The alternatives are a polyrepo (each service in its own repository, with versioned event package releases) or a monorepo with per-service `go.mod` files. The ADR choice depends on team size, release cadence, and how often the event schema changes.

**Governance for the `pkg/` boundary.** The `pkg/events` and `pkg/common` packages are the platform library boundary. At scale, changes to these packages require an RFC, a deprecation period, and notification to all consumers. A governance process that is not established early gets retrofitted painfully later. The staff-level action is to establish the process before the second service imports from `pkg/`, not after the fifth service does.

---
