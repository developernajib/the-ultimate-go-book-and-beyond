.PHONY: build run run-dev test test-cover bench lint vet clean docker-build docker-up docker-down

BINARY     := bin/gosearch
CMD        := ./cmd/server
GO         := go
GOFLAGS    := -trimpath
LDFLAGS    := -ldflags "-s -w"

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
	$(BINARY) -addr $(SERVER_ADDR)

run-dev:
	$(GO) run $(CMD) -addr :8080

# ── Test ──────────────────────────────────────────────────────────────────────

test:
	$(GO) test -v -race -count=1 ./...

test-short:
	$(GO) test -short -count=1 ./...

test-cover:
	$(GO) test -race -coverprofile=coverage.out ./...
	$(GO) tool cover -html=coverage.out -o coverage.html
	@echo "Coverage report: coverage.html"

# ── Benchmarks ────────────────────────────────────────────────────────────────

bench:
	$(GO) test -bench=. -benchmem -benchtime=5s ./benchmarks/...

# ── Lint / Vet ────────────────────────────────────────────────────────────────

lint:
	@which golangci-lint > /dev/null 2>&1 || (echo "Install golangci-lint: https://golangci-lint.run/usage/install/" && exit 1)
	golangci-lint run ./...

vet:
	$(GO) vet ./...

# ── Docker ────────────────────────────────────────────────────────────────────

docker-build:
	docker build -t gosearch:latest .

docker-up:
	docker compose up -d
	@echo "GoSearch running at http://localhost:8080"

docker-down:
	docker compose down

docker-logs:
	docker compose logs -f gosearch

# ── Demo helpers ──────────────────────────────────────────────────────────────

# Index sample documents, then run a few searches
demo: build
	@$(BINARY) -addr :8099 & PID=$$!; \
	sleep 0.5; \
	curl -s -X POST http://localhost:8099/index \
	  -H "Content-Type: application/json" \
	  -d '{"documents":[{"fields":{"title":"Go Concurrency","body":"goroutines channels select"}},{"fields":{"title":"Go HTTP","body":"net http server handler middleware"}}]}' | python3 -m json.tool; \
	curl -s "http://localhost:8099/search?q=goroutine&limit=5" | python3 -m json.tool; \
	kill $$PID 2>/dev/null || true

# ── Clean ─────────────────────────────────────────────────────────────────────

clean:
	rm -rf bin/ coverage.out coverage.html data/
