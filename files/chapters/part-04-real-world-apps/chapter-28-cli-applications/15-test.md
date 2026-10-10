## Test
```makefile
test: ## Run tests
	$(GOTEST) -v -race -coverprofile=coverage.out ./...

test-integration: ## Run integration tests
	$(GOTEST) -v -tags=integration ./...

coverage: test ## Generate coverage report
	$(GOCMD) tool cover -html=coverage.out -o coverage.html
```

### Junior to FAANG: test targets in practice

`-race` is always on in CI. Race conditions in CLIs bite when spinners, progress bars, and concurrent fetches overlap. A CLI without `-race` in its test pipeline has undiscovered bugs waiting to surface. `-coverprofile` gives you `coverage.out` which `go tool cover -html` turns into an inspectable HTML report. Aim for 80 percent on business logic, less on `cmd/` glue.

Integration tests via build tags. The `//go:build integration` tag keeps slow tests out of `go test ./...`. They run in a separate CI job. This pattern is standard. Use it.

### Senior at FAANG: test targets as quality gates

Staff concerns. The Makefile should name the gates explicitly. `test-unit` for fast in-process tests. `test-integration` for compiled-binary tests. `test-e2e` for tests that talk to a staging environment. `test-contract` for schema validation of machine output. `test-fuzz` for fuzz runs with a time budget. `test-bench` for benchmarks with regression detection.

Coverage as signal, not target. A 95 percent coverage number can hide missing assertions. Review coverage of new code in PRs, not total coverage of the repo. The staff rule. Untested code paths in error handling are bugs waiting to happen. Insist on tests for error returns, not just happy paths.

Flaky test budget. Track flakiness per test. Quarantine tests that fail more than 2 percent. Deletion is acceptable if the test has been flaky for a month and no one is fixing it. An untested feature is better than a flaky test that teaches contributors to ignore red CI.

Cross-platform test matrix orchestration. Use `reusable workflows` in GitHub Actions to run the same test suite on Linux, macOS, and Windows without duplicating the YAML. Staff engineers who skip this end up with copy-paste workflows that drift over time.

Contract test integration. Before release, run a contract test suite that validates every `-o json` output against its schema. Fail the release if any schema changed without a version bump. This is the enforcement mechanism for output compatibility.

