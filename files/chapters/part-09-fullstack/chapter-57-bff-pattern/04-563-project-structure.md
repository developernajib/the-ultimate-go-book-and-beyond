## 57.3 Project Structure

The BFF project layout reflects the presence of multiple independent frontend-facing services (web, mobile, admin) sharing a common library of downstream service clients. Each BFF lives in its own `cmd/` entry point and `internal/` package tree so it can be built and deployed independently, while the shared client code lives in a `pkg/clients/` directory imported by all BFFs. The structure below also collocates the downstream stub types with the client code that produces them, preventing the proliferation of duplicate type definitions across BFF packages.

```
bff-architecture/
├── services/
│   ├── web-bff/
│   │   ├── cmd/
│   │   │   └── server/
│   │   │       └── main.go
│   │   ├── internal/
│   │   │   ├── handler/
│   │   │   │   ├── home.go
│   │   │   │   ├── product.go
│   │   │   │   ├── cart.go
│   │   │   │   └── checkout.go
│   │   │   ├── aggregator/
│   │   │   │   ├── home.go
│   │   │   │   └── product_detail.go
│   │   │   ├── transformer/
│   │   │   │   └── response.go
│   │   │   └── client/
│   │   │       ├── user.go
│   │   │       ├── product.go
│   │   │       └── order.go
│   │   ├── go.mod
│   │   └── Dockerfile
│   │
│   ├── mobile-bff/
│   │   ├── cmd/
│   │   │   └── server/
│   │   │       └── main.go
│   │   ├── internal/
│   │   │   ├── handler/
│   │   │   ├── aggregator/
│   │   │   ├── transformer/
│   │   │   └── client/
│   │   ├── go.mod
│   │   └── Dockerfile
│   │
│   ├── admin-bff/
│   │   └── ...
│   │
│   └── shared/
│       ├── pkg/
│       │   ├── serviceclient/
│       │   │   ├── base.go
│       │   │   ├── user.go
│       │   │   ├── product.go
│       │   │   └── order.go
│       │   ├── middleware/
│       │   ├── errors/
│       │   └── cache/
│       └── go.mod
│
├── backend-services/
│   ├── user-service/
│   ├── product-service/
│   ├── order-service/
│   └── inventory-service/
│
└── docker-compose.yml
```

### Junior -> FAANG: Reading and Replicating Project Structure

The directory layout above is the most important artifact for new engineers joining a BFF project. Spend the first day on a new codebase understanding where each concern lives before touching any code.

Three structure rules that prevent the most common mistakes on a first job:

First, the `internal/` directory is not optional. Go's `internal` package visibility rule prevents other modules from importing your BFF's internal types. This forces each BFF to expose only what is in `cmd/` or `pkg/`. If you find yourself reaching across BFF boundaries to import internal types, you have a shared abstraction that should live in the `shared/pkg/` tree.

Second, transformers and aggregators are separate packages. The aggregator calls downstream services and collects their responses. The transformer converts a downstream type to a BFF response type. Keeping them separate makes both independently testable and prevents the common pattern of transformation logic inside service client methods.

Third, the `shared/pkg/` directory is for infrastructure code (base HTTP client, circuit breaker setup, tracing helpers, common error types). It is not for business types. If you add a `Product` struct to `shared/pkg/` that includes the BFF's display fields (badge, truncated name, discount percentage), you have leaked BFF concerns into the shared layer and tightly coupled all BFFs to one client's data model.

For interviews, if asked to design the project structure for a multi-BFF system, draw this directory tree or a close variant and explain the `internal`/`shared` split before discussing anything else.

### Senior @ FAANG: Monorepo vs Polyrepo and Dependency Management

The structure shown is appropriate for a monorepo layout where all BFFs and the shared library live in one repository. This is the Netflix, Google, and Meta model for internal services. It simplifies cross-BFF changes (update the shared client library and all BFFs see the change in the same PR) but requires a sophisticated build system (Bazel, Buck, or Turborepo) to avoid rebuilding and testing the entire monorepo on every commit.

The alternative is a polyrepo layout where each BFF and the shared library are separate repositories with versioned releases. This gives each BFF team full autonomy over their dependency versions but creates the "diamond dependency" problem: BFF-A depends on `sharedkit v1.2`, BFF-B depends on `sharedkit v1.5`, and `sharedkit v1.5` has a breaking change that BFF-A has not yet migrated to. Coordinating this across teams requires a deprecation policy and a migration window.

At FAANG scale, the choice between monorepo and polyrepo is often predetermined by the company's build infrastructure. The senior engineer's job is to ensure the project structure within that constraint is correct, not to relitigate the monorepo debate.

Two structure decisions with long-term reliability consequences: first, each BFF must have its own `go.mod`. Sharing a single `go.mod` across all BFFs couples their dependency versions and prevents independent deployment. Second, the `shared/` library should version its own `go.mod` separately from the BFFs so that BFFs can adopt new shared library versions on their own schedule. This is the standard Go module versioning model applied to a multi-service codebase.

A staff-level concern is the governance of the `shared/` library. Who reviews changes to `shared/pkg/serviceclient/`? If any engineer on any BFF team can merge changes to the shared client library, you have an implicit shared ownership model that tends toward inconsistent behavior and accidental breaking changes. The solution is an inner-source model: the shared library has designated maintainers, all changes require review from at least one maintainer, and a CHANGELOG entry is required for every merged PR. This is not bureaucracy for its own sake. It is the minimum process needed to prevent the shared library from becoming a liability at scale.

---
