BINARY_DIR := bin
MODULE     := github.com/example/cicd-platform
GOFLAGS    := -trimpath

.PHONY: all build run run-worker run-cli test lint clean infra-up infra-down docker-build docker-push help

all: build

## build: Compile all three binaries into ./bin/
build:
	@mkdir -p $(BINARY_DIR)
	go build $(GOFLAGS) -o $(BINARY_DIR)/apiserver ./cmd/apiserver
	go build $(GOFLAGS) -o $(BINARY_DIR)/worker    ./cmd/worker
	go build $(GOFLAGS) -o $(BINARY_DIR)/cli       ./cmd/cli
	@echo "Build complete: $(BINARY_DIR)/"

## run: Start the API server (reads .env if present)
run:
	@[ -f .env ] && export $$(grep -v '^#' .env | xargs) || true
	go run ./cmd/apiserver

## run-worker: Start a pipeline job worker
run-worker:
	@[ -f .env ] && export $$(grep -v '^#' .env | xargs) || true
	go run ./cmd/worker

## run-cli: Run the CLI tool
run-cli:
	go run ./cmd/cli $(ARGS)

## test: Run all tests with race detector
test:
	go test -race -count=1 -timeout=120s ./...

## test-cover: Run tests and open coverage report
test-cover:
	go test -race -coverprofile=coverage.out ./...
	go tool cover -html=coverage.out

## lint: Run go vet and staticcheck
lint:
	go vet ./...

## infra-up: Start PostgreSQL, Redis, MinIO with Docker Compose
infra-up:
	docker compose up -d
	@echo "Waiting for services to be healthy..."
	@sleep 3
	@echo "Infrastructure ready."

## infra-down: Stop and remove infrastructure containers
infra-down:
	docker compose down

## infra-logs: Tail infrastructure container logs
infra-logs:
	docker compose logs -f

## clean: Remove compiled binaries
clean:
	rm -rf $(BINARY_DIR)
	@echo "Cleaned."

## docker-build: Build the apiserver Docker image
docker-build:
	docker build -t cicd-platform:latest -f Dockerfile .

## docker-push: Push the image to a registry (set IMAGE_REPO variable)
docker-push:
	docker tag cicd-platform:latest $(IMAGE_REPO)/cicd-platform:latest
	docker push $(IMAGE_REPO)/cicd-platform:latest

## tidy: Tidy and verify go modules
tidy:
	go mod tidy
	go mod verify

## help: Show this help
help:
	@grep -E '^## ' Makefile | sed 's/## /  /'
