## Part 16: Utility Helpers

Several components in the gateway need shared utility functions that do not belong to any single package. The thread-safe random number generator below is used by the weighted random load balancer to pick backend targets without data races when multiple goroutines handle requests concurrently. The Makefile provides convenient commands for building, testing, linting, and deploying the project, following the standard conventions that Go developers expect in a production codebase.

### Random Number Generator (Thread-Safe)
The weighted random load balancer needs thread-safe random number generation because multiple goroutines select backends concurrently. This wrapper protects Go's PRNG with a mutex.

```go
// internal/upstream/random.go
package upstream

import (
    "math/rand/v2"
    "sync"
    "time"
)

// lockedRand provides thread-safe random number generation
type lockedRand struct {
    mu  sync.Mutex
    rng *rand.Rand
}

func newLockedRand() *lockedRand {
    return &lockedRand{
        rng: rand.New(rand.NewPCG(uint64(time.Now().UnixNano()), 0)),
    }
}

func (r *lockedRand) Intn(n int) int {
    r.mu.Lock()
    defer r.mu.Unlock()
    return r.rng.Intn(n)
}
```

### Missing Imports for Server

The server file needs additional imports for the built-in plugins registered in the previous section:

```go
// Add these imports to internal/gateway/server.go
import (
    "strings"

    "github.com/yourusername/gatewaygo/internal/plugins/circuit"
    "github.com/yourusername/gatewaygo/internal/plugins/cors"
    "github.com/yourusername/gatewaygo/internal/plugins/ratelimit"
)

// Router and UpstreamManager getters for admin API
func (s *Server) Router() *router.Router {
    return s.router
}

func (s *Server) UpstreamManager() *upstream.Manager {
    return s.upstreamManager
}
```

### Prometheus Configuration

Prometheus metrics expose key operational signals, request rates, error counts, redirect latency histograms, and cache hit ratios, in a scrape-compatible format. Instrumenting the application at this granularity enables alerting on SLO violations and capacity planning based on real traffic patterns.

```yaml
# prometheus.yml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

scrape_configs:
  - job_name: 'gatewaygo'
    static_configs:
      - targets: ['gateway:9090']
    metrics_path: '/metrics'
```

### Makefile for Development

The Makefile provides standard targets for building, testing, linting, and running the gateway in development:

```makefile
# Makefile
.PHONY: build test run clean docker-build docker-run lint

# Variables
BINARY_NAME=gatewaygo
DOCKER_IMAGE=gatewaygo:latest
CONFIG_FILE=configs/gateway.yaml

# Build the binary
build:
	@echo "Building..."
	go build -o bin/$(BINARY_NAME) ./cmd/gateway

# Run tests
test:
	@echo "Running tests..."
	go test -v -race -coverprofile=coverage.out ./...

# Run test coverage
coverage: test
	go tool cover -html=coverage.out -o coverage.html

# Run the gateway
run: build
	@echo "Running gateway..."
	./bin/$(BINARY_NAME) -config $(CONFIG_FILE)

# Clean build artifacts
clean:
	@echo "Cleaning..."
	rm -rf bin/
	rm -f coverage.out coverage.html

# Build Docker image
docker-build:
	@echo "Building Docker image..."
	docker build -t $(DOCKER_IMAGE) .

# Run in Docker
docker-run: docker-build
	@echo "Running in Docker..."
	docker-compose up

# Run linter
lint:
	@echo "Running linter..."
	golangci-lint run ./...

# Format code
fmt:
	@echo "Formatting code..."
	go fmt ./...

# Install dependencies
deps:
	@echo "Installing dependencies..."
	go mod download
	go mod tidy

# Generate mocks for testing
mocks:
	@echo "Generating mocks..."
	mockgen -source=internal/plugin/plugin.go -destination=internal/plugin/mocks/plugin_mock.go

# Benchmark
bench:
	@echo "Running benchmarks..."
	go test -bench=. -benchmem ./...

# Security scan
security:
	@echo "Running security scan..."
	gosec ./...

# Build for all platforms
build-all:
	@echo "Building for all platforms..."
	GOOS=linux GOARCH=amd64 go build -o bin/$(BINARY_NAME)-linux-amd64 ./cmd/gateway
	GOOS=darwin GOARCH=amd64 go build -o bin/$(BINARY_NAME)-darwin-amd64 ./cmd/gateway
	GOOS=windows GOARCH=amd64 go build -o bin/$(BINARY_NAME)-windows-amd64.exe ./cmd/gateway

# Help
help:
	@echo "Available targets:"
	@echo "  build       - Build the binary"
	@echo "  test        - Run tests"
	@echo "  coverage    - Generate test coverage report"
	@echo "  run         - Build and run the gateway"
	@echo "  clean       - Remove build artifacts"
	@echo "  docker-build - Build Docker image"
	@echo "  docker-run  - Run using Docker Compose"
	@echo "  lint        - Run linter"
	@echo "  fmt         - Format code"
	@echo "  deps        - Install dependencies"
	@echo "  bench       - Run benchmarks"
	@echo "  security    - Run security scan"
	@echo "  build-all   - Build for all platforms"
```

### README.md

A README provides setup instructions, configuration reference, and usage examples for the gateway:

```markdown
# GatewayGo - Production-Ready API Gateway A high-performance, feature-rich API gateway written in Go, similar to Kong and Envoy.
```
