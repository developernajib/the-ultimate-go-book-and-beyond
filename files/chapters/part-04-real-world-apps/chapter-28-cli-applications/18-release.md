## Release
```makefile
release: ## Create release with goreleaser
	goreleaser release --clean

release-snapshot: ## Create snapshot release
	goreleaser release --snapshot --clean
```

### Junior to FAANG: release mechanics

`release` requires a git tag. `git tag v1.2.3 && git push --tags` triggers the release workflow. `release-snapshot` creates an unsigned unreleased set of artifacts for local testing. Use snapshots before tagging to catch build errors. Tagging in production without a snapshot test is how broken releases happen.

The `--clean` flag removes any previous `dist/` before starting. Always use it. Otherwise stale files from a prior release leak into the new one.

Never manually run `goreleaser release` from a developer laptop. It would require a GitHub token, cosign keys, and signing credentials on your machine. The right path. CI runs it. Your laptop runs snapshots.

### Senior at FAANG: release engineering as a discipline

Staff concerns. Release cadence, channels, and governance.

Cadence. Pick a schedule. Weekly or fortnightly for active tools. Monthly for mature tools. Communicate it. Skip releases if tests are red, never release with known regressions. `gh` releases roughly weekly. `kubectl` ships patch releases monthly with roughly quarterly minors.

Release channels. Stable, beta, nightly. Stable is tagged from `main` after canary. Beta is tagged from `main` with pre-release suffix (`v2.0.0-beta.1`). Nightly is rebuilt from HEAD every night with a date suffix. Users opt in. GoReleaser supports all three via separate configs.

Canary rollout. Before `v1.2.3` is promoted to stable, it runs as `v1.2.3-rc.1` for 48 hours. Dogfood internally. Monitor telemetry for error rate spikes. Auto-promote if clean. Auto-rollback if degraded. This prevents bad releases from reaching users.

Release notes automation. `goreleaser` generates release notes from commit messages. Use conventional commits (`feat:`, `fix:`, `breaking:`). Automated notes categorize changes. Users know what changed without reading diffs. Publish to GitHub Releases, your docs site, and a mailing list simultaneously.

Hotfix process. When a critical bug ships, the hotfix path is separate from the main release train. Cherry-pick to a release branch, tag a patch version, skip non-critical CI (with documented exception). The runbook must be written before you need it, because you will be stressed when you do.

Yank protocol. If a release is truly broken, yank it. Mark the GitHub release as a pre-release so "latest" points to the previous. Revert the Homebrew tap. Revert the Scoop manifest. Post an incident notice. Timeline matters. Aim for rollback under 30 minutes.

Release signing. Every artifact is signed with cosign via keyless OIDC from CI. The signature is attached to the GitHub release. Users can verify with `cosign verify-blob`. Document the verification procedure in your security docs. This is a SLSA level 3 requirement.

Provenance attestation. Every release includes a SLSA provenance file describing what source, what CI runner, and what toolchain produced the binary. Attach it. Users and security teams can audit the supply chain retrospectively.

Changelog governance. Maintain a `CHANGELOG.md` with `Keep a Changelog` format. Every release has an entry. Entries are reviewed as part of the release PR, not generated at tag time. The discipline forces authors to articulate user-visible change per PR.

Versioning RFC. When the time comes for a major version bump, publish an RFC 4 weeks before release. Document breaking changes, migration path, deprecation timeline for old version. Users plan upgrades. Surprises in major versions are trust-eroding.

Release retrospective. After every major release, retro. What went well. What broke. What to automate next. Log findings in a permanent document. Organizational memory compounds over years.

