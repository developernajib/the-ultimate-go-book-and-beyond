BINARY    := api-gateway
CMD       := ./cmd/api-gateway
BUILD_DIR := ./bin

.PHONY: all build run test lint fmt vet clean docker-up docker-down migrate seed tidy

all: build

build:
	go build -o $(BUILD_DIR)/$(BINARY) $(CMD)

run:
	go run $(CMD)/main.go $(CMD)/stubs.go

test:
	go test ./... -v -race -count=1

lint:
	golangci-lint run ./...

fmt:
	gofmt -w .

vet:
	go vet ./...

clean:
	rm -rf $(BUILD_DIR)

docker-up:
	docker compose up -d

docker-down:
	docker compose down

migrate:
	@for f in migrations/*.sql; do \
		echo "Running $$f"; \
		psql "$$DATABASE_URL" -f "$$f"; \
	done

seed:
	go run ./scripts/seed/main.go

tidy:
	go mod tidy
