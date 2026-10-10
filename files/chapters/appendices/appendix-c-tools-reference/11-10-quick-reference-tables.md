## 10. Quick Reference Tables

### 10.1 Common Go Commands

| Command | Description | Example |
|---------|-------------|---------|
| `go build` | Compile packages | `go build ./cmd/api` |
| `go run` | Compile and run | `go run main.go` |
| `go test` | Run tests | `go test -v ./...` |
| `go mod init` | Initialize module | `go mod init github.com/user/project` |
| `go mod tidy` | Clean dependencies | `go mod tidy` |
| `go get` | Add dependency | `go get github.com/pkg/errors` |
| `go install` | Install binary | `go install ./cmd/...` |
| `go fmt` | Format code | `go fmt ./...` |
| `go vet` | Analyze code | `go vet ./...` |
| `go generate` | Run generators | `go generate ./...` |

### 10.2 Build Flags Cheat Sheet

| Flag | Purpose | Example |
|------|---------|---------|
| `-o` | Output path | `-o ./bin/app` |
| `-ldflags="-s -w"` | Strip debug info | Reduces binary size |
| `-trimpath` | Remove file paths | Reproducible builds |
| `-race` | Race detector | Debug concurrency |
| `-tags` | Build tags | `-tags=production` |
| `-gcflags="all=-N -l"` | Disable optimization | For debugging |

### 10.3 Test Flags Cheat Sheet

| Flag | Purpose | Example |
|------|---------|---------|
| `-v` | Verbose | `go test -v` |
| `-run` | Filter tests | `-run TestUser` |
| `-cover` | Coverage | `-cover` |
| `-bench` | Benchmarks | `-bench=.` |
| `-race` | Race detection | `-race` |
| `-count` | Iterations | `-count=10` |
| `-timeout` | Max duration | `-timeout=30s` |
| `-short` | Skip long tests | `-short` |

### 10.4 Environment Variables Cheat Sheet

| Variable | Purpose | Example |
|----------|---------|---------|
| `GOOS` | Target OS | `linux`, `darwin`, `windows` |
| `GOARCH` | Target architecture | `amd64`, `arm64`, `386` |
| `CGO_ENABLED` | Enable/disable CGO | `0` or `1` |
| `GOPATH` | Workspace directory | `$HOME/go` |
| `GOBIN` | Binary install directory | `$GOPATH/bin` |
| `GOPROXY` | Module proxy | `https://proxy.golang.org` |
| `GOPRIVATE` | Private modules | `github.com/mycompany/*` |
| `GODEBUG` | Runtime debugging | `gctrace=1` |

### 10.5 Platform Targets

| OS | Architecture | GOOS | GOARCH |
|----|--------------|------|--------|
| Linux 64-bit | x86-64 | linux | amd64 |
| Linux ARM | ARM64 | linux | arm64 |
| macOS Intel | x86-64 | darwin | amd64 |
| macOS Apple Silicon | ARM64 | darwin | arm64 |
| Windows 64-bit | x86-64 | windows | amd64 |
| Raspberry Pi | ARMv7 | linux | arm |

### 10.6 Profiling Quick Reference

| Profile Type | Command | pprof Endpoint |
|--------------|---------|----------------|
| CPU | `-cpuprofile` | `/debug/pprof/profile` |
| Memory | `-memprofile` | `/debug/pprof/heap` |
| Goroutines | N/A | `/debug/pprof/goroutine` |
| Block | N/A | `/debug/pprof/block` |
| Mutex | N/A | `/debug/pprof/mutex` |
| Trace | `-trace` | `/debug/pprof/trace` |

### 10.7 Linters Comparison

| Tool | Focus | Configuration |
|------|-------|---------------|
| `go vet` | Built-in checks | Flags |
| `staticcheck` | Correctness | staticcheck.conf |
| `golangci-lint` | Aggregator | .golangci.yml |
| `gosec` | Security | Rules |
| `errcheck` | Error handling | Flags |

---
