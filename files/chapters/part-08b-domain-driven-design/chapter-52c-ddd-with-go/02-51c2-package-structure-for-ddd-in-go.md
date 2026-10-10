## 52C.2 Package Structure for DDD in Go

### The Standard Layered Architecture

DDD applications are typically organized into four layers:

```
┌─────────────────────────────────────────────────────────────┐
│  Interfaces Layer (HTTP, gRPC, CLI, message consumers)      │
│  - Translates transport protocols to application commands   │
│  - Translates domain errors to transport errors             │
└──────────────────────────┬──────────────────────────────────┘
                           │ uses
┌──────────────────────────▼──────────────────────────────────┐
│  Application Layer                                          │
│  - Command handlers, query handlers                         │
│  - Use case orchestration                                   │
│  - Transaction boundaries                                   │
└──────────────────────────┬──────────────────────────────────┘
                           │ uses
┌──────────────────────────▼──────────────────────────────────┐
│  Domain Layer                                               │
│  - Entities, value objects, aggregates                      │
│  - Domain services                                          │
│  - Repository interfaces (contracts)                        │
│  - Domain events                                            │
└──────────────────────────▲──────────────────────────────────┘
                           │ implements interfaces defined in
┌──────────────────────────┴──────────────────────────────────┐
│  Infrastructure Layer                                       │
│  - Repository implementations (PostgreSQL, Redis, etc.)     │
│  - External service adapters (Stripe, SendGrid, etc.)       │
│  - Message publisher/consumer implementations               │
└─────────────────────────────────────────────────────────────┘
```

The critical rule: **dependencies point inward toward the domain**. The domain depends on nothing. The application layer depends on the domain. Infrastructure depends on both domain (to implement interfaces and use types) and application (for command/query types). Interfaces depends on application and infrastructure.

### Go Project Layout for a Single Bounded Context

Each bounded context gets its own service with independent domain, application, and infrastructure layers. The directory structure below shows how these layers map to Go packages.

```
order-service/
├── cmd/
│   ├── server/
│   │   └── main.go                    # HTTP/gRPC server entrypoint
│   └── worker/
│       └── main.go                    # Background job entrypoint
├── internal/
│   ├── domain/
│   │   └── order/                     # The order bounded context domain
│   │       ├── aggregate.go           # Order aggregate root
│   │       ├── order_line.go          # OrderLine entity
│   │       ├── value_objects.go       # Money, ShippingAddress, Quantity, etc.
│   │       ├── events.go              # Domain events
│   │       ├── repository.go          # Repository interface (contract)
│   │       ├── pricing_service.go     # Domain service
│   │       ├── reconstitute.go        # Reconstitution factory
│   │       └── errors.go              # Domain errors
│   ├── application/
│   │   └── order/
│   │       ├── commands.go            # Command types
│   │       ├── queries.go             # Query types and results
│   │       ├── place_order.go         # PlaceOrder command handler
│   │       ├── cancel_order.go        # CancelOrder command handler
│   │       ├── confirm_order.go       # ConfirmOrder command handler
│   │       ├── fulfill_order.go       # FulfillOrder command handler
│   │       └── get_order.go           # GetOrder query handler
│   └── infrastructure/
│       ├── persistence/
│       │   ├── postgres_order_repo.go # PostgreSQL repository impl
│       │   └── memory_order_repo.go   # In-memory repository (tests)
│       ├── messaging/
│       │   ├── kafka_publisher.go     # Kafka event publisher
│       │   └── outbox.go              # Transactional outbox pattern
│       └── payment/
│           └── stripe_gateway.go      # Stripe ACL
├── interfaces/
│   ├── http/
│   │   ├── router.go                  # Route registration
│   │   ├── order_handler.go           # HTTP handlers for order endpoints
│   │   └── middleware.go              # Auth, logging, CORS middleware
│   └── grpc/
│       ├── order_server.go            # gRPC server implementation
│       └── proto/                     # Generated protobuf code
├── migrations/
│   ├── 001_create_orders.sql
│   ├── 002_create_order_lines.sql
│   └── 003_create_outbox.sql
├── go.mod
└── go.sum
```

### Multi-Bounded-Context Layout

For a platform with multiple bounded contexts as separate services:

```
ecommerce-platform/
├── services/
│   ├── order-service/          # Order bounded context
│   │   ├── cmd/
│   │   ├── internal/
│   │   └── go.mod
│   ├── inventory-service/      # Inventory bounded context
│   │   ├── cmd/
│   │   ├── internal/
│   │   └── go.mod
│   ├── payment-service/        # Payment bounded context
│   │   ├── cmd/
│   │   ├── internal/
│   │   └── go.mod
│   └── notification-service/   # Notification bounded context
│       ├── cmd/
│       ├── internal/
│       └── go.mod
├── shared/                     # Shared kernel - keep minimal
│   ├── go.mod
│   ├── events/                 # Published integration event schemas
│   │   ├── order_events.go
│   │   ├── payment_events.go
│   │   └── inventory_events.go
│   └── types/
│       └── money.go            # Shared Money type for cross-service use
└── tools/
    ├── protobuf/               # Shared protobuf definitions
    └── openapi/                # Shared OpenAPI specifications
```

The `shared` module is the **Shared Kernel** - it should be kept absolutely minimal. Only put things here that truly must be shared and that all owning teams agree to change together.

### Layout Anti-Patterns to Avoid

Several layout patterns get copied from Java/Spring or C#/.NET codebases and hurt Go projects:

- `/controllers`, `/services`, `/repositories`, `/entities` at the top level. This spreads one bounded context across four directories. Moving a feature means editing four files in four packages. In Go, prefer organizing by domain concept first (`internal/order/`), then by layer within that concept. A single feature change stays in one subtree.
- A `models/` package with every struct in the project. Shared `models/` is where encapsulation goes to die. Domain types belong inside the domain package that owns them. If another context truly needs to reference them, publish an integration event schema instead.
- `utils/` or `helpers/` that every layer imports. This creates an acyclic-dependency-violating hub. If a utility is domain-specific, put it in the domain package. If it is infrastructure-specific, put it in infrastructure. If it is generic, prefer inlining or pushing it upstream to a separate module with its own tests.
- Deep nesting for its own sake. `internal/domain/aggregates/order/entities/order.go` tells the reader nothing that `internal/order/order.go` would not. Flat is better than nested.

### Enforcing the Direction of Dependencies

Go offers two mechanical checks:

1. **`internal/` directories.** A package under `internal/` can only be imported from packages rooted at the parent of `internal/`. This prevents other modules from reaching into your service's innards and accidentally coupling to its domain types.
2. **Import linters.** `go-arch-lint`, `import-boss`, or a simple `go vet` plugin can encode rules like "nothing under `internal/domain/` may import `database/sql` or `net/http`". Run this in CI. Drift is inevitable without it.

If neither is in place, expect the layering to rot within two quarters of active development.

---

### Junior → FAANG: Reading Package Structure as Architecture

When you join a new codebase, the directory tree tells you something before you read a single line of code. Learning to read it critically is a first-job skill that accelerates onboarding and flags architectural risk early.

Signs of a healthy DDD package structure in Go: bounded contexts have their own subtrees under `internal/`. The `domain` package inside each subtree has no third-party imports. The `infrastructure` package has no business logic files (no `pricing_service.go`, no files with `if order.Status == "pending"` logic). A `shared/` or `pkg/` module exists but contains fewer than five packages. Test files are next to the code they test, not in a top-level `tests/` folder.

Signs of a decayed structure: a top-level `models/` or `types/` package with 40+ files. A `services/` folder that mixes HTTP handlers, database calls, and business rules. A `domain/` folder that contains `postgres_repository.go`. any file under `domain/` that imports `github.com/lib/pq` or `encoding/json` (JSON tags are not domain concerns).

For a first-job interview, practice the following: take any open-source Go project that claims DDD and spend 10 minutes analyzing its package structure. Identify three things it does well and one thing it would do differently based on what you learned here. Companies at FAANG level ask candidates to critique a fictional codebase in system design interviews. Having practiced this on real open-source code makes the answer concrete.

### Senior @ FAANG: Package Structure as an Organizational Contract

At the staff level, package structure is not a personal preference: it is a contract between teams, enforced by tooling, and evaluated in service reviews. The decisions made here have a compounding effect over the lifetime of the platform.

**The monorepo layout decision.** Whether bounded contexts live in one monorepo (`services/order/`, `services/inventory/`) or in separate repositories is a platform governance call, not a service-level call. The monorepo option reduces the overhead of shared kernel versioning (you can make atomic cross-service changes), but it also creates implicit coupling if CI is not partitioned correctly. The separate-repo option enforces context isolation by default (you cannot import across repos without an explicit module dependency), but it multiplies CI pipelines and makes shared-kernel evolution heavyweight. At Google-scale, monorepo wins. At a 20-engineer startup with three contexts, separate repos are simpler. A Staff engineer needs a clear recommendation and a set of criteria that justify it for the specific organization.

**The `shared/` kernel discipline.** Shared kernels rot because every team has an incentive to add to them and no team has an incentive to remove from them. A healthy platform has a formal process: anything added to `shared/` requires sign-off from two or more context teams, a stability commitment (the type will not break for at least one major version), and a deprecation plan. The shared kernel should shrink over time as integration event schemas mature. If it is growing, that is a signal that context boundaries are wrong.

**Import lint as a maturity signal.** The question "do you run import linting in CI?" is a surprisingly strong signal of platform maturity. Teams that do not have it believe the rules are followed because the last code review caught it. Teams that do have it know exactly which packages violate the rules, because the tool generates a violation report on every PR. Implementing `go-arch-lint` is a one-day task. The reason it is not done is not technical: it is because someone has to decide on the rules, own the configuration, and resolve disagreements when a rule is violated intentionally. That is a staff-level responsibility.

**Enforcing structure across team boundaries.** In a multi-team environment, each team will interpret "domain layer" slightly differently. Left unchecked, each service will have a different convention within six months. Standardization options: (a) a service template (Go module with the correct package structure, pre-wired with the correct linting rules) that all new services clone, and (b) a platform chapter or guild that owns the architectural standards and reviews new services at inception. (c) a tool (like `go-scaffold` or an internal CLI) that generates the correct structure from a spec. Option (c) is the most durable because it makes the correct choice the easy choice, without requiring cultural enforcement.

---
