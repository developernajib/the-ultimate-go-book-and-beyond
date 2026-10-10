## Section 5: CI Integration

### 5.1 Complete Testing Pipeline

The complete testing pipeline runs the four advanced testing strategies in a coordinated sequence as part of CI: property tests and fuzz regression tests on every PR, chaos tests on every merge to main, and extended fuzz campaigns on a nightly schedule against the staging environment. Orchestrating these stages with GitHub Actions ensures that each strategy's feedback arrives at the right point in the development workflow, fast property and fuzz regression tests unblock PRs quickly, while slower chaos experiments gate production deployments. The pipeline configuration below defines the stage structure, resource requirements, and artifact retention rules for each testing strategy.

Time budget guidance that holds up in practice:

- PR fuzz job: 30s per target. Catches regressions introduced by the PR without padding CI time.
- Nightly fuzz job: 5-15 minutes per target, persisting the generated corpus as an artifact so the next run starts warm.
- Release branch fuzz: 1-4 hours per target against the most security-sensitive packages (parsers, codecs, crypto handling).
- OSS Fuzz integration: for critical public packages, register with Google OSS-Fuzz. It runs Go fuzz targets continuously on Google infrastructure and reports crashes via email. Zero marginal cost for maintainers.

```go
package ci_integration

// GitHubActionsAdvancedTesting generates a comprehensive testing workflow.
func GitHubActionsAdvancedTesting() string {
	return `name: Advanced Testing Suite

on: [push, pull_request]

jobs:
  unit-and-property:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: '1.27'
      - name: Unit tests
        run: go test -count=1 -race -timeout=60s ./...
      # rapid takes its iteration count from a flag, not an env var.
      # -rapid.checks is the real knob - there is no GOPTER_COUNT.
      - name: Property tests (1000 checks per property)
        run: go test -count=1 -v -rapid.checks=1000 ./...

  fuzz:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: '1.27'
      - name: Run fuzz tests (30s each)
        run: |
          set -uo pipefail
          rc=0
          for file in $(grep -rl 'func Fuzz' --include='*_test.go' .); do
            pkg=$(dirname "$file")
            for func in $(grep -o 'func \(Fuzz[A-Za-z0-9_]*\)' "$file" | awk '{print $2}'); do
              echo "::group::Fuzzing $func in $pkg"
              # Note ./$pkg and NOT ./$pkg/... : go test rejects -fuzz with
              # more than one package ("cannot use -fuzz flag with multiple
              # packages"), and the /... form silently matches subpackages.
              # -run=^$ skips the normal tests so the budget goes to fuzzing.
              go test -run='^$' -fuzz="^${func}$" -fuzztime=30s "./$pkg" || rc=1
              echo "::endgroup::"
            done
          done
          # Do not swallow failures with "|| true". A crasher found in CI is
          # the entire point of the job, and a green build that hid one is
          # worse than no job at all.
          exit $rc
      # always(), not failure(): on a crash you want the reproducer, and on a
      # pass you want the corpus the run discovered so the next one starts warm.
      - name: Upload fuzz corpus
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: fuzz-corpus
          path: '**/testdata/fuzz/**'
          if-no-files-found: ignore

  chaos:
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main'
    services:
      postgres:
        # Pin the same major version production runs.
        image: postgres:18-alpine
        env:
          POSTGRES_DB: testdb
          POSTGRES_USER: test
          POSTGRES_PASSWORD: test
        ports: ['5432:5432']
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: '1.27'
      - name: Chaos tests
        run: go test -run TestChaos -v -timeout=120s ./...
        env:
          DATABASE_URL: postgres://test:test@localhost:5432/testdb?sslmode=disable

  mutation:
    runs-on: ubuntu-latest
    if: github.event_name == 'pull_request'
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: '1.27'
      - name: Install gremlins
        run: go install github.com/go-gremlins/gremlins/cmd/gremlins@latest
      - name: Run mutation testing (diff-scoped)
        run: |
          gremlins unleash --diff origin/main ./pkg/... | tee gremlins.out
          # Fail if efficacy < 80% (enforced by threshold in .gremlins.yaml)
        continue-on-error: true  # advisory on first adoption; flip to false once scores stabilize
`
}
```

### 5.2 Fuzz Corpus Management

The fuzz corpus grows with every CI run that discovers new interesting inputs, and without management it inflates the repository and slows the seed-corpus pass of every ordinary `go test` run.

First, be clear about what Go does and does not give you here, because this trips people up. `-fuzzminimizetime` does **not** minimize your corpus. It bounds how long the fuzzer spends shrinking a single *failing* input before writing it to `testdata/fuzz/`. Go ships no corpus-minimization command at all. Nor does it deduplicate by coverage fingerprint for you. Anything beyond "commit the crashers" is a thing you build.

So keep the two corpora straight. The committed corpus in `testdata/fuzz/<FuzzName>/` is small, hand-curated, and made of seeds plus every crasher ever found. It is a regression suite, and it should stay lean enough that `go test ./...` does not notice it. The generated corpus in `$GOCACHE/fuzz/` is large, machine-local, and disposable. Cache it as a CI artifact if you want warm starts, but never commit it.

The helper below covers the one piece worth automating: adding a crasher to the committed corpus, named by content hash so the same input is never stored twice.

```go
package fuzz_corpus

import (
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
)

// CorpusManager handles fuzz test corpus persistence and seeding.
type CorpusManager struct {
	baseDir string
}

func NewCorpusManager(baseDir string) *CorpusManager {
	return &CorpusManager{baseDir: baseDir}
}

// AddToCorpus saves a crashing input to the corpus for regression testing.
func (cm *CorpusManager) AddToCorpus(fuzzTarget, data string) error {
	dir := filepath.Join(cm.baseDir, "testdata/fuzz", fuzzTarget)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}

	// Name the file after the content hash, so re-adding the same crasher is
	// idempotent. Go's own fuzzer names corpus files this way too.
	hash := fmt.Sprintf("%x", sha256.Sum256([]byte(data)))[:16]
	path := filepath.Join(dir, hash)

	// Corpus entries use the Go fuzz file format. Note the string(...) line:
	// this helper only handles targets whose f.Fuzz signature takes a single
	// string. A []byte target needs []byte("..."), and a multi-argument
	// target needs one line per argument, in signature order.
	content := fmt.Sprintf("go test fuzz v1\nstring(%q)\n", data)
	return os.WriteFile(path, []byte(content), 0o644)
}

// ListCorpus returns all entries for a fuzz target.
func (cm *CorpusManager) ListCorpus(fuzzTarget string) ([]string, error) {
	dir := filepath.Join(cm.baseDir, "testdata/fuzz", fuzzTarget)
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var files []string
	for _, e := range entries {
		if !e.IsDir() {
			files = append(files, filepath.Join(dir, e.Name()))
		}
	}
	return files, nil
}
```

### 5.3 The CI time budget

Advanced testing strategies compete with the rest of CI for wall-clock time, and budget discipline is what keeps the suite useful. A rough target: PR CI under 10 minutes end-to-end. Within that budget, allocate roughly 60 percent to unit and integration tests, 15 percent to property and fuzz regression tests, 15 percent to mutation testing in diff mode, and 10 percent headroom. Tests that cannot fit in this budget belong in a nightly or release-candidate job, not in PR CI. Engineers who wait 45 minutes for CI stop caring what the result says. Engineers who wait 8 minutes engage with every failure. The budget is the operational constraint, and every new test that lands in CI must earn its place or displace something else. Staff engineers who enforce this budget keep the suite healthy. Those who let it slide end up owning a CI pipeline nobody reads.

### 5.4 Junior → FAANG: how to add a test type to your team's CI

If you want to add fuzzing or property testing to your team's CI, walk this four-step rollout. Step one: write one fuzz target or property test against a high-value function in your codebase. Demonstrate it locally and capture a real bug it found. Step two: add it to CI with a conservative time budget (30 seconds per fuzz target). Monitor how often it fires. Step three: after a month of stability, propose adding more targets and extending the budget. Bring data on bugs found. Step four: after a quarter, write up the pattern in a team-wide document and encourage other engineers to adopt it. This rollout approach works because it builds social proof incrementally rather than demanding a big-bang adoption. It is also the pattern an interviewer is probing for when they ask "how have you influenced your team's engineering practices?"

### 5.5 Senior @ FAANG: the OSS-Fuzz case for public code

For any Go library you maintain that is publicly consumed, apply to OSS-Fuzz. Google runs it continuously on dedicated infrastructure at zero cost to maintainers. It finds crashers that your local fuzz budget would never surface, and it reports them responsibly through a disclosure process that gives you time to fix before they become public CVEs. The onboarding cost is a few hours. The payoff is continuous security review on infrastructure you do not pay for. If you maintain a parser, decoder, cryptographic primitive, or protocol implementation that has external users, the question is not whether to onboard to OSS-Fuzz. It is why you have not yet. Staff engineers responsible for open-source libraries should treat OSS-Fuzz onboarding as a baseline hygiene task.

---
