## 3. Environment Variables

### 3.1 Core Environment Variables

These variables control where Go finds its toolchain, how it resolves modules, and what platform it targets during builds. Set them in your shell profile or CI configuration.

```bash
# Go installation root
GOROOT=/usr/local/go

# Workspace and dependencies
GOPATH=$HOME/go
GOBIN=$GOPATH/bin

# Module proxy
GOPROXY=https://proxy.golang.org,direct
GOPRIVATE=github.com/mycompany/*
GONOPROXY=github.com/mycompany/*
GONOSUMDB=github.com/mycompany/*

# Go version management
GOTOOLCHAIN=auto
# Options: auto, local, go1.23.0, path

# Module mode
GO111MODULE=on
# Options: on, off, auto

# Cache directories
GOCACHE=$HOME/.cache/go-build
GOMODCACHE=$GOPATH/pkg/mod

# Target platform
GOOS=linux
GOARCH=amd64

# CGO
CGO_ENABLED=1
CGO_CFLAGS="-g -O2"
CGO_LDFLAGS=""

# Testing
GOFLAGS="-count=1 -v"

# Debugging
GODEBUG=gctrace=1,schedtrace=1000
```

### 3.2 View All Environment Variables

```bash
# Show all Go environment
go env

# Show specific variable
go env GOPATH
go env GOOS GOARCH

# Set environment variable (persistent)
go env -w GOPRIVATE=github.com/mycompany/*

# Unset environment variable
go env -u GOPRIVATE

# Show as JSON
go env -json
```

### 3.3 Platform Combinations

```bash
# Common platforms
GOOS=linux GOARCH=amd64        # Linux 64-bit
GOOS=linux GOARCH=arm64        # Linux ARM64 (AWS Graviton)
GOOS=darwin GOARCH=amd64       # macOS Intel
GOOS=darwin GOARCH=arm64       # macOS Apple Silicon
GOOS=windows GOARCH=amd64      # Windows 64-bit
GOOS=linux GOARCH=arm GOARM=7  # Raspberry Pi

# List all supported platforms
go tool dist list

# Check if platform combination is valid
go tool dist list | grep "linux/amd64"
```

### 3.4 GODEBUG Options

```bash
# Garbage collection trace
GODEBUG=gctrace=1 ./myapp

# Scheduler trace
GODEBUG=schedtrace=1000 ./myapp

# Memory allocator trace
GODEBUG=allocfreetrace=1 ./myapp

# Detailed scheduler state (scheddetail requires schedtrace)
GODEBUG=schedtrace=1000,scheddetail=1 ./myapp

# HTTP/2 debugging
GODEBUG=http2debug=1 ./myapp

# DNS resolver debugging
GODEBUG=netdns=go+2 ./myapp

# Multiple options
GODEBUG=gctrace=1,schedtrace=1000 ./myapp
```

### 3.5 Private Modules

```bash
# Configure private repositories
go env -w GOPRIVATE=github.com/mycompany/*
go env -w GONOPROXY=github.com/mycompany/*
go env -w GONOSUMDB=github.com/mycompany/*

# Git configuration for private repos
git config --global url."git@github.com:".insteadOf "https://github.com/"

# Netrc for HTTP authentication
# File: ~/.netrc
machine github.com
login username
password ghp_token_here
```

---
