.PHONY: build run run-dev test test-cover lint vet clean \
        docker-up docker-down docker-logs docker-build \
        migrate-up migrate-down migrate-create migrate-status

BINARY   := bin/api
CMD      := ./cmd/api
GO       := go
GOFLAGS  := -trimpath
LDFLAGS  := -ldflags "-s -w"

-include .env
export

DATABASE_URL ?= postgres://$(DB_USER):$(DB_PASSWORD)@$(DB_HOST):$(DB_PORT)/$(DB_NAME)?sslmode=$(DB_SSLMODE)
MIGRATIONS   := ./migrations

# ── Build ──────────────────────────────────────────────────────────────────────

build:
	@echo "Building $(BINARY)..."
	@mkdir -p bin
	$(GO) build $(GOFLAGS) $(LDFLAGS) -o $(BINARY) $(CMD)
	@echo "Done: $(BINARY)"

# ── Run ───────────────────────────────────────────────────────────────────────

run: build
	$(BINARY)

run-dev:
	$(GO) run $(CMD)

# ── Test ──────────────────────────────────────────────────────────────────────

test:
	$(GO) test -v -race -count=1 ./...

test-short:
	$(GO) test -short -count=1 ./...

test-cover:
	$(GO) test -race -coverprofile=coverage.out ./...
	$(GO) tool cover -html=coverage.out -o coverage.html
	@echo "Coverage report: coverage.html"

test-integration:
	$(GO) test -v -race -count=1 -tags integration ./...

# ── Lint / Vet ────────────────────────────────────────────────────────────────

lint:
	@which golangci-lint > /dev/null 2>&1 || (echo "Install: https://golangci-lint.run/usage/install/" && exit 1)
	golangci-lint run ./...

vet:
	$(GO) vet ./...

# ── Database Migrations ───────────────────────────────────────────────────────

migrate-up:
	@which migrate > /dev/null 2>&1 || (echo "Install: go install -tags 'postgres' github.com/golang-migrate/migrate/v4/cmd/migrate@latest" && exit 1)
	migrate -path $(MIGRATIONS) -database "$(DATABASE_URL)" up
	@echo "Migrations applied."

migrate-down:
	migrate -path $(MIGRATIONS) -database "$(DATABASE_URL)" down 1
	@echo "Rolled back one migration."

migrate-status:
	migrate -path $(MIGRATIONS) -database "$(DATABASE_URL)" version

migrate-create:
	@[ -n "$(name)" ] || (echo "Usage: make migrate-create name=<migration_name>" && exit 1)
	migrate create -ext sql -dir $(MIGRATIONS) -seq $(name)

migrate-reset:
	migrate -path $(MIGRATIONS) -database "$(DATABASE_URL)" drop -f
	migrate -path $(MIGRATIONS) -database "$(DATABASE_URL)" up

# ── Docker ────────────────────────────────────────────────────────────────────

docker-build:
	docker build -t socialnet:latest .

docker-up:
	docker compose up -d
	@echo ""
	@echo "Infrastructure ready:"
	@echo "  PostgreSQL:    localhost:5432"
	@echo "  Redis:         localhost:6379"
	@echo "  Neo4j:         bolt://localhost:7687  (browser: http://localhost:7474)"
	@echo "  Elasticsearch: http://localhost:9200"
	@echo "  MinIO:         http://localhost:9000  (console: http://localhost:9001)"
	@echo "  Prometheus:    http://localhost:9090"
	@echo "  Grafana:       http://localhost:3000  (admin/admin)"
	@echo ""
	@echo "Run 'make migrate-up' to apply database migrations."

docker-down:
	docker compose down

docker-down-v:
	docker compose down -v

docker-logs:
	docker compose logs -f api

# ── Clean ─────────────────────────────────────────────────────────────────────

clean:
	rm -rf bin/ coverage.out coverage.html
