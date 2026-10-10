## 97.10 Production Pitfalls: Docker Mistakes

### Pitfall 1: Using Full Base Images Instead of Scratch/Distroless

**Real Incident Report**: A team deployed Go binaries in `ubuntu:20.04` containers. Image size: 800MB. Attack surface: 200+ CVEs from installed packages they never used. The container startup time was slow, pulls were expensive, and security scans generated noise that hid real issues. Switching to `scratch` reduced images to 15MB and eliminated all base image CVEs.

**The Anti-Pattern**:
```dockerfile
# WRONG: Full OS for a static binary
FROM ubuntu:20.04
RUN apt-get update && apt-get install -y ca-certificates
COPY myapp /app
CMD ["/app"]
# Result: 800MB image, hundreds of CVEs
```

**The Better Approach**:
```dockerfile
# Build stage
FROM golang:1.27.1 AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /myapp

# Runtime stage - minimal
FROM scratch
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=builder /myapp /myapp
ENTRYPOINT ["/myapp"]
# Result: 10-15MB image, zero CVEs from base
```

**Key Insight**: Go produces static binaries that don't need an OS. Every package in your base image is attack surface you don't need.

### Pitfall 2: Not Caching Dependencies Properly

**Real Incident Report**: A team's CI builds took 8 minutes because every build downloaded dependencies from scratch. By reordering the Dockerfile to cache the dependency layer, builds dropped to 2 minutes on code-only changes - a 75% improvement.

**The Anti-Pattern**:
```dockerfile
# WRONG: Copies everything, invalidates cache on any change
FROM golang:1.27.1
WORKDIR /app
COPY . .                    # Any file change busts this layer
RUN go mod download         # Re-downloads every time
RUN go build -o /myapp
```

**The Better Approach**:
```dockerfile
# RIGHT: Cache-optimized layer order
FROM golang:1.27.1 AS builder
WORKDIR /app

# Layer 1: Dependencies (changes rarely)
COPY go.mod go.sum ./
RUN go mod download

# Layer 2: Source (changes often)
COPY . .
RUN go build -o /myapp

# Dependencies cached unless go.mod/go.sum change
```

**Key Insight**: Docker layers cache from top to bottom until invalidation. Put things that change least at the top.

### Pitfall 3: Running as Root

**Real Incident Report**: A container compromise allowed an attacker to escape to the host because the container ran as root. Container escape exploits are dramatically more severe when the container process has root privileges. The fix was one line: `USER nonroot`.

**The Anti-Pattern**:
```dockerfile
# WRONG: Running as root (default)
FROM golang:1.27.1
COPY myapp /app
CMD ["/app"]
# Container process runs as UID 0 (root)
```

**The Better Approach**:
```dockerfile
# RIGHT: Non-root user
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=builder /myapp /myapp
USER nonroot:nonroot
ENTRYPOINT ["/myapp"]

# Or with scratch:
FROM scratch
COPY --from=builder /myapp /myapp
USER 65534:65534    # nobody
ENTRYPOINT ["/myapp"]
```

**Key Insight**: Running as non-root is a defense-in-depth measure that makes container escapes far less damaging.

### Pitfall 4: No .dockerignore File

**Real Incident Report**: A team accidentally included their `.git` directory (500MB) and test fixtures (200MB) in their Docker build context. Builds were slow, images were huge, and worse - secrets in `.git` history were now in the image layer.

**The Anti-Pattern**:
- No `.dockerignore` file
- Build context includes everything
- Secrets in build context
- Unnecessary files inflate images

**The Better Approach**:
```dockerignore
# .dockerignore - exclude from build context
.git
.gitignore
.env
*.md
docs/
Makefile

# Test files
*_test.go
testdata/

# Build artifacts
bin/
dist/

# Editor files
.vscode/
.idea/
*.swp
```

**Key Insight**: Everything in your build context is sent to the Docker daemon. Exclude aggressively.

### Pitfall 5: Missing Health Checks

**Real Incident Report**: Kubernetes kept routing traffic to a container that had deadlocked - it was running but not responding. Without a health check, the orchestrator had no way to know the container was unhealthy. Adding a proper liveness probe enabled automatic recovery.

**The Anti-Pattern**:
```dockerfile
# WRONG: No health check
FROM scratch
COPY /myapp /myapp
CMD ["/myapp"]
# Orchestrator can't tell if the app is healthy
```

**The Better Approach**:
```dockerfile
# RIGHT: With health check
FROM gcr.io/distroless/static-debian12
COPY --from=builder /myapp /myapp

# Dockerfile HEALTHCHECK (for standalone Docker)
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD ["/myapp", "health"]

ENTRYPOINT ["/myapp"]
```

```go
package main

import (
	"database/sql"
	"net/http"
)

var db *sql.DB

// In your Go app - health endpoint
func healthHandler(w http.ResponseWriter, r *http.Request) {
	// Check dependencies
	if err := db.Ping(); err != nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	w.WriteHeader(http.StatusOK)
}
```

**Key Insight**: Without health checks, "running" doesn't mean "healthy." Orchestrators need signals to make routing decisions.

### Pitfall 6: Shell Form vs Exec Form Signal Swallowing

As highlighted in [Common Docker Mistakes in Go Microservices](https://medium.com/@yaninyzwitty/common-docker-mistakes-in-go-microservices) by Yaninyz witty, how you define `CMD` or `ENTRYPOINT` dictates whether OS signals ever reach your Go application:

**The Anti-Pattern (Shell Form)**:
```dockerfile
# WRONG: Shell form invokes /bin/sh -c "./server"
CMD ./server
```
In this syntax, `/bin/sh` runs as PID 1 inside the container namespace, and your Go server runs as a child process. When Docker or Kubernetes stops the container, it issues `SIGTERM` to PID 1. Standard POSIX shells do not forward signals to child processes by default. The Go application never sees `SIGTERM`, never executes its graceful shutdown sequence, and is forcibly terminated with `SIGKILL` after the 30-second timeout expires.

**The Better Approach (Exec Form)**:
```dockerfile
# RIGHT: JSON array exec form ensures Go binary is PID 1
CMD ["/server"]
```
With the JSON array syntax, no shell is invoked. The Go binary directly binds PID 1 and immediately receives `SIGTERM` and `SIGINT`.

### Pitfall 7: Mutable Base Image Tags vs Cryptographic SHA256 Pinning

**The Anti-Pattern**:
```dockerfile
# WRONG: Mutable tag can change upstream without notice
FROM golang:1.24-alpine AS builder
FROM gcr.io/distroless/static-debian12
```
Tags such as `alpine` or `1.24-alpine` are mutable pointers. Upstream updates, re-tagging, or compromised registry credentials can silently change the compiler version, toolchains, or system libraries, producing non-reproducible builds and introducing supply-chain vulnerabilities.

**The Better Approach**:
```dockerfile
# RIGHT: Pinned immutable digest
FROM golang:1.24.1-alpine3.21@sha256:43c094ad24b6ac0546c62193baeb3e6e49ce14d3250845d166c7781293e2974e AS builder
FROM gcr.io/distroless/static-debian12@sha256:63b6529384a81744cb89e8020a1122a27a08e1ec918342416f0d367fa62ad529
```
Automated tooling (such as Renovate or Dependabot) can monitor and propose audited SHA256 updates via pull requests with automated test runs.

### Pitfall 8: Monolithic Multi-Workload Containers

**The Anti-Pattern**:
Packing the HTTP API, background queue consumers (Kafka / RabbitMQ workers), and schema migrators into a single binary managed by a shell wrapper or supervisord:
- Scaling the HTTP layer horizontally forces identical scaling of background queue consumers, leading to consumer group partition rebalance thrashing.
- An unhandled panic in the Kafka worker terminates the HTTP server and drops user connections.
- Memory and CPU limits cannot be tuned independently.

**The Better Approach**:
Structure the repository so independent workload entrypoints share internal libraries while building into specialized container images:
```
cmd/
  ├── server/       # HTTP / gRPC entrypoint (scaled on request throughput / latency)
  ├── worker/       # Queue worker entrypoint (scaled on consumer group backlog / lag)
  └── migrator/     # Database migration job (executed as a Kubernetes Job before deployment)
```

### Quick Reference: Docker Anti-Patterns

| Anti-Pattern | Symptom | Fix |
|--------------|---------|-----|
| Full base image | 800MB image, 200 CVEs | Use scratch or distroless |
| Poor caching | 8 min builds, always redownloads | Copy go.mod first, then source |
| Running as root | Container escape = host compromise | USER nonroot, UID 65534 |
| No .dockerignore | Secrets in image, huge context | Exclude .git, tests, docs |
| Shell form `CMD` | SIGTERM ignored, 30s delay on exit | Use exec form: `CMD ["/server"]` |
| Mutable base tags | Non-reproducible builds, supply risk | Pin cryptographic digests (`@sha256:...`) |
| Monolithic container | Worker panic crashes API | Split into `cmd/server`, `cmd/worker`, `cmd/migrator` |
| No health check | Unhealthy containers receive traffic | Add liveness/readiness probes |
| Hardcoded config | Can't change between environments | Use environment variables |

---

### Junior → FAANG: Avoiding the Most Common Docker Mistakes Early

The mistakes in this list all share a common root cause: copying patterns from tutorials that prioritize getting something running over getting something right. The antidote is developing a mental checklist that runs before every PR that touches a Dockerfile.

The non-negotiable checklist items: (1) Is the final image using a minimal base (distroless or scratch)? (2) Is the Go binary built with `CGO_ENABLED=0`? (3) Is there a `.dockerignore` file? (4) Are there no secrets or credentials anywhere in any layer? (5) Is there a non-root user? (6) Is there a `HEALTHCHECK` instruction or equivalent probe configuration? Running through this list on every Dockerfile change is the habit that separates engineers who understand containers from engineers who just know the syntax.

The most embarrassing mistake in an interview is submitting a Dockerfile with `COPY . .` before `RUN go mod download`. It is the first thing reviewers look at, and it immediately signals a gap in understanding of layer caching. Fix this before showing any code.

### Senior @ FAANG: Turning Pitfalls Into Platform Guardrails

At staff level, the goal is to make these pitfalls structurally impossible, not just documented. Each item in the pitfall table corresponds to a possible automated check:

Mutable tags and no digest pinning: enforced by a conftest policy that rejects Dockerfiles with `FROM` instructions using mutable tags like `latest` or unversioned minor tags. Large images: enforced by a CI gate that fails if the final image size exceeds a configured threshold per service tier. No `.dockerignore`: enforced by a linter that checks for the file's existence before accepting a PR. Secrets in images: enforced by a scanner (Trufflehog, detect-secrets) run against the built image layers. Running as root: enforced by a Kubernetes admission controller (OPA Gatekeeper, Kyverno) that rejects pods without an explicit non-root user or `runAsNonRoot: true`.

The senior insight is that documentation of pitfalls has near-zero effectiveness at scale. Engineers are busy, documentation is not read, and the same mistakes recur in each new team. Automated enforcement at the right layer in the delivery pipeline is the only mechanism that reliably prevents these mistakes across a large organization. The L6/L7 task is to identify which layer is the right enforcement point for each pitfall (Dockerfile linter, CI gate, registry admission, runtime admission) and build or configure the tool at that layer.
