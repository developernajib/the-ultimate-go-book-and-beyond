EXAMPLES := log_analysis event_processing streaming_analytics
BUILD_DIR := ./bin

.PHONY: all build run-log run-event run-streaming test lint fmt vet clean tidy

all: build

build:
	@mkdir -p $(BUILD_DIR)
	@for ex in $(EXAMPLES); do \
		echo "Building $$ex..."; \
		go build -o $(BUILD_DIR)/$$ex ./examples/$$ex; \
	done

run-log:
	go run ./examples/log_analysis/main.go

run-event:
	go run ./examples/event_processing/main.go

run-streaming:
	go run ./examples/streaming_analytics/main.go

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
