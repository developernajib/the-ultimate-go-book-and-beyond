export default `## 1.7 Complete Development Environment Setup

This section walks through installing Go, configuring your editor, and setting up the build toolchain and CI pipeline for a production-grade project.

### Installation

#### macOS

On macOS, the simplest installation path uses Homebrew, which handles PATH configuration and updates automatically.

\`\`\`bash
# Using Homebrew (recommended)
brew install go

# Verify installation
go version
# Output: go version go1.26.2 darwin/arm64
\`\`\`

#### Ubuntu/Debian

On Debian-based Linux systems, the recommended approach downloads the official tarball directly from the Go distribution server to ensure you have the latest version.

\`\`\`bash
# Remove any old version
sudo rm -rf /usr/local/go

# Download latest version (check go.dev for current version)
wget https://go.dev/dl/go1.26.2.linux-amd64.tar.gz

# Extract to /usr/local
sudo tar -C /usr/local -xzf go1.26.2.linux-amd64.tar.gz

# Add to PATH (add to ~/.bashrc or ~/.zshrc)
echo 'export PATH=\$PATH:/usr/local/go/bin' >> ~/.bashrc
echo 'export PATH=\$PATH:\$HOME/go/bin' >> ~/.bashrc
source ~/.bashrc

# Verify
go version
\`\`\`

#### Windows

On Windows, Go can be installed via the official MSI installer or through package managers like Chocolatey or Scoop.

\`\`\`powershell
# Option 1: Download MSI from https://go.dev/dl/
# Run the installer

# Option 2: Using Chocolatey
choco install golang

# Option 3: Using Scoop
scoop install go

# Verify (new terminal)
go version
\`\`\`

### Project Structure

Modern Go projects follow this structure:

\`\`\`
myproject/
├── go.mod                 # Module definition
├── go.sum                 # Dependency checksums
├── main.go                # Application entry point
├── cmd/                   # Command-line applications
│   └── myapp/
│       └── main.go
├── internal/              # Private application code
│   ├── config/
│   │   └── config.go
│   ├── handlers/
│   │   └── handlers.go
│   └── models/
│       └── models.go
├── pkg/                   # Public library code
│   └── mylib/
│       └── mylib.go
├── api/                   # API definitions (OpenAPI, protobuf)
│   └── openapi.yaml
├── configs/               # Configuration files
│   └── config.yaml
├── scripts/               # Build and utility scripts
│   └── setup.sh
├── test/                  # Additional test files
│   └── integration/
├── Dockerfile
├── docker-compose.yml
├── Makefile
└── README.md
\`\`\`

### Initialize a New Project

Initializing a Go module creates the go.mod file that tracks the module path and dependencies. The following commands scaffold a minimal working HTTP server to verify the setup.

\`\`\`bash
# Create project directory
mkdir -p ~/projects/myproject
cd ~/projects/myproject

# Initialize Go module
go mod init github.com/yourusername/myproject

# Create main.go
cat > main.go << 'EOF'
package main

import (
    "fmt"
    "log"
    "net/http"
    "os"
)

func main() {
    port := os.Getenv("PORT")
    if port == "" {
        port = "8080"
    }

    http.HandleFunc("/", handleRoot)
    http.HandleFunc("/health", handleHealth)

    log.Printf("Server starting on port %s", port)
    log.Fatal(http.ListenAndServe(":"+port, nil))
}

func handleRoot(w http.ResponseWriter, r *http.Request) {
    fmt.Fprintf(w, "Hello, Go!")
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Content-Type", "application/json")
    fmt.Fprintf(w, \`{"status": "healthy"}\`)
}
EOF

# Run the server
go run main.go
\`\`\`

### VS Code Setup (Recommended)

Install VS Code and the Go extension:

\`\`\`bash
# Install VS Code (macOS)
brew install --cask visual-studio-code

# Install Go extension
code --install-extension golang.go
\`\`\`

Configure VS Code settings (\`.vscode/settings.json\`):

\`\`\`json
{
    "go.useLanguageServer": true,
    "go.lintOnSave": "package",
    "go.lintTool": "golangci-lint",
    "go.formatTool": "goimports",
    "editor.formatOnSave": true,
    "editor.codeActionsOnSave": {
        "source.organizeImports": true
    },
    "[go]": {
        "editor.defaultFormatter": "golang.go",
        "editor.tabSize": 4,
        "editor.insertSpaces": false
    },
    "go.testOnSave": true,
    "go.coverOnSave": true,
    "go.coverageDecorator": {
        "type": "highlight",
        "coveredHighlightColor": "rgba(64,128,64,0.3)",
        "uncoveredHighlightColor": "rgba(128,64,64,0.3)"
    },
    "gopls": {
        "experimentalWorkspaceModule": true,
        "staticcheck": true,
        "analyses": {
            "unusedparams": true,
            "shadow": true
        }
    }
}
\`\`\`

Install Go tools (run in VS Code: \`Cmd/Ctrl+Shift+P\` → "Go: Install/Update Tools"):
- gopls (language server)
- dlv (debugger)
- golangci-lint (linter)
- goimports (formatter)
- goplay (playground)

### Essential Makefile

Create a \`Makefile\` for common tasks:

\`\`\`makefile
# Makefile for Go project

# Variables
BINARY_NAME=myapp
MAIN_PACKAGE=./cmd/myapp
GO=go
GOFLAGS=-ldflags="-s -w"
DOCKER_IMAGE=myapp

# Default target
.PHONY: all
all: build

# Build the binary
.PHONY: build
build:
	\$(GO) build \$(GOFLAGS) -o bin/\$(BINARY_NAME) \$(MAIN_PACKAGE)

# Run the application
.PHONY: run
run:
	\$(GO) run \$(MAIN_PACKAGE)

# Run tests
.PHONY: test
test:
	\$(GO) test -v -race -cover ./...

# Run tests with coverage report
.PHONY: coverage
coverage:
	\$(GO) test -coverprofile=coverage.out ./...
	\$(GO) tool cover -html=coverage.out -o coverage.html
	open coverage.html

# Run benchmarks
.PHONY: bench
bench:
	\$(GO) test -bench=. -benchmem ./...

# Run linter
.PHONY: lint
lint:
	golangci-lint run ./...

# Format code
.PHONY: fmt
fmt:
	\$(GO) fmt ./...
	goimports -w .

# Tidy dependencies
.PHONY: tidy
tidy:
	\$(GO) mod tidy

# Clean build artifacts
.PHONY: clean
clean:
	rm -rf bin/
	rm -f coverage.out coverage.html

# Build Docker image
.PHONY: docker-build
docker-build:
	docker build -t \$(DOCKER_IMAGE):latest .

# Run Docker container
.PHONY: docker-run
docker-run:
	docker run -p 8080:8080 \$(DOCKER_IMAGE):latest

# Generate mocks (if using mockery)
.PHONY: mocks
mocks:
	mockery --all --output mocks

# Security scan
.PHONY: security
security:
	gosec ./...

# All checks (for CI)
.PHONY: ci
ci: fmt lint test security build

# Help
.PHONY: help
help:
	@echo "Available targets:"
	@echo "  build     - Build the binary"
	@echo "  run       - Run the application"
	@echo "  test      - Run tests"
	@echo "  coverage  - Generate coverage report"
	@echo "  bench     - Run benchmarks"
	@echo "  lint      - Run linter"
	@echo "  fmt       - Format code"
	@echo "  tidy      - Tidy dependencies"
	@echo "  clean     - Clean build artifacts"
	@echo "  docker-*  - Docker commands"
	@echo "  ci        - Run all CI checks"
\`\`\`

### Dockerfile for Production

Create an optimized multi-stage Dockerfile:

\`\`\`dockerfile
# Build stage
FROM golang:1.26-alpine AS builder

# Install git and ca-certificates (for fetching dependencies)
RUN apk add --no-cache git ca-certificates tzdata

# Create appuser
RUN adduser -D -g '' appuser

WORKDIR /build

# Copy go mod files first for caching
COPY go.mod go.sum ./
RUN go mod download

# Copy source code
COPY . .

# Build the binary
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \\
    -ldflags='-w -s -extldflags "-static"' \\
    -o /build/app ./cmd/myapp

# Final stage
FROM scratch

# Import from builder
COPY --from=builder /usr/share/zoneinfo /usr/share/zoneinfo
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=builder /etc/passwd /etc/passwd
COPY --from=builder /build/app /app

# Use non-root user
USER appuser

# Expose port
EXPOSE 8080

# Run the binary
ENTRYPOINT ["/app"]
\`\`\`

### Docker Compose for Local Development

The Docker Compose configuration defines all services needed for local development, including the application, database, and any supporting infrastructure.

\`\`\`yaml
# docker-compose.yml
version: '3.8'

services:
  app:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "8080:8080"
    environment:
      - PORT=8080
      - DATABASE_URL=postgres://postgres:postgres@db:5432/myapp?sslmode=disable
      - REDIS_URL=redis://redis:6379
    depends_on:
      - db
      - redis
    restart: unless-stopped

  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: myapp
    volumes:
      - postgres_data:/var/lib/postgresql/data
    ports:
      - "5432:5432"

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"

volumes:
  postgres_data:
\`\`\`

### GitHub Actions CI/CD

Create \`.github/workflows/ci.yml\`:

\`\`\`yaml
name: CI

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest

    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: test
        ports:
          - 5432:5432
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

    steps:
      - uses: actions/checkout@v4

      - name: Set up Go
        uses: actions/setup-go@v5
        with:
          go-version: '1.26'

      - name: Cache Go modules
        uses: actions/cache@v4
        with:
          path: |
            ~/.cache/go-build
            ~/go/pkg/mod
          key: \${{ runner.os }}-go-\${{ hashFiles('**/go.sum') }}
          restore-keys: |
            \${{ runner.os }}-go-

      - name: Download dependencies
        run: go mod download

      - name: Run tests
        run: go test -v -race -coverprofile=coverage.out ./...
        env:
          DATABASE_URL: postgres://postgres:postgres@localhost:5432/test?sslmode=disable

      - name: Upload coverage
        uses: codecov/codecov-action@v4
        with:
          file: ./coverage.out

  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up Go
        uses: actions/setup-go@v5
        with:
          go-version: '1.26'

      - name: golangci-lint
        uses: golangci/golangci-lint-action@v4
        with:
          version: latest

  security:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Run Gosec
        uses: securego/gosec@master
        with:
          args: ./...

  build:
    needs: [test, lint]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up Go
        uses: actions/setup-go@v5
        with:
          go-version: '1.26'

      - name: Build
        run: go build -v ./...

      - name: Build Docker image
        run: docker build -t myapp:\${{ github.sha }} .
\`\`\`

### The 2026 Modern Go Toolchain: What Goes Beyond the Basics

The setup above gets a new project up and running. Any production Go team in 2026 should additionally add the following tools to CI. They are free, they are standard in the Go ecosystem, and their absence shows up in code review.

#### \`govulncheck\`: Required

Since Go 1.19 (2022), the Go team has maintained a vulnerability database and a dedicated scanner that analyzes your binary's actual call graph (not just \`go.sum\`) to tell you whether a known CVE is reachable from your code. It catches, for example, a vulnerable version of \`golang.org/x/crypto/ssh\` in your module graph *only if your code actually calls the vulnerable function*. This reachability-aware model produces far fewer false positives than npm's or pip's audit tools.

\`\`\`bash
go install golang.org/x/vuln/cmd/govulncheck@latest
govulncheck ./...
\`\`\`

Add it to CI as a blocking check:

\`\`\`yaml
  vuln:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: '1.26'
      - run: go install golang.org/x/vuln/cmd/govulncheck@latest
      - run: govulncheck ./...
\`\`\`

If your org has a supply-chain security mandate, \`govulncheck\` is the first thing a reviewer will ask for. Adopt it before someone files a compliance ticket.

#### \`golangci-lint v2\`: Required

The v2 release (mid-2025) consolidated all the common Go linters (\`staticcheck\`, \`govet\`, \`errcheck\`, \`gosimple\`, \`ineffassign\`, \`gocritic\`, \`revive\`, dozens of others) into a single configured entry point. Configuration lives in \`.golangci.yml\` and should be checked into every repo.

\`\`\`yaml
# .golangci.yml (minimal starting config for a production repo)
version: "2"
linters:
  default: standard
  enable:
    - errcheck
    - govet
    - staticcheck
    - unused
    - gosimple
    - ineffassign
    - errorlint
    - goimports
    - revive
    - gocritic
    - gosec
    - bodyclose
    - noctx
    - rowserrcheck
    - sqlclosecheck
  settings:
    revive:
      rules:
        - name: exported
        - name: unused-parameter
          disabled: true
run:
  timeout: 5m
  tests: true
\`\`\`

#### \`gotestsum\`: Recommended

\`gotestsum\` wraps \`go test\` with a human-friendly output format and produces JUnit-XML for CI aggregation. If your CI dashboard integrates with JUnit (GitHub Actions, CircleCI, Jenkins), \`gotestsum\` gives you per-test timing, flake tracking, and failure grouping without writing any glue code.

\`\`\`bash
go install gotest.tools/gotestsum@latest
gotestsum --junitfile=report.xml -- -race -coverprofile=coverage.out ./...
\`\`\`

#### \`delve\`: Required for Anyone Doing Real Debugging

Delve (\`dlv\`) is Go's de facto debugger and integrates with VS Code, GoLand, and Neovim. The common commands:

\`\`\`bash
# Install
go install github.com/go-delve/delve/cmd/dlv@latest

# Debug a running binary
dlv debug ./cmd/myapp

# Attach to a running process
dlv attach <PID>

# Debug a test
dlv test ./pkg/handler -- -run TestSpecificThing
\`\`\`

If you have been relying on \`fmt.Println\` debugging in Go for more than a month, stop. Learn \`dlv\`: the investment pays back within a week on any non-trivial bug.

#### \`air\` or \`reflex\`: Optional Live-Reload

For web-service development, a live-reload tool that rebuilds and restarts on file save is a productivity win. \`air\` is the most popular:

\`\`\`bash
go install github.com/cosmtrek/air@latest
air init  # creates .air.toml
air       # now your server restarts on save
\`\`\`

#### Pre-Commit Hooks

Install a pre-commit hook that runs \`gofmt\`, \`goimports\`, and a fast \`golangci-lint\` on changed files before every commit. Either roll your own with a \`.git/hooks/pre-commit\` script or use [\`pre-commit.com\`](https://pre-commit.com/):

\`\`\`yaml
# .pre-commit-config.yaml
repos:
  - repo: https://github.com/dnephin/pre-commit-golang
    rev: v0.5.1
    hooks:
      - id: go-fmt
      - id: go-imports
      - id: golangci-lint
      - id: go-unit-tests
\`\`\`

### Editor Alternatives: GoLand and Neovim

Not every Go engineer uses VS Code. The two other major environments are worth knowing:

- **GoLand (JetBrains).** Paid, but at FAANG salary levels the license pays for itself in a day. Its debugger, refactoring (rename with cross-file reference updates, extract function, inline variable), and test-navigation UX are meaningfully better than VS Code's. If you come from an IntelliJ background, GoLand feels native. In 2026, GoLand's AI Assistant and Junie agent also integrate Go-specific refactoring actions that VS Code's Copilot does not match natively. Recommended for engineers who do heavy refactoring on large codebases.
- **Neovim + \`gopls\`.** If you are a Vim/Neovim user, the \`nvim-lspconfig\` + \`gopls\` + \`dap-go\` combination produces a fast, low-memory Go environment that rivals VS Code for the core edit/test/debug loop. A working starter config is widely documented at the \`nvim-lspconfig\` repository. Expect a weekend to configure; expect it to be the fastest Go editor you have ever used afterwards.

For junior engineers, VS Code with the Go extension is the safe starting choice: the Go team itself ships and maintains \`gopls\`, which drives all three editors, so the intelligence floor is identical across environments.

### Enterprise and Staff-Track Setup

The setup above works for a greenfield project on GitHub. A staff engineer adopting Go inside a FAANG-equivalent org has additional concerns that the typical blog-post setup guides skip:

#### \`GOPROXY\`, \`GOPRIVATE\`, and Athens

By default, \`go mod\` fetches modules through \`proxy.golang.org\`, which caches public modules and enforces the Go Checksum Database. For private modules hosted at \`github.com/myorg/...\` or an internal GitLab, you must exempt them:

\`\`\`bash
export GOPROXY="https://proxy.golang.org,direct"
export GOPRIVATE="github.com/myorg/*,internal.mycompany.com/*"
export GONOSUMDB="github.com/myorg/*,internal.mycompany.com/*"
\`\`\`

At scale, larger orgs run an internal module proxy (**Athens**, \`gomods/athens\`, is the open-source standard) to cache modules, enforce allow-lists, and eliminate dependence on the public proxy. For a fleet running hundreds of Go services, this removes an entire class of outage (proxy.golang.org degradation) and enforces supply-chain review (no module enters the cache without approval). If your org is past ~50 Go services, build the case for Athens.

#### Authenticated module access with \`GOAUTH\`

Go 1.24 (Feb 2025) introduced \`GOAUTH\` for handling credentials to private module servers, mandatory if your internal GitLab or GitHub Enterprise requires tokens. Document the setup in your onboarding guide: new hires will hit this wall on day one.

#### Reproducible builds and \`-trimpath\`

Production binaries should be built with \`-trimpath\` (removes filesystem paths from the binary) and with a pinned Go toolchain version recorded in \`go.mod\`. The Go 1.21+ toolchain directive (\`go 1.26\`) ensures CI uses the exact compiler version:

\`\`\`bash
go build -trimpath -ldflags="-s -w -X main.version=\$(git rev-parse HEAD)" -o bin/myapp ./cmd/myapp
\`\`\`

#### SLSA provenance and signed binaries

For production Go binaries that end up in container images or distributed artifacts, generate SLSA Level 3 provenance via GitHub's SLSA generator action and sign with \`cosign\` (keyless, via Sigstore). By 2026, most enterprise compliance frameworks (FedRAMP, SOC 2) expect this for any software shipped to customers. Example workflow snippet:

\`\`\`yaml
      - name: Sign binary with cosign
        uses: sigstore/cosign-installer@v3
      - run: cosign sign-blob --yes bin/myapp > bin/myapp.sig
\`\`\`

If you are a staff engineer architecting the platform, these artifact-integrity practices are no longer optional for any regulated industry. The work is modest; the audit cost of adopting them retroactively is not.

#### Monorepo vs. polyrepo

Large orgs split on whether Go services belong in a monorepo (Bazel + \`rules_go\`) or in many separate repos with module-level versioning. The monorepo story has gotten better since the \`go work\` files landed in Go 1.18 (workspace mode), which makes cross-module development in a single checkout tolerable without Bazel. For an org writing 5 to 50 Go services, polyrepos with \`go work\` for local cross-service work is usually simpler; for 100+ services or a mixed Go/non-Go codebase, Bazel is the standard answer. This is a decision that should be made deliberately at the staff level and documented in an ADR, not defaulted to by the first team that needs to ship.

### Junior-Track: "Did My Setup Actually Work?" Verification

A surprisingly common interview failure is arriving at an on-site coding round and discovering that the candidate's laptop setup cannot run \`go test\` against the provided skeleton code. Before your first on-site, run through this checklist on the exact machine you will bring to the interview. If any step fails, fix it *before* the interview, not during.

\`\`\`bash
# 1. Go installed and on PATH
go version
# Expect: go version go1.26.X darwin/arm64 (or equivalent)

# 2. GOPATH configured (most setups use default \$HOME/go)
go env GOPATH
# Expect: /Users/you/go (or equivalent)

# 3. Module mode works end-to-end
mkdir -p /tmp/go-verify && cd /tmp/go-verify
go mod init example.com/verify
cat > main.go << 'EOF'
package main
import "fmt"
func main() { fmt.Println("Hello, Go") }
EOF
go run main.go
# Expect: "Hello, Go"

# 4. Testing works
cat > main_test.go << 'EOF'
package main
import "testing"
func TestHello(t *testing.T) { if 1+1 != 2 { t.Fatal("math broken") } }
EOF
go test ./...
# Expect: PASS

# 5. Static build works (the interview may ask for this)
go build -o hello main.go
file hello  # or \`./hello\` to verify it runs

# 6. Cross-compile works (the follow-up question)
GOOS=linux GOARCH=amd64 go build -o hello-linux main.go
file hello-linux
# Expect: ELF 64-bit LSB executable

# 7. Editor starts, gopls runs, autocomplete works on a fresh file
code main.go  # or goland/nvim — whichever you use
# Type \`fmt.\` — should see autocomplete.

# 8. Debugger attaches
dlv debug main.go
# Should drop into a debugger prompt; \`q\` to quit.

# 9. Your linter runs without a mysterious error
golangci-lint run ./...
# Expect: 0 issues, or at least a clean run that exits.

# 10. Internet access for module download works
go get -u github.com/stretchr/testify/assert
# Expect: go.sum is created/updated.

# Cleanup
cd .. && rm -rf go-verify
\`\`\`

If all ten steps pass, your setup is interview-ready. If any fail, the two most common culprits are (a) \`PATH\` missing \`\$GOPATH/bin\` (fix in shell rc file) and (b) corporate VPN or proxy blocking \`proxy.golang.org\` (resolve before the interview; interviews over hotspots have caught candidates out).

---
`;
