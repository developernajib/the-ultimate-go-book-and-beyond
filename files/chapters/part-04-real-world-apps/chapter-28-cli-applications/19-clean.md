## Clean
```makefile
clean: ## Remove build artifacts
	rm -f $(BINARY_NAME)
	rm -rf dist/
	rm -f coverage.out coverage.html
```

### Junior to FAANG: safe clean targets

`make clean` must only remove generated artifacts. It must never touch source, config, or user data. Use explicit file patterns, never `rm -rf *`. A Makefile with `rm -rf` on a dynamic variable is a footgun waiting to delete a contributor's home directory when `$(BINARY_NAME)` is empty.

Better pattern. Set a variable to a tracked directory and remove only that. Guard with a check.

```makefile
DIST_DIR=dist
clean:
	@test -n "$(DIST_DIR)" || (echo "DIST_DIR empty, refusing to clean"; exit 1)
	rm -rf $(DIST_DIR)
```

This defense saves you exactly once. That once is enough.

### Senior at FAANG: clean targets as hygiene

Staff concerns. The clean target is the canary for Makefile hygiene. A well-run Makefile has. `clean` removes build artifacts. `clean-cache` removes the Go build cache. `clean-test` removes coverage files. `clean-deps` removes vendored modules. `distclean` removes everything including generated docs. Each target is scoped and safe.

Tempfile management. Tests that create temp files must register them with `t.TempDir()` for automatic cleanup. A test suite that pollutes `/tmp` is a staff-level review rejection. Clean targets should not be responsible for test fallout.

CI artifact lifecycle. Build artifacts in CI have retention policies. Keep release artifacts forever. Keep nightly builds for 30 days. Keep PR builds for 7 days. GitHub Actions has a retention setting. Without explicit policy, storage bills grow unbounded.

Cache invalidation. The Go build cache can grow to tens of GB. On CI, bound it (`GOCACHE` with size cap via a cleanup cron). Locally, `go clean -cache` occasionally. A cache problem manifests as mysterious "stale build" bugs that no one can reproduce.

Reproducibility through cleanliness. The principle. From a clean checkout, `make build` must produce an identical binary to the CI release. If it does not, something is being read from global state (env var, file outside the repo, timestamp). Clean targets expose this by forcing rebuilds from zero.

