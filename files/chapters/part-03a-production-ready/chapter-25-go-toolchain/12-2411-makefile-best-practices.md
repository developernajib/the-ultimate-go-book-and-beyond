## 25.11 Makefile Best Practices

### Production Makefile

A well-structured Makefile serves as the single entry point for every developer and CI workflow, eliminating the "works on my machine" problem by encoding the exact flags and tools required for each operation. Injecting build metadata via `-ldflags`, specifically `VERSION`, `COMMIT`, and `BUILD_TIME`, embeds provenance directly into the binary so a running service can report exactly which commit it was built from without querying an external system. Declaring targets as `.PHONY` prevents Make from silently skipping a target when a file of the same name exists in the working directory, which is a common source of mysterious CI failures.

```makefile
# Variables
APP_NAME := myapp
VERSION := $(shell git describe --tags --always --dirty)
COMMIT := $(shell git rev-parse HEAD)
BUILD_TIME := $(shell date -u '+%Y-%m-%d_%H:%M:%S')
LDFLAGS := -s -w -X main.Version=$(VERSION) -X main.Commit=$(COMMIT) -X main.BuildTime=$(BUILD_TIME)
# -trimpath makes the artifact reproducible: without it the binary embeds the
# absolute build directory, so the same commit built on a laptop and in CI
# differs byte-for-byte.
BUILDFLAGS := -trimpath -ldflags="$(LDFLAGS)"

# Go commands
GOCMD := go
GOBUILD := $(GOCMD) build
GOTEST := $(GOCMD) test
GOVET := $(GOCMD) vet
GOMOD := $(GOCMD) mod
GOFMT := gofmt
GOLINT := golangci-lint

# Directories
BUILD_DIR := ./dist
CMD_DIR := ./cmd/$(APP_NAME)

# Every target below must be listed here. A target that is missing from
# .PHONY stops running the moment a file or directory of the same name
# appears next to the Makefile: Make decides the target is "up to date" and
# skips it, printing "make: 'vet' is up to date." instead of doing anything.
# That failure is silent and exit code 0, so CI goes green while running
# none of your checks. Adding a target and forgetting this line is the
# single most common Makefile bug.
.PHONY: all build build-all test test-short bench lint fmt vet coverage \
        deps tidy vuln clean docker run generate help

## help: Show this help message
help:
	@echo 'Usage:'
	@sed -n 's/^##//p' ${MAKEFILE_LIST} | column -t -s ':' | sed -e 's/^/ /'

## build: Build the application
build:
	CGO_ENABLED=0 $(GOBUILD) $(BUILDFLAGS) -o $(BUILD_DIR)/$(APP_NAME) $(CMD_DIR)

## build-all: Build for all platforms
build-all:
	@mkdir -p $(BUILD_DIR)
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 $(GOBUILD) $(BUILDFLAGS) -o $(BUILD_DIR)/$(APP_NAME)-linux-amd64 $(CMD_DIR)
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 $(GOBUILD) $(BUILDFLAGS) -o $(BUILD_DIR)/$(APP_NAME)-linux-arm64 $(CMD_DIR)
	CGO_ENABLED=0 GOOS=darwin GOARCH=amd64 $(GOBUILD) $(BUILDFLAGS) -o $(BUILD_DIR)/$(APP_NAME)-darwin-amd64 $(CMD_DIR)
	CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 $(GOBUILD) $(BUILDFLAGS) -o $(BUILD_DIR)/$(APP_NAME)-darwin-arm64 $(CMD_DIR)
	CGO_ENABLED=0 GOOS=windows GOARCH=amd64 $(GOBUILD) $(BUILDFLAGS) -o $(BUILD_DIR)/$(APP_NAME)-windows-amd64.exe $(CMD_DIR)

## test: Run tests
test:
	$(GOTEST) -v -race -coverprofile=coverage.out ./...

## test-short: Run short tests
test-short:
	$(GOTEST) -v -short ./...

## bench: Run benchmarks
bench:
	$(GOTEST) -bench=. -benchmem ./...

## lint: Run linters
lint:
	$(GOLINT) run ./...

## fmt: Format code
fmt:
	$(GOFMT) -s -w .

## vet: Run go vet
vet:
	$(GOVET) ./...

## coverage: Generate coverage report
coverage: test
	go tool cover -html=coverage.out -o coverage.html

## deps: Download dependencies
deps:
	$(GOMOD) download
	$(GOMOD) verify

## tidy: Tidy dependencies
tidy:
	$(GOMOD) tidy

## vuln: Check for vulnerabilities
vuln:
	govulncheck ./...

## clean: Clean build artifacts
clean:
	rm -rf $(BUILD_DIR)
	rm -f coverage.out coverage.html

## docker: Build Docker image
docker:
	docker build -t $(APP_NAME):$(VERSION) .

## run: Run the application
run: build
	$(BUILD_DIR)/$(APP_NAME)

## generate: Run go generate
generate:
	$(GOCMD) generate ./...

## all: Run all checks and build
all: fmt vet lint test build
```

### Staff Lens: Makefile as Contract

Every Go service has the same Makefile targets: fmt, vet, lint, test, build, clean, docker, run. Consistency across services means any engineer can work on any service without learning new commands.

---
