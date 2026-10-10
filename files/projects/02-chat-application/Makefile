BINARY_NAME=server
BUILD_DIR=bin
CMD_PATH=./cmd/server

.PHONY: build run test lint docker-build docker-up docker-down clean migrate

## build: Compile the server binary to bin/server
build:
	go build -o $(BUILD_DIR)/$(BINARY_NAME) $(CMD_PATH)

## run: Run the server with go run (picks up .env automatically)
run:
	go run $(CMD_PATH)/main.go

## test: Run all tests
test:
	go test -race -count=1 ./...

## lint: Run go vet and staticcheck
lint:
	go vet ./...
	@which staticcheck > /dev/null 2>&1 && staticcheck ./... || echo "staticcheck not installed - run: go install honnef.co/go/tools/cmd/staticcheck@latest"

## docker-build: Build the application Docker image
docker-build:
	docker build -t chat-application:latest .

## docker-up: Start PostgreSQL, Redis, and MinIO via Docker Compose
docker-up:
	docker compose up -d

## docker-down: Stop and remove all containers and volumes
docker-down:
	docker compose down -v

## migrate: Apply all SQL migrations against the local database
migrate:
	psql -h $${DB_HOST:-localhost} -U $${DB_USER:-postgres} -d $${DB_NAME:-gochat} \
		-f migrations/001_create_users.sql \
		-f migrations/002_create_channels.sql \
		-f migrations/003_create_messages.sql

## clean: Remove build artifacts
clean:
	rm -rf $(BUILD_DIR)
