## 56.2 gqlgen Setup and Configuration

gqlgen uses a schema-first approach: you define your GraphQL schema, then generate Go code.

### Project Structure

A clean directory layout separates concerns before the codebase grows, with Go backend packages in `internal/`, frontend source under `frontend/`, and shared infrastructure configuration at the root. Following this structure from the start avoids the later pain of untangling business logic from HTTP handlers or build artifacts from source files. The tree below shows the canonical layout for this application and explains the role of each top-level directory.

```
graphql-api/
├── cmd/
│   └── server/
│       └── main.go
├── graph/
│   ├── schema.graphqls      # GraphQL schema
│   ├── schema.resolvers.go  # Generated resolver stubs (you implement)
│   ├── resolver.go          # Resolver struct definition
│   ├── generated.go         # Generated code (don't edit)
│   └── model/
│       └── models_gen.go    # Generated models
├── internal/
│   ├── auth/
│   ├── dataloader/
│   ├── repository/
│   └── service/
├── gqlgen.yml               # gqlgen configuration
├── go.mod
└── tools.go                 # Tool dependencies
```

### Installation and Setup

Installing gqlgen and running `go run github.com/99designs/gqlgen init` scaffolds the schema, config, and server files in a single step, but the generated defaults need tuning before the API is production-ready. Setting `autobind` rules in `gqlgen.yml` maps GraphQL types to existing Go domain models, avoiding the proliferation of redundant generated structs. The setup sequence below walks through the commands and configuration changes needed to wire gqlgen into an existing Go service.

```go
// tools.go
//go:build tools

package tools

import (
    _ "github.com/99designs/gqlgen"
)
```

```bash
# Install gqlgen
go get github.com/99designs/gqlgen

# Initialize project
go run github.com/99designs/gqlgen init

# Regenerate after schema changes
go run github.com/99designs/gqlgen generate
```

### Configuration

The `gqlgen.yml` file controls code generation behavior: where schemas live, where generated code goes, and how GraphQL types map to existing Go structs. The `autobind` directive tells gqlgen to reuse your domain models instead of generating new ones, and custom `models` entries let you map GraphQL scalars like `DateTime` and `UUID` to specific Go types.

```yaml
# gqlgen.yml
schema:
  - graph/*.graphqls

exec:
  filename: graph/generated.go
  package: graph

model:
  filename: graph/model/models_gen.go
  package: model

resolver:
  layout: follow-schema
  dir: graph
  package: graph
  filename_template: "{name}.resolvers.go"

# Autobind models from your domain packages
autobind:
  - "graphql-api/internal/domain"

# Custom model mappings
models:
  ID:
    model:
      - github.com/99designs/gqlgen/graphql.ID
      - github.com/99designs/gqlgen/graphql.Int
      - github.com/99designs/gqlgen/graphql.Int64
      - github.com/99designs/gqlgen/graphql.Int32
  Int:
    model:
      - github.com/99designs/gqlgen/graphql.Int
      - github.com/99designs/gqlgen/graphql.Int64
      - github.com/99designs/gqlgen/graphql.Int32
  DateTime:
    model:
      - github.com/99designs/gqlgen/graphql.Time
  UUID:
    model:
      - graphql-api/graph/scalar.UUID
```

### Junior -> FAANG: Getting the Setup Right Before Writing Resolvers

The most common gqlgen setup mistake for new engineers is editing `generated.go` or `models_gen.go` by hand. These files are overwritten every time you run `go run github.com/99designs/gqlgen generate`. Any manual edits are silently destroyed. The rule is: never edit generated files. If you need custom behavior, implement it in the non-generated files (`schema.resolvers.go`, `resolver.go`, your own packages).

The second common mistake is putting business logic in resolver methods. Resolver methods are thin adapters. They extract arguments from the GraphQL input types, call a service method, and return the result (possibly converting between domain types and generated model types). If your resolver method is longer than 20 lines, it probably contains logic that belongs in the service layer.

Understanding the `autobind` configuration in `gqlgen.yml` is worth investing in early. It tells gqlgen to reuse your existing domain structs as GraphQL model types instead of generating new ones. Without it, you end up with two parallel type hierarchies (one for your domain, one for GraphQL) and tedious mapping code between them.

For your first FAANG interview that touches gqlgen setup: be able to describe the schema-first workflow (write SDL, run generate, implement resolver interfaces) without reading the docs. The interviewer wants to see that you have actually used it, not just read about it.

### Senior @ FAANG: Configuration as a Platform Contract

At platform level, the `gqlgen.yml` file is not just a build tool configuration. It is a governance document that determines how the entire organization's Go services map their domain types to the shared graph. Several decisions here have long-term consequences.

**The `autobind` decision.** Binding gqlgen directly to internal domain packages creates a tight coupling between the GraphQL schema shape and the internal data model. When the domain model changes (a field is renamed, a type is refactored), gqlgen's generated code will fail to compile until the schema is updated to match. This is usually desirable: it makes schema-breaking changes in the domain visible at compile time. However, it can be constraining for teams that want to expose a different shape at the API boundary than what the domain model uses internally. The alternative is separate GraphQL model types with explicit mapping functions, at the cost of more boilerplate.

**Custom scalars as a platform convention.** The mapping of `DateTime` to `graphql.Time` and `UUID` to a custom scalar type should be decided once, centrally, and applied consistently across all subgraphs. If one team maps `DateTime` to `time.Time` and another maps it to a Unix epoch integer, clients that compose data from both subgraphs will receive inconsistent types for semantically identical fields. Platform teams at FAANG typically publish an internal `graphql-platform` Go module that provides canonical scalar implementations, a standard `gqlgen.yml` base configuration, and the shared auth directive library. Individual services import this module and extend it, rather than implementing these primitives themselves.

**Code generation in CI.** The `go run github.com/99designs/gqlgen generate` command must be part of the CI pipeline, with a check that verifies the committed generated files match what would be generated from the current schema. Without this check, engineers who forget to re-run generation after a schema change will commit stale resolver stubs that fail to implement the generated interface, causing a compile error that only surfaces in CI rather than locally. The check is a simple `git diff --exit-code` after running generate.

**Resolver layout strategy.** The `follow-schema` layout creates one resolver file per schema file. For a large schema split across many SDL files, this produces many small resolver files. An alternative is `single-file`, which puts all resolvers in one file (impractical at scale) or a custom layout where resolver files map to domain objects rather than schema files. The right choice depends on team size: `follow-schema` works well when schema files already map to domain boundaries, which they should if the schema was designed with bounded contexts in mind.

---
