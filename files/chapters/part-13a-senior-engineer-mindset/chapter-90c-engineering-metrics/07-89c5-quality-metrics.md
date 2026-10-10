## 90C.5 Quality Metrics

### Defect Escape Rate

**Definition**: The percentage of bugs that are discovered in production versus pre-production (testing, staging, code review).

```
Defect Escape Rate = (Production Bugs / Total Bugs) × 100%

Example:
- 50 bugs discovered in testing
- 10 bugs discovered in production
- Total: 60 bugs
- Defect Escape Rate: (10/60) × 100% = 16.7%
```

**Target**: < 10%. Elite teams with strong TDD and integration testing achieve < 5%.

**Improving defect escape rate**:
- Shift left: Find bugs earlier. Unit tests catch bugs in seconds. Production incidents catch bugs after customers are affected.
- Property-based testing: Use `gopkg.in/h2non/gentleman.v2` or `github.com/flyingmutant/rapid` for property-based testing in Go. Properties catch edge cases that example-based tests miss.
- Mutation testing: Use `github.com/zimmski/go-mutesting` to verify that your tests actually catch bugs.

### Code Coverage Trends

Absolute coverage percentage is a vanity metric. 90% coverage with tests that never assert anything is meaningless. What matters is coverage trends and the quality of assertions.

**Better approach: Coverage delta tracking**

```yaml
# In CI, require that PRs don't decrease coverage
- name: Coverage check
  run: |
    # Get coverage for changed packages only
    CHANGED_PKGS=$(git diff --name-only origin/main | \
        grep '\.go$' | \
        xargs -I{} dirname {} | \
        sort -u | \
        sed 's|^|./|' | \
        tr '\n' ' ')

    if [ -n "$CHANGED_PKGS" ]; then
      go test -coverprofile=coverage.out $CHANGED_PKGS

      # Fail if coverage dropped below baseline for changed packages
      go tool cover -func=coverage.out | awk '
        /^total/ {
          coverage = strtonum($3)
          if (coverage < 75) {
            print "Coverage " coverage "% below 75% threshold for changed packages"
            exit 1
          }
        }
      '
    fi
```

**Coverage quality indicators**:
- High coverage + high defect escape rate = weak tests (assertions are missing)
- Low coverage + low defect escape rate = strong tests but incomplete
- High coverage + low defect escape rate = strong, thorough tests (the goal)

### Technical Debt Ratio

**Definition**: The ratio of time required to fix technical debt versus time required to build the system from scratch. Typically expressed as a percentage.

A pragmatic proxy: track the number of items tagged "tech-debt" or "refactor" in your backlog as a percentage of total backlog items.

**Target**: Technical debt items should not exceed 20% of your sprint backlog. If they do, you are accruing debt faster than paying it down.

**Automated detection in Go**:

```bash
# Count TODO/FIXME/HACK comments as a proxy for technical debt
# (not perfect, but directionally useful)
grep -rn "TODO\|FIXME\|HACK\|XXX" --include="*.go" . | \
    grep -v "_test.go" | \
    wc -l

# Track cyclomatic complexity (high complexity = debt)
# Install: go install github.com/fzipp/gocyclo/cmd/gocyclo@latest
gocyclo -over 15 .  # Flag functions with complexity > 15
```

### Security Vulnerability Aging

**Definition**: How long known security vulnerabilities remain unpatched in your dependencies.

**Target**: Critical vulnerabilities patched within 24 hours. High severity within 7 days. Medium within 30 days.

**Automated monitoring in Go**:

```bash
# govulncheck: Go's official vulnerability scanner
# Install: go install golang.org/x/vuln/cmd/govulncheck@latest
govulncheck ./...

# Run in CI with failure on any vulnerability
- name: Security scan
  run: |
    go install golang.org/x/vuln/cmd/govulncheck@latest
    govulncheck ./...
  continue-on-error: false  # Block deployment on vulnerabilities
```

**Track aging in your metrics dashboard**:

```go
// VulnerabilityAging tracks how long vulnerabilities have been open.
type VulnerabilityRecord struct {
    ID           string    // CVE-2024-XXXX
    Package      string    // github.com/some/package
    Severity     string    // critical/high/medium/low
    DiscoveredAt time.Time
    ResolvedAt   *time.Time
}

func AgeByCategory(vulns []VulnerabilityRecord, now time.Time) map[string]time.Duration {
    ages := make(map[string]time.Duration)
    counts := make(map[string]int)

    for _, v := range vulns {
        if v.ResolvedAt != nil {
            continue // Skip resolved
        }
        ages[v.Severity] += now.Sub(v.DiscoveredAt)
        counts[v.Severity]++
    }

    averages := make(map[string]time.Duration)
    for sev, total := range ages {
        if counts[sev] > 0 {
            averages[sev] = total / time.Duration(counts[sev])
        }
    }
    return averages
}
```

### Junior → FAANG: Quality Metrics You Can Control Today

The quality metrics most accessible to junior engineers are those at the code level: test coverage, static analysis warnings, and benchmark regressions. Of these, benchmark regressions are the most under-used: most Go services have benchmarks that are never run in CI, making it impossible to detect performance degradations before they reach production.

Adding `go test -bench=. -benchmem` to your CI pipeline and comparing results against a baseline costs an afternoon of setup. The first time it catches a regression you introduced, that afternoon pays for itself. The habit of running benchmarks locally before submitting a PR that touches hot paths is a senior engineering habit you can build now.

### Senior @ FAANG: Quality Metrics as Technical Debt Governance

At FAANG, quality metrics are the primary input to technical debt governance decisions. A team that has been running at 85% code coverage for two years and drops to 72% over three sprints has a visible signal that something changed in their development practices. The signal prompts investigation: was the coverage drop caused by a large untested feature, by a deliberate decision to skip tests for a time-constrained deliverable, or by test suite maintenance falling behind new code?

The investigation and its resolution should be documented, either in an ADR or a technical debt backlog item. Without documentation, the coverage drop becomes accepted as the new normal, and the next drop from 72% to 65% does not trigger any investigation. Technical debt governance requires maintaining an explicit standard, measuring against it, and documenting every intentional deviation.

Error budget mechanics, borrowed from SRE practice, can be applied to quality metrics. A team that has committed to 80% code coverage and drops below that threshold has exhausted its error budget for coverage and should prioritize test investment before new feature work. This mechanical rule removes the judgment call of "is this coverage gap worth addressing?" and replaces it with a clear, pre-committed standard. FAANG teams that implement error budgets for quality metrics report less technical debt accumulation over time, because the rule prevents the incremental compromises that individually seem acceptable but collectively degrade quality.

---
