## Production Checklist

### Pre-Deployment Build

Run this script (or an equivalent CI pipeline) before every production deploy. It lints, scans for vulnerabilities, runs tests with the race detector, and produces a stripped static binary with embedded version metadata.

```bash
#!/bin/bash
# Production build script

set -e

# Version from git
VERSION=$(git describe --tags --always --dirty)
BUILD_TIME=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
GIT_COMMIT=$(git rev-parse --short HEAD)

# Linting
echo "Running linters..."
golangci-lint run ./...

# Security scanning
echo "Scanning for vulnerabilities..."
govulncheck ./...

# Tests
echo "Running tests..."
go test -race -cover ./...

# Build
echo "Building version $VERSION..."
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
  -ldflags="-s -w \
    -X main.version=$VERSION \
    -X main.buildTime=$BUILD_TIME \
    -X main.gitCommit=$GIT_COMMIT" \
  -trimpath \
  -o ./bin/api \
  ./cmd/api

echo "Build complete: ./bin/api"
ls -lh ./bin/api
```

### Makefile Template

```makefile
.PHONY: all build test lint clean

# Variables
APP_NAME := api
VERSION := $(shell git describe --tags --always --dirty)
BUILD_TIME := $(shell date -u +"%Y-%m-%dT%H:%M:%SZ")
LDFLAGS := -ldflags="-s -w -X main.version=$(VERSION) -X main.buildTime=$(BUILD_TIME)"

# Default target
all: lint test build

# Build
build:
	@echo "Building $(APP_NAME) $(VERSION)..."
	@CGO_ENABLED=0 go build $(LDFLAGS) -o ./bin/$(APP_NAME) ./cmd/api

# Development build
dev:
	@go build -o ./bin/$(APP_NAME) ./cmd/api

# Run
run:
	@go run ./cmd/api

# Tests
test:
	@go test -v -race -cover ./...

# Coverage
coverage:
	@go test -coverprofile=coverage.out ./...
	@go tool cover -html=coverage.out -o coverage.html
	@echo "Coverage report: coverage.html"

# Benchmarks
bench:
	@go test -bench=. -benchmem ./...

# Lint
lint:
	@golangci-lint run ./...

# Vet
vet:
	@go vet ./...

# Format
fmt:
	@go fmt ./...
	@goimports -w .

# Security
security:
	@gosec ./...
	@govulncheck ./...

# Clean
clean:
	@rm -rf ./bin
	@go clean -cache -testcache -modcache

# Install tools
tools:
	@go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest
	@go install golang.org/x/tools/cmd/goimports@latest
	@go install github.com/securego/gosec/v2/cmd/gosec@latest
	@go install golang.org/x/vuln/cmd/govulncheck@latest

# Docker build
docker:
	@docker build -t $(APP_NAME):$(VERSION) .

# Help
help:
	@echo "Available targets:"
	@echo "  make build      - Build production binary"
	@echo "  make dev        - Build development binary"
	@echo "  make run        - Run application"
	@echo "  make test       - Run tests"
	@echo "  make coverage   - Generate coverage report"
	@echo "  make bench      - Run benchmarks"
	@echo "  make lint       - Run linters"
	@echo "  make fmt        - Format code"
	@echo "  make security   - Run security checks"
	@echo "  make clean      - Clean build artifacts"
	@echo "  make tools      - Install development tools"
```

---
