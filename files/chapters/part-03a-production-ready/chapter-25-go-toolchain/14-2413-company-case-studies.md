## 25.13 Company Case Studies

### Google: Hermetic Builds and Bazel Integration

Google's internal build system (the basis for Bazel) enforces hermetic builds: every input, toolchain version, dependency source, and build flag, is versioned and checksummed, so the same inputs always produce bit-identical outputs. The following example demonstrates this pattern in Go, with a sandboxed build process that verifies dependencies, checks a remote cache before compiling, and uploads results for future reuse.

```go
// Example: Google-style build configuration
// BUILD.bazel equivalent in Go

package build

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// HermeticBuild implements Google-style hermetic builds.
type HermeticBuild struct {
	// Fixed toolchain version
	GoVersion string
	// Pinned dependencies with checksums
	Dependencies map[string]DependencySpec
	// Build sandbox path
	SandboxPath string
	// Remote cache URL
	RemoteCacheURL string
}

// DependencySpec defines a hermetic dependency.
type DependencySpec struct {
	Module   string
	Version  string
	Checksum string // SHA256 of the module zip
}

// Build performs a hermetic build.
func (h *HermeticBuild) Build(ctx context.Context, target string) (*BuildArtifact, error) {
	// 1. Setup isolated sandbox
	sandbox, err := h.setupSandbox()
	if err != nil {
		return nil, fmt.Errorf("sandbox setup failed: %w", err)
	}
	defer os.RemoveAll(sandbox)

	// 2. Download and verify Go toolchain
	if err := h.installToolchain(ctx, sandbox); err != nil {
		return nil, fmt.Errorf("toolchain install failed: %w", err)
	}

	// 3. Download and verify all dependencies
	if err := h.downloadDependencies(ctx, sandbox); err != nil {
		return nil, fmt.Errorf("dependency download failed: %w", err)
	}

	// 4. Check remote cache for existing artifacts
	cacheKey := h.computeCacheKey(target)
	if artifact := h.checkRemoteCache(ctx, cacheKey); artifact != nil {
		return artifact, nil
	}

	// 5. Perform hermetic build
	artifact, err := h.performBuild(ctx, sandbox, target)
	if err != nil {
		return nil, err
	}

	// 6. Upload to remote cache
	if err := h.uploadToCache(ctx, cacheKey, artifact); err != nil {
		// Non-fatal - just log
		fmt.Printf("Warning: cache upload failed: %v\n", err)
	}

	return artifact, nil
}

// computeCacheKey generates a deterministic cache key.
func (h *HermeticBuild) computeCacheKey(target string) string {
	// Hash of: Go version + all dependency checksums + target + build flags
	hasher := sha256.New()
	hasher.Write([]byte(h.GoVersion))
	hasher.Write([]byte(target))

	for module, spec := range h.Dependencies {
		hasher.Write([]byte(module))
		hasher.Write([]byte(spec.Version))
		hasher.Write([]byte(spec.Checksum))
	}

	return hex.EncodeToString(hasher.Sum(nil))
}

// Google uses this pattern for billions of builds per day
// Key principles:
// 1. Every input is versioned and checksummed
// 2. Build outputs are cached by content hash
// 3. Builds run in isolated sandboxes
// 4. Results are reproducible across machines
```

**Google's Key Practices:**
- All builds are hermetic - same inputs produce identical outputs
- Remote build cache reduces redundant builds by 90%+
- Build configuration is stored as code (Bazel BUILD files)
- Toolchain versions are pinned globally
- All dependencies verified by checksum

### Netflix: CI/CD Pipeline Optimization

Netflix prioritizes fast feedback loops: quick checks (short tests and incremental linting on changed files only) run in parallel on every push, while full validation and vulnerability scanning gate the build stage. Canary deployments through Spinnaker ensure that even passing builds are rolled out gradually. The following GitHub Actions workflow illustrates this staged pipeline.

```yaml
# .github/workflows/netflix-style-ci.yml
name: Netflix-Style CI/CD

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

env:
  GO_VERSION: '1.27'
  GOPRIVATE: 'github.com/netflix/*'

jobs:
  # Fast feedback - runs in parallel
  quick-checks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Go with cache
        uses: actions/setup-go@v5
        with:
          go-version: ${{ env.GO_VERSION }}
          cache: true
          cache-dependency-path: go.sum

      - name: Quick lint (changed files only)
        run: |
          golangci-lint run --new-from-rev=HEAD~1 --timeout=2m

      - name: Unit tests (short mode)
        run: go test -short -race ./...

  # Full validation - runs after quick checks pass
  full-validation:
    needs: quick-checks
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Go
        uses: actions/setup-go@v5
        with:
          go-version: ${{ env.GO_VERSION }}
          cache: true

      - name: Full lint
        run: golangci-lint run --timeout=10m

      - name: Full test suite with coverage
        run: |
          go test -race -coverprofile=coverage.out -covermode=atomic ./...
          go tool cover -func=coverage.out

      - name: Vulnerability scan
        run: govulncheck ./...

      - name: Security scan
        uses: securecodewarrior/github-action-add-sarif@v1
        with:
          sarif-file: gosec-results.sarif
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

  # Build artifacts for deployment
  build:
    needs: full-validation
    runs-on: ubuntu-latest
    strategy:
      matrix:
        include:
          - goos: linux
            goarch: amd64
          - goos: linux
            goarch: arm64
    steps:
      - uses: actions/checkout@v4

      - name: Setup Go
        uses: actions/setup-go@v5
        with:
          go-version: ${{ env.GO_VERSION }}
          cache: true

      - name: Build binary
        env:
          GOOS: ${{ matrix.goos }}
          GOARCH: ${{ matrix.goarch }}
        run: |
          CGO_ENABLED=0 go build \
            -ldflags="-s -w -X main.Version=${{ github.sha }}" \
            -trimpath \
            -o dist/app-${{ matrix.goos }}-${{ matrix.goarch }} \
            ./cmd/server

      - name: Upload artifacts
        uses: actions/upload-artifact@v4
        with:
          name: binaries-${{ matrix.goos }}-${{ matrix.goarch }}
          path: dist/

  # Canary deployment
  deploy-canary:
    needs: build
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    environment: canary
    steps:
      - name: Download artifacts
        uses: actions/download-artifact@v4

      - name: Deploy to canary
        run: |
          # Netflix's Spinnaker integration
          curl -X POST "$SPINNAKER_URL/pipelines/v2/execute" \
            -H "Authorization: Bearer $SPINNAKER_TOKEN" \
            -d '{"application":"myapp","pipeline":"canary-deploy"}'
```

**Netflix's Key Practices:**
- Fast feedback loops with parallel quick checks
- Incremental linting on changed files only
- Strict test coverage requirements (>80%)
- Automated canary deployments
- Spinnaker integration for deployment orchestration

### Uber: Monorepo Tooling at Scale

Uber's monorepo contains thousands of Go services that share internal libraries. To avoid rebuilding everything on every commit, their tooling computes a dependency graph, identifies which services are affected by the changed files, topologically sorts them into parallelizable build levels, and compiles only what changed. This reduces CI wall-clock time by roughly 90% compared to a full rebuild.

```go
// Example: Uber-style monorepo build system

package monorepo

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
)

// MonorepoBuilder builds services in a monorepo.
type MonorepoBuilder struct {
	RootPath       string
	AffectedFinder *AffectedFinder
	BuildGraph     *DependencyGraph
	MaxParallel    int
}

// AffectedFinder finds services affected by changes.
type AffectedFinder struct {
	gitClient *GitClient
	depGraph  *DependencyGraph
}

// FindAffectedServices finds services affected by changes since baseRef.
func (a *AffectedFinder) FindAffectedServices(baseRef string) ([]string, error) {
	// Get changed files
	changedFiles, err := a.gitClient.ChangedFiles(baseRef)
	if err != nil {
		return nil, err
	}

	// Find directly affected packages
	affectedPkgs := make(map[string]bool)
	for _, file := range changedFiles {
		pkg := filepath.Dir(file)
		affectedPkgs[pkg] = true
	}

	// Find transitively affected services (dependents)
	affectedServices := make(map[string]bool)
	for pkg := range affectedPkgs {
		dependents := a.depGraph.GetDependents(pkg)
		for _, dep := range dependents {
			if a.isService(dep) {
				affectedServices[dep] = true
			}
		}
	}

	result := make([]string, 0, len(affectedServices))
	for svc := range affectedServices {
		result = append(result, svc)
	}

	return result, nil
}

// BuildAffected builds only affected services.
func (m *MonorepoBuilder) BuildAffected(ctx context.Context, baseRef string) error {
	affected, err := m.AffectedFinder.FindAffectedServices(baseRef)
	if err != nil {
		return fmt.Errorf("finding affected services: %w", err)
	}

	if len(affected) == 0 {
		fmt.Println("No services affected by changes")
		return nil
	}

	fmt.Printf("Building %d affected services: %v\n", len(affected), affected)

	// Build in parallel respecting dependencies
	return m.buildInOrder(ctx, affected)
}

// buildInOrder builds services respecting dependency order.
func (m *MonorepoBuilder) buildInOrder(ctx context.Context, services []string) error {
	// Topological sort based on dependencies
	buildOrder := m.BuildGraph.TopologicalSort(services)

	// Group into levels that can be built in parallel
	levels := m.groupByLevel(buildOrder)

	for i, level := range levels {
		fmt.Printf("Building level %d: %v\n", i, level)

		var wg sync.WaitGroup
		sem := make(chan struct{}, m.MaxParallel)
		errCh := make(chan error, len(level))

		for _, svc := range level {
			wg.Add(1)
			go func(service string) {
				defer wg.Done()
				sem <- struct{}{}
				defer func() { <-sem }()

				if err := m.buildService(ctx, service); err != nil {
					errCh <- fmt.Errorf("building %s: %w", service, err)
				}
			}(svc)
		}

		wg.Wait()
		close(errCh)

		for err := range errCh {
			return err // Fail fast on first error
		}
	}

	return nil
}

// Uber's approach enables:
// 1. Building only what changed
// 2. Parallel builds where possible
// 3. Correct ordering based on dependencies
// 4. Fast CI for large monorepos
```

**Uber's Key Practices:**
- Monorepo with 2000+ Go services
- Affected service detection reduces build times by 90%
- Dependency graph for correct build ordering
- Parallel builds within dependency levels
- Custom tooling for monorepo management

### Stripe: Security-First Toolchain

Stripe gates every deployment on a multi-layer security scan: `govulncheck` for known CVEs, `gitleaks` for accidentally committed secrets, `gosec` for SAST findings, and a license compliance checker for dependency audit. A composite risk score determines whether the pipeline proceeds or blocks, and any critical finding is a hard stop regardless of score.

```go
// Example: Stripe-style security scanning pipeline

package security

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
)

// SecurityScanner performs comprehensive security analysis.
type SecurityScanner struct {
	VulnCheck    *VulnerabilityChecker
	SecretScan   *SecretScanner
	SASTScanner  *SASTAnalyzer
	LicenseCheck *LicenseChecker
}

// ScanResult contains all security findings.
type ScanResult struct {
	Vulnerabilities []Vulnerability
	Secrets         []SecretFinding
	CodeIssues      []CodeIssue
	LicenseIssues   []LicenseIssue
	RiskScore       float64
	Passed          bool
}

// Scan performs comprehensive security scan.
func (s *SecurityScanner) Scan(ctx context.Context) (*ScanResult, error) {
	result := &ScanResult{
		Passed: true,
	}

	// 1. Vulnerability scan (govulncheck)
	vulns, err := s.VulnCheck.Scan(ctx)
	if err != nil {
		return nil, fmt.Errorf("vulnerability scan: %w", err)
	}
	result.Vulnerabilities = vulns
	if len(vulns) > 0 {
		result.Passed = false
	}

	// 2. Secret detection (gitleaks, etc.)
	secrets, err := s.SecretScan.Scan(ctx)
	if err != nil {
		return nil, fmt.Errorf("secret scan: %w", err)
	}
	result.Secrets = secrets
	if len(secrets) > 0 {
		result.Passed = false
	}

	// 3. SAST analysis (gosec)
	issues, err := s.SASTScanner.Scan(ctx)
	if err != nil {
		return nil, fmt.Errorf("SAST scan: %w", err)
	}
	result.CodeIssues = issues

	// Filter for high/critical issues
	criticalCount := 0
	for _, issue := range issues {
		if issue.Severity == "HIGH" || issue.Severity == "CRITICAL" {
			criticalCount++
		}
	}
	if criticalCount > 0 {
		result.Passed = false
	}

	// 4. License compliance check
	licenseIssues, err := s.LicenseCheck.Scan(ctx)
	if err != nil {
		return nil, fmt.Errorf("license scan: %w", err)
	}
	result.LicenseIssues = licenseIssues
	if len(licenseIssues) > 0 {
		result.Passed = false
	}

	// Calculate risk score
	result.RiskScore = s.calculateRiskScore(result)

	return result, nil
}

// SASTAnalyzer runs static application security testing.
type SASTAnalyzer struct{}

// Scan runs gosec and other SAST tools.
func (s *SASTAnalyzer) Scan(ctx context.Context) ([]CodeIssue, error) {
	// Run gosec
	cmd := exec.CommandContext(ctx, "gosec", "-fmt=json", "-quiet", "./...")
	output, _ := cmd.Output() // gosec returns non-zero when issues found

	var gosecOutput struct {
		Issues []struct {
			Severity   string `json:"severity"`
			Confidence string `json:"confidence"`
			RuleID     string `json:"rule_id"`
			Details    string `json:"details"`
			File       string `json:"file"`
			Line       string `json:"line"`
		} `json:"Issues"`
	}

	if err := json.Unmarshal(output, &gosecOutput); err != nil {
		return nil, err
	}

	issues := make([]CodeIssue, 0, len(gosecOutput.Issues))
	for _, i := range gosecOutput.Issues {
		issues = append(issues, CodeIssue{
			Severity:   i.Severity,
			RuleID:     i.RuleID,
			Message:    i.Details,
			File:       i.File,
			Line:       i.Line,
			Confidence: i.Confidence,
		})
	}

	return issues, nil
}

// Stripe's additional rules
var stripeSecurityRules = []string{
	"G101", // Hardcoded credentials
	"G102", // Bind to all interfaces
	"G103", // Audit use of unsafe
	"G104", // Audit errors not checked
	"G106", // SSH InsecureIgnoreHostKey
	"G107", // URL provided to HTTP request
	"G108", // Profiling endpoint
	"G109", // Integer overflow
	"G110", // Decompression bomb
	"G201", // SQL query construction
	"G202", // SQL string concatenation
	"G203", // Unescaped HTML templates
	"G204", // Command injection
	"G301", // Poor file permissions
	"G302", // File creation with chmod
	"G303", // Creating temp files with predicable path
	"G304", // File path provided as taint input
	"G305", // File path traversal
	"G306", // Poor file permissions on write
	"G307", // Deferring unsafe method
	"G401", // Use of weak crypto
	"G402", // TLS InsecureSkipVerify
	"G403", // RSA keys < 2048 bits
	"G404", // Use of weak random
	"G501", // Blacklisted import crypto/md5
	"G502", // Blacklisted import crypto/des
	"G503", // Blacklisted import crypto/rc4
	"G504", // Blacklisted import net/http/cgi
	"G505", // Blacklisted import crypto/sha1
	"G601", // Implicit memory aliasing
}
```

**Stripe's Key Practices:**
- Security scanning blocks all deployments
- Zero-tolerance for hardcoded credentials
- Full SAST coverage with gosec
- License compliance enforcement
- Risk scoring for prioritization

### Staff Lens: Supply Chain Security Is Mandatory

Every production Go service should run govulncheck and dependency scanning. CVEs in dependencies are the most common supply chain incident. Catching them at CI time is orders of magnitude cheaper than in production.

---
