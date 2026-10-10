## 110.4 Reproducible Builds

### Why Reproducible Builds?

Reproducible builds ensure that:
- Same source code always produces identical binaries
- Build output can be independently verified
- Supply chain attacks are detectable through hash comparison

### Achieving Reproducibility in Go

Achieving bit-for-bit reproducible Go builds requires eliminating all non-deterministic inputs: build timestamps, embedded file paths, and toolchain version drift. The following build configuration and verification workflow demonstrates how to produce and validate reproducible binaries using `go build` flags and hash comparison.

```bash
# Basic reproducible build
CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o app ./cmd/server

# With build info: use the commit timestamp, not the current time,
# or the embedded date changes on every build and breaks reproducibility
go build -trimpath \
  -ldflags="-X main.version=$(git describe --tags) \
            -X main.commit=$(git rev-parse HEAD) \
            -X main.date=$(git show -s --format=%cI HEAD)" \
  -o app ./cmd/server

# Verify reproducibility
sha256sum app
# Build again and compare hashes
```

### Build Script for Reproducibility

A reproducible build tool encapsulates all the environment controls and `go build` flags needed to produce a byte-identical binary from the same source and toolchain. The following Go program is suitable for use in CI pipelines and can be verified independently by any party with access to the source repository. Note that the embedded build time comes from the git commit, not the wall clock, so repeated builds of the same commit stay identical.

```go
// build/build.go
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

type BuildConfig struct {
	OS          string
	Arch        string
	OutputDir   string
	Version     string
	Commit      string
	BuildTime   string
	Trimpath    bool
	CGOEnabled  bool
}

func main() {
	config := BuildConfig{
		OS:         getEnvOrDefault("GOOS", runtime.GOOS),
		Arch:       getEnvOrDefault("GOARCH", runtime.GOARCH),
		OutputDir:  "dist",
		Version:    getGitTag(),
		Commit:     getGitCommit(),
		BuildTime:  getCommitTime(), // commit time, not wall clock, for reproducibility
		Trimpath:   true,
		CGOEnabled: false,
	}

	if err := build(config); err != nil {
		fmt.Fprintf(os.Stderr, "Build failed: %v\n", err)
		os.Exit(1)
	}
}

func build(cfg BuildConfig) error {
	// Create output directory
	if err := os.MkdirAll(cfg.OutputDir, 0755); err != nil {
		return err
	}

	outputPath := filepath.Join(cfg.OutputDir,
		fmt.Sprintf("app-%s-%s", cfg.OS, cfg.Arch))

	// Prepare build command
	args := []string{"build"}

	if cfg.Trimpath {
		args = append(args, "-trimpath")
	}

	// Add ldflags for version info, -buildid= keeps the build ID stable
	ldflags := fmt.Sprintf(
		"-s -w -buildid= -X main.version=%s -X main.commit=%s -X main.buildTime=%s",
		cfg.Version, cfg.Commit, cfg.BuildTime,
	)
	args = append(args, "-ldflags", ldflags)
	args = append(args, "-o", outputPath)
	args = append(args, "./cmd/server")

	// Set environment
	cmd := exec.Command("go", args...)
	cmd.Env = append(os.Environ(),
		fmt.Sprintf("GOOS=%s", cfg.OS),
		fmt.Sprintf("GOARCH=%s", cfg.Arch),
		fmt.Sprintf("CGO_ENABLED=%d", boolToInt(cfg.CGOEnabled)),
	)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	fmt.Printf("Building %s/%s...\n", cfg.OS, cfg.Arch)
	if err := cmd.Run(); err != nil {
		return err
	}

	// Generate checksum
	hash, err := generateChecksum(outputPath)
	if err != nil {
		return err
	}

	checksumPath := outputPath + ".sha256"
	if err := os.WriteFile(checksumPath, []byte(hash), 0644); err != nil {
		return err
	}

	fmt.Printf("✓ Built: %s\n", outputPath)
	fmt.Printf("  SHA256: %s\n", hash)

	return nil
}

func generateChecksum(path string) (string, error) {
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

func getGitTag() string {
	cmd := exec.Command("git", "describe", "--tags", "--always")
	output, err := cmd.Output()
	if err != nil {
		return "dev"
	}
	return string(output[:len(output)-1])
}

func getGitCommit() string {
	cmd := exec.Command("git", "rev-parse", "HEAD")
	output, err := cmd.Output()
	if err != nil {
		return "unknown"
	}
	return string(output[:len(output)-1])
}

func getCommitTime() string {
	cmd := exec.Command("git", "show", "-s", "--format=%cI", "HEAD")
	output, err := cmd.Output()
	if err != nil {
		return "unknown"
	}
	return string(output[:len(output)-1])
}

func getEnvOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
```

### Junior → FAANG: Reproducible Builds and Why Go Makes It Achievable

Go has better reproducible build properties than most languages because its build output is deterministic given the same source, module versions, and Go toolchain version. Understanding how to preserve and verify this property is a differentiating skill.

**Gap to close:** Know what breaks reproducibility: embedding build timestamps, embedding absolute build paths, cgo builds that depend on system library versions, and non-deterministic map iteration in code generation. Know how to strip timestamps (`-ldflags="-buildid="` and `SOURCE_DATE_EPOCH`) and verify reproducibility by building twice and comparing checksums.

**First-job habit:** When building a release binary, add `-trimpath` and `-ldflags="-s -w -buildid="` to your build command. `-trimpath` removes absolute file paths from the binary (paths depend on the build machine). `-s -w` strips debug symbols. `-buildid=` produces a consistent build ID. These flags are a production best practice and also improve reproducibility.

**Interview framing:** When asked about build security in Go, mention reproducible builds as a property you care about. Explain that reproducible builds let you verify that the binary you shipped was built from the stated source without any unauthorized modifications in the build pipeline. This is the technical foundation of supply chain integrity for compiled artifacts.

### Senior @ FAANG: Reproducible Builds as a Trust Mechanism

At senior level, reproducible builds are a mechanism for establishing trust in the software supply chain. They answer the question: "Is the binary that is running in production the binary that was built from the code in our repository?"

**Independent verification:** The value of reproducible builds is realized when a third party (a customer, a security researcher, a regulator) can independently build your software from the stated source and verify that their build matches the published artifact. This independent verification is not possible without reproducible builds. Organizations that ship security-critical software (security tools, cryptographic libraries) are increasingly expected to provide this guarantee.

**Build provenance and SLSA:** Reproducible builds combined with SLSA provenance provide a complete chain of custody from source code to production artifact. The provenance attests to the build environment, the source commit, the build inputs, and the output digest. A consumer can verify the provenance signature and then independently build from the stated source to confirm the result matches. This chain of custody is the highest level of supply chain assurance currently achievable.

**Infrastructure for reproducibility testing:** Build a CI job that builds the same binary twice in separate environments and compares the output hashes. If the hashes differ, the build is not reproducible and the job fails. This job runs on every release candidate. When reproducibility breaks (due to a new Go version, a new dependency, or a build configuration change), the job catches it before the release ships. Track reproducibility as a binary metric: is every release reproducible? A regression from 100% should trigger an investigation.

---
