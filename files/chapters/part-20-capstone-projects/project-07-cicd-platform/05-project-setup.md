## Project Setup

> **Why `github.com/google/uuid` and not the Go 1.27 stdlib `uuid` package?** This project stores `uuid.UUID` values in struct fields that are scanned from the database and passed as query arguments. That path requires the `sql.Scanner` and `driver.Valuer` interfaces, which the standard library type deliberately does not implement. The third-party package remains the right choice wherever UUIDs cross a `database/sql` boundary. Projects in this book whose UUIDs stay in memory or serialize as strings (the URL shortener, API gateway, and ML platform) use the stdlib package instead.

Before writing any code, you need a well-organized directory structure that separates concerns cleanly. A CI/CD platform has many moving parts, including an API server, background workers, a CLI tool, and shared internal packages. Laying out the project correctly from the start makes it much easier to navigate, test, and deploy each component independently. The structure below follows the standard Go project layout conventions, with `cmd/` for entry points and `internal/` for private packages.

### Directory Structure

The following directory layout establishes the modular organization for the CI/CD platform components:

```
cicd-platform/
├── cmd/
│   ├── apiserver/          # HTTP API server
│   │   └── main.go
│   ├── worker/             # Job worker
│   │   └── main.go
│   └── cli/                # CLI tool
│       └── main.go
├── internal/
│   ├── api/                # HTTP handlers
│   │   ├── handlers.go
│   │   ├── middleware.go
│   │   └── routes.go
│   ├── domain/             # Business logic
│   │   ├── pipeline.go
│   │   ├── job.go
│   │   ├── artifact.go
│   │   └── repository.go
│   ├── executor/           # Container execution
│   │   ├── docker.go
│   │   ├── executor.go
│   │   └── logger.go
│   ├── git/                # Git operations
│   │   ├── clone.go
│   │   ├── webhook.go
│   │   └── provider.go
│   ├── parser/             # Pipeline YAML parser
│   │   ├── parser.go
│   │   ├── validator.go
│   │   └── types.go
│   ├── queue/              # Job queue
│   │   ├── redis.go
│   │   └── queue.go
│   ├── storage/            # Database & S3
│   │   ├── postgres.go
│   │   ├── s3.go
│   │   └── models.go
│   ├── websocket/          # Real-time logs
│   │   ├── hub.go
│   │   └── client.go
│   └── config/             # Configuration
│       └── config.go
├── pkg/                    # Public libraries
│   ├── logger/
│   ├── errors/
│   └── validator/
├── web/                    # Frontend assets
│   ├── templates/
│   ├── static/
│   └── assets/
├── migrations/             # SQL migrations
│   ├── 001_initial.up.sql
│   └── 001_initial.down.sql
├── deployments/            # Docker/K8s configs
│   ├── docker-compose.yml
│   └── kubernetes/
├── scripts/                # Helper scripts
│   ├── setup-dev.sh
│   └── seed-data.sql
├── .pipeline.yaml          # Self-hosting CI config
├── go.mod
├── go.sum
├── Makefile
└── README.md
```

### Initial Setup

#### 1. Initialize Go Module Create the project directory and initialize a Go module:

```bash
mkdir cicd-platform && cd cicd-platform
go mod init github.com/yourusername/cicd-platform
```

#### 2. Create `go.mod` with Dependencies

The `go.mod` file lists all required dependencies: Docker client for container execution, chi for HTTP routing, validator for input validation, and database drivers for PostgreSQL and Redis.

```
// go.mod
module github.com/yourusername/cicd-platform

go 1.27

require (
    github.com/docker/docker v27.5.1+incompatible
    github.com/docker/go-connections v0.5.0
    github.com/go-chi/chi/v5 v5.2.1
    github.com/go-chi/cors v1.2.1
    github.com/go-playground/validator/v10 v10.26.0
    github.com/google/uuid v1.6.0
    github.com/gorilla/websocket v1.5.3
    github.com/jackc/pgx/v5 v5.7.4
    github.com/lib/pq v1.10.9
    github.com/minio/minio-go/v7 v7.0.87
    github.com/redis/go-redis/v9 v9.7.3
    github.com/rs/zerolog v1.34.0
    go.opentelemetry.io/otel v1.35.0
    go.opentelemetry.io/otel/trace v1.35.0
    golang.org/x/crypto v0.37.0
    gopkg.in/yaml.v3 v3.0.1
)
```

#### 3. Create Development Environment Create `deployments/docker-compose.yml`:

```yaml
name: cicd-platform

services:
  postgres:
    image: postgres:18-alpine
    environment:
      POSTGRES_DB: cicd
      POSTGRES_USER: cicd
      POSTGRES_PASSWORD: cicd_dev_password
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./scripts/seed-data.sql:/docker-entrypoint-initdb.d/seed.sql
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U cicd"]
      interval: 10s
      timeout: 5s
      retries: 5

  redis:
    image: redis:8-alpine
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

  minio:
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    ports:
      - "9000:9000"
      - "9001:9001"
    volumes:
      - minio_data:/data
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:9000/minio/health/live"]
      interval: 30s
      timeout: 20s
      retries: 3

  # Create MinIO buckets on startup
  minio-setup:
    image: minio/mc:latest
    depends_on:
      - minio
    entrypoint: >
      /bin/sh -c "
      sleep 5;
      mc alias set myminio http://minio:9000 minioadmin minioadmin;
      mc mb myminio/artifacts;
      mc mb myminio/logs;
      mc mb myminio/cache;
      mc policy set download myminio/artifacts;
      "

volumes:
  postgres_data:
  minio_data:
```

#### 4. Create Makefile

The Makefile provides shortcuts for common development tasks: starting dependencies, running tests, applying migrations, and building release binaries.

```makefile
# Makefile
.PHONY: help dev build test clean migrate-up migrate-down docker-up docker-down

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

dev: ## Run in development mode
	docker compose -f deployments/docker-compose.yml up -d
	@echo "Waiting for services to be ready..."
	sleep 5
	go run cmd/apiserver/main.go

build: ## Build all binaries
	go build -o bin/apiserver cmd/apiserver/main.go
	go build -o bin/worker cmd/worker/main.go
	go build -o bin/cli cmd/cli/main.go

test: ## Run tests
	go test -v -race -coverprofile=coverage.out ./...

test-integration: ## Run integration tests
	go test -v -tags=integration ./...

lint: ## Run linters
	golangci-lint run ./...

migrate-up: ## Run database migrations
	migrate -path migrations -database "postgresql://cicd:cicd_dev_password@localhost:5432/cicd?sslmode=disable" up

migrate-down: ## Rollback database migrations
	migrate -path migrations -database "postgresql://cicd:cicd_dev_password@localhost:5432/cicd?sslmode=disable" down

docker-up: ## Start all services
	docker compose -f deployments/docker-compose.yml up -d

docker-down: ## Stop all services
	docker compose -f deployments/docker-compose.yml down

clean: ## Clean build artifacts
	rm -rf bin/
	go clean -cache

proto: ## Generate protobuf code (if using gRPC)
	protoc --go_out=. --go-grpc_out=. api/proto/*.proto
```

---

### Junior → FAANG: Treating Project Setup as a Reproducibility Contract

The Makefile and docker-compose files in a project setup are a reproducibility contract. A junior engineer's first-job habit: after cloning a repo, run the setup from a clean environment and document every manual step that the Makefile misses. Those gaps are future onboarding bugs. In interviews, when asked "how would you onboard a new engineer," mention infrastructure-as-code for local dev (docker-compose, devcontainers) as a first-class deliverable alongside documentation.

### Senior @ FAANG: Dev Environment as a Platform Concern

At staff level, the project setup is evaluated as a developer experience platform decision. Questions to answer: how long does a clean checkout-to-running-tests cycle take, and what is the target? Google's target for this is under 5 minutes for most services. Does the local environment faithfully simulate production behavior (same Postgres version, same Docker network topology)? Are environment variables managed with a secrets manager or do engineers copy .env files manually (which is a secrets hygiene violation)? The Makefile proto target signals a decision to use gRPC, which requires a proto versioning and breaking-change governance policy. Document who owns the `.proto` files, how breaking changes are communicated to consumers, and whether a Buf registry or similar is used for schema management.

---
