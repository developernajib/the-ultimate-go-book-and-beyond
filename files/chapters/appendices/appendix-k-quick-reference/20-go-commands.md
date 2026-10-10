## Go Commands

The `go` command is Go's all-in-one tool for building, testing, formatting, and managing dependencies. You do not need a separate build system like Make, `go build`, `go test`, and `go run` handle the most common workflows. The module system (`go mod`) manages dependencies and versioning, replacing the older `GOPATH`-based approach. Cross-compilation is as simple as setting `GOOS` and `GOARCH` environment variables before running `go build`.

```bash
# Build
go build                    # Build current package
go build -o output          # Custom output name
go build ./...              # Build all packages
go build -v                 # Verbose

# Run
go run main.go              # Run file
go run .                    # Run current package
go run -race main.go        # With race detector

# Test
go test                     # Test current package
go test ./...               # Test all packages
go test -v                  # Verbose
go test -run TestName       # Run specific test
go test -cover              # Coverage
go test -coverprofile=c.out # Coverage profile
go test -race               # Race detector
go test -bench=.            # Run benchmarks
go test -short              # Short mode
go test -timeout 10s        # Timeout
go test -count=1            # Disable cache
go test -shuffle=on         # Randomize test order

# Format
go fmt ./...                # Format all files
gofmt -w file.go            # Format specific file

# Vet (static analysis)
go vet                      # Check current package
go vet ./...                # Check all packages

# Modules
go mod init module-name     # Initialize module
go mod tidy                 # Add missing, remove unused
go mod download             # Download dependencies
go mod verify               # Verify dependencies
go mod vendor               # Create vendor directory
go mod graph                # Print module graph
go mod why package          # Why is package needed

# Get (download dependencies)
go get package              # Add dependency
go get package@version      # Specific version
go get package@latest       # Latest version
go get -u                   # Update dependencies
go get -u ./...             # Update all

# Install
go install                  # Install current package
go install package@latest   # Install specific package

# Clean
go clean                    # Remove build artifacts
go clean -cache             # Clean build cache
go clean -modcache          # Clean module cache
go clean -testcache         # Clean test cache

# List
go list -m all              # List all modules
go list ./...               # List all packages
go list -f '{{.Imports}}'   # Custom format

# Doc
go doc package              # Show package docs
go doc package.Type         # Show type docs
go doc package.Type.Method  # Show method docs
go doc -all package         # All docs

# Version
go version                  # Go version
go version -m binary        # Binary build info

# Environment
go env                      # Show all variables
go env GOPATH               # Show specific variable
go env -w GOPATH=path       # Set variable

# Generate
go generate                 # Run //go:generate commands
go generate ./...           # Run for all packages

# Work (multi-module workspaces, Go 1.18+)
go work init                # Initialize workspace
go work use ./module        # Add module to workspace
go work sync                # Sync workspace deps

# Common environment variables
GOROOT      # Go installation directory
GOPATH      # Workspace directory
GOBIN       # Install directory
GOOS        # Target OS
GOARCH      # Target architecture
CGO_ENABLED # Enable/disable cgo
GOMODCACHE  # Module cache directory

# Cross-compilation
GOOS=linux GOARCH=amd64 go build
GOOS=windows GOARCH=amd64 go build
GOOS=darwin GOARCH=arm64 go build

# Build tags
go build -tags=prod         # With build tag
go test -tags=integration   # Test with tag

# Compiler flags
go build -gcflags="-m"      # Escape analysis
go build -ldflags="-X main.version=1.0"  # Set variable

# Race detector
go build -race
go test -race
go run -race main.go

# Coverage
go test -coverprofile=coverage.out
go tool cover -html=coverage.out
go tool cover -func=coverage.out

# Profiling
go test -cpuprofile=cpu.prof
go test -memprofile=mem.prof
go test -blockprofile=block.prof
go tool pprof cpu.prof

# Binary size reduction
go build -ldflags="-s -w"   # Strip debug info

# Module proxy
GOPROXY=https://proxy.golang.org  # Use proxy
GOPROXY=direct                     # Direct download
GOPRIVATE=github.com/mycompany/*  # Private modules
```

---
