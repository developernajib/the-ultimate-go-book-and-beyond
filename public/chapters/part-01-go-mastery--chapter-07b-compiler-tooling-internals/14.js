export default `## 7B.12 Build Cache Internals

The Go build cache stores compiled packages so that unchanged code does not need to be recompiled. The cache is content-addressed: each entry is keyed by a hash of the compiler version, build flags, source file contents, and dependency outputs. When you run \`go build\`, the compiler checks this hash first and skips compilation if a matching result exists. This is why incremental builds in Go are fast, and understanding cache mechanics helps you diagnose unexpected recompilations.

\`\`\`bash
# Show cache location
go env GOCACHE

# Show cache info
go clean -cache -n  # dry run

# Clear cache
go clean -cache

# Cache is content-addressed:
# Key = hash(compiler version, flags, source files, dependencies)
# If key matches, skip recompilation
\`\`\`

### Optimizing Build Performance

Several techniques can speed up your Go builds. Go workspaces (\`go.work\`) allow multi-module development without \`replace\` directives, reducing unnecessary recompilation. Build tags can exclude expensive packages from regular builds. The \`-p\` flag controls parallelism, and precompiling the standard library with \`go install std\` warms the cache for all stdlib packages. Understanding these options is especially valuable in CI pipelines where build time directly affects developer feedback loops.

\`\`\`go
// go.work for multi-module development (faster than replace directives)
// go.work file:
// go 1.22
// use ./module1
// use ./module2
// use ./shared

// Build constraints to reduce compilation scope
// file: internal/expensive/only_when_needed.go
//go:build expensive

package expensive

// Build normally to skip this package
// go build -tags=expensive ./... to include it
\`\`\`

\`\`\`bash
# Parallel builds
go build -p 4 ./...  # use 4 CPU cores

# Show build timing
go build -v -a -x 2>&1 | head -100

# Module download cache
go env GOMODCACHE

# Precompile stdlib for faster builds
go install std
\`\`\`

### Remote Build Cache at Scale

For teams beyond a few engineers, a shared remote build cache is the highest-leverage CI investment. Options in 2026:

1. **Bazel with \`rules_go\`.** Full remote execution and cache. Heavy setup, powerful result.
2. **Bloaty-style cache shards.** Simpler: expose \`\$GOCACHE\` behind HTTP, let CI machines share. No first-class Go support but works.
3. **Hosted CI with cache persistence.** GitHub Actions, CircleCI, and others offer cached workspace directories. Good enough for small teams.

The effect: a cold build that takes 10 minutes becomes a warm build of 30 seconds. At team scale, this is hours of engineer time saved per week.

---
`;
