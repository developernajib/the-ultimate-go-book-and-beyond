## 17.12 Interview Questions

Project structure questions appear in almost every mid-to-senior Go interview. Interviewers use them to check whether you have opinions grounded in real maintenance experience rather than blog-post orthodoxy. The `pkg/` vs `internal/` tradeoff is especially common because the community is genuinely split on it.

> **What FAANG actually tests here**: whether you understand `internal/` is the only Go-recognized special directory (enforced by the compiler), why layout by feature/domain beats layout by technical layer, and how module boundaries (`go.mod`, `go.work`) interact with package boundaries.

### Question 1: How do you prevent circular imports in Go?

**What FAANG expects**: accept-interfaces-return-structs, the "define interfaces at point of use" rule, and the practical move of lifting shared types into a leaf package that neither side imports from the other.

Circular imports are a compile-time error in Go, so interviewers ask this to test whether you understand package boundary design and dependency inversion. The standard techniques are:

**Answer:**
1. **Define interfaces at point of use**: The consumer defines what it needs
2. **Use dependency inversion**: High-level modules shouldn't depend on low-level modules
3. **Extract shared types**: Create a separate package for shared models
4. **Use package hierarchy**: Higher packages can import lower, not vice versa

```go
// Instead of package A importing B and B importing A:
// 1. A defines interface for what it needs from B
// 2. B implements that interface
// 3. Main wires them together
```

**Follow-ups**:
- Why is Go's "circular imports are a compile error" a feature, not a limitation, compared to languages that allow them?
- Walk me through how you would break a circular import between a `user` package and an `order` package that genuinely reference each other's types.

### Question 2: When should you use `pkg/` vs `internal/`?

**What FAANG expects**: awareness that `internal/` is the only directory name with compiler-enforced visibility rules, that `pkg/` is a convention not a requirement (and is actively disputed in the community), and the practical "start in internal, promote to pkg only when you are committing to a public API" rule.

**Answer:**

| `internal/` | `pkg/` |
|-------------|--------|
| Business logic | Generic utilities |
| Domain models | Validation helpers |
| Service implementations | HTTP utilities |
| 95% of your code | Libraries others might use |

Rule: Start with `internal/`. Only move to `pkg/` if:
- Code is genuinely reusable across projects
- You're okay with maintaining backward compatibility
- It has no dependencies on your application

Note: many Go projects skip `pkg/` entirely and place public code at the module root. The standard library does, and so do most new services. The compiler does not care, and a flat top-level layout is equally valid.

Kubernetes is the counterexample people reach for, and it points the other way: it is the most prominent `pkg/` user in the ecosystem, with a `pkg/` tree of roughly thirty subtrees alongside `cmd/`, `api/`, and `plugin/`. That layout predates modules and is now effectively unchangeable, since moving a package would break every import path in a very large ecosystem. It is evidence about the cost of an early layout decision at scale, not evidence that `pkg/` is good. Be intentional about your choice rather than cargo-culting either direction.

**Follow-ups**:
- What happens at the compiler level when a package outside an `internal/` directory tries to import something inside it? Walk through the enforcement rule.
- Why did the Go team never publish an official project layout?

### Question 3: How do you structure a monorepo with multiple services?

**What FAANG expects**: you pick single-module-with-many-services or multi-module-with-`go.work` depending on release cadence and team boundaries, and you can articulate the CI implications (one module = always-all builds. Multi-module + `go.work` = affected-only builds, `go.work` stays local, not checked in).

The key challenge is sharing code between services without creating tight coupling. Each service should have its own `cmd/` and `internal/` directories for isolation, while genuinely reusable code (auth, tracing, client libraries) lives in a top-level `pkg/` directory. API contracts defined in `proto/` act as the formal interface between services.

**Answer:**
```
monorepo/
├── services/
│   ├── api-gateway/
│   │   ├── cmd/
│   │   └── internal/
│   ├── user-service/
│   │   ├── cmd/
│   │   └── internal/
│   └── order-service/
│       ├── cmd/
│       └── internal/
├── pkg/                    # Shared libraries
│   ├── auth/
│   └── tracing/
├── proto/                  # Shared API definitions
│   ├── user/
│   └── order/
└── tools/                  # Development tools
```

Key practices:
- Each service has its own `go.mod` (multi-module monorepo).
- `go.work` at the repo root wires them together so local edits across modules resolve without `replace` directives.
- Shared code in a top-level module (`pkg/`, or just the root if you skip `pkg/`). Note the catch: once services are separate modules, a shared package is a *cross-module dependency*, so each service's `go.mod` must require it at a version. This is the real cost of multi-module, and it is why `go.work` exists.
- API contracts in `proto/`.
- CI builds affected services only, using the module graph to detect what changed.

**On committing `go.work`, know that this is contested rather than settled.** The common advice is to leave it out of version control, and for an open-source library that is right: a stray `go.work` changes how anyone building your repo resolves modules, usually surprising them. The Go tutorial material presents workspaces as a local development tool in that spirit.

But a monorepo is the case the advice was not written for, and practice diverges. Kubernetes commits a generated `go.work` listing 33 modules:

```
// This is a generated file. Do not edit directly.
go 1.26.0

use (
    .
    ./staging/src/k8s.io/api
    ./staging/src/k8s.io/apimachinery
    ...
)
```

The reasoning is that in a monorepo every module *is* developed together, which is exactly the situation workspaces model, and committing the file means contributors and CI resolve modules identically instead of each developer reconstructing it. If you say "never commit `go.work`" in an interview and your interviewer works on a Go monorepo, expect pushback. The defensible answer states the trade: keep it out for libraries and anything consumed externally, consider committing it for a monorepo where the workspace is a property of the repo rather than of your laptop, and if you commit it, verify in CI that each module still builds standalone with `GOWORK=off`.

**Follow-ups**:
- When would a single-module monorepo beat a multi-module one? What does it cost in CI time and release flexibility?
- How do you handle a shared library that one service needs at `v2` and another at `v1` simultaneously?

### Question 4: How do you handle configuration for different environments?

**What FAANG expects**: twelve-factor env-var reading with sensible defaults, awareness that secrets should come from a secret manager (AWS SM, GCP Secret Manager, HashiCorp Vault) not config files, and knowledge of mature config libraries (`kelseyhightower/envconfig`, `caarlos0/env`, or `spf13/viper` when you need file merging).

Production systems typically need different database hosts, timeouts, and feature flags per environment. The twelve-factor app approach reads configuration from environment variables, with layered overrides so that defaults, config files, environment variables, and CLI flags each take increasing precedence.

**Answer:**
```go
// 1. Environment variables (12-factor app)
type Config struct {
    Environment string `env:"ENV" envDefault:"development"`
    Port        int    `env:"PORT" envDefault:"8080"`
}

// 2. Hierarchical config files
// configs/config.yaml (base)
// configs/config.production.yaml (overrides)

// 3. In code, merge with priority:
// Defaults < File < Environment < Flags
```

**Follow-ups**:
- How would you detect configuration drift between environments (e.g., a flag flipped in staging but never in prod)?
- Why should secrets never go into `configs/*.yaml`? What is the minimum production-acceptable alternative?

### Question 5: How would you structure a service that needs to support both HTTP and gRPC?

**What FAANG expects**: transport-agnostic domain layer, thin handlers per transport, and the recognition that gRPC-gateway or Connect (`connectrpc.com/connect`) can generate one of the two transports from the other rather than writing both by hand.

The goal is to avoid duplicating business logic across transport layers. A clean architecture approach puts domain logic and use cases in transport-agnostic packages, then creates thin HTTP and gRPC handlers that each call the same application layer.

**Answer:**
```
service/
├── cmd/
│   └── server/
│       └── main.go
├── internal/
│   ├── domain/           # Pure business logic
│   │   └── user/
│   ├── application/      # Use cases
│   │   └── createuser/
│   └── interfaces/       # Transport layer
│       ├── http/
│       │   └── handler.go
│       └── grpc/
│           └── server.go
└── api/
    └── user.proto
```

The domain layer has no transport dependencies. HTTP and gRPC handlers both call the same application layer use cases. For greenfield services, consider Connect (`connectrpc.com/connect`), which serves gRPC, gRPC-Web, and a REST-style JSON interface from a single handler implementation, eliminating the duplication entirely.

**Follow-ups**:
- Why is grpc-gateway sometimes preferred over Connect, and what are the tradeoffs?
- How would you share validation between HTTP and gRPC inputs without duplicating it in both handlers?

### Q (Staff track): How do you standardize project structure across 50 Go services?

**Answer**: Three mechanisms.

1. **A template generator.** New services start from a common scaffold. Every service has the same layout by default.
2. **A written standard doc.** When deviation is needed, teams reference the standard to justify the departure.
3. **Periodic audit.** Annually, measure how closely each service matches the standard. Investigate outliers, and update the standard to reflect legitimate evolution.

The combination is what makes consistency durable. Without the template, deviation is the default. Without the doc, new engineers guess. Without the audit, the standard decays.

### Q (Staff track): When would you recommend `pkg/` and when would you recommend against?

**Answer**: Recommend `pkg/` when the project is a library with both public and private code, or when the org's existing convention requires it. Recommend against when the project is an application (most Go services), when there is no public API, or when the org is starting fresh and can skip the historical convention.

The standard library does not use `pkg/`, and Go's official layout guidance never mentions it. For new work the default should be "no `pkg/`", and the burden of proof sits with whoever wants to add it. Existing projects using `pkg/` should not migrate away without a reason: the import paths are the public API, so churning them costs every consumer a change and buys nothing but tidiness. Consistency with the existing codebase wins.

---
