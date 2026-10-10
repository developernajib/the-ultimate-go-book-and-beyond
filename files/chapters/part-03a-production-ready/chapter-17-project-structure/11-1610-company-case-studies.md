## 17.10 Company Case Studies

### Google: Monorepo Structure

Google famously keeps most of its code in a single monorepo, and that repository is not public, so treat any directory tree attributed to it with suspicion. What is public and worth studying is the Google Cloud Go SDK, which is a large, multi-team, generated-plus-handwritten Go codebase maintained under the same engineering culture. Its layout is real and you can go read it:

```
google-cloud-go/          # cloud.google.com/go
├── storage/              # one module per product area
│   ├── client.go
│   └── client_test.go
├── pubsub/
├── bigquery/
├── internal/             # shared plumbing, not importable by users
│   └── ...
└── ...

go-genproto/              # google.golang.org/genproto
└── ...                   # generated protobuf stubs, a SEPARATE repo
```

The structural lessons hold regardless of what the internal monorepo looks like: packages are addressed by full import path, `internal/` keeps shared plumbing from becoming public API that must be supported forever, generated protobuf code is kept away from hand-written source (here, in an entirely separate repository), and tests sit next to the code they cover.

### Uber: A Uniform Service Skeleton

Uber has written publicly about consolidating its Go code into a monorepo and about the tooling that required. The specific per-service skeleton below is not something Uber publishes file by file, so read it as a representative shape of the pattern rather than a screenshot of their repo. The pattern itself is common at companies running many services in one language:

```
service/
├── cmd/
│   └── service/
│       └── main.go
├── config/
│   └── config.go
├── handler/
│   └── handler.go
├── client/
│   └── client.go   # for other services to import
├── gen/            # generated code
└── testutil/
    └── ...
```

The idea worth stealing is `client/`. When a service ships the client its consumers use, the consumers stop hand-rolling HTTP calls against a URL and a JSON shape they inferred from a wiki page. The client is versioned with the server, so a breaking change to the API is a compile error in the caller rather than a 4xx in production. That is a strong pattern independent of whose logo is on it.

**Key practices:**
- Each service provides a client package, versioned alongside the server
- Configuration is strongly typed rather than map-of-string
- Generated code is quarantined so diffs stay reviewable
- Test utilities are shared rather than copy-pasted per service

### Netflix: Domain-Driven Structure

The best-documented public example of Netflix separating framework-agnostic core logic from platform-specific adapters is its API gateway Zuul. Zuul is a Java project, so what follows is a structural lesson rather than a Go one, but it translates directly: routing and filter logic live in a core module with no Netflix-specific dependencies, while discovery and metrics live in a separate Netflix-flavored module. The split is visible in the module names themselves, which is what makes it a good teaching example.

```
zuul/
├── zuul-core/
│   ├── routing/
│   ├── filters/
│   └── context/
├── zuul-netflix/
│   ├── discovery/
│   └── metrics/
└── zuul-simple/
    └── ...
```

**Principles:**
- Core domain logic is framework-agnostic
- Platform-specific code is in separate modules
- Clear dependency direction (core ← specific)

### Payments-Style Clean Architecture

Stripe does not publish its internal service layouts, and its payments core is famously multi-language with a large Ruby footprint, so nothing below should be read as "how Stripe does it". What follows is what a payments-grade Go service looks like when built on clean-architecture principles, which is a useful shape regardless of who uses it: business entities in `domain/` with zero external dependencies, use cases in `application/` that orchestrate workflows without knowing whether they were invoked via HTTP or gRPC, and infrastructure adapters in `infrastructure/` that can be swapped independently during testing or migration.

The reason this shape earns its ceremony in payments specifically is that the domain rules are the hard part. Idempotency, currency handling, refund eligibility, and ledger invariants are intricate, they change slowly, and they must be tested exhaustively without a database in the loop. That is exactly the condition under which isolating the domain pays for itself. Apply the same layout to a service that mostly forwards JSON to another service and all you have bought is four extra directories.

```
payments/
├── cmd/
│   └── api/
├── internal/
│   ├── domain/           # Business entities
│   │   ├── charge/
│   │   └── customer/
│   ├── application/      # Use cases
│   │   ├── createcharge/
│   │   └── refund/
│   ├── infrastructure/   # External services
│   │   ├── persistence/
│   │   └── messaging/
│   └── interfaces/       # Entry points
│       ├── http/
│       └── grpc/
```

**Benefits:**
- Business logic has no external dependencies
- Infrastructure is easily swappable
- Use cases are explicit and testable

### Staff Lens: The Right Layout for Your Service

Each layout above fits a particular scale and complexity. Copying the hexagonal payments layout for a CRUD API is over-engineering. Copying the thin per-service skeleton for a service with genuinely complex domain rules leaves money on the table, since that skeleton is organized by technical role (`handler/`, `config/`) and works precisely because each service is small enough that the flat shape never strains. Match the layout to the problem.

The common mistake: new teams pick the "fanciest" layout without understanding why their chosen example used it. Clean Architecture is great when the business logic is complex. It adds ceremony when the service is mostly glue code. Pick honestly.

### Principal Lens: Layout Evolves With the Service

A service's layout at year one is often wrong for year three. As the domain grows, simple layouts need more structure. As the team scales, shared code needs stronger boundaries. Evolve deliberately. Do not rewrite. Refactor incrementally. Principal engineers notice when the layout is holding the service back and initiate the evolution before it becomes a mandatory rewrite.

---
