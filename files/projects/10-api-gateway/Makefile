BINARY_DIR := bin
BINARY     := $(BINARY_DIR)/gateway
CONFIG     ?= configs/gateway.yaml
GOFLAGS    := -trimpath

.PHONY: all build run test lint clean infra-up infra-down docker-build help

all: build

## build: Compile the gateway binary
build:
	@mkdir -p $(BINARY_DIR)
	go build $(GOFLAGS) -o $(BINARY) ./cmd/gateway
	@echo "Built: $(BINARY)"

## run: Start the gateway (reads --config flag)
run:
	go run ./cmd/gateway --config $(CONFIG)

## test: Run all tests with race detector
test:
	go test -race -count=1 -timeout=120s ./...

## test-cover: Run tests with HTML coverage report
test-cover:
	go test -race -coverprofile=coverage.out ./...
	go tool cover -html=coverage.out

## test-integration: Run integration tests (requires the gateway to be running)
test-integration:
	go test -v -tags integration -timeout=60s ./test/integration/...

## lint: Run go vet
lint:
	go vet ./...

## clean: Remove compiled binary
clean:
	rm -rf $(BINARY_DIR)

## infra-up: Start Redis and Jaeger via Docker Compose
infra-up:
	docker compose up -d
	@echo "Infrastructure ready."
	@echo "Jaeger UI: http://localhost:16686"
	@echo "Redis:     localhost:6379"

## infra-down: Stop and remove infrastructure containers
infra-down:
	docker compose down

## infra-logs: Tail infrastructure container logs
infra-logs:
	docker compose logs -f

## config-init: Copy example gateway config if not present
config-init:
	@[ -f configs/gateway.yaml ] || cp configs/gateway.example.yaml configs/gateway.yaml
	@echo "Config ready at configs/gateway.yaml"

## docker-build: Build the gateway Docker image
docker-build:
	docker build -t api-gateway:latest .

## docker-push: Push to registry (set IMAGE_REPO variable)
docker-push:
	docker tag api-gateway:latest $(IMAGE_REPO)/api-gateway:latest
	docker push $(IMAGE_REPO)/api-gateway:latest

## admin-health: Check admin API health
admin-health:
	curl -s -H "X-API-Key: $${ADMIN_API_KEY}" http://localhost:9090/health | jq .

## admin-routes: List routes via admin API
admin-routes:
	curl -s -H "X-API-Key: $${ADMIN_API_KEY}" http://localhost:9090/routes | jq .

## admin-reload: Reload gateway config via admin API
admin-reload:
	curl -s -X POST -H "X-API-Key: $${ADMIN_API_KEY}" http://localhost:9090/config/reload | jq .

## tidy: Tidy go modules
tidy:
	go mod tidy
	go mod verify

## help: Show this help
help:
	@grep -E '^## ' Makefile | sed 's/## /  /'
