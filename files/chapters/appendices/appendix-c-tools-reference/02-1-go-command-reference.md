## 1. Go Command Reference

### 1.1 go build

Compiles packages and dependencies into executable binaries.

#### Basic Usage

```bash
# Build current package
go build

# Build specific package
go build ./cmd/api

# Build with custom output name
go build -o myapp ./cmd/api

# Build all packages in module
go build ./...
```

#### Important Flags

```bash
# Force rebuild of all packages (ignore cache)
go build -a ./cmd/api

# Print packages being built
go build -v ./cmd/api

# Print the commands but don't execute them (dry run)
go build -n ./cmd/api

# Print compilation commands as they're executed
go build -x ./cmd/api

# Specify output directory/file
go build -o ./bin/api ./cmd/api

# Pass flags to the compiler
go build -gcflags="all=-N -l" ./cmd/api

# Pass flags to the linker
go build -ldflags="-s -w" ./cmd/api

# Build with race detector (slower, larger binary)
go build -race ./cmd/api

# Use specific build tags
go build -tags=production,mysql ./cmd/api

# Trim file paths in panic messages
go build -trimpath ./cmd/api
```

#### Cross-Compilation

```bash
# List all supported platforms
go tool dist list

# Build for Linux AMD64
GOOS=linux GOARCH=amd64 go build -o ./bin/linux_amd64/api ./cmd/api

# Build for Windows
GOOS=windows GOARCH=amd64 go build -o ./bin/windows/api.exe ./cmd/api

# Build for macOS (Intel)
GOOS=darwin GOARCH=amd64 go build -o ./bin/darwin_amd64/api ./cmd/api

# Build for macOS (Apple Silicon)
GOOS=darwin GOARCH=arm64 go build -o ./bin/darwin_arm64/api ./cmd/api

# Build for Raspberry Pi
GOOS=linux GOARCH=arm GOARM=7 go build -o ./bin/rpi/api ./cmd/api
```

#### Compiler Flags (-gcflags)

```bash
# Disable optimizations and inlining (for debugging)
go build -gcflags="all=-N -l"

# Show inlining decisions
go build -gcflags="all=-m"

# Show escape analysis
go build -gcflags="all=-m -m"

# Show all optimizations
go build -gcflags="all=-m=2"

# Disable bounds checking (unsafe, for benchmarking only)
go build -gcflags="all=-B"
```

#### Linker Flags (-ldflags)

```bash
# Strip debug information (reduces binary size ~25%)
go build -ldflags="-s -w"

# -s: Omit symbol table and debug info
# -w: Omit DWARF symbol table

# Set variables at build time
go build -ldflags="-X main.version=1.2.3 -X main.buildTime=$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Reduce binary size maximally
go build -ldflags="-s -w" -trimpath

# Static linking (for containers)
CGO_ENABLED=0 go build -ldflags="-s -w -extldflags '-static'"

# Link with external libraries
go build -ldflags="-extldflags '-lm -lpthread'"
```

#### Build Constraints (Tags)

```go
// File: config_production.go
//go:build production

package config

const Environment = "production"
```

```go
// File: config_dev.go
//go:build !production

package config

const Environment = "development"
```

```bash
# Build with production tag
go build -tags=production ./...

# Multiple tags (AND)
go build -tags="production mysql" ./...

# Build without specific tag (NOT)
go build -tags="!integration" ./...
```

#### Build Cache

```bash
# Show build cache location
go env GOCACHE

# Clear build cache
go clean -cache

# Build without using cache
go build -a ./...

# Show cached packages
go list -f '{{.ImportPath}} {{.Stale}}' ./...
```

---

### 1.2 go run

Compiles and runs Go programs in one step (useful for development).

#### Basic Usage

```bash
# Run a single file
go run main.go

# Run multiple files
go run main.go helpers.go

# Run a package
go run ./cmd/api

# Run with arguments
go run main.go -port=8080 -db=postgres://localhost/mydb

# Run with build flags
go run -race -ldflags="-X main.version=dev" ./cmd/api
```

#### Advanced Usage

```bash
# Run with environment variables
PORT=8080 DB_URL=postgres://localhost/mydb go run ./cmd/api

# Run with tags
go run -tags=debug ./cmd/api

# Run and capture output
go run ./cmd/api 2>&1 | tee app.log

# Run with profiling
go run -cpuprofile=cpu.prof ./cmd/api
```

---

### 1.3 go test

Runs tests and benchmarks for Go packages.

#### Basic Testing

```bash
# Test current package
go test

# Test all packages
go test ./...

# Verbose output
go test -v ./...

# Run specific test
go test -run TestUserCreate

# Run tests matching pattern
go test -run TestUser.*

# Test with timeout
go test -timeout 30s ./...

# Short mode (skip long-running tests)
go test -short ./...
```

#### Coverage

```bash
# Run tests with coverage
go test -cover ./...

# Detailed coverage by package
go test -coverprofile=coverage.out ./...

# View coverage in browser
go test -coverprofile=coverage.out ./...
go tool cover -html=coverage.out

# Coverage for specific package
go test -coverprofile=coverage.out -coverpkg=./internal/... ./...

# Set coverage mode
go test -covermode=atomic ./...
# Modes: set, count, atomic

# Show untested functions
go test -cover -coverprofile=coverage.out ./...
go tool cover -func=coverage.out

# Minimum coverage threshold (requires wrapper script)
#!/bin/bash
coverage=$(go test -cover ./... | grep coverage | awk '{print $5}' | tr -d '%')
if (( $(echo "$coverage < 80" | bc -l) )). Then
    echo "Coverage $coverage% is below 80%"
    exit 1
fi
```

#### Benchmarking

```bash
# Run benchmarks
go test -bench=.

# Run specific benchmark
go test -bench=BenchmarkHashPassword

# Benchmark with memory stats
go test -bench=. -benchmem

# Run for specific duration
go test -bench=. -benchtime=10s

# Run N iterations
go test -bench=. -benchtime=1000x

# Compare benchmarks
go test -bench=. -count=5 > old.txt
# Make changes...
go test -bench=. -count=5 > new.txt
benchstat old.txt new.txt

# CPU profiling during benchmark
go test -bench=. -cpuprofile=cpu.prof

# Memory profiling during benchmark
go test -bench=. -memprofile=mem.prof
```

#### Fuzzing (Go 1.18+)

```bash
# Run fuzzing
go test -fuzz=FuzzParseURL

# Fuzz for specific time
go test -fuzz=FuzzParseURL -fuzztime=30s

# Fuzz for N iterations
go test -fuzz=FuzzParseURL -fuzztime=100000x

# View fuzz cache
ls $HOME/.cache/go-build/fuzz

# Clear fuzz cache
go clean -fuzzcache
```

#### Race Detection

```bash
# Run tests with race detector
go test -race ./...

# Benchmark with race detector
go test -race -bench=.

# Set race detector options
GORACE="log_path=/tmp/race.log halt_on_error=1" go test -race ./...
```

#### Test Flags Summary

```bash
# Common combinations
go test -v -race -cover ./...
go test -v -short -count=1 ./...
go test -bench=. -benchmem -cpuprofile=cpu.prof
go test -fuzz=FuzzParse -fuzztime=1m

# Parallel execution
go test -parallel=4 ./...

# Disable test caching
go test -count=1 ./...

# JSON output (for tools)
go test -json ./...

# List tests without running
go test -list . ./...
```

---

### 1.4 go mod

Manages Go modules and dependencies.

#### Initialization

```bash
# Initialize new module
go mod init github.com/username/project

# Initialize with Go version
go mod init -go=1.26 github.com/username/project
```

#### Dependency Management

```bash
# Add missing dependencies
go mod tidy

# Add dependency and update go.mod
go get github.com/gin-gonic/gin@v1.9.1

# Add latest version
go get github.com/gin-gonic/gin@latest

# Upgrade to latest minor/patch version
go get -u github.com/gin-gonic/gin

# Upgrade all dependencies
go get -u ./...

# Downgrade dependency
go get github.com/gin-gonic/gin@v1.8.0

# Remove unused dependencies
go mod tidy
```

#### Vendor Directory

```bash
# Create vendor directory
go mod vendor

# Build using vendor directory
go build -mod=vendor ./...

# Verify vendor directory matches go.mod
go mod verify

# Update vendor directory
go mod tidy && go mod vendor
```

#### Module Information

```bash
# Show dependency graph
go mod graph

# Show why package is needed
go mod why github.com/lib/pq

# Show available versions
go list -m -versions github.com/gin-gonic/gin

# Show module info
go list -m all
go list -m -json all

# Edit go.mod
go mod edit -require=github.com/pkg/errors@v0.9.1
go mod edit -replace=old@v1.0.0=new@v1.1.0
go mod edit -droprequire=github.com/old/package
go mod edit -go=1.26

# Download dependencies
go mod download
go mod download github.com/gin-gonic/gin@v1.9.1
```

#### Module Cache

```bash
# Show module cache location
go env GOMODCACHE

# Clear module cache
go clean -modcache

# Download modules without building
go mod download -json
```

#### go.mod File Structure

```go
module github.com/username/project

go 1.27

require (
 github.com/gin-gonic/gin v1.9.1
 github.com/lib/pq v1.10.9
)

require (
 // indirect dependencies
 github.com/gin-contrib/sse v0.1.0 // indirect
 github.com/go-playground/validator/v10 v10.14.0 // indirect
)

replace (
 github.com/old/package => github.com/new/package v1.0.0
 github.com/local/package => ./local/package
)

exclude github.com/broken/package v1.2.3

retract (
 v1.0.0 // Published accidentally
 v1.0.1 // Contains critical bug
)
```

---

### 1.5 go get

Downloads and installs packages and dependencies.

```bash
# Add dependency
go get github.com/gorilla/mux

# Add specific version
go get github.com/gorilla/mux@v1.8.0

# Add latest version
go get github.com/gorilla/mux@latest

# Upgrade to latest patch
go get -u=patch github.com/gorilla/mux

# Install tool (Go 1.16+, deprecated for tools)
go get github.com/golangci/golangci-lint/cmd/golangci-lint@latest

# Remove dependency (use go.mod directly or go mod tidy)
go get github.com/unused/package@none
```

---

### 1.6 go install

Compiles and installs packages (preferred for tools).

```bash
# Install tool from current directory
go install

# Install specific tool
go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest

# Install specific version
go install github.com/golangci/golangci-lint/cmd/golangci-lint@v1.55.2

# Install to custom location
GOBIN=/usr/local/bin go install ./cmd/mytool

# Install all tools in project
go install ./cmd/...

# Check installed binaries
ls $(go env GOPATH)/bin
```

#### Common Tools to Install

```bash
# Linting
go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest

# Code generation
go install go.uber.org/mock/mockgen@latest
go install google.golang.org/protobuf/cmd/protoc-gen-go@latest
go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest

# SQL
go install github.com/sqlc-dev/sqlc/cmd/sqlc@latest

# API
go install github.com/swaggo/swag/cmd/swag@latest

# Hot reload
go install github.com/air-verse/air@latest

# Debugging
go install github.com/go-delve/delve/cmd/dlv@latest
```

---

### 1.7 go generate

Runs commands described by directives in Go source files.

#### Basic Usage

```go
// File: models.go
//go:generate mockgen -source=models.go -destination=mocks/models_mock.go
//go:generate stringer -type=Status
//go:generate go run scripts/generate_config.go

package models

type Status int

const (
    StatusPending Status = iota
    StatusActive
    StatusClosed
)
```

```bash
# Run all generate directives
go generate ./...

# Run for specific package
go generate ./internal/models

# Verbose output
go generate -v ./...

# Dry run
go generate -n ./...

# Run specific generator
go generate -run mockgen ./...
```

#### Common Use Cases

```go
// Generate mocks
//go:generate mockgen -destination=mocks/db_mock.go -package=mocks . Database

// Generate string methods for enums
//go:generate stringer -type=OrderStatus -output=orderstatus_string.go

// Embed files
//go:generate go run generate_assets.go

// Generate protobuf
//go:generate protoc --go_out=. --go-grpc_out=. api.proto

// Run custom scripts
//go:generate go run scripts/generate_migrations.go

// Multiple commands
//go:generate sh -c "mkdir -p generated && echo 'package generated' > generated/doc.go"
```

---

### 1.8 go work

Manages workspace for multi-module development (Go 1.18+).

#### Workspace Setup

```bash
# Initialize workspace
go work init ./module1 ./module2

# Add module to workspace
go work use ./module3

# Remove module from workspace
go work edit -dropuse=./module3

# Sync workspace
go work sync
```

#### go.work File

```go
go 1.27

use (
 ./api
 ./shared
 ./worker
)

replace github.com/company/shared => ./shared
```

#### Workspace Commands

```bash
# Build all modules in workspace
go build ./...

# Test all modules
go test ./...

# Show workspace info
go work edit -json

# Disable workspace (use modules normally)
GOWORK=off go build ./...
```

---

### 1.9 go vet

Examines Go source code for suspicious constructs.

```bash
# Vet current package
go vet

# Vet all packages
go vet ./...

# Vet specific files
go vet main.go handlers.go

# Show available vet checks
go tool vet help

# Run specific analyzers
go vet -printf=false ./...
```

#### Common Issues Detected

```go
// Unreachable code
func example() {
 return
 fmt.Println("Never executed") // vet: unreachable code
}

// Printf argument mismatch
fmt.Printf("%d", "string") // vet: format %d has arg "string" of wrong type string

// Missing mutex unlock
func (s *Server) Handle() {
 s.mu.Lock()
 // vet: function Handle locks mu but never unlocks it
}

// Incorrect struct tag
type User struct {
 Name string `json:"name" validate:"required` // vet: struct field tag incomplete
}

// Lost cancel function
ctx, cancel := context.WithTimeout(ctx, time.Second)
// vet: the cancel function is not used

// Incorrect time.Sleep duration
time.Sleep(1000) // vet: sleeping for 1000 nanoseconds
```

---

### 1.10 go fmt

Formats Go source code according to standard style.

```bash
# Format current directory
go fmt

# Format all packages
go fmt ./...

# Format specific files
go fmt main.go handlers.go

# Show differences without writing
gofmt -d main.go

# Simplify code
gofmt -s -w .

# Use gofumpt (stricter formatting)
go install mvdan.cc/gofumpt@latest
gofumpt -l -w .
```

---

### 1.11 go list

Lists packages and modules.

```bash
# List all packages
go list ./...

# List with full path
go list -f '{{.ImportPath}}' ./...

# List dependencies
go list -deps ./cmd/api

# List with details
go list -json ./...

# List test files
go list -f '{{.TestGoFiles}}' ./...

# List stale packages
go list -f '{{if .Stale}}{{.ImportPath}}{{end}}' ./...

# List modules
go list -m all
go list -m -versions github.com/gin-gonic/gin
```

---
