BINARY    := trader
CMD       := ./cmd/trader
BUILD_DIR := ./bin

.PHONY: all build run test lint fmt vet clean tidy

all: build

build:
	go build -o $(BUILD_DIR)/$(BINARY) $(CMD)

run:
	go run $(CMD)/main.go

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

tidy:
	go mod tidy
