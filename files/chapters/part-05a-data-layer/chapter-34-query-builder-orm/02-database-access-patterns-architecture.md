## Database Access Patterns Architecture

The diagram illustrates the tradeoffs between different data access patterns: raw `database/sql` for control, query builders for composability, and ORMs for convenience. Production systems often combine patterns, using the raw driver for bulk operations and an ORM for CRUD on domain entities.

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                    Database Access Tool Landscape                             │
├───────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  Application Layer                                                            │
│  ┌───────────────────────────────────────────────────────────────────────┐    │
│  │                           Service Layer                               │    │
│  │  ┌─────────────────────────────────────────────────────────────────┐  │    │
│  │  │                      Repository Interface                       │  │    │
│  │  │  type UserRepository interface {                                │  │    │
│  │  │      Create(ctx, user) error                                    │  │    │
│  │  │      GetByID(ctx, id) (*User, error)                            │  │    │
│  │  │      List(ctx, filter) ([]User, error)                          │  │    │
│  │  │      Update(ctx, user) error                                    │  │    │
│  │  │      Delete(ctx, id) error                                      │  │    │
│  │  │  }                                                              │  │    │
│  │  └─────────────────────────────────────────────────────────────────┘  │    │
│  └───────────────────────────────────────────────────────────────────────┘    │
│                                    │                                          │
│                    ┌───────────────┼───────────────┐                          │
│                    │               │               │                          │
│                    ▼               ▼               ▼                          │
│  ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐               │
│  │    Raw SQL       │ │  Query Builder   │ │      ORM         │               │
│  │  database/sql    │ │  sqlc/squirrel   │ │   GORM/bun       │               │
│  │                  │ │                  │ │                  │               │
│  │  ✓ Full control  │ │  ✓ Type safe     │ │  ✓ Rapid dev     │               │
│  │  ✓ Best perf     │ │  ✓ SQL power     │ │  ✓ Relations     │               │
│  │  ✗ Verbose       │ │  ✓ IDE support   │ │  ✓ Migrations    │               │
│  │  ✗ Manual types  │ │  ✗ Learning      │ │  ✗ Abstraction   │               │
│  └──────────────────┘ └──────────────────┘ └──────────────────┘               │
│                                    │                                          │
│  ┌─────────────────────────────────┴─────────────────────────────────────┐    │
│  │                         Database Driver Layer                         │    │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                 │    │
│  │  │    pgx/v5    │  │    lib/pq    │  │  go-mysql    │   ...           │    │
│  │  └──────────────┘  └──────────────┘  └──────────────┘                 │    │
│  └───────────────────────────────────────────────────────────────────────┘    │
│                                    │                                          │
└────────────────────────────────────┼──────────────────────────────────────────┘
                                     ▼
                              ┌──────────────┐
                              │   Database   │
                              └──────────────┘

sqlc Workflow:
┌──────────────────────────────────────────────────────────────────────────────┐
│                                                                              │
│  1. Write SQL        2. Generate Code       3. Use in App                    │
│                                                                              │
│  schema.sql          ┌───────────┐          queries := db.New(pool)          │
│  ┌─────────────┐     │           │          user, err := queries.            │
│  │ CREATE TABLE│     │   sqlc    │               GetUserByID(ctx, 1)         │
│  │ users (...) │───►│  generate │───►                                        │
│  └─────────────┘     │           │          // Type-safe, no reflection      │
│                      └───────────┘                                           │
│  queries.sql                                                                 │
│  ┌─────────────┐     Generated:                                              │
│  │ -- name:    │     - models.go    (structs)                                │
│  │ GetUserByID │     - queries.go   (methods)                                │
│  │ :one        │     - db.go        (interface)                              │
│  │ SELECT ...  │                                                             │
│  └─────────────┘                                                             │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘

GORM Query Pipeline:
┌──────────────────────────────────────────────────────────────────────────────┐
│                                                                              │
│   Application Code                                                           │
│   db.Where("status = ?", "active").Preload("Orders").Find(&users)            │
│                        │                                                     │
│                        ▼                                                     │
│   ┌────────────────────────────────────────────────────────────────────┐     │
│   │                      GORM Query Builder                            │     │
│   │  1. Parse conditions     4. Execute main query                     │     │
│   │  2. Build SQL            5. Execute preload queries                │     │
│   │  3. Apply scopes         6. Populate relationships                 │     │
│   └────────────────────────────────────────────────────────────────────┘     │
│                        │                                                     │
│                        ▼                                                     │
│   ┌────────────────────────────────────────────────────────────────────┐     │
│   │  SELECT * FROM users WHERE status = 'active'                       │     │
│   │  SELECT * FROM orders WHERE user_id IN (1, 2, 3, ...)              │     │
│   └────────────────────────────────────────────────────────────────────┘     │
│                        │                                                     │
│                        ▼                                                     │
│   ┌────────────────────────────────────────────────────────────────────┐     │
│   │                    Reflection-based Mapping                        │     │
│   │  - Scan rows into structs                                          │     │
│   │  - Associate relationships                                         │     │
│   │  - Handle callbacks (hooks)                                        │     │
│   └────────────────────────────────────────────────────────────────────┘     │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘

Trade-off Matrix:
┌──────────────────────────────────────────────────────────────────────────────┐
│                                                                              │
│               Control ◄─────────────────────────────────► Productivity       │
│                                                                              │
│   database/sql ──┬── sqlc ──┬── squirrel ──┬── SQLBoiler ──┬── GORM/bun      │
│                  │          │              │               │                 │
│   Max Control    │  Best    │  Dynamic     │  Database     │  Rapid          │
│   Max Perf       │  Balance │  Queries     │  First        │  Development    │
│   Manual Types   │  Type    │  SQL Power   │  Code Gen     │  Relations      │
│                  │  Safety  │              │               │  Migrations     │
│                                                                              │
│   Use for:       │  Use for:│  Use for:    │  Use for:     │  Use for:       │
│   • Performance  │  • Most  │  • Search    │  • Existing   │  • Prototypes   │
│     critical     │    apps  │    APIs      │    schemas    │  • CRUD apps    │
│   • Simple SQL   │  • Teams │  • Reports   │  • Complex    │  • Rapid dev    │
│   • Full control │    who   │  • Dynamic   │    relations  │  • Migrations   │
│                  │    know  │    filters   │               │                 │
│                  │    SQL   │              │               │                 │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Junior → FAANG: Reading the Architecture Diagram Like a Reviewer

The diagram is not a menu, it is a dependency graph. Read it top-down. The service layer depends on a `UserRepository` interface. The interface has exactly five methods. That count matters. If your interface grows to fifteen methods with names like `FindByEmailAndStatusAndOrgID`, you are pushing query logic into the interface name, which means your repository is leaking database concerns upward. A reviewer at a senior Go shop will push back and ask you to expose `List(ctx, filter)` with a structured `filter` value instead. The filter value is where the composition happens, and squirrel or sqlc named-parameters handle the dynamic shape below the interface.

Worked example. A junior PR adds `FindActiveByOrgID(ctx, orgID)` to the repository interface. The reviewer says: "Make it `List(ctx, ListUsersFilter{OrgID: &orgID, Status: &statusActive})` instead." Why. Adding a new filter field does not expand the interface. Adding a new sort order does not expand the interface. The interface stays at five methods and the filter struct absorbs variability. This is interface segregation (the I in SOLID) applied to data access.

Interview entry-point. When shown this diagram, do not narrate the boxes. Point at the arrow from service layer to repository interface and say: "The direction of this arrow is what matters. The service depends on an abstraction. The implementation is swappable. That means I can unit-test the service against an in-memory fake, and I can swap sqlc for GORM without touching business logic." That answer demonstrates you understand dependency inversion, which is the signal the interviewer is looking for.

### Senior @ FAANG: Driver Port, Adapter, and the Real Cost of Each Layer

The diagram undersells two things. First, the driver layer is not fungible. pgx/v5 speaks the Postgres binary protocol natively and supports `CopyFrom`, `pgx.Batch`, scan targets with `pgtype`, listen/notify, and prepared statement caching per connection. lib/pq speaks the text protocol, is archived, and should be treated as legacy. Any new Postgres-backed Go service in 2026 uses pgx directly or via sqlc's pgx driver. Mixing `database/sql` wrappers around pgx loses half of pgx's features, which is why sqlc's `sql_package: "pgx/v5"` option is the default for new pgx-based Go services.

Second, the "ORM" box collapses GORM, bun, ent, and sqlboiler into one shape, and that is wrong. bun is a query builder with struct mapping, not a full ORM. ent is a graph client that generates code, closer to sqlc in philosophy than to GORM. sqlboiler generates code database-first. GORM is the only one that reflects at runtime and applies conventions by default. The correct refinement of the diagram: split the rightmost column into "reflection-based ORM (GORM)" and "codegen ORM (ent, sqlboiler, bun with bunreflect off)." The cost profiles are orders of magnitude apart. Reflection-based ORMs pay roughly 3x to 10x the CPU per row scanned under benchmark (as documented in Brandur Leach's and uptrace's published comparisons). Codegen ORMs are within 10 percent of raw pgx.

Architectural implication for a staff engineer: the adapter layer in hexagonal architecture is where you choose the tool, and you can choose different tools for different aggregates within the same service. A `UserRepository` backed by sqlc for the hot login path and an `AuditLogRepository` backed by GORM for admin queries is a legitimate architecture. The interface discipline is what prevents that choice from bleeding into the service layer. Do not let the diagram's visual symmetry fool you into picking one tool for the whole service.

Query plan visibility at the architecture level. Add a fourth lane to the diagram: observability. Every query (sqlc or otherwise) emits a span via pgx's tracer. The span carries the query name (sqlc's comment tag becomes the span name), the duration, the rows affected, and the SQLSTATE on error. The observability lane feeds into OpenTelemetry, which feeds into Honeycomb or Datadog. When p99 on `ListProductsWithCategory` spikes, you know which query, which plan, which index. Without that lane, the diagram is academic. With it, the diagram is operational. Principal-level deliverable: a shared `pgxtrace` middleware that all teams import, with redaction of bind variables for PII compliance.

Connection pool placement. The diagram shows one database at the bottom. Production reality: you have a read-write primary, two or three read replicas, and often a pgbouncer layer in front of each. The repository implementation must route reads to replicas, writes to primary, and handle read-your-writes consistency for the happy path after a write. sqlc by default takes a `DBTX` interface that any pgxpool satisfies, so routing is the caller's job. A staff-level pattern: wrap sqlc's generated `Queries` in a `RoutedQueries` struct that holds a `writer` and a `reader` and exposes methods that pick the right pool per query. That routing logic is business logic about consistency, not database logic, which is why it lives above sqlc and below the service layer.

Migration pipeline as a first-class component. The diagram omits the migration layer. In a principal-level architecture, migrations live in `db/migrations`, are applied by goose or atlas in a pre-deploy Kubernetes Job, and sqlc regenerates as part of the same CI step that runs the migration against a shadow database. The invariant: generated Go code matches the schema that will be live in production. Breaking that invariant is how you ship a service that compiles locally and crashes in staging. Enforce it in CI with `sqlc diff` as a gating check.

---
