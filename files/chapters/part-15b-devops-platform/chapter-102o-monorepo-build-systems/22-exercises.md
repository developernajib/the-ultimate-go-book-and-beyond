## Exercises

### Exercise 1: Go Workspace with Three Modules and a Shared Library

Set up a Go workspace with the following structure and verify that changes to the shared library are immediately visible to all services without publishing:

```
workspace-demo/
├── go.work
├── go.work.sum
├── libs/
│   └── logger/          # Shared structured logger
│       ├── go.mod
│       ├── logger.go
│       └── logger_test.go
├── services/
│   ├── api/             # HTTP API that uses logger
│   │   ├── go.mod
│   │   └── main.go
│   └── worker/          # Background worker that uses logger
│       ├── go.mod
│       └── main.go
└── Makefile
```

Requirements:
1. Initialize `go.work` with `go work init` and add all three modules.
2. The `logger` library should expose a `NewLogger(service string) *Logger` function that outputs structured JSON logs.
3. Both `api` and `worker` import `logger` using their `go.mod` module path (not a `replace` directive).
4. The `Makefile` should have targets: `build` (build all services), `test` (test all modules), `tidy` (run `go work sync` and `go mod tidy` in each module).
5. Verify: modify `logger.go` to add a new field to the log output, and confirm that both `api` and `worker` pick up the change without any `go get` commands.
6. Write a test in `libs/logger` that verifies the JSON output format using `encoding/json`.

Expected learning: understand how `go.work` replaces `replace` directives, how workspace-level dependency resolution works, and how `go.work.sum` is updated.

### Exercise 2: GitHub API Changelog Generator in Go

Write a self-contained Go program (`tools/changelog-gen/main.go`) that generates a `CHANGELOG.md` file by querying the GitHub API for merged PRs with conventional commit titles.

Requirements:

1. Accept `--owner`, `--repo`, `--from-tag`, `--to-tag` as CLI flags using the `flag` package.
2. Use `github.com/google/go-github/v60` to list merged PRs between two git tags (use the `CompareCommits` and `PullRequests.List` APIs).
3. Parse PR titles using conventional commit format (`feat:`, `fix:`, `feat!:`, etc.). Skip PRs that don't match.
4. Group PRs by type: Features, Bug Fixes, Breaking Changes, Performance.
5. Determine the next semantic version: if any PR has `feat!` or `BREAKING CHANGE`, bump major. If any `feat`, bump minor. Otherwise bump patch.
6. Write `CHANGELOG.md` with the new version, date, and grouped PR list with links.
7. Write unit tests for the conventional commit parser and the version bumping logic (mock the GitHub API client using an interface).
8. Handle rate limiting: check `github.Response.Rate` and sleep until reset if remaining < 10.

Example output (see Section 102O.18 for complete compliance breakdown):

```markdown
## [v2.1.0] - 2026-03-14

### Features
- **auth**: add OAuth2 PKCE flow (#142)
- **api**: support cursor-based pagination (#138)

### Bug Fixes
- **worker**: fix goroutine leak on context cancellation (#145)

### Performance
- **db**: add index on created_at column (#139)
```

### Junior → FAANG: Getting Maximum Value From These Exercises

Exercise 1 (Go workspace with three modules) is the highest-return exercise for interview preparation. Once you have completed it, you can answer "how does go.work work?" with a concrete example tested firsthand rather than a paraphrased description. Build the exercise, break it intentionally (remove a module from the workspace, add a conflicting dependency), observe what fails, and read the error messages carefully. Understanding failure modes is more valuable than understanding the happy path.

Exercise 2 (GitHub API changelog generator) teaches four skills that appear together in platform engineering interviews: GitHub API pagination, conventional commit parsing with regex, interface-based mocking for testability, and rate limit handling. The mocking requirement is the most important: writing a `GitHubClient` interface that both the real `github.NewClient` and your test double implement is the canonical pattern for writing testable code that depends on external APIs.

### Senior @ FAANG: Extending the Exercises to Production Scenarios

Exercise 1 becomes a production scenario when you add: a CI job that verifies `go work sync` produces no changes (catches cases where a developer added a dependency to one module without syncing the workspace), a Makefile target that runs `go mod tidy` across all modules in dependency order (not just in parallel, since a module that depends on another must be tidied after the other), and a pre-commit hook that prevents committing a `go.work` that references modules not present in the repository.

Exercise 2 becomes a production scenario when you add: a retry-with-backoff wrapper around all GitHub API calls (network failures are the most common cause of flaky release bots), a dry-run mode that prints what would happen without creating PRs or tags (essential for debugging in production environments), structured logging with correlation IDs (so you can trace a specific release bot invocation through your log aggregation system), and a dead letter queue for failed release attempts (so a transient GitHub API outage does not silently cause a service to accumulate unreleased changes indefinitely).



