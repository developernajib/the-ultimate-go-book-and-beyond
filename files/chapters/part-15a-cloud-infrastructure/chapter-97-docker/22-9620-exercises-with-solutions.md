## 97.22 Exercises with Solutions

### Exercise 1: Multi-Stage Dockerfile

**Task**: Create a Dockerfile for a Go web server that:
1. Uses multi-stage build
2. Produces an image under 20MB
3. Runs as non-root
4. Includes health check
5. Injects version info at build time

**Solution**:

```dockerfile
# Build stage
FROM golang:1.27.1-alpine AS builder

ARG VERSION=dev
ARG COMMIT=unknown

WORKDIR /app

# Install certificates (needed for HTTPS clients)
RUN apk add --no-cache ca-certificates tzdata

# Cache dependencies
COPY go.mod go.sum ./
RUN go mod download && go mod verify

# Build with optimizations
COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
    -ldflags="-s -w -X main.Version=${VERSION} -X main.Commit=${COMMIT}" \
    -o /app/server ./cmd/server

# Runtime stage
FROM scratch

# Import from builder
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=builder /usr/share/zoneinfo /usr/share/zoneinfo
COPY --from=builder /app/server /server

# Security: non-root user
USER 65534:65534

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD ["/server", "-health-check"]

EXPOSE 8080

ENTRYPOINT ["/server"]
```

```go
// cmd/server/main.go
package main

import (
    "fmt"
    "net/http"
    "os"
)

var (
    Version = "dev"
    Commit  = "unknown"
)

func main() {
    // Health check mode
    if len(os.Args) > 1 && os.Args[1] == "-health-check" {
        resp, err := http.Get("http://localhost:8080/health")
        if err != nil || resp.StatusCode != 200 {
            os.Exit(1)
        }
        os.Exit(0)
    }

    http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
        fmt.Fprintf(w, "Version: %s, Commit: %s\n", Version, Commit)
    })

    http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(http.StatusOK)
    })

    http.ListenAndServe(":8080", nil)
}
```

```bash
# Build and verify
docker build \
    --build-arg VERSION=1.0.0 \
    --build-arg COMMIT=$(git rev-parse --short HEAD) \
    -t myserver:latest .

docker images myserver:latest
# REPOSITORY   TAG       SIZE
# myserver     latest    15.2MB  ✓ Under 20MB

docker run --rm myserver:latest /server -help
# Runs as UID 65534 (non-root) ✓
```

### Exercise 2: Development Environment with Hot Reload

**Task**: Create a Docker Compose setup for development that:
1. Hot reloads on code changes
2. Includes debugger support
3. Has separate database and cache services
4. Preserves go module cache between builds

**Solution**:

```yaml
# docker-compose.dev.yml
version: '3.8'

services:
  api:
    build:
      context: .
      dockerfile: Dockerfile.dev
    volumes:
      # Mount source code for hot reload
      - .:/app
      # Preserve module cache
      - go-modules:/go/pkg/mod
      # Preserve build cache
      - go-build-cache:/root/.cache/go-build
      # Exclude vendor if using modules
      - /app/vendor
    ports:
      - "8080:8080"   # Application
      - "2345:2345"   # Delve debugger
    environment:
      - GO_ENV=development
      - DATABASE_URL=postgres://dev:dev@postgres:5432/devdb?sslmode=disable
      - REDIS_URL=redis://redis:6379
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_started
    # Use air for hot reload
    command: ["air", "-c", ".air.toml"]

  postgres:
    image: postgres:18-alpine
    environment:
      POSTGRES_USER: dev
      POSTGRES_PASSWORD: dev
      POSTGRES_DB: devdb
    volumes:
      - postgres-data:/var/lib/postgresql/data
      - ./scripts/init.sql:/docker-entrypoint-initdb.d/init.sql
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U dev -d devdb"]
      interval: 5s
      timeout: 5s
      retries: 5

  redis:
    image: redis:8-alpine
    ports:
      - "6379:6379"

  # Optional: pgAdmin for database management
  pgadmin:
    image: dpage/pgadmin4:latest
    environment:
      PGADMIN_DEFAULT_EMAIL: admin@local.dev
      PGADMIN_DEFAULT_PASSWORD: admin
    ports:
      - "5050:80"
    depends_on:
      - postgres

volumes:
  go-modules:
  go-build-cache:
  postgres-data:
```

```dockerfile
# Dockerfile.dev
FROM golang:1.27.1

# Install development tools
RUN go install github.com/cosmtrek/air@latest
RUN go install github.com/go-delve/delve/cmd/dlv@latest

WORKDIR /app

# Download dependencies first (will be cached)
COPY go.mod go.sum ./
RUN go mod download

EXPOSE 8080 2345

CMD ["air", "-c", ".air.toml"]
```

```toml
# .air.toml
root = "."
tmp_dir = "tmp"

[build]
  cmd = "go build -gcflags='all=-N -l' -o ./tmp/main ./cmd/server"
  bin = "./tmp/main"
  include_ext = ["go", "tpl", "tmpl", "html"]
  exclude_dir = ["tmp", "vendor", "testdata", ".git"]
  exclude_regex = ["_test.go"]
  delay = 1000

[log]
  time = true

[misc]
  clean_on_exit = true
```

```bash
# Start development environment
docker compose -f docker-compose.dev.yml up

# In another terminal, attach debugger
# VS Code will connect to localhost:2345
```

### Exercise 3: Production Security Hardening

**Task**: Create a hardened production Docker Compose configuration that:
1. Uses read-only filesystem
2. Drops all capabilities
3. Sets resource limits
4. Enables security scanning
5. Implements proper secrets management

**Solution**:

```yaml
# docker-compose.prod.yml
version: '3.8'

services:
  api:
    image: myapp:${VERSION}
    read_only: true
    tmpfs:
      - /tmp:size=10M,mode=1777
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    user: "65534:65534"
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 512M
        reservations:
          cpus: '0.5'
          memory: 128M
    environment:
      - GOMAXPROCS=2
      - GOMEMLIMIT=460MiB
      - LOG_LEVEL=info
      - DB_PASSWORD_FILE=/run/secrets/db_password
    secrets:
      - db_password
      - api_key
    healthcheck:
      test: ["CMD", "/server", "-health"]
      interval: 30s
      timeout: 5s
      start_period: 10s
      retries: 3
    networks:
      - internal
    ports:
      - "8080:8080"
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
    restart: unless-stopped

  # Security scanner sidecar
  trivy:
    image: aquasec/trivy:latest
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    command: ["image", "--severity", "CRITICAL,HIGH", "myapp:${VERSION}"]
    profiles:
      - scan

networks:
  internal:
    driver: bridge

secrets:
  db_password:
    file: ./secrets/db_password.txt
  api_key:
    file: ./secrets/api_key.txt
```

```bash
# Deploy with security scan
export VERSION=1.0.0

# Run security scan first
docker compose -f docker-compose.prod.yml --profile scan run --rm trivy

# If scan passes, deploy
docker compose -f docker-compose.prod.yml up -d

# Verify security settings
docker inspect myapp-api-1 | jq '.[0].HostConfig.SecurityOpt'
# ["no-new-privileges:true"]

docker inspect myapp-api-1 | jq '.[0].HostConfig.CapDrop'
# ["ALL"]

docker inspect myapp-api-1 | jq '.[0].HostConfig.ReadonlyRootfs'
# true
```

### Junior → FAANG: Making the Most of Exercises

Exercises are most valuable when you do them before reading the solutions. The goal is not to produce correct code on the first attempt; it is to encounter the specific failure modes that the solution addresses. When your multi-stage build produces a 900 MB image instead of an 8 MB one, diagnosing why teaches more than reading a correct example.

After completing each exercise, compare your solution to the provided one and look for differences in: error handling (did you handle all the failure cases?), security controls (did you add the non-root user?), and operational readiness (did you add health checks and resource limits?). The gap between "it works" and "it is production-ready" is exactly what these exercises are designed to expose.

First-job habit: treat exercises as the starting point for a real service. After completing the exercise as written, add the `.dockerignore`, add a health check, add resource limits, run `trivy` against the image, and verify the non-root user is in place. Making "done" mean "production-ready, not just working" is the habit that separates engineers who grow quickly from those who plateau.

### Senior @ FAANG: Using Exercises to Identify Platform Gaps

At staff level, exercises like these reveal where the platform needs to provide more scaffolding. If an engineer needs to manually remember to add non-root users, health checks, and resource limits to every Dockerfile, those controls are not being enforced at the platform layer.

Walk through these exercises with the question: "which of these steps should be automated or enforced by the platform so that individual engineers do not need to remember them?" Non-root user: enforced by admission controller, not left to the Dockerfile author. Resource limits: required by namespace LimitRange or admission webhook. Health check: either enforced by the CI pipeline or provided by a standard base image entrypoint script. Image scanning: automated in CI, not a manual step.

The senior contribution from this exercise set is a gap analysis: here are the security and operational controls that every service needs, here is which ones are currently left to individual engineers to implement, and here is the prioritized list of platform investments that would automate them. That analysis, presented with concrete risk reduction as the justification and implementation cost as the constraint, is an L6/L7 platform roadmap artifact.

---
