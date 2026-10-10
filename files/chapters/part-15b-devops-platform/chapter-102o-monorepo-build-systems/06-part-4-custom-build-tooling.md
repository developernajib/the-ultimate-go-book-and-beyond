## 102O.4 Custom Build Tooling

### Monorepo Build Script

Custom build tooling fills the gap between a simple `Makefile` and a full Bazel configuration. A Go-based build orchestrator can read the monorepo's service graph, determine which services need rebuilding based on changed files, run builds and tests in parallel with a configurable concurrency limit, and produce structured output suitable for CI log parsing. Writing the build tool in Go itself is a natural choice. It uses the same dependency resolution and toolchain as the services it builds, and the resulting binary is a single statically linked executable that can be cached and reused across CI agents.

```go
// cmd/build/main.go - custom build orchestrator
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

type BuildConfig struct {
	Services  []string
	Parallel  int
	Output    string
	GOOS      string
	GOARCH    string
	Tags      []string
	LDFlags   string
	Race      bool
	Verbose   bool
}

type BuildResult struct {
	Service  string
	Success  bool
	Duration time.Duration
	Error    error
	Output   string
}

// Builder orchestrates builds across multiple services
type Builder struct {
	config  BuildConfig
	rootDir string
}

func NewBuilder(config BuildConfig) (*Builder, error) {
	rootDir, err := findModuleRoot()
	if err != nil {
		return nil, err
	}
	return &Builder{config: config, rootDir: rootDir}, nil
}

func (b *Builder) BuildAll(ctx context.Context) []BuildResult {
	sem := make(chan struct{}, b.config.Parallel)
	var wg sync.WaitGroup
	results := make([]BuildResult, len(b.config.Services))

	for i, service := range b.config.Services {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int, service string) {
			defer wg.Done()
			defer func() { <-sem }()
			results[i] = b.buildService(ctx, service)
		}(i, service)
	}

	wg.Wait()
	return results
}

func (b *Builder) buildService(ctx context.Context, service string) BuildResult {
	start := time.Now()
	servicePath := filepath.Join(b.rootDir, service)
	outputName := filepath.Base(service)

	if b.config.GOOS == "windows" {
		outputName += ".exe"
	}

	outputPath := filepath.Join(b.config.Output, outputName)
	if err := os.MkdirAll(b.config.Output, 0755); err != nil {
		return BuildResult{Service: service, Success: false, Error: err, Duration: time.Since(start)}
	}

	args := []string{"build"}
	if b.config.Race {
		args = append(args, "-race")
	}
	if b.config.Verbose {
		args = append(args, "-v")
	}
	if len(b.config.Tags) > 0 {
		args = append(args, "-tags="+strings.Join(b.config.Tags, ","))
	}
	if b.config.LDFlags != "" {
		args = append(args, "-ldflags="+b.config.LDFlags)
	}
	args = append(args, "-o", outputPath, ".")

	cmd := exec.CommandContext(ctx, "go", args...)
	cmd.Dir = servicePath
	cmd.Env = append(os.Environ(),
		"GOOS="+b.config.GOOS,
		"GOARCH="+b.config.GOARCH,
		"CGO_ENABLED=0",
		"GOFLAGS=-mod=mod",
	)

	out, err := cmd.CombinedOutput()
	if err != nil {
		return BuildResult{
			Service:  service,
			Success:  false,
			Duration: time.Since(start),
			Error:    fmt.Errorf("build failed: %w", err),
			Output:   string(out),
		}
	}

	return BuildResult{
		Service:  service,
		Success:  true,
		Duration: time.Since(start),
		Output:   string(out),
	}
}

func findModuleRoot() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.work")); err == nil {
			return dir, nil
		}
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("not in a Go module or workspace")
		}
		dir = parent
	}
}

func main() {
	var (
		services = flag.String("services", "", "comma-separated service paths")
		output   = flag.String("output", "bin", "output directory")
		goos     = flag.String("os", runtime.GOOS, "target OS")
		goarch   = flag.String("arch", runtime.GOARCH, "target architecture")
		parallel = flag.Int("p", runtime.NumCPU(), "parallel builds")
		race     = flag.Bool("race", false, "enable race detector")
		verbose  = flag.Bool("v", false, "verbose output")
		tags     = flag.String("tags", "", "build tags")
		ldflags  = flag.String("ldflags", "", "linker flags")
	)
	flag.Parse()

	var serviceList []string
	if *services != "" {
		serviceList = strings.Split(*services, ",")
	}

	config := BuildConfig{
		Services: serviceList,
		Parallel: *parallel,
		Output:   *output,
		GOOS:     *goos,
		GOARCH:   *goarch,
		Race:     *race,
		Verbose:  *verbose,
		LDFlags:  *ldflags,
	}
	if *tags != "" {
		config.Tags = strings.Split(*tags, ",")
	}

	builder, err := NewBuilder(config)
	if err != nil {
		fmt.Fprintf(os.Stderr, "init: %v\n", err)
		os.Exit(1)
	}

	ctx := context.Background()
	results := builder.BuildAll(ctx)

	// Print results
	success := 0
	failed := 0
	for _, r := range results {
		if r.Success {
			success++
			fmt.Printf("✓ %-40s %v\n", r.Service, r.Duration.Round(time.Millisecond))
		} else {
			failed++
			fmt.Printf("✗ %-40s %v\n", r.Service, r.Duration.Round(time.Millisecond))
			fmt.Println("  Error:", r.Error)
			if r.Output != "" {
				fmt.Println("  Output:", r.Output)
			}
		}
	}

	fmt.Printf("\nBuilt %d/%d services\n", success, success+failed)
	if failed > 0 {
		os.Exit(1)
	}
}
```

### Dependency Graph Analysis

Understanding which packages depend on which other packages is essential for answering questions like "if I change `shared/auth`, which services must be rebuilt?" The `golang.org/x/tools/go/packages` loader provides a programmatic API to resolve import graphs at the package level, respecting build tags, CGO settings, and Go workspace configurations. A depth-first traversal of the resolved graph can both detect import cycles. Which `go build` itself forbids but static analysis tools may encounter in partial builds. And rank packages by fan-in to identify high-impact shared code that warrants extra stability guarantees.

```go
// cmd/depgraph/main.go - analyzes package dependencies in the monorepo
package main

import (
	"fmt"
	"os"
	"strings"

	"golang.org/x/tools/go/packages"
)

// DependencyGraph represents package dependencies
type DependencyGraph struct {
	nodes map[string]*Node
}

type Node struct {
	ImportPath string
	Deps       []*Node
	ImportedBy []*Node
}

func BuildGraph(patterns []string) (*DependencyGraph, error) {
	cfg := &packages.Config{
		Mode: packages.NeedImports | packages.NeedDeps |
			packages.NeedName | packages.NeedFiles,
	}

	pkgs, err := packages.Load(cfg, patterns...)
	if err != nil {
		return nil, fmt.Errorf("load packages: %w", err)
	}

	graph := &DependencyGraph{nodes: make(map[string]*Node)}

	var visit func(pkg *packages.Package)
	visit = func(pkg *packages.Package) {
		if _, ok := graph.nodes[pkg.PkgPath]; ok {
			return
		}
		node := &Node{ImportPath: pkg.PkgPath}
		graph.nodes[pkg.PkgPath] = node

		for _, imp := range pkg.Imports {
			visit(imp)
			depNode := graph.nodes[imp.PkgPath]
			node.Deps = append(node.Deps, depNode)
			depNode.ImportedBy = append(depNode.ImportedBy, node)
		}
	}

	for _, pkg := range pkgs {
		visit(pkg)
	}

	return graph, nil
}

// FindCycles detects circular dependencies
func (g *DependencyGraph) FindCycles() [][]string {
	var cycles [][]string
	visited := make(map[string]bool)
	inStack := make(map[string]bool)

	var dfs func(node *Node, path []string)
	dfs = func(node *Node, path []string) {
		visited[node.ImportPath] = true
		inStack[node.ImportPath] = true
		path = append(path, node.ImportPath)

		for _, dep := range node.Deps {
			if !visited[dep.ImportPath] {
				dfs(dep, path)
			} else if inStack[dep.ImportPath] {
				// Found cycle - extract it
				cycleStart := -1
				for i, p := range path {
					if p == dep.ImportPath {
						cycleStart = i
						break
					}
				}
				if cycleStart >= 0 {
					cycle := make([]string, len(path[cycleStart:]))
					copy(cycle, path[cycleStart:])
					cycles = append(cycles, cycle)
				}
			}
		}

		inStack[node.ImportPath] = false
	}

	for _, node := range g.nodes {
		if !visited[node.ImportPath] {
			dfs(node, nil)
		}
	}
	return cycles
}

// MostImported returns packages imported by the most other packages
func (g *DependencyGraph) MostImported(n int) []*Node {
	var nodes []*Node
	for _, node := range g.nodes {
		nodes = append(nodes, node)
	}

	// Sort by number of importers
	for i := 0; i < len(nodes)-1; i++ {
		for j := i + 1; j < len(nodes); j++ {
			if len(nodes[j].ImportedBy) > len(nodes[i].ImportedBy) {
				nodes[i], nodes[j] = nodes[j], nodes[i]
			}
		}
	}

	if n > len(nodes) {
		n = len(nodes)
	}
	return nodes[:n]
}

func main() {
	patterns := os.Args[1:]
	if len(patterns) == 0 {
		patterns = []string{"./..."}
	}

	graph, err := BuildGraph(patterns)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}

	cycles := graph.FindCycles()
	if len(cycles) > 0 {
		fmt.Println("⚠️  Circular dependencies found:")
		for _, cycle := range cycles {
			fmt.Println(" ", strings.Join(cycle, " → "))
		}
	} else {
		fmt.Println("✓ No circular dependencies")
	}

	fmt.Println("\nMost imported packages:")
	for _, node := range graph.MostImported(10) {
		fmt.Printf("  %-60s (%d importers)\n", node.ImportPath, len(node.ImportPath))
	}
}
```

### Junior → FAANG: When to Write Custom Build Tooling

Custom build tooling is appropriate when your requirements are simple enough that Bazel's learning curve is not justified, but complex enough that a plain `Makefile` cannot express the logic. The orchestrator in this section is a worked example of that middle ground: parallel builds with a configurable concurrency limit, structured output for CI log parsing, and support for cross-compilation flags.

The dependency graph tool is equally important. Before you can safely refactor a shared package, you need to know its fan-in (how many packages import it). The `MostImported` function gives you a ranked list of the single most useful packages in the codebase. If `shared/errors` has 80 importers, changing its API is a major refactor. If `shared/featureflags` has 3 importers, it is low risk.

Habit to build early: before opening a PR that changes a shared package, run the dep graph tool and include the fan-in count in your PR description. Reviewers will appreciate the context and it will catch cases where you have underestimated the blast radius of your change.

### Senior @ FAANG: Custom Tooling Lifecycle and Maintenance Burden

Custom build tooling is a product. It has users (every engineer in the monorepo), it has bugs, and it requires ongoing maintenance as Go versions change, CI platforms evolve, and new services are added. The mistake senior engineers make when building this tooling is treating it as a one-time project rather than a product with an owner, a support channel, and a roadmap.

Three governance requirements for custom build tooling in a large monorepo: observability (emit structured metrics from every tool invocation, including build duration, success/failure, and which services were built, so you can track build time regression over quarters), versioning (the build tool itself must be versioned and pinned in CI, because an accidental update to the tool should not silently change build behavior for 200 engineers), and deprecation policy (custom tooling created to fill a gap often becomes redundant when a better tool is adopted, having a defined deprecation process prevents tool sprawl where 5 different affected-detection scripts accumulate with overlapping but incompatible behavior).

The dep graph tool's `FindCycles` function is particularly important from a governance perspective. In a large monorepo, import cycles between packages are a symptom of missing architectural boundaries. Tracking the number of cycles over time and setting a zero-tolerance policy for new cycles (enforced as a CI gate) prevents a common form of technical debt where packages become tangled over years of cross-team development. Present the cycle count as a health metric in engineering reviews alongside test coverage and build time.

### Junior → FAANG: When and Why to Write Custom Build Tooling

Most engineers first encounter custom build tooling as a black box: a `make build` command that does something opaque. The first step is reading the source. In Go monorepos, custom build tooling is usually written in Go itself, which means you can read, test, and modify it using the same skills you use for application code.

The pattern to recognize is the build orchestrator: a Go binary that reads the dependency graph (via `go list`), determines which services to build, runs builds in parallel with a semaphore to cap concurrency, and streams structured logs. When this tool is slow or produces confusing output, the fix is usually one of: increasing parallelism limit, adding progress reporting, or improving error messages. These are tractable first contributions if you are new to the codebase.

Interview entry point: describe custom build tooling as a way to encode organizational conventions into the build pipeline, such as affected-change detection logic, dependency graph visualization, or custom lint rules that enforce architectural boundaries the generic linters do not know about.

### Senior @ FAANG: Custom Tooling as Platform Product with Ownership and SLOs

Custom build tooling in a large monorepo is infrastructure with the same operational requirements as a production service. When the build tool is slow, 200 engineers experience that slowness on every PR. When the build tool has a bug, CI fails across the organization. The mistake is treating it as a side project rather than a product.

The operational requirements are: observability (every invocation emits structured metrics including duration, services built, cache hit rate, and exit code, aggregated in a dashboard that shows build time trends over weeks), versioning (the build tool binary is pinned in CI by digest, not by branch, so an update requires a deliberate version bump), and runbook coverage (when the tool fails in CI, there is a documented troubleshooting path that on-call engineers can follow without paging the platform team).

Beyond the tooling itself, the cycle detection gate is a platform-level quality commitment. Once you establish a zero-new-cycles policy, you will encounter PRs where a well-intentioned engineer introduced a cycle to solve a short-term dependency problem. The response is not just "fix the cycle." It is an architecture conversation: why did this cycle feel like the right solution? What missing abstraction or missing package boundary made the cycle tempting? The answer usually reveals a structural issue that the cycle is a symptom of. This is the L6 pattern: use tooling violations as signals for architectural conversations, not just as gatekeeping.

---
