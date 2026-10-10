## 27.10 Development Toolchain & Operational Commands

Operating an idempotency framework and exactly-once processing engine in production requires rigorous local testing, automated race detection, containerized service orchestration, and automated replay testing. Standardizing these workflows through a unified Makefile ensures that all engineers on the team validate idempotency semantics against the same specifications.

### Complete Automation Makefile

The following Makefile manages building, testing, container orchestration, database migrations, and live API idempotency verification:

```makefile
APP_NAME       := idempotency-service
BINARY_PATH    := ./cmd/server
BINARY_NAME    := bin/$(APP_NAME)
VERSION        ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo "v1.0.0")
LDFLAGS        := -ldflags="-s -w -X main.Version=$(VERSION)"

GOCMD          := go
GOBUILD        := $(GOCMD) build
GOTEST         := $(GOCMD) test
GOCLEAN        := $(GOCMD) clean
GOMOD          := $(GOCMD) mod
DOCKER_IMAGE   := idempotency-service
DOCKER_COMPOSE := docker compose

.PHONY: all build build-linux run run-dev test test-short test-integration coverage lint fmt vet deps docker docker-up docker-down bench clean help

all: lint test build

## Build: Compile the application binary
build:
	$(GOBUILD) $(LDFLAGS) -o $(BINARY_NAME) $(BINARY_PATH)

## Build-Linux: Cross-compile static binary for Linux container environments
build-linux:
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 $(GOBUILD) $(LDFLAGS) -o $(BINARY_NAME)-linux $(BINARY_PATH)

## Run: Run the idempotency server locally
run:
	$(GOCMD) run $(BINARY_PATH)

## Run-Dev: Run with live reloading via Air
run-dev:
	air

## Test: Run unit tests with race detection
test:
	$(GOTEST) -v -race ./...

## Test-Short: Fast test run omitting long-running integration suites
test-short:
	$(GOTEST) -v -short ./...

## Test-Integration: Run database and Redis idempotency store integration tests
test-integration:
	$(GOTEST) -v -tags=integration ./...

## Coverage: Generate and inspect test code coverage HTML report
coverage:
	$(GOTEST) -coverprofile=coverage.out ./...
	$(GOCMD) tool cover -html=coverage.out -o coverage.html
	@echo "Coverage report generated at coverage.html"

## Quality: Lint, format, and vet code
lint:
	golangci-lint run ./...

fmt:
	gofmt -s -w .

vet:
	$(GOCMD) vet ./...

## Dependencies: Download and verify go.mod modules
deps:
	$(GOMOD) tidy
	$(GOMOD) verify

## Docker: Build and tag container image
docker:
	docker build -t $(DOCKER_IMAGE):$(VERSION) .
	docker tag $(DOCKER_IMAGE):$(VERSION) $(DOCKER_IMAGE):latest

docker-up:
	$(DOCKER_COMPOSE) up -d

docker-down:
	$(DOCKER_COMPOSE) down

## Benchmarks: Run idempotency storage and deduplication benchmarks
bench:
	$(GOTEST) -bench=. -benchmem ./...

## Clean: Remove compiled binaries and coverage outputs
clean:
	$(GOCLEAN)
	rm -rf bin/ coverage.out coverage.html

## Help: Display available commands
help:
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

.DEFAULT_GOAL := help
```

### Verification & Replay Testing Script

Testing idempotent endpoints requires verifying that identical requests produce matching responses without re-executing business side effects. Use the following script to test payment creation and automatic replay handling:

```bash
#!/usr/bin/env bash
set -euo pipefail

BASE_URL="http://localhost:8080/api/payments"
IDEMPOTENCY_KEY="idem-$(date +%s)-$RANDOM"

echo "=== 1. First Request (Should Execute) ==="
curl -i -X POST "$BASE_URL" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $IDEMPOTENCY_KEY" \
  -d '{"amount_cents": 10000, "currency": "USD", "user_id": "usr_9981"}'

echo -e "\n=== 2. Duplicate Request with Same Key (Should Replay Cached Response) ==="
curl -i -X POST "$BASE_URL" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $IDEMPOTENCY_KEY" \
  -d '{"amount_cents": 10000, "currency": "USD", "user_id": "usr_9981"}'

echo -e "\n=== 3. Conflict Test: Same Key with Altered Payload (Must Return 422/409 Conflict) ==="
curl -i -X POST "$BASE_URL" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $IDEMPOTENCY_KEY" \
  -d '{"amount_cents": 99999, "currency": "EUR", "user_id": "usr_9981"}'
```
