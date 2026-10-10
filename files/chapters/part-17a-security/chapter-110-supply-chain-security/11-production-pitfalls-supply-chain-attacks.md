## 110.10 Production Pitfalls: Supply Chain Attacks

### Pitfall 1: Not Pinning Dependency Versions

**Real Incident Report**: A company used `go get` without version pinning in their CI/CD. A malicious actor compromised a popular logging library and released a backdoored version. Since CI always pulled "latest," production was compromised within hours of the malicious release.

**The Anti-Pattern**:
```bash
# WRONG: CI/CD bumps every dependency to latest on every build,
# defeating the pins recorded in go.mod and go.sum
go get -u ./...
go build
```

**The Better Approach**:
```go
// go.mod, RIGHT: Explicit version pinning
module myapp

go 1.27

require (
    github.com/some/library v1.2.3 // Pinned version
)
```

```bash
# RIGHT: Use go.sum for integrity verification
# Never run "go get -u" in CI

# Verify checksums match
go mod verify

# Use vendoring for hermetic builds
go mod vendor
go build -mod=vendor ./...

# Pin the Go toolchain version in CI
go install golang.org/dl/go1.27.0@latest
go1.27.0 build ./...
```

**Key Insight**: Every unpinned dependency is a potential supply chain attack vector. Pin versions, use `go.sum` verification, and consider vendoring for critical applications.

---

### Pitfall 2: Trusting Typosquatted Packages

**Real Incident Report**: A developer accidentally imported `github.com/gogle/oauth2` instead of `golang.org/x/oauth2`. The typosquatted package harvested OAuth tokens and sent them to an attacker-controlled server. The typo went unnoticed for 3 weeks.

**The Anti-Pattern**:
```go
// WRONG: No verification of package authenticity
import (
    "github.com/gogle/oauth2" // Typosquat of golang.org/x/oauth2
    "github.com/aws/aws-sdk-g0" // Typosquat with zero instead of O
)
```

**The Better Approach**:
```go
// RIGHT: Use official packages from verified sources
import (
    "golang.org/x/oauth2" // Official Google package
    "github.com/aws/aws-sdk-go-v2" // Official AWS package
)
```

```bash
# Implement package allowlisting in CI
# .allowed-packages.txt
golang.org/x/*
github.com/aws/aws-sdk-go-v2/*
github.com/prometheus/client_golang

# CI script to verify
#!/bin/bash
set -euo pipefail
fail=0
# tail skips the main module line, and avoiding a pipe into the loop
# keeps the failure flag in the current shell
while read -r mod version; do
    if ! grep -q "^${mod}$\|^${mod%/*}/\*$" .allowed-packages.txt; then
        echo "ERROR: Unapproved dependency: $mod"
        fail=1
    fi
done < <(go list -m all | tail -n +2)
exit "$fail"
```

**Key Insight**: Typosquatting is one of the most common supply chain attacks. Implement package allowlisting and use tooling to detect suspicious dependencies.

---

### Pitfall 3: Using Outdated Dependencies with Known CVEs

**Real Incident Report**: A microservice used an 18-month-old version of a JWT library with a known signature bypass vulnerability. Attackers forged admin tokens and accessed internal systems.

**The Anti-Pattern**:
```go
// go.mod, WRONG: Old version with known CVEs
module myapp

require (
    github.com/dgrijalva/jwt-go v3.2.0+incompatible // CVE-2020-26160
    github.com/gin-gonic/gin v1.4.0 // Multiple CVEs
)
```

**The Better Approach**:
```bash
# RIGHT: Automated vulnerability scanning in CI
go install golang.org/x/vuln/cmd/govulncheck@latest
govulncheck ./...
```

```go
// go.mod, RIGHT: Migrated to maintained, patched versions
module myapp

require (
    github.com/golang-jwt/jwt/v5 v5.2.0 // Maintained fork
    github.com/gin-gonic/gin v1.9.1 // Latest stable
)
```

**Key Insight**: Known vulnerabilities are the easiest attack vector. Integrate `govulncheck` into CI/CD and enable automated dependency updates.

---

### Pitfall 4: Building with Unverified Container Base Images

**Real Incident Report**: A team used `FROM golang:latest` in production. A compromised Docker Hub account pushed a malicious image. All builds for 6 hours included a cryptocurrency miner.

**The Anti-Pattern**:
```dockerfile
# WRONG: Unpinned, unverified base images
FROM golang:latest

# WRONG: Using random community images
FROM some-user/go-builder:latest
```

**The Better Approach**:
```dockerfile
# RIGHT: Pin by digest for reproducible builds
FROM golang:1.27.1@sha256:abc123... AS builder

# Use official distroless images
FROM gcr.io/distroless/static@sha256:def456...
```

```bash
# Verify signatures on signed upstream images (distroless is cosign-signed)
cosign verify gcr.io/distroless/static:nonroot \
  --certificate-oidc-issuer https://accounts.google.com \
  --certificate-identity keyless@distroless.iam.gserviceaccount.com

# Sign your own images
cosign sign --key cosign.key myapp:$SHA
```

**Key Insight**: "latest" tags are mutable. Pin by digest and verify signatures to ensure build integrity.

---

### Pitfall 5: No SBOM or Dependency Transparency

**Real Incident Report**: After Log4Shell, a company spent weeks determining which of their hundreds of services were affected. Without SBOMs, they had to manually inspect each codebase.

**The Anti-Pattern**:
```bash
# WRONG: No visibility into deployed dependencies
go build -o app
docker push myapp:latest
# No record of what's inside...
```

**The Better Approach**:
```bash
# RIGHT: Generate SBOM during build
syft dir:. -o spdx-json > sbom.spdx.json

# Attach SBOM to container image
cosign attach sbom --sbom sbom.spdx.json myapp:latest

# Scan SBOM for vulnerabilities
grype sbom:./sbom.spdx.json
```

```go
// Expose dependencies via an internal-only endpoint for inventory.
// Restrict access: this reveals your full dependency graph.
func dependencyHandler(w http.ResponseWriter, r *http.Request) {
    info, ok := debug.ReadBuildInfo()
    if !ok {
        http.Error(w, "build info unavailable", http.StatusInternalServerError)
        return
    }
    json.NewEncoder(w).Encode(info.Deps)
}
```

**Key Insight**: You can't secure what you can't see. Generate SBOMs for all builds and maintain a searchable inventory of deployed dependencies.

---

### Supply Chain Pitfall Quick Reference

| Pitfall | Attack Vector | Fix |
|---------|--------------|-----|
| Unpinned versions | Malicious updates | go.sum verification, vendoring |
| Typosquatted packages | Look-alike module paths | Package allowlisting |
| Outdated dependencies | Known CVE exploitation | govulncheck in CI |
| Unverified base images | Image poisoning | Digest pinning, cosign |
| No SBOM | Invisible vulnerabilities | syft, runtime dependency exposure |

### Junior → FAANG: Supply Chain Pitfalls as Interview Scenarios

These pitfalls are commonly used as interview scenarios at FAANG companies: "A critical dependency in your Go application was found to contain malicious code. What do you do?" The answer tests your incident response thinking as much as your supply chain knowledge.

**Gap to close:** Understand the dependency confusion attack as it applies to Go module resolution (the attack class itself also hits npm and PyPI). If your organization uses private modules with a prefix like `company.com/internal/payments`, an attacker can publish a public module with the same path if your `GOPROXY` and `GOPRIVATE` are not configured correctly. The Go toolchain might fetch the malicious public module instead of your private one. Prevention: set `GOPRIVATE=company.com/*` and configure `GOPROXY` to consult your internal proxy first.

**Interview scenario answer:** When asked what you do if a dependency is compromised: (1) query your SBOM repository to identify every service that uses the compromised module, (2) prioritize services based on whether the vulnerable code path is reachable (use `govulncheck` to check), (3) patch by updating to a clean version or forking the module, (4) deploy fixes in priority order, (5) run a post-incident review to determine how the compromise was introduced and what detection gap allowed it to be undetected.

### Senior @ FAANG: Preventing Supply Chain Pitfalls at Scale

At senior level, preventing these pitfalls requires systematic controls that work across all repositories and all teams without requiring individual vigilance.

**Dependency pinning policy:** Require that all production builds use exact version pinning (`go.mod` with specific versions, `go.sum` with checksums). Prohibit floating version references (`latest`, `@latest`). Enforce this in CI: a build that modifies `go.sum` without a corresponding PR review is blocked. This eliminates the floating dependency vector.

**Base image digest pinning:** Require that all `FROM` instructions in Dockerfiles use digest-pinned references (`FROM gcr.io/distroless/static@sha256:abc123...`). Configure a policy check (hadolint plus a custom rule, or a conftest policy) that fails CI if a `FROM` instruction is not digest-pinned. Tags are mutable: `FROM golang:1.27.1-alpine` may resolve to different images at different times. Digests are immutable.

**SBOM-driven incident response drill:** Run a tabletop exercise: announce "the widely-used `golang.org/x/net` package has a critical vulnerability." Time how long it takes to identify all affected services, rank them by exposure, and produce a remediation plan. The target time is under 30 minutes with SBOM infrastructure in place. Without SBOMs, the exercise will illustrate the gap. Use the drill results to justify SBOM investment.

---
