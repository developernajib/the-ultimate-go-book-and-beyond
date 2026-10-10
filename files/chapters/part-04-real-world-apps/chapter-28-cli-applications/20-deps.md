## Deps
```makefile
deps: ## Download dependencies
	$(GOMOD) download

deps-update: ## Update dependencies
	$(GOMOD) tidy
	$(GOGET) -u ./...
```

### Junior to FAANG: dependency hygiene

`go mod tidy` removes unused requires and adds missing ones. Run it before every PR. A `go.mod` with stale entries causes reviewers to guess why an import was added.

`go get -u ./...` upgrades everything to latest. Dangerous if done blindly. Some upgrades introduce breaking changes. The safer pattern. Upgrade one or two dependencies per PR, read the changelog, run tests, merge. Never upgrade everything in one shot unless you have strong test coverage.

Pin indirect dependencies too. `go.sum` pins every version. Commit it. Never `.gitignore` it. Without `go.sum`, reproducibility is lost, SLSA provenance is weak, and supply chain attacks go undetected.

Interview entry point. "What does `go mod verify` do?" It checks that the modules in your cache match the hashes in `go.sum`. A tampered download is detected. Combined with `GOSUMDB` which cross-checks hashes against Google's checksum database, Go has one of the strongest default supply chain guarantees of any language.

### Senior at FAANG: dependency governance

Staff concerns. Dependencies are the largest source of security, licensing, and binary size risk. Treat them as policy, not plumbing.

Allowlist of approved dependencies. For critical tools, maintain an allowlist. PRs adding new dependencies require review from the platform team. This prevents drive-by additions of leftpad-style micro-deps that become long-term liabilities.

Automated dependency updates with gating. Use Dependabot or Renovate to open PRs for dep updates. Configure to batch minor updates weekly, open security updates immediately. Every PR runs the full CI. A dep update that fails tests is reverted before merge. This is the 2026 baseline.

Vulnerability scanning. `govulncheck` in CI, updated daily. When a CVE drops, the CI breaks within 24 hours, forcing an upgrade or a justification. Track vulnerabilities per release. Ship a SECURITY.md that says "we patch critical CVEs within 7 days, high within 30, medium at next release."

Dependency size audit. `goweight` reports how many bytes each dependency adds. Review periodically. A dep adding 10 MB for one function is worth evaluating for replacement or vendoring just the needed piece.

License audit. `go-licenses` in CI. Allowlist (MIT, Apache-2.0, BSD-2, BSD-3). Blocklist (GPL, AGPL, SSPL for commercial distribution). New license requires legal review. Automate to keep legal from being a bottleneck.

Internal proxy. In regulated environments, all dependency downloads go through an internal proxy (Athens, JFrog, Sonatype). This enables offline builds, mirrors public repos in case of takedown, and audit-logs every module fetch. `GOPROXY=https://proxy.corp.com` in CI and developer docs.

Private module support. `GOPRIVATE=*.corp.com` tells Go to skip the checksum DB for private modules. Required for internal monorepos. Document in onboarding because new hires hit this on day one.

Dependency diversity. Avoid single-maintainer packages for core functionality. When `spf13/cobra` has two maintainers and one goes on leave, your framework risks stagnation. Staff engineers evaluate project health (commit frequency, open issue count, responsiveness to security reports) before adopting a dep.

Vendoring strategy. For critical tools, vendor dependencies (`go mod vendor`) and commit the `vendor/` directory. Tradeoffs. Larger repo, slower cloning, but full reproducibility even if a module disappears from the registry. `kubernetes/kubernetes` vendors. Your critical tools probably should too.

Transitive dependency minimization. Every import adds its transitive closure. Prefer small focused libraries over mega-frameworks. `spf13/viper` pulls 40 transitive deps. `knadh/koanf` pulls 5. Both do config. Size matters when multiplied across many CLIs.

SBOM generation as dep artifact. Every release produces an SBOM listing every direct and transitive dependency with versions and licenses. Attach to the release. When a new CVE is announced, you query your SBOM archive to answer "which versions of our tool are affected."

