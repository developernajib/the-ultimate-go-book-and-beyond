BINARY_DIR := bin
BINARY     := $(BINARY_DIR)/observability
CONFIG     ?= configs/config.yaml
GOFLAGS    := -trimpath

.PHONY: all build run test lint clean infra-up infra-down docker-build help

all: build

## build: Compile the observability binary
build:
	@mkdir -p $(BINARY_DIR)
	go build $(GOFLAGS) -o $(BINARY) ./cmd/observability
	@echo "Built: $(BINARY)"

## run: Start the observability platform
run:
	go run ./cmd/observability -config $(CONFIG)

## test: Run all tests with race detector
test:
	go test -race -count=1 -timeout=180s ./...

## test-cover: Run tests with HTML coverage report
test-cover:
	go test -race -coverprofile=coverage.out ./...
	go tool cover -html=coverage.out

## lint: Run go vet
lint:
	go vet ./...

## clean: Remove compiled binary
clean:
	rm -rf $(BINARY_DIR)

## infra-up: Start ClickHouse and Prometheus with Docker Compose
infra-up:
	docker compose up -d
	@echo "Waiting for ClickHouse to be ready..."
	@sleep 5
	@echo "Infrastructure ready."

## infra-down: Stop and remove infrastructure containers
infra-down:
	docker compose down

## infra-logs: Tail infrastructure container logs
infra-logs:
	docker compose logs -f

## config-init: Copy example config if config.yaml does not exist
config-init:
	@[ -f configs/config.yaml ] || cp configs/config.example.yaml configs/config.yaml
	@echo "Config ready at configs/config.yaml"

## docker-build: Build the observability Docker image
docker-build:
	docker build -t observability-platform:latest .

## tidy: Tidy go modules
tidy:
	go mod tidy
	go mod verify

## query-test: Run a test instant query against the running server
query-test:
	curl -s "http://localhost:8080/api/v1/query?query=up" | jq .

## help: Show this help
help:
	@grep -E '^## ' Makefile | sed 's/## /  /'
