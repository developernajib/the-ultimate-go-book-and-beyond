## Build
```makefile
build: ## Build the application
	$(GOBUILD) $(LDFLAGS) -o $(BINARY_NAME) .

build-all: ## Build for all platforms
	@mkdir -p dist
	GOOS=darwin GOARCH=amd64 $(GOBUILD) $(LDFLAGS) -o dist/$(BINARY_NAME)-darwin-amd64 .
	GOOS=darwin GOARCH=arm64 $(GOBUILD) $(LDFLAGS) -o dist/$(BINARY_NAME)-darwin-arm64 .
	GOOS=linux GOARCH=amd64 $(GOBUILD) $(LDFLAGS) -o dist/$(BINARY_NAME)-linux-amd64 .
	GOOS=linux GOARCH=arm64 $(GOBUILD) $(LDFLAGS) -o dist/$(BINARY_NAME)-linux-arm64 .
	GOOS=windows GOARCH=amd64 $(GOBUILD) $(LDFLAGS) -o dist/$(BINARY_NAME)-windows-amd64.exe .
```

### Junior to FAANG: what the build targets teach

`build` compiles for the current host. `build-all` cross-compiles to five platforms. The `LDFLAGS` variable is where version metadata is injected via `-X main.Version=...`. This is how `mycli --version` reports the git tag without reading a VERSION file at runtime. Learn this trick once and you use it on every Go CLI you write.

Common pitfall. If you edit the Makefile and add a platform (say `linux/riscv64`), but do not test that the Go compiler supports that target with your dependency graph, the build silently produces a broken binary at release time. Always test a new platform locally first with `GOOS=target GOARCH=arch go build ./...` before adding to the matrix.

Interview entry point. "How does Go cross-compile from Mac to Linux?" Answer. Go's compiler is self-hosted and targets-agnostic. The `GOOS` and `GOARCH` env vars select the target. No external toolchain required unless CGO is enabled. This is one of Go's biggest selling points for CLI tooling versus C, Rust, or Zig (though Zig's cross-compilation is now comparable).

### Senior at FAANG: build matrix as policy

Staff concerns. The five-platform matrix is a minimum. Enterprise users will ask for `linux/386` (legacy embedded), `freebsd/amd64` (server ops), `linux/s390x` (mainframe), `linux/ppc64le` (IBM Power). Each platform is a CI cost and a support commitment. Staff decision. Publish a supported platforms matrix with tiers. Tier 1 (tested in CI, SLA on bug fixes). Tier 2 (built in CI, best-effort bug support). Tier 3 (user-built from source, no guarantees). Tiers let you add platforms without committing to them.

Build determinism requires pinned toolchain. Add `toolchain go1.27.1` to `go.mod` so every build uses the same compiler version. Two engineers on different Go versions produce different binaries. Without pinning, reproducibility is impossible and SLSA provenance is weak.

CI matrix cost optimization. Cross-compilation on a single Linux runner is fast. But native testing requires six runners. The staff tradeoff. Cross-compile all six targets on one fast Linux runner (under 5 minutes), then test each binary on its native OS (slower, parallel). GoReleaser supports this split.

Binary size enforcement. Add a CI step that runs `go tool nm` and fails if any binary exceeds the budget. Without enforcement, every dependency upgrade adds bytes and no one notices until users complain about download times.

Build cache and artifact cache. On CI, use `actions/cache` for `~/.cache/go-build` and `~/go/pkg/mod`. A cached build is 10 seconds, a cold build is 4 minutes. Over a year, this is thousands of CI minutes saved.

Supply chain for the build itself. The Go toolchain downloads modules on first build. In regulated environments, all downloads must go through an internal proxy (`GOPROXY=https://athens.corp`). The Makefile should set `GOPROXY`, `GOSUMDB`, and `GOPRIVATE` explicitly so builds do not depend on `proxy.golang.org` being reachable. This is a supply chain and an availability concern.

Build reproducibility verification. After a release, a second CI runner rebuilds the same commit and compares SHA-256 of outputs. Any difference is an incident. This verifies that the build is deterministic and that the CI runner itself was not compromised. Levels of SLSA require this.

