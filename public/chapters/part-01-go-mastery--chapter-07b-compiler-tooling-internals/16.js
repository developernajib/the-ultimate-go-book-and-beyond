export default `## 7B.14 The Module System Internals

### go.mod and go.sum Mechanics

The \`go.mod\` file declares your module's path, the minimum Go version, and all direct and indirect dependencies with their exact versions. The \`go.sum\` file contains cryptographic hashes of each dependency's source code, ensuring that the exact same code is used every time you build. Together, these files provide reproducible builds and protect against supply chain attacks where a dependency's contents might change after publication.

\`\`\`bash
# Module initialization
go mod init github.com/myorg/myproject

# go.mod structure:
module github.com/myorg/myproject

go 1.22

require (
    github.com/gin-gonic/gin v1.9.1
    github.com/jackc/pgx/v5 v5.5.0
)

require (
    // indirect dependencies (managed automatically)
    github.com/bytedance/sonic v1.10.0 // indirect
)
\`\`\`

### Module Proxy Protocol

When Go downloads a module, it fetches it through a module proxy rather than directly from the source repository. The default proxy is \`proxy.golang.org\`, which caches modules permanently so they remain available even if the original repository is deleted. For private code, you can configure \`GOPRIVATE\` to bypass both the proxy and the checksum database. Enterprise teams often run their own proxy (like Athens or Artifactory) to cache dependencies and control which modules are allowed.

\`\`\`bash
# GOPROXY controls where modules are fetched from
# Default: GOPROXY=https://proxy.golang.org,direct

# Custom proxy for enterprise
GOPROXY=https://goproxy.mycompany.com,https://proxy.golang.org,direct

# GONOSUMCHECK: skip sum check for private modules
GONOSUMCHECK=github.com/myorg/*

# GONOSUMDB: don't verify with sum database
GONOSUMDB=github.com/myorg/*

# GOPRIVATE: combines GONOSUMCHECK + GONOSUMDB + GONOPROXY
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
\`\`\`

### go.sum Verification

The \`go.sum\` file stores SHA-256 hashes for every module version your project depends on, including both the module's zip archive and its \`go.mod\` file. When you build, Go verifies that the downloaded module matches the hash in \`go.sum\`. It also checks with the global checksum database at \`sum.golang.org\` to ensure no one has tampered with a module after it was first published. This two-layer verification protects your builds from both accidental corruption and deliberate supply chain attacks.

\`\`\`go
// go.sum format: module version hash
// github.com/gin-gonic/gin v1.9.1 h1:4...=
// github.com/gin-gonic/gin v1.9.1/go.mod h1:5...=

// Hash is: sha256 of zip file (h1:) or go.mod file (/go.mod h1:)
// Verified against sum.golang.org (GONOSUMDB to skip)
\`\`\`

### Supply-Chain Discipline

For a senior engineer owning dependency management:

1. **Wire \`govulncheck\` into CI.** Runs on every PR, reports known CVEs in the dependency tree.
2. **Use a private module proxy for internal dependencies.** \`GOPROXY=https://internal-proxy,https://proxy.golang.org,direct\` gives internal resolution first with public fallback.
3. **Set \`GOSUMCHECK\` behaviour explicitly.** The default is strict checksum verification. Turn it off only for specific internal modules via \`GONOSUMCHECK\`.
4. **Audit dependency additions in review.** Every new direct dependency is a supply-chain commitment. Justify in PR descriptions.

---
`;
