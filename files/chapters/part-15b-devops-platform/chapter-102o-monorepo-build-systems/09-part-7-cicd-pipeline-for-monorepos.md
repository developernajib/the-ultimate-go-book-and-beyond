## 102O.7 CI/CD Pipeline for Monorepos

### GitHub Actions Monorepo CI

A monorepo CI pipeline must determine which services were affected by a given commit and parallelize builds across only those services. The workflow below uses the affected-change detection tool from Part 2 to produce a JSON matrix of changed services, then fans out into parallel build-and-test jobs using GitHub Actions' `matrix` strategy. This reduces total CI time from O(number of all services) to O(critical path of affected services), making CI fast even as the monorepo grows to dozens or hundreds of services.

```yaml
# .github/workflows/ci.yml
name: Monorepo CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  detect-changes:
    name: Detect Changed Services
    runs-on: ubuntu-latest
    outputs:
      matrix: ${{ steps.affected.outputs.matrix }}
      has-changes: ${{ steps.affected.outputs.has-changes }}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0  # full history for diff

      - uses: actions/setup-go@v5
        with:
          go-version: '1.27'

      - name: Find affected services
        id: affected
        run: |
          MATRIX=$(go run ./cmd/affected --base=origin/main --format=github-matrix)
          echo "matrix=$MATRIX" >> $GITHUB_OUTPUT
          echo "has-changes=$(echo $MATRIX | jq '.include | length > 0')" >> $GITHUB_OUTPUT

  build-and-test:
    name: Build & Test ${{ matrix.service }}
    needs: detect-changes
    if: needs.detect-changes.outputs.has-changes == 'true'
    runs-on: ubuntu-latest
    strategy:
      matrix: ${{ fromJson(needs.detect-changes.outputs.matrix) }}
      fail-fast: false

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-go@v5
        with:
          go-version: '1.27'
          cache: true
          cache-dependency-path: '**/go.sum'

      - name: Run tests
        working-directory: ${{ matrix.service }}
        run: |
          go test -v -race -coverprofile=coverage.out ./...
          go tool cover -func=coverage.out | tail -1

      - name: Build
        working-directory: ${{ matrix.service }}
        run: |
          CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
          go build -ldflags="-s -w \
            -X main.Version=${{ github.sha }} \
            -X main.BuildTime=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
          -o bin/$(basename ${{ matrix.service }}) ./cmd/...

      - name: Upload artifacts
        uses: actions/upload-artifact@v4
        with:
          name: ${{ matrix.service }}-binary
          path: ${{ matrix.service }}/bin/

  lint:
    name: Lint
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: '1.27'
      - uses: golangci/golangci-lint-action@v4
        with:
          version: latest
          args: --timeout=5m

  security:
    name: Security Scan
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: '1.27'
      - name: govulncheck
        run: |
          go install golang.org/x/vuln/cmd/govulncheck@latest
          govulncheck ./...

  integration-tests:
    name: Integration Tests
    needs: build-and-test
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:18
        env:
          POSTGRES_DB: testdb
          POSTGRES_USER: test
          POSTGRES_PASSWORD: test
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: '1.27'
      - name: Run integration tests
        run: |
          go test -tags=integration -v ./...
        env:
          DATABASE_URL: postgres://test:test@localhost:5432/testdb
```

### Release Strategy

In a monorepo, each service can be released independently, so a single repository-wide version number is inadequate. The common patterns are calendar versioning (`YYYY.MM.DD-<sha>`), per-service semantic versioning tagged as `<service>/vX.Y.Z`, or plain Git SHAs for fully immutable references. Git tags scoped to a service path. For example `services/user-service/v1.4.2`. Allow `git log, services/user-service` to produce a clean, service-specific commit history from which automated changelog tools can extract meaningful release notes.

```go
// cmd/release/main.go - manages service releases in monorepo
package main

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

// Versioning strategy for monorepo services:
// Option 1: Calendar versioning (CalVer): 2024.03.14-abc1234
// Option 2: Semantic versioning per service: v1.2.3
// Option 3: Git SHA: abc1234 (simple, always unique)

// ServiceVersion generates a version string for a service
func ServiceVersion(service string) (string, error) {
	// Get git commit SHA
	shaOut, err := exec.Command("git", "rev-parse", "--short=8", "HEAD").Output()
	if err != nil {
		return "", fmt.Errorf("git rev-parse: %w", err)
	}
	sha := strings.TrimSpace(string(shaOut))

	// Check if working tree is clean
	statusOut, _ := exec.Command("git", "status", "--porcelain").Output()
	dirty := ""
	if len(strings.TrimSpace(string(statusOut))) > 0 {
		dirty = "-dirty"
	}

	// CalVer + SHA
	now := time.Now().UTC()
	version := fmt.Sprintf("%d.%02d.%02d-%s%s",
		now.Year(), now.Month(), now.Day(), sha, dirty)

	return version, nil
}

// TagService creates a git tag for a specific service release
func TagService(service, version string) error {
	tag := fmt.Sprintf("%s/v%s", service, version)
	msg := fmt.Sprintf("Release %s %s", service, version)

	if err := exec.Command("git", "tag", "-a", tag, "-m", msg).Run(); err != nil {
		return fmt.Errorf("git tag: %w", err)
	}

	if err := exec.Command("git", "push", "origin", tag).Run(); err != nil {
		return fmt.Errorf("git push tag: %w", err)
	}

	fmt.Printf("Tagged %s with %s\n", service, tag)
	return nil
}

// CHANGELOG generator
func GenerateChangelog(service, since string) (string, error) {
	tag := fmt.Sprintf("%s/%s", service, since)
	out, err := exec.Command("git", "log",
		"--oneline",
		"--no-merges",
		fmt.Sprintf("%s..HEAD", tag),
		"--", service,
	).Output()
	if err != nil {
		return "", fmt.Errorf("git log: %w", err)
	}

	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("## Changes since %s\n\n", since))
	for _, line := range lines {
		if line != "" {
			sb.WriteString("- " + line + "\n")
		}
	}
	return sb.String(), nil
}

func main() {
	if len(os.Args) < 2 {
		fmt.Println("usage: release <service-path>")
		os.Exit(1)
	}

	service := os.Args[1]
	version, err := ServiceVersion(service)
	if err != nil {
		fmt.Fprintf(os.Stderr, "version: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("Releasing %s version %s\n", service, version)
}
```

### Junior → FAANG: Reading CI Configuration as Architecture Documentation

The GitHub Actions workflow in this section is architecture documentation. It tells you: which jobs are required to merge, which jobs run in parallel versus serial, what the service deployment model is (matrix-based per-service), and what security checks are mandatory. Before modifying a CI pipeline, read its dependency graph (`needs:` keys) top to bottom to understand which jobs block which.

The matrix strategy in the `build-and-test` job is the key pattern here. The `detect-changes` job produces a JSON array of affected services. GitHub Actions expands that array into parallel jobs, one per service. This is the CI equivalent of affected-change detection from Part 2. Understanding this flow end-to-end is a common infrastructure interview question: "how does your CI system know which services to build on a given PR?"

For the release strategy section: CalVer versus SemVer is less important than the principle behind it, which is that each service must be identifiable by a unique, immutable version string that maps back to a specific git commit. Whether you use `2024.03.14-abc1234` or `v1.4.2` matters less than whether the version is deterministic and auditable.

### Senior @ FAANG: CI Pipeline as a Platform Product

A monorepo CI pipeline is a platform product with dozens or hundreds of teams as customers. When the pipeline is slow, every team's deployment cadence slows. When it is flaky, teams lose trust in CI and start merging without green builds. When it changes without notice, teams' PRs fail unexpectedly. All three of these are platform reliability failures, not individual team failures.

The operational discipline required: treat CI pipeline changes as production deployments with the same rigor. Changes to the core workflow YAML that affect all jobs require a canary period where the change runs on a subset of PRs before being applied universally. Maintain a CI health dashboard showing p50/p95 pipeline duration, flakiness rate by job, and cache hit rate over time. Alert on regressions in these metrics before engineers start complaining.

The release strategy question has a governance dimension that is often missed: who has the authority to release a service, and how is that enforced in the pipeline? A CI pipeline that allows any engineer to trigger a production deployment for any service is a security and compliance risk. At FAANG companies, deployment authorization is enforced at the CI layer: only engineers listed as owners of a service (via CODEOWNERS or an equivalent ownership registry) can approve the deployment step for that service. Implementing this authorization layer in the CI pipeline, rather than relying on human process, is the difference between a governance policy and a governance control.

---
