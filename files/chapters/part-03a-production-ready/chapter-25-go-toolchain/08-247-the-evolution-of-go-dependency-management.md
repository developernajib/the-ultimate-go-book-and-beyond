## 25.7 The Evolution of Go Dependency Management

Understanding Go's dependency management history helps you recognize legacy projects and understand why `go.mod` works the way it does.

**Era 1: GOPATH (2009-2015)**

- All Go code lived in a single `$GOPATH/src` directory tree
- `go get` downloaded packages directly into GOPATH with no versioning
- No lock files, no reproducible builds, since `go get` always fetched the latest commit
- Two developers could build the same project and get different results
- Worked for Google's monorepo workflow but failed for the broader ecosystem

**Era 2: Vendoring Tools (2015-2018)**

- Community tools emerged to solve the versioning gap: `godep`, `govendor`, `glide`, `dep`
- Go 1.5 introduced the `vendor/` directory, allowing projects to commit dependencies
- `dep` (2017) was the official experiment, using `Gopkg.toml` and `Gopkg.lock`
- Still required GOPATH, no standard across tools, fragmented ecosystem
- Projects from this era have `Gopkg.toml`, `glide.yaml`, or `vendor/` without `go.mod`

**Era 3: Go Modules (2018-present)**

- Go 1.11: `go mod` introduced as experimental (`GO111MODULE=auto`)
- Go 1.13: modules enabled by default for projects with `go.mod`
- Go 1.16: `GO111MODULE=on` became the permanent default
- `go.mod` + `go.sum` provide reproducible builds, semantic versioning, and checksum verification
- Minimum Version Selection (MVS), unique to Go, avoids "dependency hell" by always choosing the minimum version that satisfies all constraints
- Module proxy (`GOPROXY`) and checksum database (`GOSUMDB`) add supply-chain security

One nuance worth carrying forward: `vendor/` did not die with the vendoring era. It is a supported, first-class mode alongside modules, and since Go 1.14 the toolchain uses it automatically. If a `vendor/` directory exists and your `go.mod` declares Go 1.14 or later, `go build` and `go test` default to `-mod=vendor` and never touch the network or the module cache. That surprises people twice over: once when a stale `vendor/` silently shadows the dependency they just added to `go.mod`, and once when they discover the fix is either `go mod vendor` to refresh it or `-mod=mod` to bypass it for a single command. What the legacy tooling left behind is `Gopkg.toml` and `glide.yaml`, not the directory itself.

```bash
# Migrating a legacy project to Go modules
cd /path/to/legacy-project
go mod init github.com/org/project    # creates go.mod
go mod tidy                            # resolves and downloads dependencies
rm -rf vendor/ Gopkg.toml Gopkg.lock  # clean up legacy files (after verifying builds)
```

> **Key point:** If you encounter a project with `Gopkg.toml`, `glide.yaml`, or a `vendor/` directory without `go.mod`, it needs migration to Go modules. Run `go mod init` followed by `go mod tidy` to migrate.

### Staff Lens: Modules Are the Only Choice

Legacy dependency managers are deprecated. New projects use Go modules. Migration is straightforward and eliminates years of tooling debt.

---
