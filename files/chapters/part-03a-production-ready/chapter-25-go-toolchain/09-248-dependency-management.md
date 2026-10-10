## 25.8 Dependency Management

### Upgrading Dependencies

Go's module system lets you upgrade dependencies with surgical precision, updating a single package to an exact version, bumping all transitive dependencies at once, or restricting upgrades to patch releases that are unlikely to introduce breaking changes. The `go list -m -u all` command is particularly useful for auditing your full dependency graph before committing to any upgrades.

```bash
# Update all dependencies
go get -u ./...

# Update specific dependency
go get -u github.com/lib/pq

# Update to specific version
go get github.com/lib/pq@v1.10.9

# Update patch versions only
go get -u=patch ./...

# Check for updates
go list -m -u all
```

### Vendoring

Vendoring copies all module dependencies into a local `vendor` directory, making builds fully reproducible without network access and ensuring CI environments use exactly the same source code you tested locally.

Since Go 1.14 you do not have to ask for it. If `vendor/` exists and `go.mod` says Go 1.14 or later, the toolchain defaults to `-mod=vendor` on its own, so `go build` silently reads the directory and never consults the module cache or the network. The flag is only worth writing when you want to be explicit, and `-mod=mod` is how you deliberately bypass a vendor directory for one command.

Be careful about what verifies what, because the obvious pairing is wrong. `go mod verify` checks the modules in your **local download cache** against their recorded hashes. It does not look at `vendor/` at all: corrupt a file under `vendor/` and `go mod verify` still cheerfully reports "all modules verified", while the build fails on the mangled source. What guards vendor consistency is `vendor/modules.txt`, which the toolchain cross-checks against `go.mod`, and the real CI test is to regenerate and diff.

```bash
# Create vendor directory
go mod vendor

# Build using vendor. Since Go 1.14 this is the default when vendor/ exists,
# so the flag is redundant unless you want it stated.
go build -mod=vendor

# Deliberately IGNORE vendor/ for one command
go build -mod=mod

# Verify the module CACHE against go.sum. Note: this says nothing about vendor/.
go mod verify

# The actual vendor drift check for CI: regenerate and diff.
go mod vendor
git diff --exit-code vendor/
```

### Pruning Unused Dependencies

Over time, removed imports leave stale entries in `go.mod` and `go.sum` that bloat your dependency graph and slow security audits. Running `go mod tidy` removes those orphaned entries and adds any missing ones, while `go mod why` lets you trace exactly which import path pulls in a package you suspect is no longer needed.

```bash
# Remove unused dependencies
go mod tidy

# Check for unused dependencies
go mod why -m github.com/some/package

# List all dependencies
go list -m all

# Produce an SBOM-friendly JSON view of the full graph
go list -m -json all
```

> **Senior track**: Gate `go mod tidy` in CI with `git diff --exit-code go.mod go.sum` after running it. Drift between committed and tidy state is a common source of non-reproducible builds and a supply-chain smell. Combine with `govulncheck ./...` on every PR to catch CVEs before they reach production.

### Staff Lens: Dependency Policy

Written policy: what kinds of dependencies accepted, approval process for new ones, audit cadence. Supply chain security starts with deliberate dependency selection.

---
