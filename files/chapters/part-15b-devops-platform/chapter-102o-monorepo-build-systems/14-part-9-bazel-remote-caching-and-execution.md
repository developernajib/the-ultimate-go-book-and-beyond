## 102O.12 Bazel Remote Caching and Execution

Remote caching is the single most impactful improvement available to a large monorepo CI pipeline. Instead of recompiling the same artifact on every PR, every worker checks a shared cache keyed by a cryptographic hash of all inputs. A cache hit means zero compilation time for that target.

### Remote Cache Architecture

```
Developer / CI Worker
        |
        | (check cache key)
        v
  Remote Cache Server  <----->  Object Storage (GCS / S3 / minio)
        |
        | (miss: upload result)
        v
  Bazel Build Engine
```

The cache key is a hash of: source files, toolchain version, environment variables explicitly passed to the build, and BUILD file contents. This is what makes Bazel builds **hermetic** - the same inputs always produce the same outputs, and outputs are safely sharable.

### Self-Hosted Remote Cache with Bazel

The simplest remote cache is a plain HTTP server that implements the Bazel remote cache protocol (a subset of the Remote Execution API). `bazel-remote` is the canonical open-source implementation.

```bash
# Run bazel-remote with local disk storage
docker run \
  -v /data/bazel-cache:/data \
  -p 9090:9090 \
  buchgr/bazel-remote-cache \
  --dir /data \
  --max_size 50  # GB
```

Point Bazel at it in `.bazelrc`:

```ini
# .bazelrc
build --remote_cache=http://cache.internal:9090
build --remote_upload_local_results=true

# Use TLS in production
build:ci --remote_cache=grpcs://cache.internal:9092
build:ci --remote_header=x-build-token=${BAZEL_CACHE_TOKEN}
```

### BuildBuddy and EngFlow (Managed Solutions)

For teams that don't want to operate their own cache server, managed solutions provide a drop-in replacement with a web UI for cache analytics.

```ini
# .bazelrc - BuildBuddy
build:remote --remote_cache=grpcs://remote.buildbuddy.io
build:remote --remote_executor=grpcs://remote.buildbuddy.io
build:remote --remote_header=x-buildbuddy-api-key=${BUILDBUDDY_API_KEY}
build:remote --jobs=200  # concurrent remote actions
```

BuildBuddy's UI shows per-action timing, cache hit rates by target type, and an invocation trace view similar to a Gantt chart.

### Measuring Cache Hit Rates

Bazel prints a summary after each build. Parse it in CI to track regression:

```bash
bazel build //... 2>&1 | tee /tmp/bazel-output.txt

# Extract cache stats
grep -E "Remote|local" /tmp/bazel-output.txt
# Output example:
# INFO: 1,247 processes: 1,102 remote cache hit, 98 internal, 47 linux-sandbox.
```

Target a cache hit rate above 90% on the second run of any unchanged branch. If hit rates drop, common causes are:

- Non-deterministic source files (embedded timestamps, random UUIDs in codegen)
- Toolchain changes not captured in the cache key
- Environment variables leaking into actions

### Hermetic Builds: Achieving Determinism

A hermetic build produces the same output byte-for-byte given the same inputs, regardless of which machine or time it runs. This is the prerequisite for correct remote caching.

```python
# BUILD - hermetic Go binary rule
go_binary(
    name = "api-server",
    srcs = glob(["*.go"]),
    deps = [
        "//internal/config",
        "//internal/server",
        "@com_github_gin_gonic_gin//:gin",
    ],
    # Explicitly declare all data files - no implicit filesystem access
    data = ["//configs:default.yaml"],
    # Force pure Go (no CGO) for hermetic cross-compilation
    pure = "on",
    static = "on",
)
```

Avoid these common sources of non-determinism:

| Source | Problem | Fix |
|--------|---------|-----|
| `time.Now()` in codegen | Output changes every run | Accept timestamp as a parameter |
| `os.Getenv` in `go:generate` | Machine-specific output | Pass env vars explicitly via Bazel |
| Map iteration order | Non-deterministic output | Use sorted keys |
| CGO with host libraries | Different .so versions | Use `pure = "on"` or hermetic toolchain |

### Gazelle: Automated BUILD File Generation

Writing BUILD files by hand for hundreds of Go packages is impractical. Gazelle generates and updates them from `go.mod` and import analysis.

```bash
# Install Gazelle
go install github.com/bazelbuild/bazel-gazelle/cmd/gazelle@latest

# Import all external Go deps into WORKSPACE
gazelle update-repos \
  -from_file=go.mod \
  -to_macro=deps.bzl%go_dependencies \
  -prune

# Generate or update BUILD files for all Go packages
gazelle fix ./...

# Check what would change (dry run)
gazelle diff ./...
```

Keep Gazelle in CI to detect BUILD files that are out of sync:

```yaml
# .github/workflows/bazel-check.yml
- name: Check BUILD files are up to date
  run: |
    gazelle diff ./...
    if [ $? -ne 0 ]; then
      echo "BUILD files are out of sync. Run: gazelle fix ./..."
      exit 1
    fi
```

A typical WORKSPACE setup for a Go monorepo:

```python
# WORKSPACE
workspace(name = "mycompany_monorepo")

load("@bazel_tools//tools/build_defs/repo:http.bzl", "http_archive")

# Go rules
http_archive(
    name = "io_bazel_rules_go",
    sha256 = "...",
    urls = ["https://github.com/bazelbuild/rules_go/releases/download/v0.44.0/rules_go-v0.44.0.zip"],
)

# Gazelle
http_archive(
    name = "bazel_gazelle",
    sha256 = "...",
    urls = ["https://github.com/bazelbuild/bazel-gazelle/releases/download/v0.35.0/bazel-gazelle-v0.35.0.tar.gz"],
)

load("@io_bazel_rules_go//go:deps.bzl", "go_register_toolchains", "go_rules_dependencies")
go_rules_dependencies()
go_register_toolchains(version = "1.22.0")

load("@bazel_gazelle//:deps.bzl", "gazelle_dependencies")
load("//:deps.bzl", "go_dependencies")
go_dependencies()
gazelle_dependencies()
```

### Remote Execution: Distributed Builds Across 100 Workers

Remote execution (RBE) takes remote caching further - instead of just caching results, Bazel sends action descriptions to a pool of remote workers that execute them in parallel. The local machine becomes an orchestrator.

```ini
# .bazelrc - Remote Execution
build:rbe --remote_executor=grpcs://rbe.buildbuddy.io
build:rbe --remote_cache=grpcs://rbe.buildbuddy.io
build:rbe --jobs=500          # concurrent remote actions
build:rbe --remote_timeout=3600
build:rbe --build_event_publish_all_actions

# Toolchain for remote Linux workers (even if your dev machine is macOS)
build:rbe --extra_execution_platforms=@buildbuddy_toolchain//:platform
build:rbe --host_platform=@buildbuddy_toolchain//:platform
build:rbe --platforms=@buildbuddy_toolchain//:platform
```

With RBE on a large monorepo, wall-clock build time is bounded by the critical path length, not total work. Google's internal build system (Forge/RBE) achieves sub-5-minute CI for their >100K file monorepo by running hundreds of thousands of actions in parallel. The key insight: 10,000 independent test actions that each take 30 seconds complete in ~30 seconds of wall time with 500 workers, not 83 hours.

### Bazel in GitHub Actions with Parallel Test Sharding

GitHub Actions' `matrix` strategy can split a Bazel test run across multiple runners without any custom orchestration. Bazel's `--shard_count` and `--shard_index` flags deterministically partition the full test target list so each runner executes a non-overlapping slice. Combined with a shared remote cache, a runner only recompiles targets that changed since the last green build, making each shard fast regardless of total repo size.

```yaml
# .github/workflows/bazel-ci.yml
name: Bazel CI

on: [push, pull_request]

jobs:
  build-and-test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        shard: [0, 1, 2, 3]  # 4 parallel shards
    steps:
      - uses: actions/checkout@v4

      - name: Mount Bazel cache
        uses: actions/cache@v4
        with:
          path: |
            ~/.cache/bazel
            ~/.cache/bazelisk
          key: bazel-${{ runner.os }}-${{ hashFiles('WORKSPACE', 'deps.bzl') }}
          restore-keys: bazel-${{ runner.os }}-

      - name: Install Bazelisk
        run: |
          curl -Lo /usr/local/bin/bazel \
            https://github.com/bazelbuild/bazelisk/releases/latest/download/bazelisk-linux-amd64
          chmod +x /usr/local/bin/bazel

      - name: Run tests (shard ${{ matrix.shard }} of 4)
        env:
          BUILDBUDDY_API_KEY: ${{ secrets.BUILDBUDDY_API_KEY }}
        run: |
          bazel test \
            --config=ci \
            --test_output=errors \
            --test_sharding_strategy=explicit \
            --runs_per_test=1 \
            --shard_count=4 \
            --shard_index=${{ matrix.shard }} \
            //...
```

Cache between PRs by using a read-only remote cache token for PRs and a read-write token for the main branch:

```yaml
      - name: Set cache permissions
        run: |
          if [ "${{ github.ref }}" = "refs/heads/main" ]; then
            echo "CACHE_FLAGS=--remote_upload_local_results=true" >> $GITHUB_ENV
          else
            echo "CACHE_FLAGS=--remote_upload_local_results=false" >> $GITHUB_ENV
          fi

      - name: Bazel build
        run: bazel build ${{ env.CACHE_FLAGS }} //...
```

### Junior → FAANG: Understanding Cache Hit Rates as a Health Signal

The most important number in a Bazel-based CI system is the remote cache hit rate. A rate above 90% means your CI is fast and your builds are hermetic. A rate below 70% means engineers are waiting for builds that should be instant, and the root cause is almost always non-determinism: timestamps in generated code, environment variables leaking into actions, or map iteration order in a codegen tool.

The practical habit: after any change to a generator, toolchain, or environment variable in CI, check the cache hit rate on the next few builds. A sudden drop is a diagnostic signal, not a random fluctuation. The non-determinism table in this section (timestamps, `os.Getenv` in generators, map iteration, CGO host libraries) is a checklist to work through when hit rates drop unexpectedly.

For interviews: "what is Bazel's remote cache, and why does it require hermetic builds?" The answer is content-addressed caching: the cache key is a hash of all inputs, so the same inputs on any machine retrieve the same cached output. Non-determinism breaks this because the same source files produce different binaries on different machines or at different times, causing cache misses.

### Senior @ FAANG: Remote Cache as Infrastructure with an SLO

A remote cache server is a piece of infrastructure with the same operational requirements as a database or message queue. It needs uptime monitoring, capacity planning, backup and recovery for cache warming data, and a defined behavior when it is unavailable (Bazel should fall back to local builds, not fail CI entirely). Without these operational controls, a remote cache that was "set up once" will degrade silently until engineers start complaining about slow builds.

The cache hit rate SLO is the key metric. A reasonable target: 85% hit rate on PRs against main within 24 hours of any main branch build. This requires that the main branch CI populates the cache on every merge, and that PR builds use read-only access to that populated cache. Implementing token-scoped read/write (main branch gets write access, PRs get read-only) prevents the cache poisoning scenario where a flawed PR build uploads incorrect artifacts to the shared cache.

The capacity planning question appears in L6 system design interviews: "how do you size a remote build cache for a 500-engineer organization with 1,000 PRs per day?" The key factors are artifact size distribution (Go binaries are typically 30-100 MB each, test result caches are smaller), cache eviction policy (content-addressed stores typically use LRU by access time), and write throughput during peak CI hours (typically a 2-3x spike during business hours in each timezone). A reasonable starting point is 2TB of storage with LRU eviction, scaled up as the p95 hit rate falls below the SLO. Publishing this analysis as a capacity plan document is the staff-level deliverable that supports the infrastructure budget request.

---
