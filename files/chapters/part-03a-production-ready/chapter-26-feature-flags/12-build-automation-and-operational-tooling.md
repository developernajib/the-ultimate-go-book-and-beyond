## 26.10 Build, Automation, and Operational Commands

A production-grade feature flag service requires consistent, automated tooling for builds, testing, containerization, database migrations, and operational maintenance. Rather than running ad-hoc shell commands, standardizing targets in a project Makefile guarantees reproducibility across local developer machines and CI/CD pipelines.

### Complete Project Makefile

The following Makefile coordinates the full lifecycle of the feature flag server and the accompanying `flagctl` administrative CLI:

```makefile
APP_NAME    := flagserver
CLI_NAME    := flagctl
VERSION     ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo "v1.0.0")
COMMIT      ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo "unknown")
BUILD_TIME  := $(shell date -u +'%Y-%m-%dT%H:%M:%SZ')
LDFLAGS     := -s -w -X main.Version=$(VERSION) -X main.Commit=$(COMMIT) -X main.BuildTime=$(BUILD_TIME)

.PHONY: all build build-cli test lint run docker up down logs clean migrate seed help

all: lint test build build-cli

## Build: Compile the server binary
build:
	@echo "Building $(APP_NAME) ($(VERSION))..."
	CGO_ENABLED=0 go build -trimpath -ldflags="$(LDFLAGS)" -o bin/$(APP_NAME) ./cmd/flagserver

## Build-CLI: Compile the flagctl administration CLI
build-cli:
	@echo "Building $(CLI_NAME)..."
	CGO_ENABLED=0 go build -trimpath -ldflags="$(LDFLAGS)" -o bin/$(CLI_NAME) ./cmd/flagctl

## Test: Run unit and race-detector tests
test:
	go test -race -covermode=atomic -coverprofile=coverage.out ./...
	@go tool cover -func=coverage.out | grep total | awk '{print "Total Coverage: " $$3}'

## Lint: Execute static analysis linters
lint:
	golangci-lint run --timeout=5m ./...

## Run: Run the feature flag server locally
run: build
	./bin/$(APP_NAME) --config=configs/development.yaml

## Docker: Build production container image
docker:
	docker build --build-arg VERSION=$(VERSION) --build-arg COMMIT=$(COMMIT) \
		-t $(APP_NAME):$(VERSION) -t $(APP_NAME):latest .

## Up: Launch server and dependencies (PostgreSQL, Redis) via Docker Compose
up:
	docker compose up -d

## Down: Stop all containers and remove networks
down:
	docker compose down

## Logs: Tail live logs from the flagserver service
logs:
	docker compose logs -f $(APP_NAME)

## Clean: Remove compiled binaries and clear test cache
clean:
	rm -rf bin/ coverage.out
	go clean -testcache

## Migrate: Run database migrations
migrate:
	go run ./cmd/migrate up

## Seed: Populate initial feature flags and percentage rollouts
seed:
	./bin/$(CLI_NAME) flag create --name "new-checkout" --key "new-checkout-flow" \
		--description "New checkout flow experiment"
	./bin/$(CLI_NAME) flag enable "new-checkout-flow" --percentage 10

## Help: Display available Makefile targets
help:
	@echo "Feature Flag System Automation"
	@echo ""
	@echo "Usage: make <target>"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

.DEFAULT_GOAL := help
```

### Production Engineering Considerations

1. **Deterministic Binaries (`-trimpath` and `CGO_ENABLED=0`)**: Producing static, portable binaries ensures that the container image runs smoothly on minimal distroless or Alpine base images without dynamic libc dependency mismatches.
2. **Metadata Injection via `-ldflags`)**: Embedding the Git commit SHA, semantic version, and build timestamp directly into the binary enables the `/healthz` and `/version` endpoints to accurately report running revisions during rollouts and rollbacks.
3. **Atomic Migration & Seed Routines**: Running database schema migrations in a dedicated pre-deploy hook or container task before booting application traffic prevents race conditions when new flag schema columns are introduced.
