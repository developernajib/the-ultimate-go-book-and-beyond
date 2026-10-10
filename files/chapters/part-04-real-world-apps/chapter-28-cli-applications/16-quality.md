## Quality
```makefile
lint: ## Run linter
	golangci-lint run ./...

fmt: ## Format code
	$(GOFMT) -s -w .

vet: ## Run go vet
	$(GOCMD) vet ./...
```

### Junior to FAANG: quality targets that matter

`golangci-lint` is the aggregator you want. It runs `gofmt`, `govet`, `staticcheck`, `errcheck`, `ineffassign`, `gosec`, and a dozen more in parallel. The config file `.golangci.yaml` at the repo root turns linters on or off. Start with the default set, not the full kitchen sink, because too many warnings train contributors to ignore them.

`gofmt -s` includes simplification rules that regular `gofmt` skips (redundant type conversions, unnecessary parens, etc). Run this in pre-commit. Code that is not `gofmt`-clean should not merge.

Interview entry point. "What linters do you run?" Name golangci-lint, gosec for security, and revive as an alternative to staticcheck. Explain why vet catches issues the compiler does not (printf format strings, suspicious struct tags, unreachable code).

### Senior at FAANG: quality as governance

Staff concerns. The linter config is a policy artifact owned by the platform team. Each rule has a rationale documented. When a rule produces false positives, the team decides whether to disable or fix. Unilateral rule changes in PRs are blocked.

Security linters as a separate gate. `gosec` catches hardcoded credentials, unsafe SQL queries, weak random. Run as a separate CI job, not as part of golangci-lint, because its findings are security-critical and should not be drowned in style warnings.

Custom linters for org conventions. `semgrep` or `go-ruleguard` can enforce org-specific rules. "No `os.Exit` outside main. No `fmt.Println` in internal packages (only logger or formatter). No import of `cmd/` from `internal/`." These rules codify what would otherwise be review-time comments and catch violations before review.

License compliance. Run `go-licenses` to verify every dependency's license. Block GPL and AGPL if your distribution is commercial. Flag new dependencies for legal review. This is a compliance requirement, not a nice-to-have.

Binary dependency audit. `govulncheck` scans your dependency graph against the Go vulnerability database. Add it to CI. Failing CI on a new CVE forces upgrades to be addressed quickly. `grype` and `trivy` scan compiled binaries for CVEs.

SBOM generation. `syft` generates an SBOM from a Go project. Attach to every release. This is how you answer "are we affected by CVE-X" in minutes rather than days.

Static analysis for output contracts. Custom linter that parses your Cobra tree and fails if any command lacks a Long description, has a flag without help text, or registers a `-o json` output without a schema. Codify UX rules as lint rules.

Maturity model for quality. Level 1. fmt and vet in CI. Level 2. golangci-lint with default rules. Level 3. gosec, govulncheck, go-licenses. Level 4. Custom org linters, contract tests, SBOM. Level 5. SLSA provenance, reproducible builds, cosign signing. Know where you are and where you want to be.

