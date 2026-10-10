## 102O.8 Linting and Code Standards

### golangci-lint Configuration

`golangci-lint` aggregates dozens of Go linters into a single fast runner that parallelizes analysis and caches results between runs. Configuring it via `.golangci.yml` at the repository root ensures every developer and CI job uses identical linter settings. Enabling `staticcheck` catches deprecated API usage and potential bugs. `gosec` flags security anti-patterns like weak cryptography and unsafe input handling. `revive` enforces naming and style conventions. The configuration below represents a production-ready baseline that catches real bugs without generating excessive false positives.

```yaml
# .golangci.yml
run:
  timeout: 10m
  go: '1.22'

linters:
  enable:
    - errcheck
    - gosimple
    - govet
    - ineffassign
    - staticcheck
    - unused
    - gofmt
    - goimports
    - revive
    - gosec
    - godot
    - misspell
    - nolintlint
    - bodyclose
    - contextcheck
    - exhaustive
    - forcetypeassert
    - gocritic
    - goerr113
    - wrapcheck
    - cyclop

linters-settings:
  cyclop:
    max-complexity: 15
    package-average: 10.0

  gocritic:
    enabled-tags:
      - diagnostic
      - performance
      - style

  revive:
    rules:
      - name: exported
        severity: warning
      - name: error-return
        severity: error

  wrapcheck:
    ignoreSigs:
      - .Errorf(
      - errors.New(
      - errors.Unwrap(
      - .Wrap(
      - .Wrapf(

issues:
  exclude-rules:
    - path: _test\.go
      linters:
        - gosec
        - errcheck

  max-issues-per-linter: 50
  max-same-issues: 5
```

### Junior → FAANG: Building the Habit of Local Linting Before Push

The most common junior mistake with linting is treating it as a CI concern rather than a local development concern. If you push code and wait for `golangci-lint` to run in CI before seeing errors, you are wasting 5-10 minutes per iteration cycle. Install `golangci-lint` locally and run it before every push. Better: configure your editor (VS Code, GoLand, Neovim) to run `staticcheck` and `govet` on save. These two alone catch the majority of real bugs that linting finds.

Understanding which linters catch what is worth the investment. `errcheck` catches silently ignored errors (the most common real bug in Go code). `gosec` catches security anti-patterns like `math/rand` used for secrets or `os.MkdirAll` with overly permissive modes. `wrapcheck` ensures you wrap errors with context before returning them across package boundaries. Each of these corresponds to a category of code review comment you will stop receiving once you internalize the rule.

For interviews: if asked "how do you maintain code quality in a large Go codebase?", `golangci-lint` with a team-agreed configuration checked into the repository is the canonical answer. The key detail is "team-agreed and checked in": lint configuration as a PR-approved artifact prevents individuals from disabling linters they find inconvenient.

### Senior @ FAANG: Linting as an Enforcement Layer for Architectural Rules

At FAANG scale, `golangci-lint` is not just a code quality tool. It is an architectural enforcement layer. Custom linters (written using the `analysis` framework from `golang.org/x/tools/go/analysis`) can enforce rules that no general-purpose linter knows about: "packages under `internal/platform/` must not import from `services/`," "all HTTP handlers must call the request logging middleware," "context must be the first argument to any function that accepts it." These rules encode architectural decisions that would otherwise live only in documentation or code review comments.

The governance question is: who owns the linter configuration, and what is the process for adding or removing a linter? At organizations where the `.golangci.yml` is effectively owned by whoever opens the next PR modifying it, linter configuration drifts toward the lowest common denominator: linters that generate false positives get disabled by whoever is annoyed by them, and new linters never get added because no one is responsible for evaluating them. The solution is a platform team that owns the configuration with a defined RFC process for changes: any proposed linter change is evaluated on a sample of the current codebase, the false positive rate is measured, and the decision is documented in the ADR log. This is what "linting as a platform product" looks like versus "linting as a configuration file."

---
