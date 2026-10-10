### CLAUDE.md Specification: Code Conventions

Code conventions come next, every rule here saves a review-round later:

```markdown
## Code Conventions
- All errors must be wrapped with %w and include context
- Use log/slog for all logging with structured fields
- Context must be the first parameter of every function that does I/O
- Use 'any' not 'interface{}'
- Use table-driven tests for all test files
- All database queries use parameterized queries via pgx
- No global mutable state - use dependency injection
```

### Junior → FAANG: Code Conventions as Go Maturity Checklist

This seven-item code conventions list is a Go maturity checklist. An engineer who follows all seven conventions consistently is writing idiomatic, production-quality Go. Each convention has a testable form: errors wrapping (errcheck linter), slog usage (no fmt.Print in non-main packages), context first parameter (custom linter or code review), `any` over `interface{}` (staticcheck), table-driven tests (code review), parameterized queries (SQL injection linter), no global mutable state (code review, race detector). Knowing not just the conventions but the enforcement mechanisms demonstrates Go ecosystem fluency.

### Senior @ FAANG: Code Conventions as Automated Quality Gate Configuration

At senior level, each convention in this list should be enforced by automated tooling, not just by code review. The goal is to move conventions from "things engineers must remember" to "things CI enforces automatically." Configure golangci-lint with the linters that enforce each convention, integrate golangci-lint into CI as a blocking check, and distribute the golangci-lint configuration as part of the team's service template. This configuration is the platform engineering work that makes the conventions real rather than aspirational.
