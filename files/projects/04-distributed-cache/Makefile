.PHONY: build run test bench lint clean docker-up docker-down docker-build

BINARY     := bin/gocache
CMD        := ./cmd/gocache
GO         := go
GOFLAGS    := -trimpath
LDFLAGS    := -ldflags "-s -w"

# Load .env if it exists
-include .env
export

# ── Build ──────────────────────────────────────────────────────────────────────

build:
	@echo "Building $(BINARY)..."
	@mkdir -p bin
	$(GO) build $(GOFLAGS) $(LDFLAGS) -o $(BINARY) $(CMD)
	@echo "Done: $(BINARY)"

# ── Run ───────────────────────────────────────────────────────────────────────

run: build
	$(BINARY) -addr $(CACHE_ADDR) -maxmemory $(MAX_MEMORY)

run-dev:
	$(GO) run $(CMD) -addr :6379 -maxmemory 268435456

# ── Test ──────────────────────────────────────────────────────────────────────

test:
	$(GO) test -v -race -count=1 ./...

test-short:
	$(GO) test -short -count=1 ./...

test-cover:
	$(GO) test -race -coverprofile=coverage.out ./...
	$(GO) tool cover -html=coverage.out -o coverage.html
	@echo "Coverage report: coverage.html"

# ── Benchmark ─────────────────────────────────────────────────────────────────

bench:
	$(GO) test -bench=. -benchmem -benchtime=5s ./benchmark/...

# ── Lint ──────────────────────────────────────────────────────────────────────

lint:
	@which golangci-lint > /dev/null 2>&1 || (echo "Install golangci-lint: https://golangci-lint.run/usage/install/" && exit 1)
	golangci-lint run ./...

vet:
	$(GO) vet ./...

# ── Docker ────────────────────────────────────────────────────────────────────

docker-build:
	docker build -t gocache:latest .

docker-up:
	docker compose up -d
	@echo "Cluster running:"
	@echo "  Node 1: localhost:6379"
	@echo "  Node 2: localhost:6380"
	@echo "  Node 3: localhost:6381"
	@echo "  Metrics: localhost:2112/metrics"

docker-down:
	docker compose down

docker-logs:
	docker compose logs -f

# ── Clean ─────────────────────────────────────────────────────────────────────

clean:
	rm -rf bin/ coverage.out coverage.html

# ── Helpers ───────────────────────────────────────────────────────────────────

# Quick smoke test against a running server
smoke: build
	@echo "Starting server in background..."
	@$(BINARY) -addr :6399 &
	@sleep 0.5
	@redis-cli -p 6399 PING
	@redis-cli -p 6399 SET smoke-key smoke-value
	@redis-cli -p 6399 GET smoke-key
	@redis-cli -p 6399 DBSIZE
	@pkill -f "gocache -addr :6399" || true
	@echo "Smoke test passed."
