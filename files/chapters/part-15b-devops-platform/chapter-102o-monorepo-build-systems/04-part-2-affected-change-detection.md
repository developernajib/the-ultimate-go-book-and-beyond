## 102O.2 Affected Change Detection

One of the key benefits of monorepos is knowing exactly which services changed.

```go
// cmd/affected/main.go - detects which services are affected by git changes
package main

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// AffectedAnalyzer determines what needs to be built/tested based on git changes
type AffectedAnalyzer struct {
	rootDir     string
	servicesDirs []string
	sharedDirs  []string
}

func NewAffectedAnalyzer(rootDir string) *AffectedAnalyzer {
	return &AffectedAnalyzer{
		rootDir:      rootDir,
		servicesDirs: []string{"services"},
		sharedDirs:   []string{"shared", "pkg", "internal"},
	}
}

// ChangedFiles returns files changed since the given base commit/branch
func (a *AffectedAnalyzer) ChangedFiles(base string) ([]string, error) {
	cmd := exec.Command("git", "diff", "--name-only", base+"...HEAD")
	cmd.Dir = a.rootDir
	out, err := cmd.Output()
	if err != nil {
		// Try --name-only without ...HEAD for single commit
		cmd = exec.Command("git", "diff", "--name-only", base)
		cmd.Dir = a.rootDir
		out, err = cmd.Output()
		if err != nil {
			return nil, fmt.Errorf("git diff: %w", err)
		}
	}

	var files []string
	scanner := bufio.NewScanner(strings.NewReader(string(out)))
	for scanner.Scan() {
		if f := strings.TrimSpace(scanner.Text()); f != "" {
			files = append(files, f)
		}
	}
	return files, nil
}

// AffectedServices returns service directories that need to be rebuilt
func (a *AffectedAnalyzer) AffectedServices(changedFiles []string) []string {
	// Build a set of changed directories
	changedDirs := make(map[string]bool)
	for _, f := range changedFiles {
		parts := strings.Split(filepath.ToSlash(f), "/")
		for i := 1; i <= len(parts); i++ {
			changedDirs[strings.Join(parts[:i], "/")] = true
		}
	}

	// Check if any shared package changed
	sharedChanged := false
	for _, dir := range a.sharedDirs {
		for changed := range changedDirs {
			if strings.HasPrefix(changed, dir+"/") || changed == dir {
				sharedChanged = true
				break
			}
		}
		if sharedChanged {
			break
		}
	}

	// If shared packages changed, all services are affected
	if sharedChanged {
		return a.allServices()
	}

	// Otherwise, only directly changed services
	affected := make(map[string]bool)
	for _, serviceDir := range a.servicesDirs {
		entries, err := os.ReadDir(filepath.Join(a.rootDir, serviceDir))
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if !entry.IsDir() {
				continue
			}
			servicePath := serviceDir + "/" + entry.Name()
			for changed := range changedDirs {
				if strings.HasPrefix(changed, servicePath+"/") || changed == servicePath {
					affected[servicePath] = true
					break
				}
			}
		}
	}

	var result []string
	for dir := range affected {
		result = append(result, dir)
	}
	return result
}

func (a *AffectedAnalyzer) allServices() []string {
	var services []string
	for _, serviceDir := range a.servicesDirs {
		entries, err := os.ReadDir(filepath.Join(a.rootDir, serviceDir))
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if entry.IsDir() {
				services = append(services, serviceDir+"/"+entry.Name())
			}
		}
	}
	return services
}

func main() {
	base := "origin/main"
	if len(os.Args) > 1 {
		base = os.Args[1]
	}

	rootDir, err := os.Getwd()
	if err != nil {
		fmt.Fprintf(os.Stderr, "getwd: %v\n", err)
		os.Exit(1)
	}

	analyzer := NewAffectedAnalyzer(rootDir)

	changed, err := analyzer.ChangedFiles(base)
	if err != nil {
		fmt.Fprintf(os.Stderr, "changed files: %v\n", err)
		os.Exit(1)
	}

	affected := analyzer.AffectedServices(changed)

	if len(affected) == 0 {
		fmt.Println("No services affected")
		return
	}

	fmt.Println("Affected services:")
	for _, svc := range affected {
		fmt.Println(" ", svc)
	}

	// Output format for CI (GitHub Actions matrix)
	if os.Getenv("GITHUB_ACTIONS") == "true" {
		matrix := `{"include":[`
		for i, svc := range affected {
			if i > 0 {
				matrix += ","
			}
			matrix += fmt.Sprintf(`{"service":%q}`, svc)
		}
		matrix += `]}`
		fmt.Printf("::set-output name=matrix::%s\n", matrix)
	}
}
```

### Junior → FAANG: Why "Build Everything" Breaks at Scale

Imagine a monorepo with 40 services. If every PR triggers a full `go test ./...` across all 40, a one-line typo fix in `services/user-service` waits in a CI queue behind the combined test time of services it has no relation to. At 2 minutes per service that is 80 minutes of CI time for a 5-second change. Affected-change detection collapses this to 2 minutes by running only the impacted service.

The code in this section implements the simplest correct version of affected detection: if a shared package changes, all services rebuild (conservative). If only a service-local file changes, only that service rebuilds (precise). Understanding this conservative-vs-precise tradeoff is the first thing to grasp. The conservative fallback for shared code is intentional: you cannot safely skip a rebuild of a service that depends on a changed shared package.

For interviews, be ready to walk through the algorithm: "git diff to get changed files, check if any changed file lives under a shared directory, if yes rebuild everything, if no rebuild only the services whose directories appear in the diff."

### Senior @ FAANG: Building a Production-Grade Dependency Graph for Affected Analysis

The simple path-prefix approach in this section has a critical flaw at scale: it misses transitive dependencies. If `shared/auth` imports `shared/crypto`, and only `shared/crypto` changes, the prefix check will not flag `shared/auth` or any of its consumers as affected unless you also implement graph traversal. At Google, Meta, and Uber, affected analysis is backed by a full package dependency graph built from import resolution, not file paths.

Production affected analysis at FAANG has three additional concerns. First, correctness under build tags: a file behind `//go:build integration` is not in the normal build graph, so a change to it should not trigger the normal service rebuild. The graph must be tag-aware. Second, non-Go assets: a change to a protobuf definition in `proto/` must propagate to all services that depend on the generated Go code, even though the `.proto` file is not a Go source. The dependency graph must include generation edges. Third, false negatives are catastrophic: if affected analysis incorrectly excludes a service from a rebuild and that service has a latent bug introduced by the change, the bug ships silently. Production systems therefore maintain a "shadow mode" where the old affected analysis and the new one run in parallel and alert on divergence before the new version is promoted.

The maturity model for affected analysis: level 1 is path-prefix matching (this section), level 2 is package-level graph traversal using `go list -deps`, level 3 is Bazel's action graph query (`bazel query "rdeps(//..., //shared/auth:auth)"`), which includes generated code edges and build-tag filtering. Staff-level engineers own the decision of when to invest in each level transition and what the migration path looks like without breaking CI for the entire engineering organization.

### Junior → FAANG: Reading Affected Analysis Output and Trusting It

When you work in a monorepo that has affected-change detection, the most important early habit is understanding what the tool includes and excludes. Path-prefix matching is the simplest form: if you changed a file under `services/payments/`, only the payments service is rebuilt. That is correct for isolated changes. It breaks down when you modify something in `shared/` that everything imports.

Before opening a PR that touches a shared package, check the affected set manually. Most monorepos expose a command like `make affected` or `bazel query "rdeps(//..., //shared/auth:auth)"`. If the affected set is unexpectedly large, that is a signal your change has a wide blast radius and may need a phased rollout or a feature flag rather than a direct merge. First-job habit: never rely purely on CI to tell you the impact of a shared library change. Know the impact before you push.

Interview entry point: describe affected-change detection as a build-time optimization that queries the dependency graph to find the minimal set of targets that must rebuild after a given commit. Contrast path-prefix matching (fast, imprecise) with graph traversal (accurate, more expensive to compute).

### Senior @ FAANG: Correctness Guarantees and the Cost of False Negatives

At senior level, the engineering concern shifts from "how does it work" to "under what conditions does it fail, and what are the consequences." The two failure modes are false positives (rebuilding targets that did not need to change, wasting CI time) and false negatives (not rebuilding targets that did need to change, shipping broken code). False positives are annoying. False negatives are production incidents.

The sources of false negatives in Go monorepo affected analysis are well-documented. Build tags: a change behind `//go:build integration` may not be in the normal package graph but will be compiled in integration CI. Code generation: a `.proto` file change must propagate through the generation edge to all generated Go files and then to all services that import them. External configuration: a YAML config file read at startup that changes service behavior is invisible to the Go dependency graph entirely.

The production defense against false negatives at FAANG scale is multi-layered. First, a comprehensive build graph that includes generation edges (Bazel's `proto_library` and `go_proto_library` rules handle this natively). Second, a shadow-mode validation system: for a defined period after any change to the affected analysis algorithm, the old and new implementations run in parallel and alert the platform team when their outputs diverge. Third, a sampling-based full build: a fraction of PRs (say 5%) trigger a full `//...` build regardless of affected analysis output, and the results are compared against what affected analysis predicted. Divergence from sampling triggers an investigation, not just a notification.

Bar-raiser signal in system design interviews: when candidates describe affected-change detection, top performers include the failure mode analysis and the defense-in-depth strategy. Candidates who describe only the happy path are showing L4-level thinking. The L6 answer includes the correctness contract, the monitoring strategy, and the process for handling divergence.

---
