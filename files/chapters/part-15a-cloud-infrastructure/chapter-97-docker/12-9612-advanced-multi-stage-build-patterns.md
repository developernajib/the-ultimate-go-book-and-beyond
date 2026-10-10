## 97.12 Advanced Multi-Stage Build Patterns

### Pattern 1: Separate Test Stage

When you need to run tests in CI but also produce a minimal production image, you can add a dedicated test stage to your Dockerfile. Docker lets you build up to a specific stage using the `--target` flag, so your CI pipeline can run `docker build --target tester` to execute tests, and then build the full image for deployment. This keeps your test execution and production build in a single Dockerfile, ensuring they always use the same dependencies and build configuration.

```dockerfile
# Dockerfile with test stage
FROM golang:1.27.1-alpine AS base
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download

# Test stage - includes test dependencies and runs tests
FROM base AS tester
COPY . .
RUN go test -v -race -coverprofile=coverage.out ./...
RUN go tool cover -html=coverage.out -o coverage.html

# Build stage - produces the binary
FROM base AS builder
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build \
    -ldflags="-s -w" \
    -o /app/server ./cmd/server

# Production stage - minimal runtime
FROM scratch
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=builder /app/server /server
USER 65534:65534
ENTRYPOINT ["/server"]
```

```bash
# Run tests only (for CI)
docker build --target tester -t myapp:test .

# Build production image
docker build -t myapp:prod .

# Extract coverage report
docker create --name test-container myapp:test
docker cp test-container:/app/coverage.html ./coverage.html
docker rm test-container
```

### Pattern 2: Builder Cache with BuildKit

BuildKit is Docker's modern build engine that provides advanced caching features far beyond standard layer caching. With BuildKit's `--mount=type=cache` instruction, you can persist the Go module cache and build cache across builds in a way that survives even when earlier layers change. This means that even if you modify `go.mod`, the previously downloaded modules are still available in the cache mount, and incremental Go compilations reuse object files from previous builds.

```dockerfile
# syntax=docker/dockerfile:1.4
FROM golang:1.27.1-alpine AS builder

# Enable go module cache
ENV GOMODCACHE=/go/pkg/mod
ENV GOCACHE=/root/.cache/go-build

WORKDIR /app

# Cache mounts for go modules and build cache
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download

COPY . .
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -ldflags="-s -w" -o /app/server ./cmd/server

FROM scratch
COPY --from=builder /app/server /server
ENTRYPOINT ["/server"]
```

```bash
# Enable BuildKit
export DOCKER_BUILDKIT=1

# Build with cache
docker build -t myapp:latest .

# Second build reuses cached layers
time docker build -t myapp:latest .
# Result: < 5 seconds if only source changed
```

### Pattern 3: Multi-Architecture Builds

Supporting both AMD64 and ARM64 is increasingly important as Apple Silicon Macs and AWS Graviton instances become common in development and production environments. Docker Buildx lets you compile your Go application for multiple architectures in a single build command using Go's built-in cross-compilation. The `$BUILDPLATFORM` and `$TARGETPLATFORM` variables are automatically set by Docker, so Go compiles on your native architecture but produces a binary for the target platform.

```dockerfile
# Dockerfile supporting multi-arch
FROM --platform=$BUILDPLATFORM golang:1.27.1-alpine AS builder

ARG TARGETPLATFORM
ARG TARGETOS
ARG TARGETARCH

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .

# Cross-compile for target platform
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -ldflags="-s -w" -o /app/server ./cmd/server

FROM scratch
COPY --from=builder /app/server /server
ENTRYPOINT ["/server"]
```

```bash
# Build for multiple platforms
docker buildx create --use --name multiarch
docker buildx build \
    --platform linux/amd64,linux/arm64 \
    -t myregistry/myapp:latest \
    --push .

# Verify manifest
docker manifest inspect myregistry/myapp:latest
```

### Pattern 4: Conditional CGO Support

Sometimes you need CGO for certain dependencies like SQLite, certain crypto libraries, or any Go package that wraps a C library. When `CGO_ENABLED=1`, the Go compiler uses the system's C compiler to link against C libraries, which means your final binary is no longer fully static and may need shared libraries at runtime. To work around this, you can use the `-extldflags '-static'` flag to force a fully static link, or switch your final stage from `scratch` to `alpine` which includes the necessary C runtime.

```dockerfile
# Dockerfile with CGO support
FROM golang:1.27.1-alpine AS builder

# Install C compiler and required libraries
RUN apk add --no-cache gcc musl-dev

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .

# Build with CGO enabled
ARG CGO_ENABLED=1
RUN go build \
    -ldflags="-s -w -linkmode external -extldflags '-static'" \
    -o /app/server ./cmd/server

# Need alpine (not scratch) for dynamic linking unless fully static
FROM alpine:3.19
RUN apk add --no-cache ca-certificates tzdata
RUN adduser -D -u 1000 appuser
USER appuser
COPY --from=builder /app/server /server
ENTRYPOINT ["/server"]
```

---

### Junior → FAANG: Applying Advanced Patterns Without Over-Engineering

Advanced multi-stage patterns (separate test stage, parallel build stages, build-arg-driven variants) solve real problems, but the risk for junior engineers is reaching for them before the basic pattern is solid. The correct progression: single-stage to learn the mechanics, two-stage (builder and runtime) for all real work, then add stages only when a specific problem requires them.

The separate test stage is genuinely useful when you want CI to run tests inside the container environment but not ship the test binaries or test dependencies. The pattern is: builder stage compiles the binary, test stage runs `go test`, runtime stage copies only the binary. If the test stage fails, the build fails and the runtime image is never produced.

First-job habit: when you add a new stage, document why it exists in a comment in the Dockerfile. Comments in Dockerfiles are not common, but they are valuable. `# Test stage: runs unit tests in the build environment; fails the build on test failure` is clear and prevents future engineers from deleting the stage because they do not understand its purpose.

### Senior @ FAANG: Multi-Stage Build Architecture for Large Monorepos

At staff level, multi-stage builds in a monorepo with hundreds of services reveal architectural constraints that do not exist in single-service repositories. The core problem is that `COPY . .` in a monorepo context either copies the entire repository (slow, cache-unfriendly) or requires complex path filtering to scope the copy to the relevant service (brittle, hard to maintain).

The architectural solutions are: Bazel with remote execution (provides hermetic, reproducible builds with shared action cache across all developers and CI), Earthly (a Makefile/Dockerfile hybrid designed for monorepos), or a custom BuildKit graph that uses sparse checkouts to scope each service build. Each has different trade-offs in complexity, cache efficiency, and developer ergonomics.

The parallel stage pattern becomes important when protobuf generation, static asset compilation, and Go compilation are independent work that can proceed simultaneously. BuildKit's `--parallel` flag enables this, but it requires explicit stage dependency declaration. At scale, the wall-clock build time reduction from parallelism can be significant, but the cache invalidation behavior becomes more complex and requires careful design. The staff engineer responsibility is to design the build graph to maximize cache hit rate across the most common change patterns: most PRs touch one service, a few touch shared libraries, and rarer PRs touch the build system itself. Each of these change patterns should have a corresponding cache key strategy.
