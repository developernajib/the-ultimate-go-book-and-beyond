## 102O.5 Code Generation Pipeline

Code generation is ubiquitous in Go monorepos: protobuf compilation, mock generation with `mockery`, OpenAPI client generation, and `go generate` directives all need to run in the correct order before the build succeeds. A generation pipeline orchestrator walks the monorepo, discovers all `//go:generate` directives and `proto` files, runs generators in dependency order, and verifies that the committed generated files are up to date. Running this check in CI as a required status ensures that developers never accidentally commit stale generated code.

```go
// cmd/generate-all/main.go - runs go generate for all packages
package main

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
)

// GenerateRunner discovers and runs go:generate directives
type GenerateRunner struct {
	rootDir   string
	parallel  int
	dryRun    bool
	filter    string // only run generators matching this pattern
}

type GenerateTask struct {
	PackageDir string
	Directive  string
}

type GenerateResult struct {
	Task    GenerateTask
	Success bool
	Output  string
	Error   error
}

// DiscoverTasks finds all go:generate directives in the codebase
func (r *GenerateRunner) DiscoverTasks() ([]GenerateTask, error) {
	var tasks []GenerateTask
	var mu sync.Mutex

	err := filepath.Walk(r.rootDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			// Skip hidden dirs and vendor
			name := info.Name()
			if name == "vendor" || name == ".git" || strings.HasPrefix(name, ".") {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") {
			return nil
		}

		directives, err := extractGenerateDirectives(path)
		if err != nil {
			return nil
		}

		dir := filepath.Dir(path)
		for _, d := range directives {
			if r.filter == "" || strings.Contains(d, r.filter) {
				mu.Lock()
				tasks = append(tasks, GenerateTask{PackageDir: dir, Directive: d})
				mu.Unlock()
			}
		}
		return nil
	})

	return tasks, err
}

func extractGenerateDirectives(filename string) ([]string, error) {
	f, err := os.Open(filename)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	var directives []string
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "//go:generate ") {
			directive := strings.TrimPrefix(line, "//go:generate ")
			directives = append(directives, directive)
		}
	}
	return directives, scanner.Err()
}

// RunAll executes all discovered generate tasks
func (r *GenerateRunner) RunAll() []GenerateResult {
	tasks, err := r.DiscoverTasks()
	if err != nil {
		fmt.Fprintf(os.Stderr, "discover: %v\n", err)
		return nil
	}

	fmt.Printf("Found %d generate directives\n", len(tasks))
	if r.dryRun {
		for _, t := range tasks {
			fmt.Printf("  [%s] %s\n", t.PackageDir, t.Directive)
		}
		return nil
	}

	sem := make(chan struct{}, r.parallel)
	var wg sync.WaitGroup
	results := make([]GenerateResult, len(tasks))

	for i, task := range tasks {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int, task GenerateTask) {
			defer wg.Done()
			defer func() { <-sem }()
			results[i] = r.runTask(task)
		}(i, task)
	}

	wg.Wait()
	return results
}

func (r *GenerateRunner) runTask(task GenerateTask) GenerateResult {
	// Parse directive into command and args
	parts := strings.Fields(task.Directive)
	if len(parts) == 0 {
		return GenerateResult{Task: task, Success: false, Error: fmt.Errorf("empty directive")}
	}

	cmd := exec.Command(parts[0], parts[1:]...)
	cmd.Dir = task.PackageDir
	cmd.Env = append(os.Environ(),
		"GOFILE=",
		"GOLINE=0",
		"GOPACKAGE=",
		"GOROOT="+os.Getenv("GOROOT"),
	)

	out, err := cmd.CombinedOutput()
	if err != nil {
		return GenerateResult{
			Task:    task,
			Success: false,
			Error:   fmt.Errorf("generate failed: %w", err),
			Output:  string(out),
		}
	}

	return GenerateResult{Task: task, Success: true, Output: string(out)}
}

func main() {
	rootDir, _ := os.Getwd()
	runner := &GenerateRunner{
		rootDir:  rootDir,
		parallel: 4,
		dryRun:   len(os.Args) > 1 && os.Args[1] == "--dry-run",
	}

	results := runner.RunAll()

	failed := 0
	for _, r := range results {
		if !r.Success {
			failed++
			fmt.Printf("✗ [%s] %s\n  %v\n", r.Task.PackageDir, r.Task.Directive, r.Error)
		}
	}

	if failed > 0 {
		fmt.Printf("\n%d generate tasks failed\n", failed)
		os.Exit(1)
	}
	fmt.Printf("\nAll %d generate tasks succeeded\n", len(results))
}
```

### Junior → FAANG: The Golden Rule of Code Generation

The golden rule of code generation in a monorepo: check in the generated files and verify in CI that regenerating them produces no diff. This is non-negotiable. If generated files are not checked in, two bad things happen. First, code review becomes dishonest because reviewers see the generator invocation but not what it actually produces. Second, `git bisect` becomes unusable because a bisect checkout does not include the generated output.

The verification pattern is simple: run `go generate ./...` in CI, then run `git diff --exit-code`. If the diff is non-empty, fail the build with a message explaining how to regenerate. This takes 30 seconds to implement and prevents an entire class of "works on my machine" bugs where generated code drifts from its source over time.

For interviews: if asked about code generation in a large codebase, the answer is always "check in the output and verify the round-trip in CI." This is the standard at Google, Meta, and Uber.

### Senior @ FAANG: Code Generation as a First-Class Dependency

At FAANG scale, code generation is not a developer convenience. It is a critical dependency in the build graph. Protobuf compilation generates Go types that are shared across dozens of services. OpenAPI generation produces HTTP client code that is imported by frontend and backend teams simultaneously. Mock generation creates test doubles that determine whether test suites remain isolated. When generation is unreliable or slow, every team's productivity is affected.

The architecture question that separates senior from staff thinking: should code generators run at developer commit time, at CI time, or at build time (via Bazel genrules)? Each has tradeoffs. Commit time: fast feedback, but requires all generators to be installed locally and produces diff noise in PRs. CI time (the approach in this section): clean separation, but adds latency before developers see generator output. Bazel genrule time: fully hermetic, generators are pinned by hash, but generated files are not checked in, which breaks IDE navigation and `git bisect`.

The resolution used at Google: generators run at commit time via pre-commit hooks for speed, and the CI verify step catches cases where the hook was skipped. Generated files are checked in. Bazel genrules are used only for generated files that are too large or too numerous to check in (for example, generated code for thousands of protobuf files). Publish this decision as a policy document with the rationale and the exceptions, so engineers do not repeatedly re-debate it on individual PRs.

### Junior → FAANG: Understanding the Generated Code Contract

Generated code is source code that you are not supposed to edit by hand. The top of every generated file in a well-run monorepo contains a comment like `// Code generated by mockery; DO NOT EDIT.` That comment is a contract: if you edit the file by hand, the next time the generator runs, your changes will be overwritten. The correct pattern is to modify the source (the protobuf definition, the interface, the OpenAPI spec) and then re-run the generator.

The first-job skill is knowing how to re-run generators in the project you are working on. Look for a `Makefile` target like `make generate`, a script like `./scripts/gen.sh`, or a CI job called `verify-generated`. Run that before opening a PR if you changed anything the generators consume. If you do not, CI will fail with a diff that shows your checked-in generated files do not match what the generator would produce.

Interview entry point: explain the generated code verification pattern as "run the generator in CI and fail the build if the output differs from what is checked in." This catches two classes of bugs: engineers who forgot to re-run the generator, and generators that produce non-deterministic output (which shows up as a spurious diff on every PR).

### Senior @ FAANG: Generation Architecture, Hermeticity, and Scaling to Hundreds of Proto Files

At scale, the code generation pipeline is one of the most fragile parts of the build system. Generators are external binaries with their own version requirements. A protoc version mismatch between a developer's machine and CI produces different output from the same input, creating permanent diff noise that makes the CI verify step useless. The solution is generator hermeticity: every generator is pinned by version in the repo (not installed globally), and CI and local development use the same pinned version.

The practical implementation for protoc is a Buf schema registry and `buf.lock` file that pins the exact version of each plugin. For `mockery`, a tools.go file with a `//go:build tools` tag pins the version via the module graph. For OpenAPI generators, a Docker image tag pinned in the repo achieves the same result. The invariant is: the generator version is a first-class dependency of the repo, pinned in version control, updated through the normal dependency update process.

The scaling problem appears at around 50 proto files and becomes acute at 200. Running all generators sequentially on every PR takes too long. The solution parallels affected-change detection: a generator dependency graph. If only `user.proto` changed, only the generators that consume `user.proto` need to run. Building this graph requires understanding which generated files depend on which source files, which is precisely what Bazel genrules encode natively. For teams without Bazel, a custom generation manifest (a YAML file that declares generator dependencies) provides a lightweight alternative. The manifest is checked in and updated via a CI check that verifies it is consistent with the proto import graph.

---
