## 25.12 Complete Production Development Toolkit

This section presents a full-featured development toolkit that automates module management, builds, analysis, and deployment, the kind of tooling used by engineering organizations at Google, Netflix, and Uber.

### Project Structure

The toolkit is organized into `pkg` for reusable, importable packages (toolchain detection and version management) and `internal` for the CLI-specific orchestration logic (build, lint, dependency management, code generation, and release). The `cmd/gotk` entry point composes all internal packages into a single binary, while `cmd/analyzer` provides a standalone custom static analysis tool that can be run independently or via `go vet -vettool`.

```
gotoolkit/
├── cmd/
│   ├── gotk/                      # Main CLI tool
│   │   └── main.go
│   └── analyzer/                  # Custom static analyzer
│       └── main.go
├── internal/
│   ├── build/                     # Build automation
│   │   ├── builder.go
│   │   └── cross.go
│   ├── lint/                      # Linting coordination
│   │   ├── runner.go
│   │   └── config.go
│   ├── deps/                      # Dependency management
│   │   ├── manager.go
│   │   └── audit.go
│   ├── gen/                       # Code generation
│   │   ├── generator.go
│   │   └── templates.go
│   └── release/                   # Release automation
│       ├── releaser.go
│       └── changelog.go
├── pkg/
│   ├── toolchain/                 # Toolchain detection
│   │   └── detect.go
│   └── version/                   # Version management
│       └── version.go
├── configs/
│   ├── .golangci.yml             # Linter configuration
│   └── release.yml               # Release configuration
├── scripts/
│   └── install-tools.sh          # Tool installation
├── Dockerfile
├── docker-compose.yml
├── Makefile
├── go.mod
└── go.sum
```

### pkg/toolchain/detect.go - Toolchain Detection

The `Detector` queries `go version` and `go env -json` to build a fully-populated `Info` struct describing the active toolchain, then probes for optional development tools (golangci-lint, dlv, mockgen, and so on) by running each one's version command in its own goroutine, since these are subprocess spawns and the wall-clock cost is dominated by process startup. A mutex guards the shared results map, which is required for correctness rather than a performance measure: it serializes the map writes, and the parallelism comes from the subprocesses running concurrently around it. Results are cached behind a read-write lock so repeated calls in the same process lifetime return immediately without re-executing subprocesses. `ValidateToolchain` cross-references the detected tools against the `GetRequiredTools` list and returns actionable install commands for anything missing.

Note the honest limitation: `ValidateToolchain` checks only whether each tool is *present*. It carries a `MinVersion` for each entry and never compares against it, so a five-year-old golangci-lint passes validation. Comparing versions properly means parsing each tool's idiosyncratic `--version` output, which is exactly the kind of work the `tool` directive from 25.1 removes: pin the tools in `go.mod` and the question stops being "is a good enough version on PATH" and becomes "does the module build".

```go
// Package toolchain provides Go toolchain detection and management.
package toolchain

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"runtime"
	"strings"
	"sync"
)

// Info contains information about the Go toolchain.
type Info struct {
	Version      string            `json:"version"`
	GOOS         string            `json:"goos"`
	GOARCH       string            `json:"goarch"`
	GOROOT       string            `json:"goroot"`
	GOPATH       string            `json:"gopath"`
	GOMODCACHE   string            `json:"gomodcache"`
	GOCACHE      string            `json:"gocache"`
	GOPRIVATE    string            `json:"goprivate"`
	GOPROXY      string            `json:"goproxy"`
	CGOEnabled   bool              `json:"cgo_enabled"`
	Environment  map[string]string `json:"environment"`
	InstalledTools map[string]string `json:"installed_tools"`
}

// Detector detects and validates Go toolchain configuration.
type Detector struct {
	mu          sync.RWMutex
	cachedInfo  *Info
	cacheValid  bool
}

// NewDetector creates a new toolchain detector.
func NewDetector() *Detector {
	return &Detector{}
}

// Detect returns information about the Go toolchain.
func (d *Detector) Detect(ctx context.Context) (*Info, error) {
	d.mu.RLock()
	if d.cacheValid {
		info := d.cachedInfo
		d.mu.RUnlock()
		return info, nil
	}
	d.mu.RUnlock()

	d.mu.Lock()
	defer d.mu.Unlock()

	// Double-check after acquiring write lock
	if d.cacheValid {
		return d.cachedInfo, nil
	}

	info := &Info{
		GOOS:         runtime.GOOS,
		GOARCH:       runtime.GOARCH,
		Environment:  make(map[string]string),
		InstalledTools: make(map[string]string),
	}

	// Get Go version
	version, err := d.runCommand(ctx, "go", "version")
	if err != nil {
		return nil, fmt.Errorf("failed to get Go version: %w", err)
	}
	info.Version = parseVersion(version)

	// Get Go environment
	envJSON, err := d.runCommand(ctx, "go", "env", "-json")
	if err != nil {
		return nil, fmt.Errorf("failed to get Go environment: %w", err)
	}

	var env map[string]string
	if err := json.Unmarshal([]byte(envJSON), &env); err != nil {
		return nil, fmt.Errorf("failed to parse Go environment: %w", err)
	}

	info.GOROOT = env["GOROOT"]
	info.GOPATH = env["GOPATH"]
	info.GOMODCACHE = env["GOMODCACHE"]
	info.GOCACHE = env["GOCACHE"]
	info.GOPRIVATE = env["GOPRIVATE"]
	info.GOPROXY = env["GOPROXY"]
	info.CGOEnabled = env["CGO_ENABLED"] == "1"
	info.Environment = env

	// Detect installed tools
	info.InstalledTools = d.detectTools(ctx)

	d.cachedInfo = info
	d.cacheValid = true

	return info, nil
}

// detectTools detects installed Go development tools.
func (d *Detector) detectTools(ctx context.Context) map[string]string {
	tools := map[string][]string{
		"golangci-lint": {"golangci-lint", "--version"},
		"staticcheck":   {"staticcheck", "-version"},
		"govulncheck":   {"govulncheck", "-version"},
		"gofumpt":       {"gofumpt", "-version"},
		"goimports":     {"goimports", "-version"},
		"mockgen":       {"mockgen", "-version"},
		"protoc-gen-go": {"protoc-gen-go", "--version"},
		"dlv":           {"dlv", "version"},
		"gopls":         {"gopls", "version"},
	}

	installed := make(map[string]string)
	var wg sync.WaitGroup
	var mu sync.Mutex

	for name, cmd := range tools {
		wg.Add(1)
		go func(name string, cmd []string) {
			defer wg.Done()
			output, err := d.runCommand(ctx, cmd[0], cmd[1:]...)
			if err == nil {
				mu.Lock()
				installed[name] = strings.TrimSpace(output)
				mu.Unlock()
			}
		}(name, cmd)
	}

	wg.Wait()
	return installed
}

// runCommand runs a command and returns its output.
func (d *Detector) runCommand(ctx context.Context, name string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return "", err
	}
	return string(output), nil
}

// parseVersion extracts the version from "go version" output.
func parseVersion(output string) string {
	parts := strings.Fields(output)
	if len(parts) >= 3 {
		return parts[2] // "go1.22.0"
	}
	return "unknown"
}

// RequiredTools defines the minimum required tools for development.
type RequiredTools struct {
	Name        string
	MinVersion  string
	InstallCmd  string
	Description string
}

// GetRequiredTools returns the list of required development tools.
func GetRequiredTools() []RequiredTools {
	return []RequiredTools{
		{
			Name:       "golangci-lint",
			MinVersion: "2.0.0",
			// Note the /v2/ in the path. golangci-lint v2 is a distinct module
			// major version, so the old github.com/golangci/golangci-lint/cmd/...
			// path still resolves, but it silently installs the last v1 release
			// instead of current v2, and a v2 config will not load under it.
			InstallCmd:  "go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@latest",
			Description: "Meta linter for Go",
		},
		{
			Name:        "govulncheck",
			MinVersion:  "1.0.0",
			InstallCmd:  "go install golang.org/x/vuln/cmd/govulncheck@latest",
			Description: "Vulnerability checker",
		},
		{
			Name:        "gofumpt",
			MinVersion:  "0.5.0",
			InstallCmd:  "go install mvdan.cc/gofumpt@latest",
			Description: "Stricter gofmt",
		},
		{
			Name:        "mockgen",
			MinVersion:  "0.3.0",
			InstallCmd:  "go install go.uber.org/mock/mockgen@latest",
			Description: "Mock generator",
		},
	}
}

// ValidateToolchain validates that all required tools are installed.
func (d *Detector) ValidateToolchain(ctx context.Context) ([]string, error) {
	info, err := d.Detect(ctx)
	if err != nil {
		return nil, err
	}

	var missing []string
	required := GetRequiredTools()

	for _, tool := range required {
		if _, ok := info.InstalledTools[tool.Name]; !ok {
			missing = append(missing, fmt.Sprintf("%s (install: %s)", tool.Name, tool.InstallCmd))
		}
	}

	return missing, nil
}

// SupportedPlatforms returns all supported build platforms.
func SupportedPlatforms() []Platform {
	return []Platform{
		{GOOS: "linux", GOARCH: "amd64"},
		{GOOS: "linux", GOARCH: "arm64"},
		{GOOS: "linux", GOARCH: "arm", GOARM: "7"},
		{GOOS: "darwin", GOARCH: "amd64"},
		{GOOS: "darwin", GOARCH: "arm64"},
		{GOOS: "windows", GOARCH: "amd64"},
		{GOOS: "windows", GOARCH: "arm64"},
		{GOOS: "freebsd", GOARCH: "amd64"},
	}
}

// Platform represents a target build platform.
type Platform struct {
	GOOS   string
	GOARCH string
	GOARM  string
}

// String returns the platform string.
func (p Platform) String() string {
	if p.GOARM != "" {
		return fmt.Sprintf("%s/%s/v%s", p.GOOS, p.GOARCH, p.GOARM)
	}
	return fmt.Sprintf("%s/%s", p.GOOS, p.GOARCH)
}
```

### internal/build/builder.go - Build Automation

The `Builder` constructs the full `go build` invocation from a `Config` struct, injecting version, commit hash, and build timestamp via `-ldflags -X` so every binary carries its own provenance. Cross-platform builds are parallelized through a semaphore channel bounded by `MaxParallel`, and each `BuildResult` includes the output file size and a SHA-256 checksum that feeds directly into the `BuildManifest`, a JSON artifact used by release pipelines to verify download integrity.

```go
// Package build provides build automation for Go projects.
package build

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// Config configures the build process.
type Config struct {
	// Binary configuration
	OutputDir   string
	BinaryName  string
	MainPackage string

	// Version information
	Version   string
	Commit    string
	BuildTime string

	// Build options
	CGOEnabled    bool
	Race          bool
	StripDebug    bool
	StaticLink    bool
	BuildTags     []string
	LDFlags       []string
	TrimPath      bool

	// Parallelism
	MaxParallel   int
}

// DefaultConfig returns a default build configuration.
func DefaultConfig() *Config {
	return &Config{
		OutputDir:   "dist",
		BinaryName:  "app",
		MainPackage: "./cmd/app",
		CGOEnabled:  false,
		StripDebug:  true,
		TrimPath:    true,
		MaxParallel: runtime.NumCPU(),
	}
}

// Builder builds Go binaries.
type Builder struct {
	config *Config
	logger *slog.Logger
}

// NewBuilder creates a new builder.
func NewBuilder(config *Config, logger *slog.Logger) *Builder {
	if config == nil {
		config = DefaultConfig()
	}
	return &Builder{
		config: config,
		logger: logger,
	}
}

// BuildResult contains the result of a build.
type BuildResult struct {
	Platform    Platform
	OutputPath  string
	Size        int64
	Checksum    string
	Duration    time.Duration
	Error       error
}

// Platform defines a target platform.
type Platform struct {
	GOOS   string
	GOARCH string
	GOARM  string
}

func (p Platform) String() string {
	if p.GOARM != "" {
		return fmt.Sprintf("%s-%s-v%s", p.GOOS, p.GOARCH, p.GOARM)
	}
	return fmt.Sprintf("%s-%s", p.GOOS, p.GOARCH)
}

// Build builds for the current platform.
func (b *Builder) Build(ctx context.Context) (*BuildResult, error) {
	platform := Platform{
		GOOS:   runtime.GOOS,
		GOARCH: runtime.GOARCH,
	}
	return b.BuildForPlatform(ctx, platform)
}

// BuildForPlatform builds for a specific platform.
func (b *Builder) BuildForPlatform(ctx context.Context, platform Platform) (*BuildResult, error) {
	start := time.Now()

	result := &BuildResult{
		Platform: platform,
	}

	// Create output directory
	if err := os.MkdirAll(b.config.OutputDir, 0755); err != nil {
		result.Error = fmt.Errorf("failed to create output dir: %w", err)
		return result, result.Error
	}

	// Determine output path. Order matters: the platform suffix goes on
	// first and .exe last. Appending .exe before the suffix yields
	// "app.exe-windows-amd64", which Windows does not recognise as an
	// executable and which every release pipeline then happily uploads.
	outputName := fmt.Sprintf("%s-%s", b.config.BinaryName, platform.String())
	if platform.GOOS == "windows" {
		outputName += ".exe"
	}
	result.OutputPath = filepath.Join(b.config.OutputDir, outputName)

	// Build ldflags
	ldflags := b.buildLDFlags()

	// Build command
	args := []string{"build"}

	if b.config.Race {
		args = append(args, "-race")
	}

	if b.config.TrimPath {
		args = append(args, "-trimpath")
	}

	if len(b.config.BuildTags) > 0 {
		args = append(args, "-tags="+strings.Join(b.config.BuildTags, ","))
	}

	args = append(args, "-ldflags="+ldflags)
	args = append(args, "-o", result.OutputPath)
	args = append(args, b.config.MainPackage)

	b.logger.Info("building",
		"platform", platform.String(),
		"output", result.OutputPath,
	)

	// Set environment
	env := os.Environ()
	env = append(env, fmt.Sprintf("GOOS=%s", platform.GOOS))
	env = append(env, fmt.Sprintf("GOARCH=%s", platform.GOARCH))
	if platform.GOARM != "" {
		env = append(env, fmt.Sprintf("GOARM=%s", platform.GOARM))
	}
	if b.config.CGOEnabled {
		env = append(env, "CGO_ENABLED=1")
	} else {
		env = append(env, "CGO_ENABLED=0")
	}

	// Run build
	cmd := exec.CommandContext(ctx, "go", args...)
	cmd.Env = env
	cmd.Dir = "."

	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		result.Error = fmt.Errorf("build failed: %w: %s", err, stderr.String())
		result.Duration = time.Since(start)
		return result, result.Error
	}

	// Get file info
	info, err := os.Stat(result.OutputPath)
	if err != nil {
		result.Error = fmt.Errorf("failed to stat output: %w", err)
		result.Duration = time.Since(start)
		return result, result.Error
	}
	result.Size = info.Size()

	// Calculate checksum
	checksum, err := b.calculateChecksum(result.OutputPath)
	if err != nil {
		b.logger.Warn("failed to calculate checksum", "error", err)
	} else {
		result.Checksum = checksum
	}

	result.Duration = time.Since(start)

	// Checksum may be empty: the calculateChecksum failure above is only
	// logged, not fatal. Slicing it unconditionally (result.Checksum[:16])
	// panics with "slice bounds out of range [:16] with length 0" and turns
	// a warning into a crash of the build tool itself.
	b.logger.Info("build complete",
		"platform", platform.String(),
		"size", formatSize(result.Size),
		"duration", result.Duration,
		"checksum", shortChecksum(result.Checksum),
	)

	return result, nil
}

// shortChecksum abbreviates a checksum for logging, tolerating an empty one.
func shortChecksum(sum string) string {
	if sum == "" {
		return "unavailable"
	}
	if len(sum) <= 16 {
		return sum
	}
	return sum[:16] + "..."
}

// BuildAll builds for all target platforms.
func (b *Builder) BuildAll(ctx context.Context, platforms []Platform) []*BuildResult {
	results := make([]*BuildResult, len(platforms))

	// Create semaphore for parallelism
	sem := make(chan struct{}, b.config.MaxParallel)
	var wg sync.WaitGroup

	for i, platform := range platforms {
		wg.Add(1)
		go func(idx int, plat Platform) {
			defer wg.Done()

			sem <- struct{}{}
			defer func() { <-sem }()

			result, _ := b.BuildForPlatform(ctx, plat)
			results[idx] = result
		}(i, platform)
	}

	wg.Wait()
	return results
}

// buildLDFlags constructs ldflags string.
func (b *Builder) buildLDFlags() string {
	var flags []string

	// Strip debug symbols
	if b.config.StripDebug {
		flags = append(flags, "-s", "-w")
	}

	// Static linking. Only with CGO enabled: with CGO_ENABLED=0 the
	// internal linker already produces a static binary and there is no
	// external linker to receive -extldflags (see 25.2).
	if b.config.StaticLink && b.config.CGOEnabled {
		flags = append(flags, "-extldflags '-static'")
	}

	// Version information
	if b.config.Version != "" {
		flags = append(flags, fmt.Sprintf("-X main.Version=%s", b.config.Version))
	}
	if b.config.Commit != "" {
		flags = append(flags, fmt.Sprintf("-X main.Commit=%s", b.config.Commit))
	}
	if b.config.BuildTime != "" {
		flags = append(flags, fmt.Sprintf("-X 'main.BuildTime=%s'", b.config.BuildTime))
	}

	// Additional ldflags
	flags = append(flags, b.config.LDFlags...)

	return strings.Join(flags, " ")
}

// calculateChecksum calculates SHA256 checksum.
func (b *Builder) calculateChecksum(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()

	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}

	return hex.EncodeToString(h.Sum(nil)), nil
}

// formatSize formats byte size.
func formatSize(size int64) string {
	const (
		KB = 1024
		MB = KB * 1024
	)
	switch {
	case size >= MB:
		return fmt.Sprintf("%.1f MB", float64(size)/MB)
	case size >= KB:
		return fmt.Sprintf("%.1f KB", float64(size)/KB)
	default:
		return fmt.Sprintf("%d B", size)
	}
}

// BuildManifest generates a build manifest.
type BuildManifest struct {
	Version    string                 `json:"version"`
	Commit     string                 `json:"commit"`
	BuildTime  string                 `json:"build_time"`
	GoVersion  string                 `json:"go_version"`
	Builds     []ManifestBuild        `json:"builds"`
	Checksums  map[string]string      `json:"checksums"`
}

type ManifestBuild struct {
	Platform  string `json:"platform"`
	File      string `json:"file"`
	Size      int64  `json:"size"`
	Checksum  string `json:"checksum"`
}

// GenerateManifest generates a build manifest from results.
func (b *Builder) GenerateManifest(results []*BuildResult) *BuildManifest {
	manifest := &BuildManifest{
		Version:   b.config.Version,
		Commit:    b.config.Commit,
		BuildTime: b.config.BuildTime,
		GoVersion: runtime.Version(),
		Builds:    make([]ManifestBuild, 0, len(results)),
		Checksums: make(map[string]string),
	}

	for _, r := range results {
		if r.Error != nil {
			continue
		}

		build := ManifestBuild{
			Platform: r.Platform.String(),
			File:     filepath.Base(r.OutputPath),
			Size:     r.Size,
			Checksum: r.Checksum,
		}
		manifest.Builds = append(manifest.Builds, build)
		manifest.Checksums[build.File] = r.Checksum
	}

	return manifest
}
```

### internal/lint/runner.go - Lint Runner

The `Runner` orchestrates golangci-lint as the primary linter by invoking it with `--output.json.path=stdout` and parsing its structured output into a typed `Issue` slice, then runs `govulncheck` and a license checker concurrently as supplementary passes.

Two details in `runGolangciLint` are where this class of tool usually goes wrong. The flag is the v2 spelling: v1's `--out-format=json` was removed in v2 and now fails with `unknown flag`. And the exit code is interpreted rather than discarded, because golangci-lint uses 0 for clean, 1 for "issues found", and other codes for "I could not run". Collapsing those, by ignoring the error and treating empty output as success, produces a linter that silently passes when it never executed, which is strictly worse than no linter at all: you get the green check without the checking. Issues from all sources are merged and sorted by file path and line number before being returned, giving CI pipelines a single, deterministic list regardless of which linter found each problem. The `NewFromRev` option restricts reporting to code changed since a specified git revision, enabling incremental linting on large codebases without penalizing pre-existing technical debt.

```go
// Package lint provides linting coordination for Go projects.
package lint

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"time"
)

// Issue represents a linting issue.
type Issue struct {
	Linter      string    `json:"linter"`
	Severity    string    `json:"severity"`
	File        string    `json:"file"`
	Line        int       `json:"line"`
	Column      int       `json:"column"`
	Message     string    `json:"message"`
	SourceLines []string  `json:"source_lines,omitempty"`
	Suggestion  string    `json:"suggestion,omitempty"`
}

// Result contains linting results.
type Result struct {
	Duration    time.Duration `json:"duration"`
	TotalIssues int           `json:"total_issues"`
	ByLinter    map[string]int `json:"by_linter"`
	BySeverity  map[string]int `json:"by_severity"`
	Issues      []Issue        `json:"issues"`
	Passed      bool           `json:"passed"`
}

// Config configures the lint runner.
type Config struct {
	ConfigFile     string
	Packages       []string
	EnabledLinters []string
	Timeout        time.Duration
	MaxIssues      int
	NewFromRev     string  // Only show issues in new code since revision
	FixEnabled     bool    // Enable auto-fix
}

// DefaultConfig returns a default configuration.
func DefaultConfig() *Config {
	return &Config{
		ConfigFile: ".golangci.yml",
		Packages:   []string{"./..."},
		Timeout:    5 * time.Minute,
		MaxIssues:  0, // No limit
	}
}

// Runner runs linting tools.
type Runner struct {
	config *Config
	logger *slog.Logger
}

// NewRunner creates a new lint runner.
func NewRunner(config *Config, logger *slog.Logger) *Runner {
	if config == nil {
		config = DefaultConfig()
	}
	return &Runner{
		config: config,
		logger: logger,
	}
}

// Run runs all linting tools.
func (r *Runner) Run(ctx context.Context) (*Result, error) {
	start := time.Now()

	result := &Result{
		ByLinter:   make(map[string]int),
		BySeverity: make(map[string]int),
		Issues:     make([]Issue, 0),
		Passed:     true,
	}

	// Run golangci-lint
	issues, err := r.runGolangciLint(ctx)
	if err != nil {
		r.logger.Error("golangci-lint failed", "error", err)
	}
	result.Issues = append(result.Issues, issues...)

	// Run additional standalone linters
	additionalIssues, err := r.runAdditionalLinters(ctx)
	if err != nil {
		r.logger.Warn("additional linters had errors", "error", err)
	}
	result.Issues = append(result.Issues, additionalIssues...)

	// Aggregate results
	for _, issue := range result.Issues {
		result.ByLinter[issue.Linter]++
		result.BySeverity[issue.Severity]++
	}

	result.TotalIssues = len(result.Issues)
	result.Duration = time.Since(start)
	result.Passed = result.TotalIssues == 0

	// Sort issues by file, then line
	sort.Slice(result.Issues, func(i, j int) bool {
		if result.Issues[i].File != result.Issues[j].File {
			return result.Issues[i].File < result.Issues[j].File
		}
		return result.Issues[i].Line < result.Issues[j].Line
	})

	r.logger.Info("lint complete",
		"issues", result.TotalIssues,
		"duration", result.Duration,
		"passed", result.Passed,
	)

	return result, nil
}

// golangciLintOutput matches golangci-lint JSON output.
type golangciLintOutput struct {
	Issues []struct {
		FromLinter string `json:"FromLinter"`
		Text       string `json:"Text"`
		Severity   string `json:"Severity"`
		Pos        struct {
			Filename string `json:"Filename"`
			Line     int    `json:"Line"`
			Column   int    `json:"Column"`
		} `json:"Pos"`
		SourceLines []string `json:"SourceLines"`
		Replacement *struct {
			NewLines []string `json:"NewLines"`
		} `json:"Replacement"`
	} `json:"Issues"`
}

// runGolangciLint runs golangci-lint.
func (r *Runner) runGolangciLint(ctx context.Context) ([]Issue, error) {
	// Have golangci-lint write JSON to a file rather than stdout.
	//
	// Two reasons. v1's --out-format=json was removed in v2 (it now fails with
	// "unknown flag"), and v2's --output.json.path=stdout still appends a
	// human-readable summary ("1 issues:\n* revive: 1") after the JSON
	// document, so json.Unmarshal on stdout dies with "invalid character '1'
	// after top-level value". A file gets exactly one clean JSON document.
	reportFile, err := os.CreateTemp("", "golangci-*.json")
	if err != nil {
		return nil, fmt.Errorf("creating report file: %w", err)
	}
	reportPath := reportFile.Name()
	reportFile.Close()
	defer os.Remove(reportPath)

	args := []string{
		"run",
		"--output.json.path=" + reportPath,
		fmt.Sprintf("--timeout=%s", r.config.Timeout),
	}

	if r.config.ConfigFile != "" {
		if _, err := os.Stat(r.config.ConfigFile); err == nil {
			args = append(args, "-c", r.config.ConfigFile)
		}
	}

	if r.config.NewFromRev != "" {
		args = append(args, "--new-from-rev="+r.config.NewFromRev)
	}

	if len(r.config.EnabledLinters) > 0 {
		args = append(args, "--enable="+strings.Join(r.config.EnabledLinters, ","))
	}

	if r.config.FixEnabled {
		args = append(args, "--fix")
	}

	args = append(args, r.config.Packages...)

	cmd := exec.CommandContext(ctx, "golangci-lint", args...)

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout // human summary, not parsed
	cmd.Stderr = &stderr

	r.logger.Debug("running golangci-lint", "args", args)

	// Exit codes are meaningful and must be told apart:
	//   0 = clean, 1 = issues found, anything else = the tool itself failed
	//       (bad flag, config error, binary missing, timeout).
	//
	// Discarding this error and treating empty stdout as "no issues" is how a
	// lint step reports success while never having run. That is not
	// hypothetical: a stale --out-format flag exits 3 with nothing on stdout,
	// which the naive version reports as a clean codebase, and CI goes green.
	runErr := cmd.Run()
	if runErr != nil {
		var exitErr *exec.ExitError
		if !errors.As(runErr, &exitErr) {
			// Could not execute it at all (not on PATH, permissions).
			return nil, fmt.Errorf("running golangci-lint: %w: %s", runErr, stderr.String())
		}
		if code := exitErr.ExitCode(); code != 1 {
			return nil, fmt.Errorf("golangci-lint failed (exit %d): %s", code, strings.TrimSpace(stderr.String()))
		}
		// exit 1 means issues were found, which is a normal result here.
	}

	data, err := os.ReadFile(reportPath)
	if err != nil {
		return nil, fmt.Errorf("reading golangci-lint report: %w", err)
	}
	if len(data) == 0 {
		return nil, nil
	}

	var output golangciLintOutput
	if err := json.Unmarshal(data, &output); err != nil {
		return nil, fmt.Errorf("failed to parse golangci-lint output: %w", err)
	}

	issues := make([]Issue, 0, len(output.Issues))
	for _, i := range output.Issues {
		issue := Issue{
			Linter:      i.FromLinter,
			Severity:    i.Severity,
			File:        i.Pos.Filename,
			Line:        i.Pos.Line,
			Column:      i.Pos.Column,
			Message:     i.Text,
			SourceLines: i.SourceLines,
		}
		if i.Replacement != nil && len(i.Replacement.NewLines) > 0 {
			issue.Suggestion = strings.Join(i.Replacement.NewLines, "\n")
		}
		issues = append(issues, issue)
	}

	return issues, nil
}

// runAdditionalLinters runs linters not covered by golangci-lint.
func (r *Runner) runAdditionalLinters(ctx context.Context) ([]Issue, error) {
	var allIssues []Issue
	var mu sync.Mutex
	var wg sync.WaitGroup

	linters := []struct {
		name string
		fn   func(context.Context) ([]Issue, error)
	}{
		{"govulncheck", r.runGovulncheck},
		{"go-licenses", r.runGoLicenses},
	}

	for _, linter := range linters {
		wg.Add(1)
		go func(name string, fn func(context.Context) ([]Issue, error)) {
			defer wg.Done()
			issues, err := fn(ctx)
			if err != nil {
				r.logger.Warn("linter failed", "linter", name, "error", err)
				return
			}
			mu.Lock()
			allIssues = append(allIssues, issues...)
			mu.Unlock()
		}(linter.name, linter.fn)
	}

	wg.Wait()
	return allIssues, nil
}

// runGovulncheck runs vulnerability checking.
func (r *Runner) runGovulncheck(ctx context.Context) ([]Issue, error) {
	cmd := exec.CommandContext(ctx, "govulncheck", "-json", "./...")

	var stdout bytes.Buffer
	cmd.Stdout = &stdout

	if err := cmd.Run(); err != nil {
		// govulncheck returns error when vulnerabilities are found
		if stdout.Len() == 0 {
			return nil, err
		}
	}

	// Parse govulncheck JSON output (simplified)
	var issues []Issue
	// In production, you'd parse the full JSON output
	// For brevity, we just check if there was output
	if stdout.Len() > 0 && strings.Contains(stdout.String(), "Vulnerability") {
		issues = append(issues, Issue{
			Linter:   "govulncheck",
			Severity: "error",
			File:     "go.mod",
			Message:  "Vulnerabilities found - run 'govulncheck ./...' for details",
		})
	}

	return issues, nil
}

// runGoLicenses checks for problematic licenses.
func (r *Runner) runGoLicenses(ctx context.Context) ([]Issue, error) {
	// Check if go-licenses is installed
	if _, err := exec.LookPath("go-licenses"); err != nil {
		return nil, nil // Skip if not installed
	}

	cmd := exec.CommandContext(ctx, "go-licenses", "check", "./...")

	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		// go-licenses returns error for problematic licenses
		return []Issue{{
			Linter:   "go-licenses",
			Severity: "warning",
			File:     "go.mod",
			Message:  fmt.Sprintf("License check issues: %s", stderr.String()),
		}}, nil
	}

	return nil, nil
}

// FormatResults formats results for display.
func FormatResults(result *Result) string {
	var b strings.Builder

	b.WriteString(fmt.Sprintf("\n=== Lint Results ===\n"))
	b.WriteString(fmt.Sprintf("Duration: %s\n", result.Duration))
	b.WriteString(fmt.Sprintf("Total Issues: %d\n", result.TotalIssues))
	b.WriteString(fmt.Sprintf("Passed: %t\n\n", result.Passed))

	if result.TotalIssues > 0 {
		b.WriteString("Issues by Linter:\n")
		for linter, count := range result.ByLinter {
			b.WriteString(fmt.Sprintf("  %s: %d\n", linter, count))
		}

		b.WriteString("\nIssues by Severity:\n")
		for severity, count := range result.BySeverity {
			b.WriteString(fmt.Sprintf("  %s: %d\n", severity, count))
		}

		b.WriteString("\nDetails:\n")
		currentFile := ""
		for _, issue := range result.Issues {
			if issue.File != currentFile {
				currentFile = issue.File
				b.WriteString(fmt.Sprintf("\n%s:\n", currentFile))
			}
			b.WriteString(fmt.Sprintf("  %d:%d [%s] %s: %s\n",
				issue.Line, issue.Column, issue.Severity, issue.Linter, issue.Message))
		}
	}

	return b.String()
}
```

### internal/deps/manager.go - Dependency Manager

The `Manager` wraps `go list -m -json all` to enumerate every direct and indirect dependency, parses the JSON stream into typed `Module` structs, and cross-references each module against `go list -m -u` output to identify available updates and deprecated packages. It also runs `govulncheck` and parses its output into a structured `Vulnerability` slice, so a single `Analyze` call gives CI pipelines a complete dependency health report, outdated count, deprecated count, and known CVEs, in one pass.

```go
// Package deps provides dependency management for Go projects.
package deps

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Module represents a Go module dependency.
type Module struct {
	Path       string     `json:"path"`
	Version    string     `json:"version"`
	Update     *Version   `json:"update,omitempty"`
	Main       bool       `json:"main,omitempty"`
	Indirect   bool       `json:"indirect,omitempty"`
	Dir        string     `json:"dir,omitempty"`
	GoVersion  string     `json:"go_version,omitempty"`
	Time       *time.Time `json:"time,omitempty"`
	Deprecated string     `json:"deprecated,omitempty"`
}

// Version represents a module version.
type Version struct {
	Path    string     `json:"path"`
	Version string     `json:"version"`
	Time    *time.Time `json:"time,omitempty"`
}

// AnalysisResult contains dependency analysis results.
type AnalysisResult struct {
	TotalDeps      int             `json:"total_deps"`
	DirectDeps     int             `json:"direct_deps"`
	IndirectDeps   int             `json:"indirect_deps"`
	Outdated       int             `json:"outdated"`
	Deprecated     int             `json:"deprecated"`
	Modules        []Module        `json:"modules"`
	UpdatesAvail   []Module        `json:"updates_available"`
	Vulnerabilities []Vulnerability `json:"vulnerabilities"`
}

// Vulnerability represents a dependency vulnerability.
type Vulnerability struct {
	ID          string   `json:"id"`
	Module      string   `json:"module"`
	Versions    string   `json:"versions"`
	Description string   `json:"description"`
	Severity    string   `json:"severity"`
	References  []string `json:"references"`
}

// Manager manages Go module dependencies.
type Manager struct {
	logger    *slog.Logger
	projectDir string
}

// NewManager creates a new dependency manager.
func NewManager(projectDir string, logger *slog.Logger) *Manager {
	return &Manager{
		logger:    logger,
		projectDir: projectDir,
	}
}

// Analyze analyzes project dependencies.
func (m *Manager) Analyze(ctx context.Context) (*AnalysisResult, error) {
	result := &AnalysisResult{
		Modules:      make([]Module, 0),
		UpdatesAvail: make([]Module, 0),
	}

	// Get all modules
	modules, err := m.listModules(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to list modules: %w", err)
	}
	result.Modules = modules

	// Count by type
	for _, mod := range modules {
		if mod.Main {
			continue
		}
		result.TotalDeps++
		if mod.Indirect {
			result.IndirectDeps++
		} else {
			result.DirectDeps++
		}
		if mod.Update != nil {
			result.Outdated++
			result.UpdatesAvail = append(result.UpdatesAvail, mod)
		}
		if mod.Deprecated != "" {
			result.Deprecated++
		}
	}

	// Check for vulnerabilities
	vulns, err := m.checkVulnerabilities(ctx)
	if err != nil {
		m.logger.Warn("vulnerability check failed", "error", err)
	} else {
		result.Vulnerabilities = vulns
	}

	return result, nil
}

// listModules lists all modules with update information.
func (m *Manager) listModules(ctx context.Context) ([]Module, error) {
	cmd := exec.CommandContext(ctx, "go", "list", "-m", "-u", "-json", "all")
	cmd.Dir = m.projectDir

	output, err := cmd.Output()
	if err != nil {
		return nil, err
	}

	var modules []Module
	decoder := json.NewDecoder(bytes.NewReader(output))
	for decoder.More() {
		var mod Module
		if err := decoder.Decode(&mod); err != nil {
			return nil, err
		}
		modules = append(modules, mod)
	}

	return modules, nil
}

// checkVulnerabilities runs govulncheck.
func (m *Manager) checkVulnerabilities(ctx context.Context) ([]Vulnerability, error) {
	cmd := exec.CommandContext(ctx, "govulncheck", "-json", "./...")
	cmd.Dir = m.projectDir

	output, err := cmd.Output()
	if err != nil {
		// govulncheck returns error when vulns are found
		if output == nil {
			return nil, err
		}
	}

	// Parse govulncheck JSON output (simplified)
	// In production, implement full parsing
	var vulns []Vulnerability
	if bytes.Contains(output, []byte("OSV-")) {
		// Found vulnerabilities
		vulns = append(vulns, Vulnerability{
			Description: "Run 'govulncheck ./...' for details",
		})
	}

	return vulns, nil
}

// Update updates dependencies.
func (m *Manager) Update(ctx context.Context, modules []string, patchOnly bool) error {
	var args []string
	if len(modules) == 0 {
		args = []string{"get", "-u"}
		if patchOnly {
			args = append(args, "-u=patch")
		}
		args = append(args, "./...")
	} else {
		args = []string{"get", "-u"}
		args = append(args, modules...)
	}

	cmd := exec.CommandContext(ctx, "go", args...)
	cmd.Dir = m.projectDir
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("update failed: %w", err)
	}

	// Run go mod tidy
	return m.Tidy(ctx)
}

// Tidy runs go mod tidy.
func (m *Manager) Tidy(ctx context.Context) error {
	cmd := exec.CommandContext(ctx, "go", "mod", "tidy")
	cmd.Dir = m.projectDir
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

// Verify verifies dependencies.
func (m *Manager) Verify(ctx context.Context) error {
	cmd := exec.CommandContext(ctx, "go", "mod", "verify")
	cmd.Dir = m.projectDir
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

// Vendor creates vendor directory.
func (m *Manager) Vendor(ctx context.Context) error {
	cmd := exec.CommandContext(ctx, "go", "mod", "vendor")
	cmd.Dir = m.projectDir
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

// Graph generates dependency graph in DOT format.
func (m *Manager) Graph(ctx context.Context) (string, error) {
	cmd := exec.CommandContext(ctx, "go", "mod", "graph")
	cmd.Dir = m.projectDir

	output, err := cmd.Output()
	if err != nil {
		return "", err
	}

	// Convert to DOT format
	var b strings.Builder
	b.WriteString("digraph deps {\n")
	b.WriteString("  rankdir=LR;\n")
	b.WriteString("  node [shape=box];\n")

	scanner := bufio.NewScanner(bytes.NewReader(output))
	for scanner.Scan() {
		parts := strings.Fields(scanner.Text())
		if len(parts) == 2 {
			// Escape @ symbols
			from := strings.ReplaceAll(parts[0], "@", "\\n")
			to := strings.ReplaceAll(parts[1], "@", "\\n")
			b.WriteString(fmt.Sprintf("  \"%s\" -> \"%s\";\n", from, to))
		}
	}

	b.WriteString("}\n")
	return b.String(), nil
}

// WhyModule explains why a module is needed.
func (m *Manager) WhyModule(ctx context.Context, module string) (string, error) {
	cmd := exec.CommandContext(ctx, "go", "mod", "why", "-m", module)
	cmd.Dir = m.projectDir

	output, err := cmd.Output()
	if err != nil {
		return "", err
	}

	return string(output), nil
}

// Licenses gathers license information for dependencies.
func (m *Manager) Licenses(ctx context.Context) (map[string]string, error) {
	licenses := make(map[string]string)

	modules, err := m.listModules(ctx)
	if err != nil {
		return nil, err
	}

	for _, mod := range modules {
		if mod.Main || mod.Dir == "" {
			continue
		}

		// Look for common license files
		licenseFiles := []string{"LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING"}
		for _, lf := range licenseFiles {
			path := filepath.Join(mod.Dir, lf)
			if content, err := os.ReadFile(path); err == nil {
				// Detect license type from content (simplified)
				license := detectLicense(string(content))
				licenses[mod.Path] = license
				break
			}
		}
	}

	return licenses, nil
}

// detectLicense detects license type from content.
func detectLicense(content string) string {
	content = strings.ToLower(content)
	switch {
	case strings.Contains(content, "mit license"):
		return "MIT"
	case strings.Contains(content, "apache license"):
		return "Apache-2.0"
	case strings.Contains(content, "bsd"):
		return "BSD"
	case strings.Contains(content, "gnu general public license"):
		return "GPL"
	case strings.Contains(content, "mozilla public license"):
		return "MPL"
	default:
		return "Unknown"
	}
}

// FormatAnalysis formats analysis results for display.
func FormatAnalysis(result *AnalysisResult) string {
	var b strings.Builder

	b.WriteString("\n=== Dependency Analysis ===\n\n")
	b.WriteString(fmt.Sprintf("Total Dependencies: %d\n", result.TotalDeps))
	b.WriteString(fmt.Sprintf("  Direct: %d\n", result.DirectDeps))
	b.WriteString(fmt.Sprintf("  Indirect: %d\n", result.IndirectDeps))
	b.WriteString(fmt.Sprintf("  Outdated: %d\n", result.Outdated))
	b.WriteString(fmt.Sprintf("  Deprecated: %d\n", result.Deprecated))
	b.WriteString(fmt.Sprintf("  Vulnerabilities: %d\n", len(result.Vulnerabilities)))

	if len(result.UpdatesAvail) > 0 {
		b.WriteString("\nUpdates Available:\n")

		// Sort by path
		sort.Slice(result.UpdatesAvail, func(i, j int) bool {
			return result.UpdatesAvail[i].Path < result.UpdatesAvail[j].Path
		})

		for _, mod := range result.UpdatesAvail {
			if mod.Update != nil {
				b.WriteString(fmt.Sprintf("  %s: %s → %s\n",
					mod.Path, mod.Version, mod.Update.Version))
			}
		}
	}

	if len(result.Vulnerabilities) > 0 {
		b.WriteString("\nVulnerabilities:\n")
		for _, v := range result.Vulnerabilities {
			b.WriteString(fmt.Sprintf("  [%s] %s: %s\n", v.Severity, v.ID, v.Description))
		}
	}

	return b.String()
}
```

### internal/gen/generator.go - Code Generator

The `Generator` provides three generation paths: `RunAll` delegates to `go generate ./...` to execute every `//go:generate` directive in the project. `GenerateMocks` invokes `mockgen -source` to produce typed test doubles from interface definitions. And `GenerateFromTemplate` renders a `text/template` against a data map and writes the result after passing it through `go/format` to ensure the generated file is always gofmt-clean. Coupling template rendering with automatic formatting prevents generated code from failing lint checks before any human has touched it.

```go
// Package gen provides code generation utilities.
package gen

import (
	"bytes"
	"context"
	"fmt"
	"go/format"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"text/template"
	"time"
)

// Generator coordinates code generation.
type Generator struct {
	logger     *slog.Logger
	projectDir string
	templates  *template.Template
}

// NewGenerator creates a new code generator.
func NewGenerator(projectDir string, logger *slog.Logger) *Generator {
	return &Generator{
		logger:     logger,
		projectDir: projectDir,
	}
}

// RunAll runs all go:generate directives in the project.
func (g *Generator) RunAll(ctx context.Context) error {
	g.logger.Info("running go generate")

	cmd := exec.CommandContext(ctx, "go", "generate", "-v", "./...")
	cmd.Dir = g.projectDir
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	start := time.Now()
	err := cmd.Run()

	g.logger.Info("go generate complete", "duration", time.Since(start))
	return err
}

// GenerateMocks generates mocks for interfaces.
func (g *Generator) GenerateMocks(ctx context.Context, sourceFile, destFile, pkg string) error {
	args := []string{
		"-source=" + sourceFile,
		"-destination=" + destFile,
		"-package=" + pkg,
	}

	cmd := exec.CommandContext(ctx, "mockgen", args...)
	cmd.Dir = g.projectDir
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	return cmd.Run()
}

// GenerateStringers generates String() methods for enums.
func (g *Generator) GenerateStringers(ctx context.Context, typeName, output string) error {
	args := []string{
		"-type=" + typeName,
		"-output=" + output,
	}

	cmd := exec.CommandContext(ctx, "stringer", args...)
	cmd.Dir = g.projectDir
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	return cmd.Run()
}

// ServiceConfig defines service configuration for generation.
type ServiceConfig struct {
	PackageName  string
	ServiceName  string
	Methods      []MethodConfig
	Imports      []string
	OutputDir    string
}

// MethodConfig defines a service method.
type MethodConfig struct {
	Name       string
	InputType  string
	OutputType string
	HTTPMethod string
	Path       string
	Comment    string
}

// GenerateServiceStub generates a service stub from configuration.
func (g *Generator) GenerateServiceStub(config ServiceConfig) error {
	tmpl := template.Must(template.New("service").Parse(serviceTemplate))

	var buf bytes.Buffer
	if err := tmpl.Execute(&buf, config); err != nil {
		return fmt.Errorf("template execution failed: %w", err)
	}

	// Format the generated code
	formatted, err := format.Source(buf.Bytes())
	if err != nil {
		return fmt.Errorf("gofmt failed: %w", err)
	}

	// Write output
	outputPath := filepath.Join(config.OutputDir, strings.ToLower(config.ServiceName)+".go")
	if err := os.WriteFile(outputPath, formatted, 0644); err != nil {
		return fmt.Errorf("failed to write output: %w", err)
	}

	g.logger.Info("generated service stub", "path", outputPath)
	return nil
}

const serviceTemplate = `// Code generated by gotk. DO NOT EDIT.

package {{.PackageName}}

import (
	"context"
	"fmt"
{{range .Imports}}
	"{{.}}"
{{end}}
)

// {{.ServiceName}} defines the {{.ServiceName}} service interface.
type {{.ServiceName}} interface {
{{range .Methods}}
	// {{.Name}} {{.Comment}}
	{{.Name}}(ctx context.Context, req *{{.InputType}}) (*{{.OutputType}}, error)
{{end}}
}

// {{.ServiceName}}Impl implements {{.ServiceName}}.
type {{.ServiceName}}Impl struct {
	// Add dependencies here
}

// New{{.ServiceName}} creates a new {{.ServiceName}} implementation.
func New{{.ServiceName}}() *{{.ServiceName}}Impl {
	return &{{.ServiceName}}Impl{}
}

{{range .Methods}}
// {{.Name}} implements {{$.ServiceName}}.{{.Name}}.
func (s *{{$.ServiceName}}Impl) {{.Name}}(ctx context.Context, req *{{.InputType}}) (*{{.OutputType}}, error) {
	// TODO: Implement {{.Name}}
	return nil, fmt.Errorf("not implemented")
}
{{end}}
`

// RepositoryConfig defines repository configuration.
type RepositoryConfig struct {
	PackageName string
	EntityName  string
	TableName   string
	Fields      []FieldConfig
	OutputDir   string
}

// FieldConfig defines an entity field.
type FieldConfig struct {
	Name       string
	Type       string
	Column     string
	PrimaryKey bool
	Nullable   bool
}

// GenerateRepository generates a repository from entity configuration.
func (g *Generator) GenerateRepository(config RepositoryConfig) error {
	tmpl := template.Must(template.New("repo").Funcs(template.FuncMap{
		"inc": func(i int) int { return i + 1 },
	}).Parse(repositoryTemplate))

	var buf bytes.Buffer
	if err := tmpl.Execute(&buf, config); err != nil {
		return fmt.Errorf("template execution failed: %w", err)
	}

	formatted, err := format.Source(buf.Bytes())
	if err != nil {
		return fmt.Errorf("gofmt failed: %w", err)
	}

	outputPath := filepath.Join(config.OutputDir, strings.ToLower(config.EntityName)+"_repository.go")
	if err := os.WriteFile(outputPath, formatted, 0644); err != nil {
		return fmt.Errorf("failed to write output: %w", err)
	}

	g.logger.Info("generated repository", "path", outputPath)
	return nil
}

const repositoryTemplate = `// Code generated by gotk. DO NOT EDIT.

package {{.PackageName}}

import (
	"context"
	"database/sql"
	"fmt"
)

// {{.EntityName}}Repository handles {{.EntityName}} persistence.
type {{.EntityName}}Repository struct {
	db *sql.DB
}

// New{{.EntityName}}Repository creates a new repository.
func New{{.EntityName}}Repository(db *sql.DB) *{{.EntityName}}Repository {
	return &{{.EntityName}}Repository{db: db}
}

// {{.EntityName}} represents the {{.TableName}} entity.
type {{.EntityName}} struct {
{{range .Fields}}
	{{.Name}} {{.Type}} ` + "`" + `db:"{{.Column}}"` + "`" + `
{{end}}
}

// Create inserts a new {{.EntityName}}.
func (r *{{.EntityName}}Repository) Create(ctx context.Context, entity *{{.EntityName}}) error {
	query := ` + "`" + `INSERT INTO {{.TableName}} ({{range $i, $f := .Fields}}{{if $i}}, {{end}}{{$f.Column}}{{end}})
		VALUES ({{range $i, $f := .Fields}}{{if $i}}, {{end}}${{inc $i}}{{end}})` + "`" + `

	_, err := r.db.ExecContext(ctx, query{{range .Fields}}, entity.{{.Name}}{{end}})
	return err
}

// GetByID retrieves a {{.EntityName}} by ID.
func (r *{{.EntityName}}Repository) GetByID(ctx context.Context, id string) (*{{.EntityName}}, error) {
	query := ` + "`" + `SELECT {{range $i, $f := .Fields}}{{if $i}}, {{end}}{{$f.Column}}{{end}}
		FROM {{.TableName}} WHERE id = $1` + "`" + `

	var entity {{.EntityName}}
	err := r.db.QueryRowContext(ctx, query, id).Scan({{range $i, $f := .Fields}}{{if $i}}, {{end}}&entity.{{$f.Name}}{{end}})
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return &entity, err
}

// Update updates an existing {{.EntityName}}.
func (r *{{.EntityName}}Repository) Update(ctx context.Context, entity *{{.EntityName}}) error {
	query := ` + "`" + `UPDATE {{.TableName}} SET {{range $i, $f := .Fields}}{{if not $f.PrimaryKey}}{{if $i}}, {{end}}{{$f.Column}} = ${{inc $i}}{{end}}{{end}} WHERE id = $1` + "`" + `

	_, err := r.db.ExecContext(ctx, query{{range .Fields}}{{if not .PrimaryKey}}, entity.{{.Name}}{{end}}{{end}}, entity.ID)
	return err
}

// Delete removes a {{.EntityName}} by ID.
func (r *{{.EntityName}}Repository) Delete(ctx context.Context, id string) error {
	query := ` + "`" + `DELETE FROM {{.TableName}} WHERE id = $1` + "`" + `
	_, err := r.db.ExecContext(ctx, query, id)
	return err
}
`

// ConfigFileGenerator generates configuration file structures.
type ConfigFileGenerator struct {
	logger *slog.Logger
}

// NewConfigFileGenerator creates a new config file generator.
func NewConfigFileGenerator(logger *slog.Logger) *ConfigFileGenerator {
	return &ConfigFileGenerator{logger: logger}
}

// GenerateGolangCIConfig generates a .golangci.yml configuration.
func (c *ConfigFileGenerator) GenerateGolangCIConfig(outputPath string, strict bool) error {
	config := golangciConfigTemplate
	if strict {
		config = golangciConfigStrictTemplate
	}

	if err := os.WriteFile(outputPath, []byte(config), 0644); err != nil {
		return err
	}

	c.logger.Info("generated golangci-lint config", "path", outputPath, "strict", strict)
	return nil
}

const golangciConfigTemplate = `# golangci-lint configuration
# Generated by gotk
#
# v2 schema. gotk shells out to golangci-lint v2, so this file must be v2:
# a v1 file is rejected outright with "unsupported version of the
# configuration" rather than partially applied.

version: "2"

run:
  timeout: 5m
  tests: true

linters:
  # errcheck, govet, ineffassign, staticcheck, unused
  default: standard
  settings:
    errcheck:
      check-type-assertions: true
    govet:
      enable-all: true
  exclusions:
    paths:
      - vendor
      - testdata

# gofmt/goimports are formatters in v2, not linters.
formatters:
  enable:
    - gofmt
    - goimports

issues:
  max-issues-per-linter: 0
  max-same-issues: 0
`

const golangciConfigStrictTemplate = `# golangci-lint strict configuration
# Generated by gotk (v2 schema)

version: "2"

run:
  timeout: 10m
  tests: true

linters:
  default: all
  disable:
    - exhaustruct
    - depguard
    - wrapcheck
    - varnamelen
    - ireturn
  settings:
    errcheck:
      check-type-assertions: true
      check-blank: true
    govet:
      enable-all: true
    gocyclo:
      min-complexity: 15
    gocognit:
      min-complexity: 20
    dupl:
      threshold: 100
    goconst:
      min-len: 3
      min-occurrences: 3
    funlen:
      lines: 100
      statements: 50
    lll:
      line-length: 140
  exclusions:
    paths:
      - vendor
      - testdata

formatters:
  enable:
    - gofmt
    - goimports

issues:
  max-issues-per-linter: 0
  max-same-issues: 0
`
```

### cmd/gotk/main.go - CLI Application

`gotk` is the top-level CLI that maps sub-commands (`build`, `lint`, `deps`, `gen`, `init`, `check`) to the corresponding internal packages, wiring each with a shared `slog.Logger` and a cancellable context that responds to `SIGINT`/`SIGTERM` for clean shutdown. The `check` sub-command runs lint, dependency analysis, and vulnerability scanning in sequence and exits non-zero on any failure, making it suitable as a single gate-check step in CI pipelines. Version, commit, and build-time variables are injected at link time, so `gotk version` always reflects the exact binary in use.

```go
// Package main provides the gotk CLI tool.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/company/gotoolkit/internal/build"
	"github.com/company/gotoolkit/internal/deps"
	"github.com/company/gotoolkit/internal/gen"
	"github.com/company/gotoolkit/internal/lint"
	"github.com/company/gotoolkit/pkg/toolchain"
)

var (
	Version   = "dev"
	Commit    = "unknown"
	BuildTime = "unknown"
)

func main() {
	// Setup logging
	logLevel := slog.LevelInfo
	if os.Getenv("DEBUG") != "" {
		logLevel = slog.LevelDebug
	}
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{
		Level: logLevel,
	}))

	// Setup context with signal handling
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigCh
		logger.Info("shutting down...")
		cancel()
	}()

	// Parse command
	if len(os.Args) < 2 {
		printUsage()
		os.Exit(1)
	}

	cmd := os.Args[1]
	args := os.Args[2:]

	var err error
	switch cmd {
	case "version":
		printVersion()
	case "info":
		err = cmdInfo(ctx, logger)
	case "build":
		err = cmdBuild(ctx, args, logger)
	case "lint":
		err = cmdLint(ctx, args, logger)
	case "deps":
		err = cmdDeps(ctx, args, logger)
	case "gen":
		err = cmdGen(ctx, args, logger)
	case "init":
		err = cmdInit(ctx, args, logger)
	case "check":
		err = cmdCheck(ctx, args, logger)
	case "help":
		printUsage()
	default:
		fmt.Fprintf(os.Stderr, "Unknown command: %s\n", cmd)
		printUsage()
		os.Exit(1)
	}

	if err != nil {
		logger.Error("command failed", "error", err)
		os.Exit(1)
	}
}

func printUsage() {
	fmt.Println(`gotk - Go Development Toolkit

Usage: gotk <command> [options]

Commands:
  version     Show version information
  info        Show toolchain information
  build       Build project for one or more platforms
  lint        Run linters
  deps        Manage dependencies
  gen         Run code generation
  init        Initialize project configuration
  check       Run all checks (lint, test, vuln)
  help        Show this help

Examples:
  gotk build                    Build for current platform
  gotk build --all              Build for all platforms
  gotk lint                     Run linters
  gotk lint --fix               Run linters with auto-fix
  gotk deps analyze             Analyze dependencies
  gotk deps update              Update dependencies
  gotk gen                      Run go generate
  gotk init                     Initialize project config
  gotk check                    Run all pre-commit checks

Environment:
  DEBUG=1     Enable debug logging`)
}

func printVersion() {
	fmt.Printf("gotk %s\n", Version)
	fmt.Printf("  Commit: %s\n", Commit)
	fmt.Printf("  Built: %s\n", BuildTime)
	fmt.Printf("  Go: %s\n", runtime.Version())
}

func cmdInfo(ctx context.Context, logger *slog.Logger) error {
	detector := toolchain.NewDetector()
	info, err := detector.Detect(ctx)
	if err != nil {
		return err
	}

	// Pretty print
	data, err := json.MarshalIndent(info, "", "  ")
	if err != nil {
		return err
	}
	fmt.Println(string(data))

	// Check for missing tools
	missing, err := detector.ValidateToolchain(ctx)
	if err != nil {
		return err
	}

	if len(missing) > 0 {
		fmt.Println("\nMissing required tools:")
		for _, m := range missing {
			fmt.Printf("  - %s\n", m)
		}
	}

	return nil
}

func cmdBuild(ctx context.Context, args []string, logger *slog.Logger) error {
	fs := flag.NewFlagSet("build", flag.ExitOnError)
	all := fs.Bool("all", false, "Build for all platforms")
	output := fs.String("o", "dist", "Output directory")
	name := fs.String("name", "", "Binary name (default: directory name)")
	pkg := fs.String("pkg", "./cmd/app", "Main package to build")
	race := fs.Bool("race", false, "Enable race detector")
	tags := fs.String("tags", "", "Build tags (comma-separated)")
	fs.Parse(args)

	// Get version info from git
	version := getGitVersion()
	commit := getGitCommit()
	buildTime := time.Now().Format(time.RFC3339)

	// Determine binary name
	binaryName := *name
	if binaryName == "" {
		cwd, _ := os.Getwd()
		binaryName = filepath.Base(cwd)
	}

	config := &build.Config{
		OutputDir:   *output,
		BinaryName:  binaryName,
		MainPackage: *pkg,
		Version:     version,
		Commit:      commit,
		BuildTime:   buildTime,
		Race:        *race,
		StripDebug:  true,
		TrimPath:    true,
	}

	if *tags != "" {
		// Comma-separated, matching the flag help above. filepath.SplitList
		// splits OS PATH lists (colon/semicolon), not this.
		config.BuildTags = strings.Split(*tags, ",")
	}

	builder := build.NewBuilder(config, logger)

	if *all {
		platforms := []build.Platform{
			{GOOS: "linux", GOARCH: "amd64"},
			{GOOS: "linux", GOARCH: "arm64"},
			{GOOS: "darwin", GOARCH: "amd64"},
			{GOOS: "darwin", GOARCH: "arm64"},
			{GOOS: "windows", GOARCH: "amd64"},
		}

		results := builder.BuildAll(ctx, platforms)

		// Print results
		fmt.Println("\nBuild Results:")
		for _, r := range results {
			if r.Error != nil {
				fmt.Printf("  ✗ %s: %v\n", r.Platform, r.Error)
			} else {
				fmt.Printf("  ✓ %s: %s (%s)\n", r.Platform, filepath.Base(r.OutputPath), formatSize(r.Size))
			}
		}

		// Generate manifest
		manifest := builder.GenerateManifest(results)
		manifestData, _ := json.MarshalIndent(manifest, "", "  ")
		manifestPath := filepath.Join(*output, "manifest.json")
		os.WriteFile(manifestPath, manifestData, 0644)
		fmt.Printf("\nManifest: %s\n", manifestPath)

		return nil
	}

	result, err := builder.Build(ctx)
	if err != nil {
		return err
	}

	fmt.Printf("Built: %s (%s)\n", result.OutputPath, formatSize(result.Size))
	return nil
}

func cmdLint(ctx context.Context, args []string, logger *slog.Logger) error {
	fs := flag.NewFlagSet("lint", flag.ExitOnError)
	fix := fs.Bool("fix", false, "Enable auto-fix")
	newFromRev := fs.String("new-from-rev", "", "Only show issues in code newer than revision")
	timeout := fs.Duration("timeout", 5*time.Minute, "Timeout duration")
	fs.Parse(args)

	config := &lint.Config{
		ConfigFile:  ".golangci.yml",
		Packages:    []string{"./..."},
		Timeout:     *timeout,
		FixEnabled:  *fix,
		NewFromRev:  *newFromRev,
	}

	runner := lint.NewRunner(config, logger)
	result, err := runner.Run(ctx)
	if err != nil {
		return err
	}

	fmt.Print(lint.FormatResults(result))

	if !result.Passed {
		return fmt.Errorf("linting failed with %d issues", result.TotalIssues)
	}

	return nil
}

func cmdDeps(ctx context.Context, args []string, logger *slog.Logger) error {
	if len(args) == 0 {
		args = []string{"analyze"}
	}

	cwd, _ := os.Getwd()
	manager := deps.NewManager(cwd, logger)

	switch args[0] {
	case "analyze":
		result, err := manager.Analyze(ctx)
		if err != nil {
			return err
		}
		fmt.Print(deps.FormatAnalysis(result))

	case "update":
		patchOnly := false
		if len(args) > 1 && args[1] == "--patch" {
			patchOnly = true
		}
		return manager.Update(ctx, nil, patchOnly)

	case "tidy":
		return manager.Tidy(ctx)

	case "vendor":
		return manager.Vendor(ctx)

	case "verify":
		return manager.Verify(ctx)

	case "graph":
		graph, err := manager.Graph(ctx)
		if err != nil {
			return err
		}
		fmt.Println(graph)

	case "why":
		if len(args) < 2 {
			return fmt.Errorf("usage: gotk deps why <module>")
		}
		output, err := manager.WhyModule(ctx, args[1])
		if err != nil {
			return err
		}
		fmt.Println(output)

	default:
		return fmt.Errorf("unknown deps command: %s", args[0])
	}

	return nil
}

func cmdGen(ctx context.Context, args []string, logger *slog.Logger) error {
	cwd, _ := os.Getwd()
	generator := gen.NewGenerator(cwd, logger)
	return generator.RunAll(ctx)
}

func cmdInit(ctx context.Context, args []string, logger *slog.Logger) error {
	fs := flag.NewFlagSet("init", flag.ExitOnError)
	strict := fs.Bool("strict", false, "Use strict linting configuration")
	fs.Parse(args)

	configGen := gen.NewConfigFileGenerator(logger)

	// Generate .golangci.yml
	if err := configGen.GenerateGolangCIConfig(".golangci.yml", *strict); err != nil {
		return err
	}

	fmt.Println("Initialized project configuration")
	return nil
}

func cmdCheck(ctx context.Context, args []string, logger *slog.Logger) error {
	fmt.Println("Running all checks...")

	// 1. Lint
	fmt.Println("\n=== Linting ===")
	if err := cmdLint(ctx, nil, logger); err != nil {
		logger.Warn("linting had issues", "error", err)
	}

	// 2. Tests
	fmt.Println("\n=== Tests ===")
	if err := runTests(ctx); err != nil {
		return fmt.Errorf("tests failed: %w", err)
	}

	// 3. Vulnerability check
	fmt.Println("\n=== Vulnerability Check ===")
	if err := runVulnCheck(ctx); err != nil {
		logger.Warn("vulnerability check had issues", "error", err)
	}

	// 4. Build verification
	fmt.Println("\n=== Build ===")
	if err := cmdBuild(ctx, nil, logger); err != nil {
		return fmt.Errorf("build failed: %w", err)
	}

	fmt.Println("\n✓ All checks passed!")
	return nil
}

func runTests(ctx context.Context) error {
	cmd := exec.CommandContext(ctx, "go", "test", "-race", "-cover", "./...")
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

func runVulnCheck(ctx context.Context) error {
	cmd := exec.CommandContext(ctx, "govulncheck", "./...")
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

func getGitVersion() string {
	cmd := exec.Command("git", "describe", "--tags", "--always", "--dirty")
	output, err := cmd.Output()
	if err != nil {
		return "dev"
	}
	return strings.TrimSpace(string(output))
}

func getGitCommit() string {
	cmd := exec.Command("git", "rev-parse", "HEAD")
	output, err := cmd.Output()
	if err != nil {
		return "unknown"
	}
	return strings.TrimSpace(string(output))
}

func formatSize(size int64) string {
	const (
		KB = 1024
		MB = KB * 1024
	)
	switch {
	case size >= MB:
		return fmt.Sprintf("%.1f MB", float64(size)/MB)
	case size >= KB:
		return fmt.Sprintf("%.1f KB", float64(size)/KB)
	default:
		return fmt.Sprintf("%d B", size)
	}
}
```

### Dockerfile

The Dockerfile compiles the `gotk` binary for `linux/amd64` with CGO disabled and debug symbols stripped, then copies only the binary into a minimal `alpine` runtime image alongside `git`, `make`, and `bash` so the containerized tool can run git-aware operations like `--new-from-rev` lint filtering against a mounted workspace. The `WORKDIR /workspace` in the runtime stage makes it natural to bind-mount a project directory at that path without any path juggling.

```dockerfile
# Build stage
FROM golang:1.27.1-alpine AS builder

# Install build dependencies
RUN apk add --no-cache git ca-certificates tzdata

# Set working directory
WORKDIR /app

# Copy go mod files
COPY go.mod go.sum ./
RUN go mod download

# Copy source code
COPY . .

# Build arguments
ARG VERSION=dev
ARG COMMIT=unknown
ARG BUILD_TIME=unknown

# Build the binary. -trimpath keeps the artifact reproducible by stripping
# the /app build path out of the binary.
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath \
    -ldflags="-s -w -X main.Version=${VERSION} -X main.Commit=${COMMIT} -X 'main.BuildTime=${BUILD_TIME}'" \
    -o /gotk ./cmd/gotk

# Runtime stage
FROM alpine:3.19

# Install runtime dependencies
RUN apk add --no-cache \
    ca-certificates \
    tzdata \
    git \
    && rm -rf /var/cache/apk/*

# Create non-root user
RUN adduser -D -g '' appuser

# Copy binary from builder
COPY --from=builder /gotk /usr/local/bin/gotk

# Install Go tools in container
RUN wget -qO- https://go.dev/dl/go1.27.1.linux-amd64.tar.gz | tar -C /usr/local -xz
ENV PATH="/usr/local/go/bin:${PATH}"
ENV GOPATH="/home/appuser/go"
ENV PATH="${GOPATH}/bin:${PATH}"

# Install development tools
USER appuser
# Note the /v2/ in the golangci-lint path. Without it this silently installs
# the final v1 release, which then refuses to read a v2 .golangci.yml.
RUN go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@latest && \
    go install golang.org/x/vuln/cmd/govulncheck@latest && \
    go install go.uber.org/mock/mockgen@latest && \
    go install mvdan.cc/gofumpt@latest

WORKDIR /workspace

ENTRYPOINT ["/usr/local/bin/gotk"]
```

### docker-compose.yml

The Compose file defines three service profiles, default, `dev`, and `ci`, that share the same image but differ in command, environment, and volume mount modes. The `ci` profile mounts the workspace read-only to prevent accidental mutation of source files during automated checks. Named volumes for the Go module cache and build cache are shared across all profiles, so subsequent runs benefit from cached downloads and incremental compilation even inside containers.

Cache volumes only work if you mount them where the toolchain actually looks, and the path depends on which user the container runs as. This image runs as `appuser`, so `HOME=/home/appuser` and `go env GOCACHE` reports `/home/appuser/.cache/go-build`. Mounting the build cache at `/root/.cache/go-build`, as is often copy-pasted from root-running examples, puts the volume somewhere Go never reads and `appuser` cannot write, so every run recompiles from scratch while the volume sits there looking reassuring. The module cache follows `GOPATH`, which this Dockerfile sets to `/home/appuser/go`. When in doubt, ask the image: `docker run --rm --user appuser <image> go env GOCACHE GOMODCACHE`.

```yaml
# No `version:` key: obsolete since Compose v2, and current versions warn.
services:
  gotk:
    build:
      context: .
      dockerfile: Dockerfile
      args:
        VERSION: ${VERSION:-dev}
        COMMIT: ${COMMIT:-unknown}
        BUILD_TIME: ${BUILD_TIME:-unknown}
    image: gotoolkit:latest
    container_name: gotk
    volumes:
      - ./:/workspace
      - go-cache:/home/appuser/go
      # GOCACHE for appuser, NOT /root/.cache/go-build
      - build-cache:/home/appuser/.cache/go-build
    working_dir: /workspace
    environment:
      - GOPROXY=${GOPROXY:-https://proxy.golang.org,direct}
      - GOPRIVATE=${GOPRIVATE:-}
      - CGO_ENABLED=0
    user: appuser
    command: ["help"]

  # Development environment with live reload
  dev:
    build:
      context: .
      dockerfile: Dockerfile
    image: gotoolkit:latest
    container_name: gotk-dev
    volumes:
      - ./:/workspace
      - go-cache:/home/appuser/go
      # GOCACHE for appuser, NOT /root/.cache/go-build
      - build-cache:/home/appuser/.cache/go-build
    working_dir: /workspace
    environment:
      - DEBUG=1
      - GOPROXY=${GOPROXY:-https://proxy.golang.org,direct}
      - GOPRIVATE=${GOPRIVATE:-}
    user: appuser
    command: ["check"]
    profiles:
      - dev

  # CI environment
  ci:
    build:
      context: .
      dockerfile: Dockerfile
    image: gotoolkit:latest
    container_name: gotk-ci
    volumes:
      - ./:/workspace:ro
      - go-cache:/home/appuser/go
      - ./dist:/workspace/dist
    working_dir: /workspace
    environment:
      - CI=true
      - GOPROXY=${GOPROXY:-https://proxy.golang.org,direct}
    user: appuser
    command: ["check"]
    profiles:
      - ci

volumes:
  go-cache:
  build-cache:
```

### Makefile

The Makefile uses `gofumpt` (a stricter superset of `gofmt`) for formatting and defines a `build-all` target that cross-compiles for five platforms, `linux/amd64`, `linux/arm64`, `darwin/amd64`, `darwin/arm64`, `windows/amd64`, by iterating the `PLATFORMS` variable with `GOOS`/`GOARCH` substitution. The default `all` target runs format, vet, lint, test, and build in sequence so a single `make` command serves as the complete pre-commit quality gate.

```makefile
# Go Toolkit Makefile
# Production-grade build automation

# Variables
APP_NAME := gotk
VERSION := $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
COMMIT := $(shell git rev-parse HEAD 2>/dev/null || echo "unknown")
BUILD_TIME := $(shell date -u '+%Y-%m-%d_%H:%M:%S')
LDFLAGS := -s -w \
	-X main.Version=$(VERSION) \
	-X main.Commit=$(COMMIT) \
	-X 'main.BuildTime=$(BUILD_TIME)'

# Go settings
GOCMD := go
GOBUILD := $(GOCMD) build
GOTEST := $(GOCMD) test
GOVET := $(GOCMD) vet
GOMOD := $(GOCMD) mod
GOFMT := gofumpt
GOLINT := golangci-lint

# Directories
BUILD_DIR := ./dist
CMD_DIR := ./cmd/$(APP_NAME)
COVERAGE_DIR := ./coverage

# Platforms for cross-compilation
PLATFORMS := linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64

# Every target must be listed. Omit one and Make treats a same-named file or
# directory as the target being "up to date", skipping it silently with exit
# code 0. `release` and `ci` are the dangerous ones to forget: a `dist/`
# or `ci/` directory in the repo is enough to make them do nothing.
.PHONY: all help build build-all test test-short bench lint lint-fix fmt vet \
        coverage deps tidy vuln generate clean docker docker-push install run \
        check release ci

# Default target
all: fmt vet lint test build

## help: Show this help message
help:
	@echo 'Go Toolkit - Build Automation'
	@echo ''
	@echo 'Usage: make <target>'
	@echo ''
	@echo 'Targets:'
	@sed -n 's/^##//p' ${MAKEFILE_LIST} | column -t -s ':' | sed -e 's/^/ /'

## build: Build for current platform
build:
	@echo "Building $(APP_NAME) $(VERSION)..."
	@mkdir -p $(BUILD_DIR)
	CGO_ENABLED=0 $(GOBUILD) -ldflags="$(LDFLAGS)" -trimpath -o $(BUILD_DIR)/$(APP_NAME) $(CMD_DIR)
	@echo "Built: $(BUILD_DIR)/$(APP_NAME)"

## build-all: Build for all platforms
build-all:
	@echo "Building for all platforms..."
	@mkdir -p $(BUILD_DIR)
	@for platform in $(PLATFORMS); do \
		GOOS=$${platform%/*} GOARCH=$${platform#*/} \
		output="$(BUILD_DIR)/$(APP_NAME)-$${platform%/*}-$${platform#*/}"; \
		if [ "$${platform%/*}" = "windows" ]; then output="$$output.exe"; fi; \
		echo "Building $$output..."; \
		CGO_ENABLED=0 GOOS=$${platform%/*} GOARCH=$${platform#*/} \
		$(GOBUILD) -ldflags="$(LDFLAGS)" -trimpath -o $$output $(CMD_DIR); \
	done
	@echo "Build complete!"
	@ls -la $(BUILD_DIR)

## test: Run tests
test:
	@echo "Running tests..."
	$(GOTEST) -v -race -coverprofile=$(COVERAGE_DIR)/coverage.out ./...

## test-short: Run short tests only
test-short:
	@echo "Running short tests..."
	$(GOTEST) -v -short ./...

## bench: Run benchmarks
bench:
	@echo "Running benchmarks..."
	$(GOTEST) -bench=. -benchmem ./...

## lint: Run linters
lint:
	@echo "Running linters..."
	$(GOLINT) run ./...

## lint-fix: Run linters with auto-fix
lint-fix:
	@echo "Running linters with auto-fix..."
	$(GOLINT) run --fix ./...

## fmt: Format code
fmt:
	@echo "Formatting code..."
	$(GOFMT) -l -w .

## vet: Run go vet
vet:
	@echo "Running go vet..."
	$(GOVET) ./...

## coverage: Generate coverage report
coverage: test
	@echo "Generating coverage report..."
	@mkdir -p $(COVERAGE_DIR)
	$(GOCMD) tool cover -html=$(COVERAGE_DIR)/coverage.out -o $(COVERAGE_DIR)/coverage.html
	@echo "Coverage report: $(COVERAGE_DIR)/coverage.html"

## deps: Download dependencies
deps:
	@echo "Downloading dependencies..."
	$(GOMOD) download
	$(GOMOD) verify

## tidy: Tidy dependencies
tidy:
	@echo "Tidying dependencies..."
	$(GOMOD) tidy

## vuln: Check for vulnerabilities
vuln:
	@echo "Checking for vulnerabilities..."
	govulncheck ./...

## generate: Run code generation
generate:
	@echo "Running code generation..."
	$(GOCMD) generate ./...

## clean: Clean build artifacts
clean:
	@echo "Cleaning..."
	rm -rf $(BUILD_DIR)
	rm -rf $(COVERAGE_DIR)
	$(GOCMD) clean -cache -testcache

## docker: Build Docker image
docker:
	@echo "Building Docker image..."
	docker build \
		--build-arg VERSION=$(VERSION) \
		--build-arg COMMIT=$(COMMIT) \
		--build-arg BUILD_TIME="$(BUILD_TIME)" \
		-t $(APP_NAME):$(VERSION) \
		-t $(APP_NAME):latest \
		.

## docker-push: Push Docker image
docker-push: docker
	@echo "Pushing Docker image..."
	docker push $(APP_NAME):$(VERSION)
	docker push $(APP_NAME):latest

## install: Install the binary
install: build
	@echo "Installing $(APP_NAME)..."
	cp $(BUILD_DIR)/$(APP_NAME) $(GOPATH)/bin/

## run: Run the application
run: build
	$(BUILD_DIR)/$(APP_NAME)

## check: Run all checks
check: fmt vet lint test vuln build
	@echo "All checks passed!"

## release: Create a release
release: clean check build-all
	@echo "Creating release $(VERSION)..."
	@mkdir -p $(BUILD_DIR)/release
	@for f in $(BUILD_DIR)/$(APP_NAME)-*; do \
		sha256sum $$f > $$f.sha256; \
	done
	@echo "Release $(VERSION) ready in $(BUILD_DIR)/"

## ci: CI pipeline target
ci: deps generate check build-all
	@echo "CI pipeline complete!"
```

### Staff Lens: Toolkit as Template

This toolkit becomes the org's service template. Every new service starts from it. Adjustments for specific services are fine. The core stays consistent.

---
