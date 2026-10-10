## 99.14 Monorepo CI/CD Strategies

### Path-Based Triggers

```yaml
# .github/workflows/monorepo.yaml
name: Monorepo CI

on:
  push:
    branches: [main]
    paths:
      - 'services/**'
      - 'libs/**'
  pull_request:
    branches: [main]

jobs:
  detect-changes:
    runs-on: ubuntu-latest
    outputs:
      services: ${{ steps.changes.outputs.services }}
      libs: ${{ steps.changes.outputs.libs }}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Detect changes
        id: changes
        run: |
          if [ "${{ github.event_name }}" = "push" ]; then
            BASE_SHA=${{ github.event.before }}
          else
            BASE_SHA=${{ github.event.pull_request.base.sha }}
          fi

          # Get changed services
          SERVICES=$(git diff --name-only $BASE_SHA HEAD | grep '^services/' | cut -d'/' -f2 | sort -u | jq -R -s -c 'split("\n") | map(select(length > 0))')
          echo "services=$SERVICES" >> $GITHUB_OUTPUT

          # Get changed libs
          LIBS=$(git diff --name-only $BASE_SHA HEAD | grep '^libs/' | cut -d'/' -f2 | sort -u | jq -R -s -c 'split("\n") | map(select(length > 0))')
          echo "libs=$LIBS" >> $GITHUB_OUTPUT

  test-libs:
    needs: detect-changes
    if: needs.detect-changes.outputs.libs != '[]'
    runs-on: ubuntu-latest
    strategy:
      matrix:
        lib: ${{ fromJson(needs.detect-changes.outputs.libs) }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: '1.27'
      - name: Test ${{ matrix.lib }}
        run: |
          cd libs/${{ matrix.lib }}
          go test -v ./...

  test-services:
    needs: [detect-changes, test-libs]
    if: always() && needs.detect-changes.outputs.services != '[]'
    runs-on: ubuntu-latest
    strategy:
      matrix:
        service: ${{ fromJson(needs.detect-changes.outputs.services) }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: '1.27'
      - name: Test ${{ matrix.service }}
        run: |
          cd services/${{ matrix.service }}
          go test -v ./...

  build-services:
    needs: test-services
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    strategy:
      matrix:
        service: ${{ fromJson(needs.detect-changes.outputs.services) }}
    steps:
      - uses: actions/checkout@v4
      - name: Build ${{ matrix.service }}
        run: |
          cd services/${{ matrix.service }}
          docker build -t ${{ matrix.service }}:${{ github.sha }} .
          docker push ghcr.io/myorg/${{ matrix.service }}:${{ github.sha }}
```

### Shared Go Workspace

Go workspaces (`go.work`) solve the monorepo dependency problem by letting multiple modules in the same repository reference each other's local source trees without requiring `replace` directives in each `go.mod`. This means changes to a shared library in `libs/auth` are immediately visible to `services/api` during development and CI without publishing an intermediate module version, while each service still retains its own `go.mod` for independent versioning and deployment.

```
# Monorepo structure with Go workspace
monorepo/
├── go.work
├── go.work.sum
├── libs/
│   ├── common/
│   │   ├── go.mod
│   │   └── common.go
│   ├── auth/
│   │   ├── go.mod
│   │   └── auth.go
│   └── database/
│       ├── go.mod
│       └── database.go
├── services/
│   ├── api/
│   │   ├── go.mod
│   │   ├── Dockerfile
│   │   └── main.go
│   ├── worker/
│   │   ├── go.mod
│   │   ├── Dockerfile
│   │   └── main.go
│   └── gateway/
│       ├── go.mod
│       ├── Dockerfile
│       └── main.go
└── .github/
    └── workflows/
        └── monorepo.yaml
```

```go
// go.work
go 1.27.1

use (
    ./libs/common
    ./libs/auth
    ./libs/database
    ./services/api
    ./services/worker
    ./services/gateway
)
```

---

### Junior → FAANG: Monorepo CI Fundamentals and the Affected-Service Problem

The core challenge of monorepo CI: a repository with 50 services should not run all 50 pipelines on every commit, but it also must not miss running the pipeline for any service that was actually affected by a change. Getting this right requires change detection: determining which services are affected by a given commit.

Path-based triggers (only run service A's pipeline if files under `services/a/` changed) are the simplest approach and work well when services are well-isolated. The complexity arises when services share libraries: a change to `lib/db/` may affect every service that imports it, but the path filter for each service does not include `lib/db/`. Handling shared library changes correctly requires a dependency graph, not just path filters.

First-job habit: always test the change detection logic explicitly. Deliberately make a change to a shared library and verify that all affected services' pipelines are triggered. The absence of a pipeline run is not always correct silence. It may be incorrect silence (a bug in the change detection logic).

### Senior @ FAANG: Monorepo CI Architecture at Google/FAANG Scale

At staff level, monorepo CI is an infrastructure problem at the same scale as any other distributed system. Google's Blaze (the internal predecessor to Bazel) addressed it by treating the entire build as a dependency graph where each target specifies its exact inputs and outputs, enabling correct incremental builds (only rebuild what changed or depends on what changed) with hermetic execution (each build action runs in a clean environment with exactly its declared inputs).

The practical path to Bazel in a Go monorepo: start with `go build` and path-based change detection, measure the pain points (CI time, incorrect change detection), evaluate whether Bazel's cost (migration effort, learning curve, build rule maintenance) is justified by the benefit, and adopt incrementally if it is. Many organizations find that path-based change detection with a shared library dependency tracker (a custom tool that parses Go imports and builds a dependency graph) provides 80% of the benefit at 20% of the cost.

The organizational challenge of a monorepo CI system is ownership. Who owns the CI configuration for a shared library? Who is responsible when the shared library's change detection logic produces false negatives (changed code that should trigger a pipeline but does not)? Defining ownership boundaries for shared CI infrastructure in a monorepo is a governance problem that needs explicit resolution, typically in a platform team charter or an organizational responsibility document.
