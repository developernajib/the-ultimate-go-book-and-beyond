## 25.16 Exercises with Solutions

### Exercise 1: Build a Multi-Platform Release Pipeline

**Task:** Create a complete release pipeline that builds for 5 platforms, generates checksums, and creates a GitHub release.

**Solution:**

This program builds all platforms in parallel using a semaphore to limit concurrency, computes SHA-256 checksums for each artifact, writes a JSON manifest for downstream verification, and optionally creates a GitHub release using the `gh` CLI when a token is available.

```go
// cmd/releaser/main.go
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
	"time"
)

type Platform struct {
	GOOS   string
	GOARCH string
}

type ReleaseConfig struct {
	Version     string
	MainPackage string
	OutputDir   string
	Platforms   []Platform
}

type ReleaseArtifact struct {
	Platform string `json:"platform"`
	Filename string `json:"filename"`
	Size     int64  `json:"size"`
	SHA256   string `json:"sha256"`
}

type ReleaseManifest struct {
	Version   string            `json:"version"`
	Commit    string            `json:"commit"`
	Timestamp string            `json:"timestamp"`
	GoVersion string            `json:"go_version"`
	Artifacts []ReleaseArtifact `json:"artifacts"`
}

func main() {
	ctx := context.Background()

	config := ReleaseConfig{
		Version:     getVersion(),
		MainPackage: "./cmd/app",
		OutputDir:   "dist",
		Platforms: []Platform{
			{GOOS: "linux", GOARCH: "amd64"},
			{GOOS: "linux", GOARCH: "arm64"},
			{GOOS: "darwin", GOARCH: "amd64"},
			{GOOS: "darwin", GOARCH: "arm64"},
			{GOOS: "windows", GOARCH: "amd64"},
		},
	}

	// Create output directory
	os.MkdirAll(config.OutputDir, 0755)

	// Build all platforms in parallel
	artifacts := buildAll(ctx, config)

	// Generate manifest
	manifest := ReleaseManifest{
		Version:   config.Version,
		Commit:    getCommit(),
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		GoVersion: runtime.Version(),
		Artifacts: artifacts,
	}

	// Write manifest
	manifestPath := filepath.Join(config.OutputDir, "manifest.json")
	data, _ := json.MarshalIndent(manifest, "", "  ")
	os.WriteFile(manifestPath, data, 0644)

	// Generate checksums file
	writeChecksums(config.OutputDir, artifacts)

	// Create GitHub release (if GITHUB_TOKEN is set)
	if os.Getenv("GITHUB_TOKEN") != "" {
		createGitHubRelease(ctx, config.Version, config.OutputDir)
	}

	fmt.Printf("\nRelease %s complete!\n", config.Version)
	fmt.Printf("Artifacts: %s\n", config.OutputDir)
}

func buildAll(ctx context.Context, config ReleaseConfig) []ReleaseArtifact {
	artifacts := make([]ReleaseArtifact, len(config.Platforms))
	var wg sync.WaitGroup
	sem := make(chan struct{}, runtime.NumCPU())

	for i, platform := range config.Platforms {
		wg.Add(1)
		go func(idx int, p Platform) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			artifact := buildPlatform(ctx, config, p)
			artifacts[idx] = artifact
		}(i, platform)
	}

	wg.Wait()
	return artifacts
}

func buildPlatform(ctx context.Context, config ReleaseConfig, p Platform) ReleaseArtifact {
	filename := fmt.Sprintf("app-%s-%s", p.GOOS, p.GOARCH)
	if p.GOOS == "windows" {
		filename += ".exe"
	}
	outputPath := filepath.Join(config.OutputDir, filename)

	ldflags := fmt.Sprintf("-s -w -X main.Version=%s -X main.Commit=%s",
		config.Version, getCommit())

	cmd := exec.CommandContext(ctx, "go", "build",
		"-ldflags", ldflags,
		"-trimpath",
		"-o", outputPath,
		config.MainPackage,
	)
	cmd.Env = append(os.Environ(),
		"GOOS="+p.GOOS,
		"GOARCH="+p.GOARCH,
		"CGO_ENABLED=0",
	)

	if err := cmd.Run(); err != nil {
		fmt.Printf("Build failed for %s/%s: %v\n", p.GOOS, p.GOARCH, err)
		return ReleaseArtifact{}
	}

	// Get file info
	info, _ := os.Stat(outputPath)
	checksum := calculateSHA256(outputPath)

	fmt.Printf("Built: %s (%d bytes)\n", filename, info.Size())

	return ReleaseArtifact{
		Platform: fmt.Sprintf("%s/%s", p.GOOS, p.GOARCH),
		Filename: filename,
		Size:     info.Size(),
		SHA256:   checksum,
	}
}

func calculateSHA256(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()

	h := sha256.New()
	io.Copy(h, f)
	return hex.EncodeToString(h.Sum(nil))
}

func writeChecksums(dir string, artifacts []ReleaseArtifact) {
	path := filepath.Join(dir, "SHA256SUMS")
	f, _ := os.Create(path)
	defer f.Close()

	for _, a := range artifacts {
		fmt.Fprintf(f, "%s  %s\n", a.SHA256, a.Filename)
	}
}

func createGitHubRelease(ctx context.Context, version, dir string) {
	// Use gh CLI to create release
	cmd := exec.CommandContext(ctx, "gh", "release", "create",
		version,
		"--title", "Release "+version,
		"--generate-notes",
		filepath.Join(dir, "*"),
	)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Run()
}

func getVersion() string {
	cmd := exec.Command("git", "describe", "--tags", "--always")
	out, err := cmd.Output()
	if err != nil {
		return "dev"
	}
	return string(out[:len(out)-1]) // trim newline
}

func getCommit() string {
	cmd := exec.Command("git", "rev-parse", "HEAD")
	out, err := cmd.Output()
	if err != nil {
		return "unknown"
	}
	return string(out[:len(out)-1])
}
```

### Exercise 2: Create a Custom golangci-lint Configuration

**Task:** Create a `.golangci.yml` that catches common bugs, enforces style, and runs efficiently in CI.

**Solution:**

```yaml
# .golangci.yml - Production-grade configuration (golangci-lint v2 schema)
#
# Verified with `golangci-lint config verify`. The v2 shape matters, because
# v2 rejects a v1 file outright rather than half-applying it:
#   - `version: "2"` is required. Without it v2 errors with
#     "unsupported version of the configuration".
#   - `linters.default: none` replaces v1's `disable-all: true`.
#   - gosimple and stylecheck no longer exist. Their checks moved inside
#     `staticcheck`, so listing them is an error rather than a no-op.
#   - gofmt and goimports are FORMATTERS now, not linters, and live in
#     their own top-level `formatters:` block.
#   - settings moved under `linters.settings` (was `linters-settings`).
#   - run.skip-dirs and run.skip-files became `linters.exclusions.paths`.
#
# Porting a v1 file: run `golangci-lint migrate`, then `config verify`.
version: "2"

run:
  timeout: 10m
  tests: true
  build-tags:
    - integration
  modules-download-mode: readonly

output:
  formats:
    text:
      path: stdout
      print-issued-lines: true
      print-linter-name: true
  sort-order:
    - file

linters:
  default: none
  enable:
    - errcheck
    - gosec
    - govet
    - staticcheck
    - bodyclose
    - nilerr
    - sqlclosecheck
    - ineffassign
    - unused
    - unconvert
    - unparam
    - prealloc
    - misspell
    - whitespace
    - gocyclo
    - gocognit
    - funlen
    - nestif
    - gocritic
    - revive
  settings:
    errcheck:
      check-type-assertions: true
      check-blank: true
      exclude-functions:
        - io.Copy
        - io.WriteString
        - (*bytes.Buffer).WriteString
    gosec:
      excludes:
        - G104
    gocyclo:
      min-complexity: 15
    gocognit:
      min-complexity: 25
    funlen:
      lines: 100
      statements: 60
    nestif:
      min-complexity: 5
    misspell:
      locale: US
    gocritic:
      enabled-tags:
        - diagnostic
        - style
        - performance
      disabled-checks:
        - hugeParam
        - rangeValCopy
    revive:
      rules:
        - name: blank-imports
        - name: context-as-argument
        - name: context-keys-type
        - name: error-return
        - name: exported
        - name: var-naming
  exclusions:
    paths:
      - vendor
      - testdata
      - examples
      - ".*_gen\\.go$"
      - ".*\\.pb\\.go$"

formatters:
  enable:
    - gofmt
    - goimports
  settings:
    goimports:
      local-prefixes:
        - github.com/mycompany
```

### Exercise 3: Implement Incremental Build Detection

**Task:** Build a tool that detects which packages need rebuilding based on file changes.

**Solution:**

This tool maintains a `.build-cache.json` file that records the SHA-256 hash of every Go source file in each package. On each run, it compares current file hashes against the cache, finds directly changed packages, walks the reverse dependency graph to find transitively affected packages, and rebuilds only those. This pattern mirrors what Uber and Google use internally to avoid full rebuilds in large repositories.

```go
// cmd/incremental/main.go
package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
)

// PackageState tracks the state of a package.
type PackageState struct {
	ImportPath string            `json:"import_path"`
	Dir        string            `json:"dir"`
	FileHashes map[string]string `json:"file_hashes"`
	Hash       string            `json:"hash"`
	Deps       []string          `json:"deps"`
}

// BuildCache stores package states.
type BuildCache struct {
	Packages map[string]PackageState `json:"packages"`
	Version  string                  `json:"version"`
}

func main() {
	cacheFile := ".build-cache.json"

	// Load existing cache
	cache := loadCache(cacheFile)

	// Get current package states
	current := getCurrentState()

	// Find changed packages
	changed := findChangedPackages(cache, current)

	// Find affected packages (dependents)
	affected := findAffectedPackages(changed, current)

	if len(affected) == 0 {
		fmt.Println("No packages need rebuilding")
		return
	}

	fmt.Printf("Packages requiring rebuild (%d):\n", len(affected))
	for _, pkg := range affected {
		fmt.Printf("  - %s\n", pkg)
	}

	// Build affected packages
	if err := buildPackages(affected); err != nil {
		fmt.Fprintf(os.Stderr, "Build failed: %v\n", err)
		os.Exit(1)
	}

	// Update cache
	cache.Packages = current
	saveCache(cacheFile, cache)

	fmt.Println("\nBuild complete!")
}

func getCurrentState() map[string]PackageState {
	// Get list of packages
	cmd := exec.Command("go", "list", "-json", "./...")
	output, err := cmd.Output()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to list packages: %v\n", err)
		os.Exit(1)
	}

	packages := make(map[string]PackageState)
	decoder := json.NewDecoder(bytes.NewReader(output))

	for decoder.More() {
		var pkg struct {
			ImportPath string   `json:"ImportPath"`
			Dir        string   `json:"Dir"`
			GoFiles    []string `json:"GoFiles"`
			Imports    []string `json:"Imports"`
		}
		if err := decoder.Decode(&pkg); err != nil {
			continue
		}

		state := PackageState{
			ImportPath: pkg.ImportPath,
			Dir:        pkg.Dir,
			FileHashes: make(map[string]string),
			Deps:       pkg.Imports,
		}

		// Hash all Go files
		for _, file := range pkg.GoFiles {
			path := filepath.Join(pkg.Dir, file)
			hash := hashFile(path)
			state.FileHashes[file] = hash
		}

		// Compute overall package hash
		state.Hash = computePackageHash(state)
		packages[pkg.ImportPath] = state
	}

	return packages
}

func hashFile(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()

	h := sha256.New()
	io.Copy(h, f)
	return hex.EncodeToString(h.Sum(nil))[:16]
}

func computePackageHash(state PackageState) string {
	// Sort file names for deterministic hash
	files := make([]string, 0, len(state.FileHashes))
	for f := range state.FileHashes {
		files = append(files, f)
	}
	slices.Sort(files)

	h := sha256.New()
	for _, f := range files {
		h.Write([]byte(f))
		h.Write([]byte(state.FileHashes[f]))
	}
	return hex.EncodeToString(h.Sum(nil))[:16]
}

func findChangedPackages(cache *BuildCache, current map[string]PackageState) []string {
	var changed []string

	for path, state := range current {
		cached, ok := cache.Packages[path]
		if !ok || cached.Hash != state.Hash {
			changed = append(changed, path)
		}
	}

	return changed
}

func findAffectedPackages(changed []string, packages map[string]PackageState) []string {
	// Build reverse dependency graph
	dependents := make(map[string][]string)
	for path, state := range packages {
		for _, dep := range state.Deps {
			dependents[dep] = append(dependents[dep], path)
		}
	}

	// Find all transitively affected packages
	affected := make(map[string]bool)
	var findAffected func(string)
	findAffected = func(pkg string) {
		if affected[pkg] {
			return
		}
		affected[pkg] = true
		for _, dep := range dependents[pkg] {
			findAffected(dep)
		}
	}

	for _, pkg := range changed {
		findAffected(pkg)
	}

	result := make([]string, 0, len(affected))
	for pkg := range affected {
		result = append(result, pkg)
	}
	slices.Sort(result)

	return result
}

func buildPackages(packages []string) error {
	args := append([]string{"build"}, packages...)
	cmd := exec.Command("go", args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

func loadCache(path string) *BuildCache {
	cache := &BuildCache{
		Packages: make(map[string]PackageState),
		Version:  "1",
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return cache
	}

	json.Unmarshal(data, cache)
	return cache
}

func saveCache(path string, cache *BuildCache) {
	data, _ := json.MarshalIndent(cache, "", "  ")
	os.WriteFile(path, data, 0644)
}
```

---

## Go Toolchain Pitfalls: Build and Dependency Disasters

The most damaging toolchain mistakes tend to be silent, builds succeed, tests pass, but the resulting binary is insecure, bloated, or non-portable. This section covers the pitfalls that cause real production incidents.

### The go.sum Catastrophe

Deleting `go.sum` because it looks like a generated file is a common instinct, and it is wrong. But be precise about why, because the scary version of this story ("your next build silently ships tampered code") is not what happens for public modules, and believing it teaches the wrong lesson.

Delete `go.sum` and rebuild, and the go command regenerates it, having verified each module against the checksum database at `sum.golang.org` (the `GOSUMDB` default). That database is an append-only transparency log: the hash was recorded when the version was first published, so a module tampered with afterwards fails verification even with no `go.sum` in your repo. For public dependencies the sumdb, not `go.sum`, is what stops the attack.

`go.sum` still matters, and here is what it actually buys you:

- **Private modules have no sumdb.** Anything matched by `GOPRIVATE` or `GONOSUMDB` is deliberately exempt from the checksum database, so for your own internal modules `go.sum` is the *only* integrity check. This is the case where deleting it genuinely does mean an unverified fetch.
- **It pins what you tested.** The sumdb says "this is the published module", `go.sum` says "this is the exact module this repo has been building against".
- **It works offline and in `GOFLAGS=-mod=mod` free-for-alls**, and it is what `-mod=readonly` (the default) enforces against.
- **It gives you a diff to review.** An unexpected `go.sum` change in a PR is a signal a human can catch.

So: commit it, review changes to it, and if a checksum mismatch appears, investigate rather than regenerate. A mismatch is loud and unmistakable:

```
verifying golang.org/x/sync@v0.22.0: checksum mismatch
	downloaded: h1:SZjpbeLmrCk4xhRSZFNZW5gFUeCeFgjekvI/+gfScek=
	go.sum:     h1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=

SECURITY ERROR
```

```bash
# CORRECT: go.sum is security-critical

# go.sum MUST be committed and never deleted
# It contains cryptographic checksums of exact dependency versions

# If you get checksum mismatch:
# DON'T just delete go.sum
# DO investigate why the checksum changed

# Clear cache and verify
go clean -modcache
go mod download
go mod verify  # This checks go.sum against downloaded modules
```

### The Replace Directive Leak

Local `replace` directives committed to the repository cause CI builds to fail, or worse, succeed using the wrong code when CI happens to have a matching directory layout.

```go
// go.mod - WRONG: Developer forgot to remove replace

module mycompany/service

go 1.27

require (
    mycompany/shared v1.5.0
    github.com/gin-gonic/gin v1.9.0
)

replace mycompany/shared => ../shared  // 🚨 Works locally, fails in CI
replace github.com/gin-gonic/gin => ./local-gin  // 🚨 Testing local changes
```

Go workspaces solve this cleanly. The `go.work` file stays local and goes into `.gitignore`, while `go.mod` remains publishable and CI-safe.

```bash
# CORRECT: Use go.work for local development

# go.work (add to .gitignore!)
go 1.27

use (
    ./service
    ./shared
    ./local-gin
)

# go.mod stays clean
# CI sees proper module versions
# Local development uses workspace
```

### The Binary Size Explosion

Default `go build` embeds the symbol table and DWARF debug information. Together these are usually worth a quarter to a third of the binary, not the order of magnitude that folklore suggests, and the only number that matters is the one you measure on your own binary.

```bash
# Default build includes symbol table and DWARF

go build -o myapp ./cmd/server

# A service pulling in net/http, database/sql, encoding/json and
# text/template measures ~9.1 MB here. Measure yours rather than
# trusting any ratio, including this one.
ls -l myapp
```

Stripping debug symbols with `-ldflags="-s -w"` and adding `-trimpath` (which removes local filesystem paths) produces a significantly smaller, more portable binary.

```bash
# CORRECT: Optimized production builds

# Strip debug info
go build -ldflags="-s -w" -o myapp ./cmd/server

# -s: Omit symbol table
# -w: Omit DWARF debugging info
# Measured on the service above: 9.1 MB -> 6.2 MB, about 32% smaller.

# Reproducible AND stripped, which is what you want for a release
go build -trimpath -ldflags="-s -w" -o myapp ./cmd/server

# Static binary: CGO_ENABLED=0 is the flag that does this. Note that
# adding -extldflags '-static' here does nothing, since no external
# linker runs when cgo is disabled.
CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o myapp ./cmd/server
```

Two things not to do. Do not reach for `upx`: it trades startup time and resident memory for disk you are not short of, and compressed binaries trip container scanners and antivirus heuristics. And do not strip DWARF if you depend on post-mortem core analysis (24.3), because `-w` is precisely what makes a core unreadable to Delve. Note that pprof profiles still symbolize from a stripped binary, since `pclntab` is not removed by `-s -w`, so profiling is not a reason to keep the debug info.

### The Cross-Compilation Surprise

Cross-compilation with `GOOS` and `GOARCH` works flawlessly for pure Go code, but CGO dependencies break it silently. The binary may build without errors yet link against the host platform's C libraries, causing crashes or subtle corruption on the target.

```bash
# WRONG: Assuming cross-compilation always works

GOOS=linux GOARCH=arm64 go build -o myapp-arm64 ./cmd/server

# If you have CGO dependencies, this either:
# 1. Fails to build
# 2. Builds but links wrong libraries
# 3. Builds but crashes on target platform
```

Explicitly setting `CGO_ENABLED=0` eliminates the problem for pure Go builds. When CGO is genuinely needed, build inside a container matching the target platform, or use Zig as a cross-compiler.

```bash
# CORRECT: Explicit CGO handling

# For pure Go (no CGO):
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -o myapp-arm64 ./cmd/server

# For CGO with cross-compilation:
# Use Docker for the target platform
docker run --rm -v "$PWD":/app -w /app golang:1.27.1 \
    go build -o myapp-linux ./cmd/server

# Or use zig as cross-compiler (recommended)
CGO_ENABLED=1 CC="zig cc -target aarch64-linux-gnu" \
    GOOS=linux GOARCH=arm64 go build -o myapp-arm64 ./cmd/server
```

### The Build Tag Trap

Mixing the legacy `// +build` syntax with the modern `//go:build` syntax in the same codebase creates subtle inclusion bugs. The two syntaxes have different operator semantics, a comma means AND in the old syntax but a space means OR, so a file can be included on platforms the author did not intend.

```go
// WRONG: Confusing build tag syntax

//go:build linux && amd64
// +build linux,amd64

// Two problems here. The legacy `// +build` line has to be kept in sync by
// hand with the `//go:build` line above it, and its operators read
// differently: in +build a comma is AND and a SPACE is OR, so
// `// +build linux,amd64` and `// +build linux amd64` mean opposite things.
// Drift between the two lines is silent.
//
// Note also that you cannot annotate the constraint inline. A trailing
// comment on the directive is not a comment at all, it is part of the
// expression, and the toolchain rejects the file:
//
//   //go:build linux && amd64  // linux AND amd64
//   => tagged.go: parsing //go:build line: invalid syntax at /
```

Standardize on `//go:build` (available since Go 1.17) and verify inclusion with `go list -f '{{.GoFiles}}'`.

```go
// CORRECT: Consistent build tag usage

// Use ONLY the new //go:build syntax (Go 1.17+)

//go:build linux && amd64
package main

// For multiple conditions:
//go:build (linux || darwin) && amd64

// For integration tests:
//go:build integration

// For production vs development:
//go:build !debug

// Verify with: go list -f '{{.GoFiles}}' ./...
```

### The Vulnerability Blindspot

Skipping vulnerability scanning means shipping binaries with known CVEs. Unlike language ecosystems where vulnerabilities are often in unused transitive dependencies, `govulncheck` performs call-graph analysis and only reports vulnerabilities in functions your code actually calls, making its output high-signal and worth gating CI on.

```bash
# WRONG: Never checking for vulnerabilities

go build ./...
go test ./...
# Ship it! (with CVEs included)
```

```bash
# CORRECT: Automated vulnerability scanning

# In CI/CD:
- name: Check for vulnerabilities
  run: |
    go install golang.org/x/vuln/cmd/govulncheck@latest
    govulncheck ./...

# In Makefile:
.PHONY: security
security:
	go install golang.org/x/vuln/cmd/govulncheck@latest
	govulncheck ./...
	go list -json -m all | nancy sleuth  # Also check with nancy

# Pre-commit hook:
#!/bin/bash
govulncheck ./...
if [ $? -ne 0 ]; then
    echo "Vulnerabilities found! Fix before committing."
    exit 1
fi
```

### Quick Reference: Toolchain Pitfalls

| Pitfall | Impact | Fix |
|---------|--------|-----|
| Delete go.sum | Security vulnerability | Never delete, verify changes |
| Commit replace | CI failures | Use go.work, add to .gitignore |
| Debug in prod binary | 100MB+ binaries | Use -ldflags="-s -w" |
| CGO cross-compile | Build failures, crashes | CGO_ENABLED=0 or Docker |
| Mixed build tags | Wrong code included | Use only //go:build |
| No vuln scanning | Ship CVEs | govulncheck in CI |

---

## Summary

The Go toolchain covers the full development lifecycle in a single binary. The key areas to master:

1. **Modules**: MVS algorithm, replace vs workspaces, private module configuration
2. **Build**: ldflags for metadata injection, build tags for conditional compilation, cross-compilation
3. **Analysis**: go vet for correctness, staticcheck for deeper bugs, golangci-lint for CI integration
4. **Testing**: Coverage profiling, race detection, fuzz testing
5. **Profiling**: pprof for CPU/memory, trace for goroutine scheduling, escape analysis for allocation
6. **Automation**: Makefiles as the single entry point for every developer and CI workflow

---

## Exercises

1. **Multi-Platform Build**: Create a build script that produces binaries for 5 platforms with version metadata injected via ldflags.

2. **Custom Linter Config**: Set up golangci-lint with 15+ linters, appropriate exclusion rules for test files, and a CI timeout.

3. **Module Management**: Set up a workspace with 3 related modules and shared dependencies, keeping go.mod files clean of replace directives.

4. **Vulnerability Scanning**: Integrate govulncheck into a CI/CD pipeline that blocks merges on high-severity findings.

5. **Build Optimization**: Reduce binary size with ldflags and trimpath, measuring before and after on your own binary. Do not use UPX (see the pitfalls section for why), and report the measured percentage rather than a target: the chapter's own example measured ~32%.

### Senior at FAANG Track

6. **golangci-lint configuration.** Build your team's shared config. Apply across all services. Measure violation reduction.

7. **govulncheck rollout.** Integrate into CI across all services. Document findings. Close critical vulnerabilities.

### Staff / Principal Track

8. **Service template.** Build the scaffold for new Go services: Makefile, linter config, CI pipeline, observability. Drive adoption.

9. **Supply chain security program.** Implement SBOM generation, vulnerability scanning, dependency approval process across the org.

10. **Toolchain training.** Workshop on toolchain mastery for senior engineers. Measure comprehension. Iterate.
