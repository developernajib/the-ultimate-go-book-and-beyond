## 7B.14 The Module System Internals

### go.mod and go.sum Mechanics

The `go.mod` file declares your module's path, the minimum Go version, and all direct and indirect dependencies with their exact versions. The `go.sum` file contains cryptographic hashes of each dependency's source code, ensuring that the exact same code is used every time you build. Together, these files provide reproducible builds and protect against supply chain attacks where a dependency's contents might change after publication.

```bash
# Module initialization
go mod init github.com/myorg/myproject

# go.mod structure:
module github.com/myorg/myproject

go 1.27

require (
    github.com/gin-gonic/gin v1.9.1
    github.com/jackc/pgx/v5 v5.5.0
)

require (
    // indirect dependencies (managed automatically)
    github.com/bytedance/sonic v1.10.0 // indirect
)
```

### Module Proxy Protocol

When Go downloads a module, it fetches it through a module proxy rather than directly from the source repository. The default proxy is `proxy.golang.org`, which caches modules permanently so they remain available even if the original repository is deleted. For private code, you can configure `GOPRIVATE` to bypass both the proxy and the checksum database. Enterprise teams often run their own proxy (like Athens or Artifactory) to cache dependencies and control which modules are allowed.

```bash
# GOPROXY controls where modules are fetched from
# Default: GOPROXY=https://proxy.golang.org,direct

# Custom proxy for enterprise
GOPROXY=https://goproxy.mycompany.com,https://proxy.golang.org,direct

# GONOSUMDB: don't verify these modules against the checksum database
GONOSUMDB=github.com/myorg/*

# GONOPROXY: fetch these modules directly, bypassing the proxy
GONOPROXY=github.com/myorg/*

# GOPRIVATE: shorthand that sets the defaults for GONOPROXY + GONOSUMDB
GOPRIVATE=github.com/myorg/*

# Inspect module graph
go mod graph | head -20

# Explain why a dependency is required
go mod why -m github.com/some/package

# Tidy: add missing, remove unused
go mod tidy

# Vendor (copy dependencies into ./vendor)
go mod vendor
go build -mod=vendor ./...
```

### go.sum Verification

The `go.sum` file stores SHA-256 hashes for every module version your project depends on, including both the module's zip archive and its `go.mod` file. When you build, Go verifies that the downloaded module matches the hash in `go.sum`. It also checks with the global checksum database at `sum.golang.org` to ensure no one has tampered with a module after it was first published. This two-layer verification protects your builds from both accidental corruption and deliberate supply chain attacks.

```go
// go.sum format: module version hash
// github.com/gin-gonic/gin v1.9.1 h1:4...=
// github.com/gin-gonic/gin v1.9.1/go.mod h1:5...=

// h1: is a SHA-256 dirhash over the module's file tree
// (file names plus per-file hashes), not a hash of the zip bytes.
// The /go.mod line hashes just the go.mod file.
// Verified against sum.golang.org (GONOSUMDB to skip)
```

### Supply-Chain Discipline

For a senior engineer owning dependency management:

1. **Wire `govulncheck` into CI.** Runs on every PR, reports known CVEs in the dependency tree.
2. **Use a private module proxy for internal dependencies.** `GOPROXY=https://internal-proxy,https://proxy.golang.org,direct` gives internal resolution first with public fallback.
3. **Set checksum-verification behavior explicitly.** The default (`GOSUMDB=sum.golang.org`) is strict checksum verification. Exempt only specific internal modules via `GONOSUMDB` (or the `GOPRIVATE` shorthand), not the whole build.
4. **Audit dependency additions in review.** Every new direct dependency is a supply-chain commitment. Justify in PR descriptions.

---
