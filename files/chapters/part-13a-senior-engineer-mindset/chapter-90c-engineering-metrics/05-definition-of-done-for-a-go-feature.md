## Definition of Done for a Go Feature

- [ ] Implementation complete and passes `go vet ./...`
- [ ] Unit tests written (coverage >= existing baseline)
- [ ] Integration tests written for happy path + error paths
- [ ] golangci-lint passes with zero new findings
- [ ] Performance: no regression in p99 latency (measured via benchmark)
- [ ] Documentation: exported functions have godoc comments
- [ ] ADR written if architectural decision was made
- [ ] Feature flag added if change is risk-flagged
- [ ] Deployed to staging and smoke tested
- [ ] PR reviewed and approved by >= 1 team member

**Tactic 3: Measure and reduce PR review time**

PR review time is often the largest contributor to wait time in a flow analysis. Go-specific tactics:

```go
// Reduce cognitive load in PRs by keeping functions small
// and using descriptive names. This is not just style preference  - 
// smaller, well-named functions reduce PR review time measurably.

// Hard to review - what does this function actually do?
func processData(d []byte, f int, b bool) ([]byte, error) {
    // 200 lines...
}

// Easy to review - intent is clear from signature
func encryptUserCredentials(
    plaintext []byte,
    keyID string,
    compress bool,
) (ciphertext []byte, err error) {
    // 40 lines...
}
```

**Tactic 4: Automated PR checks to reduce review round-trips**

Every manual check that can be automated is a reduction in review time:

```yaml
# .github/workflows/pr-checks.yml
name: PR Checks

on: [pull_request]

jobs:
  quality:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: '1.27'
          cache: true

      - name: Vet
        run: go vet ./...

      - name: Lint
        uses: golangci/golangci-lint-action@v4
        with:
          version: latest

      - name: Test
        run: go test -race -coverprofile=coverage.out ./...

      - name: Coverage gate
        run: |
          COVERAGE=$(go tool cover -func=coverage.out | grep total | awk '{print $3}' | tr -d '%')
          if (( $(echo "$COVERAGE < 70" | bc -l) )); then
            echo "Coverage $COVERAGE% is below 70% threshold"
            exit 1
          fi

      - name: Benchmark regression check
        run: |
          go test -bench=. -benchmem -run=^$ ./... > new_bench.txt
          # Compare with baseline if exists
          if [ -f baseline_bench.txt ]; then
            go run golang.org/x/perf/cmd/benchstat baseline_bench.txt new_bench.txt
          fi
```

### Junior → FAANG: Definition of Done as a Quality Contract

The Definition of Done is not a checklist that slows you down. It is a quality contract that prevents you from shipping things that create incidents. As a junior engineer, internalizing the DoD for your team is the fastest path to shipping work that senior engineers trust without extensive oversight.

The most common junior mistake with DoD: treating it as boxes to check rather than outcomes to achieve. A test suite that satisfies coverage requirements but does not actually test the behavior that matters in production is compliance theater. A benchmark that runs in CI but measures the wrong thing is noise. The DoD is valuable when it forces you to think about what "done" actually means for the user, the operator, and the team.

### Senior @ FAANG: DoD as a Cross-Team Alignment Tool

At FAANG, inconsistent Definitions of Done across teams is a significant source of integration friction. When Team A ships an API that it considers "done" without a circuit breaker, and Team B's service depends on that API and gets cascaded failures during a downstream outage, the root cause is often a DoD mismatch: Team A did not define resilience requirements as part of done.

Staff engineers who own cross-team platform work should define an explicit shared DoD for every cross-team interface. The shared DoD covers what reliability properties are required, what observability must be in place, what documentation is necessary, and what rollback procedure exists. Formalizing this in an ADR prevents the "we thought you were going to handle that" conversations that drive up incident MTTR.

---
