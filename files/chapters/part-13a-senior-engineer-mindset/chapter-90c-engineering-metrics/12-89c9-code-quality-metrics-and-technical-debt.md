## 90C.9 Code Quality Metrics and Technical Debt

### Measuring Technical Debt Systematically

Technical debt is not just "messy code." It has measurable dimensions that can be tracked over time:

| Debt Category | Measurement Tool | Key Metric |
|---------------|-----------------|------------|
| Complexity | `gocyclo`, `cognitive-complexity` | Cyclomatic complexity per function |
| Dependency freshness | `go list -m -u all` | Number of outdated dependencies |
| Test coverage | `go test -coverprofile` | Coverage trend (delta per sprint) |
| Code duplication | `dupl` | Duplicate code blocks |
| Static analysis | `staticcheck`, `golangci-lint` | Issue count by severity |
| Security | `govulncheck` | Known CVEs in dependency tree |

The key insight: **measure trends, not absolutes.** A 45% coverage codebase that is trending up is healthier than a 70% coverage codebase that is trending down.

### Cyclomatic Complexity in Go

Cyclomatic complexity counts the number of linearly independent paths through a function. A function with complexity 1 has a single straight path. Each `if`, `for`, `case`, `&&`, `||` adds one.

```
Complexity 1-5:   Low risk. Easy to test.
Complexity 6-10:  Medium risk. Consider splitting.
Complexity 11-20: High risk. Hard to test reliably.
Complexity 20+:   Very high risk. Refactor immediately.
```

Install and run: `go install github.com/fzipp/gocyclo/cmd/gocyclo@latest`

```bash
# Report functions with complexity > 10
gocyclo -over 10 ./...

# Output example:
# 15 main processPayment payment.go:42:1
# 12 handlers handleWebhook webhook.go:88:1
```

### Building a Tech Debt Score Aggregator in Go

Rather than treating each tool's output in isolation, a debt score aggregator runs all static analysis tools in sequence and combines their findings into a single weighted score. Vulnerabilities receive the highest weight because they represent immediate risk, while outdated dependencies and complexity issues receive lower weights reflecting their deferred risk. Running all tools from a single Go binary makes it easy to invoke from CI without managing multiple tool invocations separately, and the normalized 0-100 score maps cleanly to a traffic-light status for leadership dashboards.

```go
package techdebt

import (
    "bytes"
    "encoding/json"
    "fmt"
    "os/exec"
    "strconv"
    "strings"
)

// TechDebtReport aggregates multiple static analysis tools.
type TechDebtReport struct {
    CyclomaticComplexityIssues int     `json:"cyclomatic_complexity_issues"`
    StaticCheckIssues          int     `json:"staticcheck_issues"`
    LintIssues                 int     `json:"lint_issues"`
    OutdatedDependencies       int     `json:"outdated_dependencies"`
    VulnerablePackages         int     `json:"vulnerable_packages"`
    DebtScore                  float64 `json:"debt_score"` // 0-100, lower is better
    Grade                      string  `json:"grade"`
}

// RunCyclomatic counts functions with complexity above threshold.
func RunCyclomatic(threshold int, path string) (int, error) {
    cmd := exec.Command("gocyclo", fmt.Sprintf("-over=%d", threshold), path)
    var out bytes.Buffer
    cmd.Stdout = &out
    _ = cmd.Run() // non-zero exit when issues found; that's expected

    lines := strings.Split(strings.TrimSpace(out.String()), "\n")
    if len(lines) == 1 && lines[0] == "" {
        return 0, nil
    }
    return len(lines), nil
}

// RunStaticCheck runs staticcheck and counts issues.
func RunStaticCheck(path string) (int, error) {
    cmd := exec.Command("staticcheck", "-f", "json", path)
    var out bytes.Buffer
    cmd.Stdout = &out
    _ = cmd.Run()

    var issues []struct {
        Code string `json:"code"`
    }
    if err := json.NewDecoder(&out).Decode(&issues); err != nil {
        return 0, nil // tool not installed or no output
    }
    return len(issues), nil
}

// RunOutdatedDeps counts modules with available updates.
func RunOutdatedDeps() (int, error) {
    cmd := exec.Command("go", "list", "-m", "-u", "-json", "all")
    var out bytes.Buffer
    cmd.Stdout = &out
    if err := cmd.Run(); err != nil {
        return 0, fmt.Errorf("go list failed: %w", err)
    }

    outdated := 0
    decoder := json.NewDecoder(&out)
    for decoder.More() {
        var m struct {
            Update *struct{ Version string } `json:"Update"`
        }
        if err := decoder.Decode(&m); err != nil {
            continue
        }
        if m.Update != nil {
            outdated++
        }
    }
    return outdated, nil
}

// RunVulnCheck counts known vulnerabilities.
func RunVulnCheck() (int, error) {
    cmd := exec.Command("govulncheck", "-json", "./...")
    var out bytes.Buffer
    cmd.Stdout = &out
    _ = cmd.Run()

    var result struct {
        Vulns []struct{ ID string } `json:"vulns"`
    }
    if err := json.Unmarshal(out.Bytes(), &result); err != nil {
        return 0, nil
    }
    return len(result.Vulns), nil
}

// Compute runs all tools and returns an aggregated tech debt report.
func Compute(path string) (*TechDebtReport, error) {
    complexity, _ := RunCyclomatic(10, path)
    staticIssues, _ := RunStaticCheck(path)
    outdated, _ := RunOutdatedDeps()
    vulns, _ := RunVulnCheck()

    // Weighted debt score (higher = more debt)
    // Weights reflect relative severity
    score := float64(complexity)*2.0 +
        float64(staticIssues)*1.5 +
        float64(outdated)*1.0 +
        float64(vulns)*5.0 // vulnerabilities weighted heavily

    // Normalize to 0-100 (cap at 100)
    normalized := score
    if normalized > 100 {
        normalized = 100
    }

    grade := debtGrade(normalized)

    return &TechDebtReport{
        CyclomaticComplexityIssues: complexity,
        StaticCheckIssues:          staticIssues,
        OutdatedDependencies:       outdated,
        VulnerablePackages:         vulns,
        DebtScore:                  normalized,
        Grade:                      grade,
    }, nil
}

func debtGrade(score float64) string {
    switch {
    case score < 10:
        return "A"
    case score < 25:
        return "B"
    case score < 50:
        return "C"
    case score < 75:
        return "D"
    default:
        return "F"
    }
}

// FormatReport renders the report as human-readable text.
func FormatReport(r *TechDebtReport) string {
    return fmt.Sprintf(`Tech Debt Report
================
Grade:                  %s  (score: %.1f/100)
Complex functions:      %d  (cyclomatic > 10)
Static analysis issues: %d
Outdated dependencies:  %d
Vulnerable packages:    %d
`,
        r.Grade, r.DebtScore,
        r.CyclomaticComplexityIssues,
        r.StaticCheckIssues,
        r.OutdatedDependencies,
        r.VulnerablePackages,
    )
}

// Placeholder for FormatReport to avoid strconv unused import
var _ = strconv.Itoa
```

### Setting Tech Debt Budgets

A tech debt budget defines the maximum acceptable debt score for a codebase. Teams that exceed their budget stop feature work until debt is reduced. This practice, popularized by Google's SRE model (analogous to error budgets), prevents debt accumulation from becoming unmanageable.

```
Budget Tiers:
  Green  (score 0-15):  Normal feature velocity. Debt is under control.
  Yellow (score 16-35): Reduce debt alongside features. 20% of sprint capacity.
  Red    (score 36-60): Debt reduction sprint. Feature work paused for one sprint.
  Black  (score 60+):   Stop feature work. Full debt reduction focus.
```

Integrate debt scoring into your CI pipeline:

```yaml
# .github/workflows/tech-debt.yml
name: Tech Debt Check
on: [push]
jobs:
  debt:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with: { go-version: '1.27' }
      - name: Install tools
        run: |
          go install github.com/fzipp/gocyclo/cmd/gocyclo@latest
          go install honnef.co/go/tools/cmd/staticcheck@latest
          go install golang.org/x/vuln/cmd/govulncheck@latest
      - name: Run debt check
        run: go run ./cmd/techdebt/main.go --fail-on-grade=D
```

---
