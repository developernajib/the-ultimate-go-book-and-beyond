## 97.4 Build Optimizations

### Layer Caching Strategy

Docker builds images one instruction at a time, and each instruction creates a "layer." If a layer and everything before it has not changed, Docker reuses the cached version instead of rebuilding it. By copying `go.mod` and `go.sum` before your source code, you ensure that the expensive dependency-download step is only re-run when your dependencies actually change. Source code changes (which happen frequently) only invalidate the later layers, making most rebuilds much faster.

```dockerfile
# GOOD: Dependencies cached separately from code
FROM golang:1.27.1-alpine AS builder
WORKDIR /app

# Step 1: Download dependencies (cached unless go.mod changes)
COPY go.mod go.sum ./
RUN go mod download

# Step 2: Copy source (changes frequently)
COPY . .

# Step 3: Build
RUN go build -o /app/server ./cmd/server
```

### Build Arguments and Versioning

Docker build arguments (`ARG`) let you pass values into the build process at build time. This is especially useful for embedding version information, git commit hashes, and build timestamps directly into your Go binary using `-ldflags`. When your application starts, it can log or expose this metadata, making it easy to tell exactly which version is running in any environment.

```dockerfile
FROM golang:1.27.1-alpine AS builder

ARG VERSION=dev
ARG COMMIT=unknown
ARG BUILD_TIME=unknown

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .

# Inject version info at build time
RUN CGO_ENABLED=0 go build \
    -ldflags="-w -s \
        -X main.Version=${VERSION} \
        -X main.Commit=${COMMIT} \
        -X main.BuildTime=${BUILD_TIME}" \
    -o /app/server ./cmd/server

FROM scratch
COPY --from=builder /app/server /server
ENTRYPOINT ["/server"]
```

```go
// main.go - Version variables injected at build time
package main

import "log"

var (
    Version   = "dev"
    Commit    = "unknown"
    BuildTime = "unknown"
)

func main() {
    log.Printf("Starting server version=%s commit=%s built=%s",
        Version, Commit, BuildTime)
    // ...
}
```

```bash
# Build with version info
docker build \
    --build-arg VERSION=1.2.3 \
    --build-arg COMMIT=$(git rev-parse --short HEAD) \
    --build-arg BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ) \
    -t myapp:1.2.3 .
```

---

### Junior → FAANG: Build Optimization Habits That Matter in Practice

The layer ordering rule is worth memorizing as a first principle: put instructions that change rarely at the top of the stage, and instructions that change often at the bottom. For Go this translates directly to a fixed sequence: copy `go.mod` and `go.sum`, run `go mod download`, then copy source, then build. Breaking this sequence by doing `COPY . .` first means every source file change invalidates the module download cache.

A common gap is not understanding what `--mount=type=cache` does in BuildKit. Without it, the Go module cache and build cache inside the container are thrown away after every build. With it, they persist across builds on the same host. This is a meaningful speedup for projects with large dependency trees, and it is a standard optimization in any mature CI setup.

For interviews, understand the tradeoff between image size and build time optimization. Parallel build stages (`--parallel` in BuildKit) can reduce wall-clock time but increase peak resource usage. Being able to reason about this tradeoff concretely is a good entry-level signal.

### Senior @ FAANG: Build Performance as an Engineering Productivity Metric

At senior level, build optimization is a product with internal customers. The customers are every engineer on the platform, and the metric is end-to-end CI time from `git push` to deployment-ready image. Treating this metric with the same rigor as user-facing latency, including P50/P95/P99, tracking it over time, and setting SLOs, is an L6/L7 pattern.

The architectural levers available are: remote BuildKit cache (registry or S3 backend with proper cache key design), distributed build systems (Bazel with remote execution for very large monorepos), and parallel stage design. Cache key design is subtle: too coarse and you get cache misses on irrelevant changes. Too fine and you fragment the cache and waste storage. The right cache key for Go module download is the hash of `go.sum`, not the hash of all source files.

At FAANG scale, build optimization intersects with cost governance. Every minute of CI compute has a dollar cost. A 10-minute build for 500 engineers running 10 builds a day each is 83 engineer-hours of wall time and a significant compute bill. The staff engineer responsibility is to own the build performance budget, detect regressions proactively (build time regression in CI as a required check on PRs that touch the build system), and make the investment case for infrastructure spend on caching and parallelism.
