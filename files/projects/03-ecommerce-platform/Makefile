BINARY_DIR := bin
MODULE     := github.com/example/ecommerce-platform

.PHONY: all build clean test lint proto \
        run-product run-gateway run-all \
        infra-up infra-down logs

# ─── Build ────────────────────────────────────────────────────────────────────

all: build

## build: Compile all service binaries into bin/
build: build-product build-gateway build-server

build-product:
	@echo ">>> Building product service..."
	@mkdir -p $(BINARY_DIR)
	go build -o $(BINARY_DIR)/product-service ./services/product/cmd/server/

build-gateway:
	@echo ">>> Building API gateway..."
	@mkdir -p $(BINARY_DIR)
	go build -o $(BINARY_DIR)/api-gateway ./api-gateway/cmd/gateway/

build-server:
	@echo ">>> Building monolith server (dev)..."
	@mkdir -p $(BINARY_DIR)
	go build -o $(BINARY_DIR)/server ./cmd/server/

## clean: Remove compiled binaries
clean:
	@echo ">>> Cleaning binaries..."
	rm -rf $(BINARY_DIR)

# ─── Run ──────────────────────────────────────────────────────────────────────

## run-product: Start the product gRPC service (port 50051)
run-product:
	@echo ">>> Starting product service on :50051..."
	DB_HOST=$${DB_HOST:-localhost} \
	DB_USER=$${DB_USER:-postgres} \
	DB_PASSWORD=$${DB_PASSWORD:-postgres} \
	DB_NAME=$${DB_NAME:-product_db} \
	GRPC_PORT=$${GRPC_PORT:-50051} \
	JAEGER_ENDPOINT=$${JAEGER_ENDPOINT:-http://localhost:14268/api/traces} \
	go run ./services/product/cmd/server/

## run-gateway: Start the API gateway (port 8080)
run-gateway:
	@echo ">>> Starting API gateway on :8080..."
	HTTP_PORT=$${HTTP_PORT:-8080} \
	PRODUCT_SERVICE_ADDR=$${PRODUCT_SERVICE_ADDR:-localhost:50051} \
	go run ./api-gateway/cmd/gateway/

## run-server: Start the monolith server (dev/demo)
run-server:
	@echo ">>> Starting monolith server on :8080..."
	HTTP_PORT=$${HTTP_PORT:-8080} \
	go run ./cmd/server/

## run-all: Start infrastructure + all services via Docker Compose
run-all:
	docker compose up --build

# ─── Infrastructure ───────────────────────────────────────────────────────────

## infra-up: Start only infrastructure containers (PostgreSQL, Redis, NATS, ES)
infra-up:
	@echo ">>> Starting infrastructure..."
	docker compose up -d postgres redis nats elasticsearch
	@echo ">>> Waiting for services to be ready..."
	@sleep 5
	docker compose ps

## infra-down: Stop and remove all containers
infra-down:
	docker compose down

## logs: Stream logs from all containers
logs:
	docker compose logs -f

# ─── Test & Lint ──────────────────────────────────────────────────────────────

## test: Run all tests with race detector
test:
	@echo ">>> Running tests..."
	go test -race -count=1 ./...

## test-coverage: Run tests and display coverage report
test-coverage:
	@echo ">>> Running tests with coverage..."
	go test -race -coverprofile=coverage.out ./...
	go tool cover -html=coverage.out -o coverage.html
	@echo ">>> Coverage report written to coverage.html"

## lint: Run go vet across all packages
lint:
	@echo ">>> Running go vet..."
	go vet ./...

## tidy: Tidy and verify module dependencies
tidy:
	go mod tidy
	go mod verify

# ─── Proto ────────────────────────────────────────────────────────────────────

## proto: Regenerate Go code from .proto files (requires protoc + plugins)
proto:
	@echo ">>> Generating proto files..."
	protoc \
		--go_out=. --go_opt=paths=source_relative \
		--go-grpc_out=. --go-grpc_opt=paths=source_relative \
		services/product/proto/*.proto

# ─── Help ─────────────────────────────────────────────────────────────────────

## help: Display available make targets
help:
	@echo ""
	@echo "E-Commerce Platform - available targets:"
	@echo ""
	@grep -E '^## ' Makefile | sed 's/^## /  /'
	@echo ""
