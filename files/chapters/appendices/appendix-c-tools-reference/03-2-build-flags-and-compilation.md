## 2. Build Flags and Compilation

### 2.1 Production Build Configuration

A production Go binary should be statically linked, stripped of debug symbols, and embedded with version metadata so that the running process is always identifiable without consulting external records. Setting `CGO_ENABLED=0` ensures no dynamic C library dependencies exist, making the binary portable across any Linux container without needing a specific libc version, while `-ldflags="-s -w"` removes the symbol table and DWARF debug information to reduce binary size.

```bash
# Optimal production build
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
  -ldflags="-s -w -X main.version=1.2.3 -X main.buildTime=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  -trimpath \
  -o ./bin/api \
  ./cmd/api
```

### 2.2 Build Flags Explained

| Flag | Description | Example |
|------|-------------|---------|
| `-a` | Force rebuild all packages | `go build -a` |
| `-n` | Print commands without executing | `go build -n` |
| `-o` | Output file/directory | `go build -o myapp` |
| `-p n` | Parallelize build with n processes | `go build -p 4` |
| `-race` | Enable race detector | `go build -race` |
| `-tags` | Build tags | `go build -tags=prod` |
| `-trimpath` | Remove file paths from binary | `go build -trimpath` |
| `-v` | Verbose output | `go build -v` |
| `-work` | Print temp work directory | `go build -work` |
| `-x` | Print build commands | `go build -x` |

### 2.3 Build Tags

Build tags give you compile-time control over which files are included in a package, enabling you to maintain separate implementations for different operating systems, minimum Go versions, or deployment environments within the same repository. The `//go:build` directive at the top of a file accepts boolean expressions combining tags with `&&`, `||`, and `!`, so a single file can be gated on both environment and the absence of a debug flag simultaneously.

```go
// File: feature_new.go
//go:build go1.27

package main

// File: feature_linux.go
//go:build linux

package main

// File: feature_prod.go
//go:build production && !debug

package main
```

```bash
# Build with tags
go build -tags=production ./...
go build -tags="production mysql" ./...
go build -tags="integration,slow" -test ./...
```

### 2.4 Size Optimization

Smaller binaries reduce container image pull times, lower cold-start latency in serverless environments, and minimize the attack surface by excluding unnecessary symbols. Stripping the symbol table and DWARF data with `-ldflags="-s -w"` combined with `-trimpath` often cuts binary size in half, and tools like UPX can compress the result further at the cost of a small decompression overhead at startup.

```bash
# Minimal binary size
CGO_ENABLED=0 go build \
  -ldflags="-s -w" \
  -trimpath \
  -o myapp

# UPX compression (additional ~50% reduction)
go build -ldflags="-s -w" -o myapp
upx --best --lzma myapp

# Compare sizes
ls -lh myapp
go build -o myapp-normal ./...
go build -ldflags="-s -w" -trimpath -o myapp-optimized ./...
ls -lh myapp-*
```

---
