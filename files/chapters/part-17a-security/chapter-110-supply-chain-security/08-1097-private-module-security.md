## 110.7 Private Module Security

### Go Module Proxy Configuration

Go module proxy configuration controls which proxy servers are consulted for module resolution and whether the checksum database is enforced, directly affecting supply chain security. The following environment configuration demonstrates how to route private module fetches through an internal proxy while using the public proxy for open-source dependencies.

```bash
# With an internal proxy: route all fetches through it first
export GOPROXY="https://proxy.yourcompany.com,https://proxy.golang.org,direct"

# Skip the public checksum database for private modules
# (they are never published to sum.golang.org)
export GONOSUMDB="github.com/yourcompany/*"

# Without an internal proxy: fetch private modules directly from VCS.
# GOPRIVATE implies both GONOPROXY and GONOSUMDB for the listed paths.
# export GOPRIVATE="github.com/yourcompany/*"
```

### Authentication for Private Modules

Go's module proxy protocol requires authentication when fetching from private repositories, and the `.netrc` file is the standard mechanism for storing credentials that `go get` and `go mod download` read automatically without code changes. Setting `GONOSUMDB` (or `GOPRIVATE`, which implies it) for private module paths bypasses the public checksum database for internal packages while still enforcing checksums for public dependencies. In CI environments, credentials should be sourced from secrets management rather than committed `.netrc` files, using `GOAUTH` or a credential helper script that the Go toolchain invokes per-request.

```bash
# Using .netrc for authentication
cat >> ~/.netrc << EOF
machine github.com
  login YOUR_GITHUB_USERNAME
  password YOUR_GITHUB_TOKEN
EOF

chmod 600 ~/.netrc

# Using Git config
git config --global url."https://${GITHUB_TOKEN}@github.com/".insteadOf "https://github.com/"
```

### Private Module Proxy Setup

A private module proxy puts an approval gate between the public module ecosystem and your builds. The setup below stands up the proxy and points the toolchain at it.
```go
// cmd/moduleproxy/main.go
package main

import (
	"crypto/subtle"
	"fmt"
	"log"
	"net/http"
	"os"

	"github.com/gorilla/mux"
)

func main() {
	r := mux.NewRouter()

	// Module proxy endpoints
	r.HandleFunc("/{module:.*}/@v/list", handleList)
	r.HandleFunc("/{module:.*}/@v/{version}.info", handleInfo)
	r.HandleFunc("/{module:.*}/@v/{version}.mod", handleMod)
	r.HandleFunc("/{module:.*}/@v/{version}.zip", handleZip)
	r.HandleFunc("/{module:.*}/@latest", handleLatest)

	port := getEnvOrDefault("PORT", "8080")
	log.Printf("Starting module proxy on :%s", port)
	log.Fatal(http.ListenAndServe(":"+port, authMiddleware(r)))
}

func authMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Check authentication token
		token := r.Header.Get("Authorization")
		if !isValidToken(token) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func isValidToken(token string) bool {
	expected := "Bearer " + os.Getenv("PROXY_AUTH_TOKEN")
	return token != "" &&
		subtle.ConstantTimeCompare([]byte(token), []byte(expected)) == 1
}

func handleList(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	log.Printf("listing versions for %s", vars["module"])

	// Implementation would list available versions
	fmt.Fprintf(w, "v1.0.0\nv1.0.1\nv1.1.0\n")
}

func handleInfo(w http.ResponseWriter, r *http.Request) {
	// Return version info as JSON
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprintf(w, `{"Version":"v1.0.0","Time":"2024-01-01T00:00:00Z"}`)
}

func handleMod(w http.ResponseWriter, r *http.Request) {
	// Return go.mod file
	w.Header().Set("Content-Type", "text/plain")
	fmt.Fprintf(w, "module example.com/private\n\ngo 1.27\n")
}

func handleZip(w http.ResponseWriter, r *http.Request) {
	// Return module zip file
	w.Header().Set("Content-Type", "application/zip")
	// Implementation would serve actual zip file
}

func handleLatest(w http.ResponseWriter, r *http.Request) {
	// Return latest version info
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprintf(w, `{"Version":"v1.1.0","Time":"2024-01-15T00:00:00Z"}`)
}

func getEnvOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
```

### Junior → FAANG: Private Module Security Basics

Go private modules introduce security considerations that public module users do not face: authentication to the private registry, preventing dependency confusion attacks, and ensuring the private module proxy does not leak module metadata to the public checksum database.

**Gap to close:** Know the `GOPRIVATE`, `GONOSUMDB`, and `GOSUMDB` environment variables. `GONOSUMDB` specifies which module paths should not be looked up in the public checksum database (`sum.golang.org`). Set it to your organization's module prefix: `GONOSUMDB=company.com`. `GOPRIVATE` is the umbrella variable that implies both `GONOPROXY` and `GONOSUMDB` for the listed paths. `GOSUMDB=off` disables checksum database verification entirely (use only in fully controlled environments). Set these in your build environment and document why each exclusion is necessary.

**Dependency confusion prevention:** Configure `GOPRIVATE=company.com/*` to tell the Go toolchain that these modules are private and should not be fetched from the public module proxy. Without this, the toolchain might attempt to fetch your private modules from `proxy.golang.org`, which will fail (they are not there) but also leaks your private module names to a third party.

**Interview framing:** When asked about private Go modules in a FAANG context, describe: GOPROXY configuration to direct private modules to your internal proxy (Athens or Artifactory), GOPRIVATE to prevent leaking module names to the public proxy, and authentication to the private proxy using machine credentials (not developer credentials) in CI.

### Senior @ FAANG: Private Module Infrastructure and Governance

At senior level, private module infrastructure is a platform service used by many teams. The infrastructure must be highly available, authenticated, and consistent with your organization's security posture.

**Private module proxy architecture:** Run an internal Go module proxy (Athens) backed by your artifact repository (Artifactory, Nexus) or cloud storage. The proxy caches approved module versions and provides a single point of control for module access. Configure the proxy to: require authentication, log all module fetch requests, and block known-vulnerable module versions (by consulting your vulnerability database and rejecting requests for affected versions).

**Module signing governance:** Require that all internal Go modules are signed with your organization's signing key before being published to the internal proxy. The signing step happens in your CI pipeline. The proxy rejects unsigned modules. This eliminates the possibility of a compromised internal module being published without going through the approved build and review process.

**Module access control:** Not all internal modules should be accessible to all services. Use the module proxy's access control to restrict which teams can import which modules. Core platform libraries are available to all teams. Internal service libraries are restricted to their intended consumers. This access control is enforced at the proxy level, not by convention, so it cannot be bypassed by editing go.mod.

---
