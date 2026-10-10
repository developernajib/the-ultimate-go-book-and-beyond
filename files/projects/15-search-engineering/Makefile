BINARY    := search-engine
BUILD_DIR := ./bin

.PHONY: all build run test bench lint fmt vet clean tidy

all: build

build:
	go build -o $(BUILD_DIR)/$(BINARY) .

run:
	go run main.go

test:
	go test ./... -v -race -count=1

bench:
	go test ./... -bench=. -benchmem -run=^$

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
