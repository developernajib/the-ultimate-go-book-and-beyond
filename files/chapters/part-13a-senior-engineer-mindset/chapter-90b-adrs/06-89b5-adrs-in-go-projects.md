## 90B.5 ADRs in Go Projects

Go projects have a well-established convention for directory layout, and ADRs fit naturally into that structure. This section covers where to store ADR files in a Go repository, how to name them so they sort correctly and are easy to find, and how to link ADRs from your Go source code so that engineers discover the relevant decision record when they encounter an unfamiliar pattern. Getting these conventions right from the start means that your ADRs remain discoverable as the project grows from a handful of services to dozens.

### Where to Store ADRs

The canonical location for ADRs in a Go project is `docs/adr/`. This placement:

- Co-locates architectural documentation with the code it documents
- Makes ADRs version-controlled alongside the code
- Survives team migrations between documentation platforms
- Is discoverable via repository search

For a monorepo with multiple services:

```
my-monorepo/
├── docs/
│   └── adr/                    # Cross-cutting ADRs
│       ├── 0001-use-postgresql.md
│       ├── 0002-use-grpc.md
│       └── 0003-use-zerolog.md
├── services/
│   ├── order/
│   │   ├── docs/
│   │   │   └── adr/            # Order service-specific ADRs
│   │   │       └── 0001-event-sourcing.md
│   │   └── ...
│   └── user/
│       ├── docs/
│       │   └── adr/            # User service-specific ADRs
│       │       └── 0001-postgresql-user-service.md
│       └── ...
└── ...
```

Cross-cutting ADRs (protocol choice, logging library, deployment platform) live in the root `docs/adr/`. Service-specific ADRs (event sourcing in the order service) live in the service's `docs/adr/`.

### ADR Naming Conventions

Use zero-padded sequential numbers with kebab-case descriptive names:

```
0001-use-postgresql-for-user-service.md
0002-use-grpc-for-internal-communication.md
0003-adopt-zerolog-for-structured-logging.md
0004-event-sourcing-for-order-service.md
0005-kubernetes-for-container-orchestration.md
```

**Conventions:**
- **Zero-pad to 4 digits**: `0001`, not `1`. Ensures correct alphabetical sorting for up to 9,999 ADRs.
- **Kebab-case**: `use-postgresql-for-user-service`, not `UsePostgreSQLForUserService`
- **Verb-first when possible**: `use-`, `adopt-`, `migrate-`, `reject-`
- **No version numbers in filename**: Version is tracked by git history, not filename
- **Short but descriptive**: The filename should tell a new engineer what the ADR is about without opening it

### Linking ADRs to Code Comments

Co-locating ADRs with code is only half the discoverability solution. The other half is linking from code to ADRs. When an engineer encounters an architectural choice in code, they should be able to find the ADR that explains it.

**Pattern 1: Package-level doc comments**

```go
// Package order implements the order management service.
//
// This service uses event sourcing for order state management.
// See docs/adr/0004-event-sourcing-for-order-service.md for the
// architectural rationale and trade-offs.
//
// The order aggregate root is defined in aggregate.go.
// Event types are defined in events.go.
// The PostgreSQL event store implementation is in store/postgres.go.
package order
```

**Pattern 2: Inline comments for non-obvious decisions**

```go
// connectWithRetry implements exponential backoff for database connections.
//
// We use jitter (±20% of backoff interval) to prevent thundering herd
// when multiple services restart simultaneously after a database outage.
// See docs/adr/0008-database-connection-retry-strategy.md.
func connectWithRetry(ctx context.Context, dsn string) (*pgxpool.Pool, error) {
    // ...
}
```

**Pattern 3: Interface definitions**

```go
// EventStore defines the interface for persisting and retrieving
// domain events. We use an interface here (rather than depending
// directly on PostgreSQL) to satisfy the Dependency Inversion
// Principle and enable testing without a live database.
//
// The production implementation uses PostgreSQL.
// See docs/adr/0004-event-sourcing-for-order-service.md.
// The PostgreSQL implementation is in store/postgres/event_store.go.
type EventStore interface {
    AppendEvents(ctx context.Context, aggregateID uuid.UUID, events []Event, expectedVersion int) error
    LoadEvents(ctx context.Context, aggregateID uuid.UUID) ([]Event, error)
    LoadEventsFromVersion(ctx context.Context, aggregateID uuid.UUID, fromVersion int) ([]Event, error)
}
```

**Pattern 4: Build tag rationale**

```go
//go:build integration

// This file contains integration tests that require a running PostgreSQL
// instance. Run with: go test -tags integration ./...
//
// We separate integration tests from unit tests to keep CI feedback
// loops fast. See docs/adr/0009-test-strategy.md for the full
// test pyramid strategy.
package order_test
```

**Pattern 5: README.md in key packages**

For complex packages, a short README that links to relevant ADRs is more readable than dense comments:

```markdown
# internal/order

This package implements the order service business logic using
event sourcing.

## Architecture

- `aggregate.go`: Order aggregate root and state reconstruction
- `events.go`: All domain event types
- `commands.go`: Command handlers (CreateOrder, PayOrder, etc.)
- `store/`: Event store interface and implementations

## Related ADRs

- [ADR-004: Event Sourcing for Order Service](../../docs/adr/0004-event-sourcing-for-order-service.md)
- [ADR-007: Outbox Pattern for Reliable Event Publishing](../../docs/adr/0007-outbox-pattern.md)
```

### ADR Index File

Maintain an `docs/adr/README.md` as a human-readable index:

```markdown
# Architectural Decision Records

This directory contains the Architectural Decision Records (ADRs) for
the platform. Each ADR documents a significant architectural decision,
the context in which it was made, and its consequences.

## How to Create an ADR

1. Create a new file: `NNNN-short-description.md` (increment NNNN)
2. Use the template in `template.md`
3. Submit as a Pull Request with `adr:` prefix in the title
4. Request review from affected team leads
5. Update status to `Accepted` when merged

## Index

| # | Title | Status | Date |
|---|-------|--------|------|
| [0001](0001-use-postgresql-for-user-service.md) | Use PostgreSQL for User Service | Accepted | 2024-01-10 |
| [0002](0002-use-grpc-for-internal-communication.md) | gRPC Internal, REST External | Accepted | 2024-01-18 |
| [0003](0003-adopt-zerolog.md) | Adopt zerolog for Structured Logging | Accepted | 2024-02-05 |
| [0004](0004-event-sourcing-order-service.md) | Event Sourcing for Order Service | Accepted | 2024-03-12 |
| [0005](0005-kubernetes-eks.md) | Kubernetes on EKS | Accepted | 2024-01-05 |
```

### Junior → FAANG: Integrating ADRs Into Your Go Workflow From Day One

Go projects have a natural structure for ADRs because Go enforces a single module root and a consistent directory layout. The `docs/decisions/` or `docs/adr/` directory convention is simple to establish and easy to reference from code comments.

The highest-value practice for a junior Go engineer: when you write a non-obvious package or export a non-obvious API, add a comment at the package level that references the relevant ADR. Something as simple as `// See docs/decisions/0003-adopt-zerolog.md for context on the logging choice.` costs ten seconds and prevents the code archaeology that wastes hours. Make this a PR checklist item for yourself.

Go's explicit approach to dependency management, through `go.mod` and the module proxy, means that many dependency choices are permanently visible in version control. When you add a dependency that has non-obvious implications (a C dependency, a dependency with a viral license, a dependency that pins a specific OS), write an ADR. Future engineers doing dependency audits will find it.

### Senior @ FAANG: Go-Specific ADR Governance at Scale

Large Go codebases at FAANG (Google's monorepo, Uber's services, Cloudflare's infrastructure tooling) surface a Go-specific ADR governance problem: the module boundary question. When a monorepo contains hundreds of Go modules, which modules require ADRs for dependency decisions, and which are small enough that a PR description suffices?

The practical answer used at Google: ADRs are required for decisions that affect more than one module boundary, or that involve dependencies used by more than five teams. Within a single module, PR descriptions and code comments are sufficient. This scope rule produces a manageable ADR corpus without sacrificing governance where it matters.

The `go.sum` file is itself an audit artifact: it records the exact versions and content hashes of every direct and transitive dependency. Combining a complete ADR corpus with a properly maintained `go.sum` gives a security or compliance auditor everything they need to understand why a dependency is present and verify that it has not been tampered with. Staff engineers who frame ADRs as a compliance asset, rather than just a knowledge transfer tool, often find more organizational appetite for investment in the practice.

---
