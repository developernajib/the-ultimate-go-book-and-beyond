## 18.9 Test Coverage

### Generating Coverage

Go's built-in toolchain can instrument your code for coverage and produce a profile file with a single `go test` flag. Running `go tool cover` against the resulting `coverage.out` profile lets you view per-function percentages in the terminal or open an annotated HTML report in the browser where covered code is highlighted green and uncovered code red.

```bash
# Generate coverage profile
go test -coverprofile=coverage.out ./...

# View in terminal
go tool cover -func=coverage.out

# View in browser
go tool cover -html=coverage.out
```

**Go measures statements, not lines.** The tool says so if you read the output closely (`coverage: 100.0% of statements`, and `total: (statements) 14.3%`), and the distinction is visible in the profile format itself. Each row is `file:startLine.startCol,endLine.startCol numStatements count`:

```
mode: set
cv/svc/svc.go:5.21,5.46 1 1
cv/lib/lib.go:4.25,4.50 3 0
```

That second row is a single line containing three statements. So "line coverage" is the wrong mental model, and tools that convert Go profiles into line-based numbers for a dashboard are quietly translating between two different units.

### The `-coverpkg` Trap

By default, `go test -coverprofile=coverage.out ./...` instruments **only the package under test**, not the packages it calls. This surprises almost everyone, and it makes the default number wrong in a specific direction: code that is thoroughly exercised through another package's tests is reported as untested.

Concretely, with a `svc` package whose test calls `lib.Compact`:

```
$ go test -coverprofile=cover.out ./...
        cv/lib          coverage: 0.0% of statements
ok      cv/svc          coverage: 100.0% of statements

$ go tool cover -func=cover.out
cv/lib/lib.go:4:   Compact      0.0%     <- but the svc test DID call it
cv/lib/lib.go:6:   Uncovered    0.0%
cv/svc/svc.go:5:   Run          100.0%
total:             (statements) 14.3%
```

`Compact` ran, and coverage says 0%, because `lib` had no test binary of its own. Now pass `-coverpkg`:

```
$ go test -coverprofile=cover2.out -coverpkg=./... ./...
ok      cv/svc          coverage: 57.1% of statements in ./...

$ go tool cover -func=cover2.out
cv/lib/lib.go:4:   Compact      100.0%   <- the truth
cv/lib/lib.go:6:   Uncovered    0.0%
cv/svc/svc.go:5:   Run          100.0%
total:             (statements) 14.3% -> 57.1%
```

Same tests, same code, and the total moved from 14.3% to 57.1%. Neither number is a lie, they answer different questions: the default asks "how much of each package do its own tests cover", `-coverpkg` asks "how much of the whole module does the whole suite cover". The second is nearly always what people believe they are already measuring, and it is the only one that makes sense for integration tests, whose entire purpose is to exercise code in other packages.

```bash
go test -coverprofile=coverage.out -coverpkg=./... ./...
```

Be aware of the cost: `-coverpkg=./...` instruments every package for every test binary, so builds get slower and the number becomes sensitive to code you never intended to test (generated code, `main`). Scope it when that matters (`-coverpkg=./internal/...`).

### Coverage Thresholds

Enforcing a minimum coverage percentage in CI prevents coverage regressions from silently merging into the main branch. The script below extracts the total from the `go tool cover` summary line and fails the build if it drops below the threshold.

```bash
#!/usr/bin/env bash
set -euo pipefail

THRESHOLD=${1:-80}

go test -coverprofile=coverage.out -coverpkg=./... ./...

# Anchor on '^total:' and read the LAST field. See the notes below.
COVERAGE=$(go tool cover -func=coverage.out | awk '/^total:/ {gsub(/%/,"",$NF); print $NF}')

if [ -z "$COVERAGE" ]; then
    echo "could not determine coverage" >&2
    exit 2
fi

awk -v c="$COVERAGE" -v t="$THRESHOLD" 'BEGIN {
    if (c+0 < t+0) { printf "Coverage %.1f%% is below %.1f%%\n", c, t; exit 1 }
    printf "Coverage %.1f%% meets threshold %.1f%%\n", c, t
}'
```

Three details separate this from the version you usually see, and each is a real failure:

**`grep total` is not anchored.** It matches any line containing the substring, including source paths. Add a package named `total` to the repo and the pipeline silently returns two values:

```
$ go tool cover -func=coverage.out | grep total
cv/total/total.go:3:    Sum             0.0%
total:                  (statements)    50.0%

COVERAGE='0.0
50.0'      # the threshold comparison now gets garbage
```

`awk '/^total:/'` matches only the summary row.

**`bc` is frequently not installed.** It is absent from many minimal CI images, and because `$(...)` failure inside `(( ))` can evaluate to a passing condition, a missing `bc` can turn the gate into a no-op that reports success. Using `awk` for the comparison removes the dependency entirely, since you already require `awk` for the extraction.

**`set -euo pipefail` matters.** Without it, a failing `go test` earlier in the script does not stop the job, and the gate happily evaluates a stale `coverage.out` from a previous run.

Note the `-coverpkg=./...` in the `go test` line, for the reason in the previous section: without it you are gating on a number that ignores every package exercised only through another package's tests.

### Coverage Analysis Best Practices

Rather than relying solely on the aggregate percentage, it is more useful to parse the raw coverage profile and identify which individual files and line ranges have zero coverage. The `ParseCoverageProfile` function below reads the profile format directly, accumulates per-file statement counts, records every uncovered block with its start and end lines, and produces a sorted report that surfaces the worst-covered files first for targeted improvement.

```go
// coverage_analysis.go
package coverage

import (
    "bufio"
    "fmt"
    "os"
    "sort"
    "strconv"
    "strings"
)

// CoverageReport represents analyzed coverage data.
// Counts are STATEMENTS, not lines: a Go coverage profile records the
// number of statements per block, and one line can hold several.
type CoverageReport struct {
    TotalStatements   int
    CoveredStatements int
    Percentage        float64
    Files             []FileCoverage
    Uncovered         []UncoveredBlock
}

// FileCoverage represents coverage for a single file.
type FileCoverage struct {
    Path       string
    Statements int
    Covered    int
    Percentage float64
}

// UncoveredBlock represents a block of uncovered code
type UncoveredBlock struct {
    File      string
    StartLine int
    EndLine   int
    Function  string
}

// ParseCoverageProfile parses a Go coverage profile
func ParseCoverageProfile(path string) (*CoverageReport, error) {
    file, err := os.Open(path)
    if err != nil {
        return nil, fmt.Errorf("open coverage file: %w", err)
    }
    defer file.Close()

    report := &CoverageReport{
        Files:     make([]FileCoverage, 0),
        Uncovered: make([]UncoveredBlock, 0),
    }

    fileStats := make(map[string]*FileCoverage)
    scanner := bufio.NewScanner(file)

    // Skip mode line
    scanner.Scan()

    for scanner.Scan() {
        line := scanner.Text()
        parts := strings.Fields(line)
        if len(parts) < 3 {
            continue
        }

        // Parse: file:start.col,end.col statements count
        fileAndPos := strings.Split(parts[0], ":")
        if len(fileAndPos) < 2 {
            continue
        }

        filePath := fileAndPos[0]
        positions := strings.Split(fileAndPos[1], ",")
        if len(positions) < 2 {
            continue
        }

        startPos := strings.Split(positions[0], ".")
        endPos := strings.Split(positions[1], ".")
        statements, _ := strconv.Atoi(parts[1])
        count, _ := strconv.Atoi(parts[2])

        startLine, _ := strconv.Atoi(startPos[0])
        endLine, _ := strconv.Atoi(endPos[0])

        // Update file stats
        if _, exists := fileStats[filePath]; !exists {
            fileStats[filePath] = &FileCoverage{Path: filePath}
        }

        fileStats[filePath].Statements += statements

        if count > 0 {
            fileStats[filePath].Covered += statements
            report.CoveredStatements += statements
        } else {
            // Track uncovered blocks
            report.Uncovered = append(report.Uncovered, UncoveredBlock{
                File:      filePath,
                StartLine: startLine,
                EndLine:   endLine,
            })
        }
        report.TotalStatements += statements
    }

    // Calculate percentages
    for _, fc := range fileStats {
        if fc.Statements > 0 {
            fc.Percentage = float64(fc.Covered) / float64(fc.Statements) * 100
        }
        report.Files = append(report.Files, *fc)
    }

    if report.TotalStatements > 0 {
        report.Percentage = float64(report.CoveredStatements) / float64(report.TotalStatements) * 100
    }

    // Sort by percentage, ascending, so the worst files come first
    sort.Slice(report.Files, func(i, j int) bool {
        return report.Files[i].Percentage < report.Files[j].Percentage
    })

    return report, scanner.Err()
}

// PrintUncoveredReport prints files that need more coverage
func (r *CoverageReport) PrintUncoveredReport(minCoverage float64) {
    fmt.Printf("\n=== Coverage Report ===\n")
    fmt.Printf("Total: %.1f%% (%d/%d statements)\n\n",
        r.Percentage, r.CoveredStatements, r.TotalStatements)

    fmt.Println("Files below threshold:")
    for _, f := range r.Files {
        if f.Percentage < minCoverage {
            fmt.Printf("  %.1f%% %s\n", f.Percentage, f.Path)
        }
    }
}
```

### Coverage Is a Signal, Not a Goal

A statement-coverage percentage does not measure test quality. A test that executes every statement but asserts nothing reports 100% coverage and has zero value, and this chapter has already shown two real examples of exactly that: a fuzz target that never compared its round trip, and an auth middleware test that only sent a valid token. Both would show as covered.

Coverage is useful in one direction only. Uncovered code is definitely untested, which is a hard fact worth acting on. Covered code is merely *executed*, which is not the same as verified. Treat the number as a gap-finder, never as a quality claim.

So use it to find gaps (error paths without tests, whole files uncovered), not to claim quality. The metric that actually matters is "does this suite give us the confidence to refactor?", which is hard to measure and much more important than a percentage.

### Staff Lens: Per-Service Coverage Targets

Uniform org-wide coverage targets are a mistake. Payment processing code should have higher coverage than a read-only cache. Risk-tier the service and set appropriate targets. A flat "80% everywhere" policy is either too demanding for low-risk code (wasted effort) or too lenient for high-risk code (insufficient safety).

### Integration Coverage (Go 1.20+)

Go 1.20 added `go build -cover`, which instruments a **binary** rather than a test. You can then measure what your actual service executes while it runs against integration tests, a staging environment, or real traffic. For services where meaningful coverage requires real dependencies, this closes the gap that unit-test coverage leaves.

The flow differs from `-coverprofile`, so it is worth seeing once. The instrumented binary writes raw counter files to the directory named by `GOCOVERDIR`:

```bash
$ go build -cover -o app .
$ mkdir -p covdata
$ GOCOVERDIR=./covdata ./app world
hello world

$ ls covdata
covcounters.8b55e8a6...  covmeta.8b55e8a6...
```

Those are not coverage profiles, so `go tool cover` cannot read them directly. `go tool covdata` either summarizes them in place or converts them into the familiar text format:

```bash
$ go tool covdata percent -i=./covdata
        cb      coverage: 66.7% of statements

$ go tool covdata textfmt -i=./covdata -o=prof.out
$ go tool cover -func=prof.out
cb/main.go:8:   used       100.0%
cb/main.go:9:   unused     0.0%
cb/main.go:11:  main       100.0%
total:          (statements) 66.7%
```

Two practical notes. The binary flushes counters on normal exit, so a service killed with SIGKILL may lose data, which is one more reason to implement the graceful shutdown from chapter 21. And `covdata merge` combines directories from many runs or many replicas, which is how you build a single picture of what an entire e2e suite touched.

---
