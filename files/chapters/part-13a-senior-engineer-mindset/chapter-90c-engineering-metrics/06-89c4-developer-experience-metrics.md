## 90C.4 Developer Experience Metrics

### Why Developer Experience Metrics Matter

Developer experience (DevEx) metrics measure the friction in your development environment. High friction reduces throughput - engineers spend time fighting tools instead of solving problems. It also reduces retention: engineers who are frustrated by their tools leave for companies where tools work.

The Humanizing Work Research Group defines developer experience along three dimensions:
- **Cognitive load**: How much engineers must hold in their heads to do their work
- **Flow state**: How often engineers can enter deep, focused work
- **Feedback loops**: How quickly engineers know whether their work is correct

The following metrics are proxies for these dimensions.

### Build Time

For Go projects, build time has two components:

**Cold build time** (from clean cache): Measures the complexity of your build graph and the quality of your module organization.

**Incremental build time** (with cache): Measures how well your project structure enables Go's build cache.

```go
// Measure build time in CI
// .github/workflows/build-metrics.yml snippet:
//
// - name: Build with timing
//   run: |
//     START=$(date +%s%N)
//     go build ./...
//     END=$(date +%s%N)
//     DURATION=$(( (END - START) / 1000000 ))
//     echo "build_time_ms=$DURATION" >> $GITHUB_OUTPUT
//
//     # Push to metrics store
//     curl -X POST https://metrics.internal/api/v1/build \
//       -H "Content-Type: application/json" \
//       -d "{\"duration_ms\": $DURATION, \"commit\": \"$GITHUB_SHA\", \"branch\": \"$GITHUB_REF_NAME\"}"
```

**Targets**:
- Cold build: < 2 minutes for most services
- Incremental build: < 30 seconds
- If exceeding targets: audit dependency graph with `go mod graph`, split packages, use `go build -v` to identify slow packages

**Go-specific optimization**: Go's build cache is content-addressed. Structure your packages so that frequently changed code is in leaf packages, not in packages that everything imports. A change to `internal/utils` invalidates the entire build. A change to `services/order/handler` only invalidates that subtree.

### Test Time

Test time is the single biggest factor in developer flow state. Tests that take more than a few minutes break the tight feedback loop that makes TDD effective.

```bash
# Profile test time by package
go test -v -timeout 300s ./... 2>&1 | grep -E "^(ok|FAIL|---)" | sort -t'/' -k2

# Identify the slowest tests
go test -v -timeout 300s ./... 2>&1 | grep "^--- PASS" | \
    sed 's/--- PASS: \(.*\) (\(.*\)s)/\2 \1/' | sort -rn | head -20
```

**Targets**:
- Unit tests: < 30 seconds for the full suite
- Integration tests (with `-tags integration`): < 5 minutes
- If exceeding unit test target: identify slow tests, use `testing.Short()` to skip slow tests in fast mode

```go
func TestSlowOperation(t *testing.T) {
    if testing.Short() {
        t.Skip("skipping slow test in short mode")
    }
    // ... test that takes 10+ seconds
}
```

Run with `go test -short ./...` for fast feedback during development, full suite in CI.

### CI Time (End-to-End Pipeline Time)

CI time is the total time from `git push` to "ready to deploy". This includes:
- Queue time (waiting for a runner)
- Checkout and setup time
- Build time
- Test time
- Lint and vet time
- Build artifact creation
- Docker image build and push

**Target**: < 10 minutes for most services. > 15 minutes is a significant productivity drag.

**Breakdown analysis**:

```yaml
# Add timing to each CI step
- name: Test
  run: |
    START=$(date +%s)
    go test -race ./...
    echo "Test duration: $(($(date +%s) - START))s"

- name: Lint
  run: |
    START=$(date +%s)
    golangci-lint run ./...
    echo "Lint duration: $(($(date +%s) - START))s"
```

**Common optimizations**:

| Optimization | Typical Savings |
|-------------|-----------------|
| Go build cache in CI | 30-60% build time |
| Parallel test packages (`-p`) | 20-40% test time |
| Docker layer caching | 50-80% image build time |
| Pre-built base images | 60-70% base image pull time |
| Test splitting (by package) | 40-70% with parallel runners |

### Flaky Test Rate

A flaky test is a test that fails non-deterministically - it passes sometimes and fails sometimes without any code change. Flaky tests are the most corrosive metric on this list. Their effects:

- Engineers stop trusting CI results
- Engineers add "just re-run the pipeline" to their workflow
- Real failures are hidden in flaky noise
- Time is wasted triaging false positives

**Target**: < 0.1% of test runs produce a flaky failure. Zero is the goal.

**Detecting flakiness**:

```go
// Run a test 100 times to detect flakiness
// go test -count=100 -run TestSomething ./package/

// Or detect through CI history
// Track: which tests fail, on which builds, with no code changes?

type FlakyTestTracker struct {
    mu      sync.Mutex
    results map[string][]TestResult // testName → results
}

type TestResult struct {
    Passed    bool
    Duration  time.Duration
    BuildID   string
    CommitSHA string
    Timestamp time.Time
}

// FlakyScore returns a flakiness score (0.0 = stable, 1.0 = always flaky)
// for a given test based on recent runs.
func (t *FlakyTestTracker) FlakyScore(testName string, window int) float64 {
    t.mu.Lock()
    defer t.mu.Unlock()

    results := t.results[testName]
    if len(results) < window {
        return 0 // Insufficient data
    }

    recent := results[len(results)-window:]
    failures := 0
    for _, r := range recent {
        if !r.Passed {
            failures++
        }
    }

    return float64(failures) / float64(len(recent))
}
```

**Common causes of flaky Go tests**:

```go
// BAD: Race condition - goroutine may not have started yet
func TestRaceCondition(t *testing.T) {
    var result int
    go func() {
        result = computeExpensively()
    }()
    // Race: result may or may not be set
    assert.Equal(t, 42, result)
}

// GOOD: Proper synchronization
func TestNoRaceCondition(t *testing.T) {
    var result int
    done := make(chan struct{})
    go func() {
        result = computeExpensively()
        close(done)
    }()
    <-done
    assert.Equal(t, 42, result)
}

// BAD: Time-dependent test
func TestTimeout(t *testing.T) {
    start := time.Now()
    doSomething()
    // Flaky on slow CI runners
    assert.Less(t, time.Since(start), 100*time.Millisecond)
}

// GOOD: Use test doubles for time
func TestTimeout(t *testing.T) {
    clock := clockwork.NewFakeClock()
    svc := NewService(clock)
    // ... test with fake clock
}
```

### PR Review Turnaround Time

**Definition**: Time from when a PR is marked "Ready for Review" to when it receives its first substantive review.

**Why it matters**: PR review bottlenecks are the number-one contributor to long lead times in most teams. An engineer who submits a PR at 2pm and receives feedback the next morning has lost their context and their working day.

**Target**: First review within 4 hours (same business day).

**How to measure**:

```bash
# GitHub CLI query for PR review turnaround
gh api graphql -f query='
{
  repository(owner: "myorg", name: "myrepo") {
    pullRequests(last: 100, states: [MERGED]) {
      nodes {
        createdAt
        reviews(first: 1, states: [APPROVED, CHANGES_REQUESTED, COMMENTED]) {
          nodes {
            createdAt
          }
        }
      }
    }
  }
}' | jq '.data.repository.pullRequests.nodes[] |
  select(.reviews.nodes | length > 0) |
  {
    created: .createdAt,
    first_review: .reviews.nodes[0].createdAt
  }'
```

**Improvement tactics**:
- Set explicit PR review SLAs in team agreements
- Use GitHub CODEOWNERS to auto-assign reviewers
- Distinguish "Review this today" from "FYI" in PR descriptions
- Rotate review responsibilities to prevent bottlenecks on specific engineers

### Onboarding Time for New Engineers

**Definition**: Time from a new engineer's first day to when they deploy their first change to production.

**Target**: < 5 days for a Go team with good tooling and documentation.

**Why it matters**: Onboarding time is a leading indicator of documentation quality, developer tooling complexity, and team culture. It also directly affects productivity - a new engineer who takes 8 weeks to reach productivity is significantly more expensive than one who takes 2 weeks.

**How to measure**: Tag tickets with "onboarding" or track time-to-first-production-deployment in your HR/engineering system.

### Junior → FAANG: Experiencing Developer Experience as Data

Developer experience metrics measure things you experience daily but may never have thought of as measurable: how long it takes to build the project, how often tests are flaky, how long it takes to get a PR reviewed. Start measuring these for yourself. Time your build. Note every flaky test you encounter this week. Calculate your average PR review turnaround time over the last month.

That personal measurement exercise produces two things: a concrete dataset you can cite in interviews ("our build time is 18 minutes and I drove it down to 8 minutes by moving to incremental builds"), and an intuition for which developer experience problems have the largest leverage for your specific team.

### Senior @ FAANG: Developer Experience as a Retention and Hiring Multiplier

At FAANG, developer experience metrics are increasingly recognized as a talent retention signal. The engineering blog posts from companies like Airbnb and DoorDash that describe their developer experience programs consistently show that engineers who experience poor tooling, slow builds, and high incident burden leave at higher rates. The cost of attrition at FAANG fully-loaded compensation levels makes developer experience investment economically rational even before you count the productivity impact.

Staff engineers who want to make the case for developer experience investment should frame it in both productivity terms (quantifiable throughput improvement) and retention terms (reduction in attrition rate and hiring cost). The combined argument is almost always economically positive and tends to win budget that a pure productivity argument does not.

The space-bar test (how long it takes an engineer to go from "I just had an idea" to "I can see whether it worked in production") is a useful single-metric summary of developer experience at the highest level. FAANG teams that have optimized this metric, through fast builds, fast test runs, progressive delivery infrastructure, and good observability, consistently outperform on DORA metrics as well. The causal arrow runs in both directions: better developer experience enables faster deployment, and faster deployment provides faster feedback that improves engineering quality.

---
