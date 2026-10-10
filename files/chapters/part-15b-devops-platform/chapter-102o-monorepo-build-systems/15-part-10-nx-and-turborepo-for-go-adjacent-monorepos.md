## 102O.13 Nx and Turborepo for Go-Adjacent Monorepos

Many real-world monorepos are polyglot: a Go backend, a TypeScript frontend, Python data pipelines, and shared protobuf definitions. Bazel handles this well but has a steep learning curve. Nx and Turborepo offer simpler alternatives optimized for the JavaScript ecosystem with Go support via custom executors.

### Nx for Polyglot Monorepos

Nx uses a project graph to understand dependencies between projects and runs only what is affected by a change.

```bash
# Initialize Nx in an existing monorepo
npx nx@latest init

# Add Go plugin
npm install --save-dev @nx-go/nx-go
```

Project configuration for a Go service:

```json
// apps/api-server/project.json
{
  "name": "api-server",
  "projectType": "application",
  "sourceRoot": "apps/api-server",
  "targets": {
    "build": {
      "executor": "@nx-go/nx-go:build",
      "options": {
        "main": "apps/api-server/main.go",
        "outputPath": "dist/api-server"
      }
    },
    "test": {
      "executor": "@nx-go/nx-go:test",
      "options": {
        "args": ["-v", "-race", "-count=1"]
      }
    },
    "lint": {
      "executor": "@nx-go/nx-go:lint"
    }
  },
  "implicitDependencies": ["shared-lib", "proto-types"]
}
```

### Nx Affected Analysis

Nx builds a dependency graph by analyzing imports and explicit `implicitDependencies`. When a PR changes files, Nx computes the set of affected projects:

```bash
# Only build projects affected by changes since main
nx affected --target=build --base=main --head=HEAD

# Only test affected projects
nx affected --target=test --base=origin/main

# Visualize the project graph
nx graph
```

Internally,, Nx computes a topological sort of the project graph and marks a project as affected if any of its transitive dependencies changed. This is the same principle as Bazel's incremental builds but expressed at the project level rather than the file level.

### Task Pipelines

Nx task pipelines define execution order dependencies between targets:

```json
// nx.json
{
  "targetDefaults": {
    "build": {
      "dependsOn": ["^build"],  // build all deps first
      "inputs": ["production", "^production"],
      "cache": true
    },
    "test": {
      "dependsOn": ["build"],   // test after build
      "inputs": ["default", "^production", "{workspaceRoot}/jest.config.ts"],
      "cache": true
    },
    "lint": {
      "inputs": ["default", "{workspaceRoot}/.golangci.yml"],
      "cache": true
    }
  }
}
```

This means `nx run api-server:test` will automatically build `api-server` and all its library dependencies first.

### Turborepo Remote Caching

Turborepo (by Vercel) is a simpler task runner focused purely on caching and parallelism, without the project graph analysis of Nx.

```json
// turbo.json
{
  "$schema": "https://turbo.build/schema.json",
  "pipeline": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**", "bin/**"]
    },
    "test": {
      "dependsOn": ["build"],
      "outputs": ["coverage/**"],
      "env": ["GO_TEST_FLAGS"]
    },
    "lint": {
      "outputs": []
    }
  },
  "remoteCache": {
    "signature": true
  }
}
```

Enable Turborepo remote caching with Vercel or a self-hosted server:

```bash
# Authenticate with Vercel remote cache
npx turbo login
npx turbo link

# Or use a custom remote cache server
TURBO_API=https://cache.internal \
TURBO_TOKEN=${CACHE_TOKEN} \
TURBO_TEAM=myorg \
turbo run build test
```

### go-work Workspace Mode as a Pure-Go Alternative

For teams with a pure Go monorepo (no polyglot requirements), `go.work` is the simplest option with zero tooling overhead. It is built into the Go toolchain since Go 1.18.

```
mymonorepo/
├── go.work
├── go.work.sum
├── services/
│   ├── api/
│   │   └── go.mod  (module mycompany.com/services/api)
│   ├── worker/
│   │   └── go.mod  (module mycompany.com/services/worker)
│   └── gateway/
│       └── go.mod  (module mycompany.com/services/gateway)
└── libs/
    ├── auth/
    │   └── go.mod  (module mycompany.com/libs/auth)
    └── db/
        └── go.mod  (module mycompany.com/libs/db)
# go.work
go 1.27

use (
    ./services/api
    ./services/worker
    ./services/gateway
    ./libs/auth
    ./libs/db
)
```

With this setup, `go build ./...` from the repo root builds everything. Changes to `libs/auth` are immediately visible to all services without publishing. No BUILD files, no configuration, no plugins.

### Tool Comparison for Different Team Sizes

| Tool | Best For | Learning Curve | Remote Cache | Affected Analysis | Polyglot |
|------|---------|---------------|--------------|------------------|---------|
| `go.work` | Pure Go, <20 devs | None (built-in) | No (use GH cache) | Manual scripting | No |
| Turborepo | JS-primary, Go secondary | Low | Yes (Vercel/self) | File-based | Yes |
| Nx | Polyglot, 20-200 devs | Medium | Yes | Project graph | Yes |
| Bazel | Large teams, 200+ devs | High | Yes (RBE) | Target-level | Yes |
| Pants | Python+Go shops | Medium | Yes | File-level | Partial |

The key decision factors:
- **Team size under 10**: `go.work` is sufficient. Add GitHub Actions caching for speed.
- **Polyglot under 100 devs**: Nx provides good affected analysis without Bazel's complexity.
- **Over 100 devs or >50K files**: Bazel's hermetic builds and RBE become essential. The learning cost pays off.

### Junior → FAANG: Choosing a Tool Appropriate to Your Organization's Size

The comparison table in this section is the key takeaway. The mistake junior engineers make is over-engineering: reaching for Bazel in a 5-person startup because "that's what Google uses." The organizational overhead of Bazel (BUILD file maintenance, WORKSPACE management, toolchain pinning, remote cache operation) is a full-time platform engineer concern. At a 5-person team, that overhead consumes capacity that should go into the product.

The practical heuristic: use `go.work` until CI takes more than 10 minutes on a typical PR. Then implement custom affected detection (Part 2). When that stops being sufficient (typically when the repo has 50+ services or 200+ engineers), evaluate Nx for polyglot repos or Bazel for pure-Go repos. The decision is driven by current pain, not anticipated future scale.

For interviews: being able to articulate why you would choose each tool at each team size shows that you understand trade-offs, not just that you know the tools exist.

### Senior @ FAANG: Build Tool Standardization as an Organizational Decision

The choice of build tool in a monorepo is an organizational decision as much as a technical one. Once a build tool is established, it becomes embedded in onboarding documentation, CI templates, editor plugins, internal tooling, and the mental models of every engineer in the organization. Changing it later is a multi-quarter migration that requires buy-in from every team. This means the initial tool selection deserves a formal evaluation process rather than being decided by whichever engineer sets up CI first.

The evaluation framework for build tool selection at a growing organization: correctness (does it produce reproducible outputs?), performance (what are p50 and p95 build times for a typical PR?), developer experience (how long does onboarding take, and how often do developers need platform team help?), observability (can you measure cache hit rates, build time by target, and flakiness by test?), and migration cost (if you outgrow this tool, how hard is it to switch to the next one?). Nx is easier to migrate away from than Bazel because Nx targets are less tightly coupled to the build system. This makes Nx a lower-risk bet for organizations that are not yet certain they will reach Bazel scale.

The staff-level deliverable when evaluating build tools: a written ADR that scores each candidate on these dimensions with quantitative evidence (benchmark results, migration effort estimates, organizational adoption projections), a recommended tool with a rationale, and a stated review trigger ("we will reconsider this decision when CI times exceed 15 minutes for 50% of PRs"). This document anchors future discussions and prevents the tool selection from being relitigated on every relevant PR.

---
