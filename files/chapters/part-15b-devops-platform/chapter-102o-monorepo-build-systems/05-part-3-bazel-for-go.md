## 102O.3 Bazel for Go

Bazel is Google's open-source build system offering hermetic, reproducible, and incrementally-cached builds.

```python
# WORKSPACE (root)
load("@bazel_tools//tools/build_defs/repo:http.bzl", "http_archive")

# Go rules
http_archive(
    name = "io_bazel_rules_go",
    sha256 = "...",
    urls = ["https://github.com/bazelbuild/rules_go/releases/download/v0.44.0/rules_go-v0.44.0.zip"],
)

# Gazelle (auto-generates BUILD files)
http_archive(
    name = "bazel_gazelle",
    sha256 = "...",
    urls = ["https://github.com/bazelbuild/bazel-gazelle/releases/download/v0.35.0/bazel-gazelle-v0.35.0.tar.gz"],
)

load("@io_bazel_rules_go//go:deps.bzl", "go_register_toolchains", "go_rules_dependencies")
go_rules_dependencies()
go_register_toolchains(version = "1.22.0")

load("@bazel_gazelle//:deps.bzl", "gazelle_dependencies")
gazelle_dependencies()
```

```python
# services/user-service/BUILD.bazel
load("@io_bazel_rules_go//go:def.bzl", "go_binary", "go_library", "go_test")

go_library(
    name = "user-service_lib",
    srcs = ["main.go"],
    importpath = "github.com/myorg/user-service",
    visibility = ["//visibility:private"],
    deps = [
        "//shared/auth:auth",
        "//shared/database:database",
        "@com_github_gin_gonic_gin//:gin",
    ],
)

go_binary(
    name = "user-service",
    embed = [":user-service_lib"],
    visibility = ["//visibility:public"],
)

go_test(
    name = "user-service_test",
    srcs = ["main_test.go"],
    embed = [":user-service_lib"],
    deps = [
        "@com_github_stretchr_testify//assert",
    ],
)
```

```python
# shared/auth/BUILD.bazel
load("@io_bazel_rules_go//go:def.bzl", "go_library", "go_test")

go_library(
    name = "auth",
    srcs = glob(["*.go"], exclude = ["*_test.go"]),
    importpath = "github.com/myorg/shared/auth",
    visibility = ["//visibility:public"],
    deps = [
        "@com_github_golang_jwt_jwt_v5//:jwt",
    ],
)

go_test(
    name = "auth_test",
    srcs = glob(["*_test.go"]),
    embed = [":auth"],
)
```

```bash
# Build specific service
bazel build //services/user-service:user-service

# Build all
bazel build //...

# Test specific service
bazel test //services/user-service:user-service_test

# Test all
bazel test //...

# Generate BUILD files from go.mod (Gazelle)
bazel run //:gazelle

# Update dependencies in BUILD files
bazel run //:gazelle -- update-repos -from_file=go.mod -to_macro=deps.bzl%go_dependencies

# Build Docker image
bazel build //services/user-service:image
bazel run //services/user-service:push_image
```

### Bazel Remote Cache

Bazel's remote cache stores build and test action outputs on a shared backend. Google Cloud Storage, Amazon S3, or a hosted service like BuildBuddy. So that any machine reproducing the same inputs retrieves pre-computed results rather than recomputing them. The `.bazelrc` file is the conventional place to configure remote cache endpoints and authentication headers, ensuring every developer and CI agent uses the same settings without modifying individual `BUILD` files. Remote execution extends this further by offloading action execution itself to a cluster of workers, enabling true distributed compilation that scales with the size of the monorepo.

```python
# .bazelrc
# Remote cache configuration (use GCS, S3, or BuildBuddy)
build --remote_cache=grpcs://remote.buildbuddy.io
build --remote_header=x-buildbuddy-api-key=YOUR_KEY

# Or use GCS bucket
build --remote_cache=https://storage.googleapis.com/my-bazel-cache

# Enable remote execution (optional, for distributed builds)
build --remote_executor=grpcs://remote.buildbuddy.io

# Parallel jobs
build --jobs=8

# Show progress
build --show_progress_rate_limit=0.1

# Sandbox (default on Linux/Mac)
build --sandbox_tmpfs_path=/tmp
```

### Junior → FAANG: Learning Bazel Without Getting Overwhelmed

Bazel has a steep learning curve. The key insight that makes it manageable: Bazel BUILD files are just structured declarations of "what depends on what." You are not writing build logic. You are declaring targets and their dependencies. Once Gazelle generates your initial BUILD files, you rarely write them by hand. Your job is to understand what the generated files mean and how to run basic Bazel commands.

Start with these four commands and understand what each does before moving on: `bazel build //services/user-service:user-service` (build one target), `bazel test //...` (test everything), `bazel run //:gazelle` (regenerate BUILD files), and `bazel query "rdeps(//..., //shared/auth:auth)"` (find everything that depends on auth). These cover 90 percent of daily Bazel use.

The `.bazelrc` file is where you configure remote cache and execution. Think of it like a `.env` file for your build system. Settings in `.bazelrc` apply to all Bazel invocations in the repo, so changes there affect every developer and every CI job simultaneously.

### Senior @ FAANG: Bazel Adoption Strategy and Organizational Rollout

Adopting Bazel in an existing Go codebase is a multi-quarter migration, not a weekend project. The common failure mode is a "big bang" adoption where a platform team converts the entire repo to Bazel in a single PR, breaking every developer's local workflow simultaneously. The correct approach is a staged rollout with explicit exit criteria for each stage.

Stage one: add Bazel alongside `go build` without removing anything. CI runs both. Engineers can use either. Measure build times and cache hit rates with Bazel but do not gate deployments on it yet. This stage catches toolchain compatibility issues and identifies packages that have implicit filesystem dependencies that break Bazel's sandbox.

Stage two: require Bazel for CI on a pilot set of services (typically 3-5 high-traffic services with cooperative teams). Fix hermeticity issues that surface. Publish cache hit rate dashboards. Build internal documentation. This is where you discover that generated code checked into the repo sometimes has timestamps embedded in it, killing cache hit rates.

Stage three: migrate remaining services. Gate deployments on successful Bazel builds. Deprecate the parallel `go build` CI path. This stage requires a migration tool (often a script that adds missing BUILD file entries) and a support rotation for teams hitting Bazel-specific issues.

The governance concern that only appears at L6+: what is your Bazel version upgrade policy? Bazel major version upgrades break rule APIs and require coordinated updates to all BUILD files and the WORKSPACE. Without a defined upgrade policy (including who owns the upgrade, how long it takes, and what compatibility testing is required), Bazel versions drift across teams, making shared infrastructure impossible to maintain. Publish an internal Bazel version policy document before completing the migration.

### Junior → FAANG: Learning Bazel Without Being Overwhelmed

Bazel has a steep learning curve relative to `go build`. The key insight that reduces the learning surface: for Go specifically, you rarely write BUILD files by hand. Gazelle generates them from `go.mod` and `import` statements. Your day-to-day interaction with Bazel as a Go engineer is mostly `bazel build //services/myservice/...` and `bazel test //...`. The complexity lives in the WORKSPACE and in the Bazel rules, which the platform team maintains.

The concepts worth understanding early: the difference between a `go_binary`, `go_library`, and `go_test` rule. What `deps` means in a BUILD file (direct dependencies only, not transitive). And why hermeticity matters (builds are reproducible because inputs are fully declared). When Gazelle-generated BUILD files drift out of sync with the code (because someone added an import without running `gazelle update`), you will see an error about a missing dependency. The fix is `bazel run //:gazelle` or whatever alias the team has set up.

Interview entry point: explain Bazel as a build system that achieves hermetic, reproducible, and incrementally cached builds by requiring every build target to declare its inputs explicitly. Contrast with `go build ./...`, which discovers dependencies through the module graph but does not produce hermetically sealed artifacts.

### Senior @ FAANG: Cache Hit Rate as a Platform SLO and Migration Strategy

For a platform team owning Bazel in a large monorepo, cache hit rate is the primary KPI. A cache hit rate below 70% on incremental PR builds means CI is too slow and engineers are losing confidence in the build system. Cache hit rate degrades due to three main causes: non-deterministic build actions (timestamps embedded in generated code, random UUIDs in output artifacts), incomplete remote executor configuration (actions running locally bypass the remote cache), and missing `gazelle` runs causing spurious dependency changes.

Instrumenting cache hit rate requires reading from the Bazel build event protocol (BEP). The BEP emits a JSON stream of build events that includes action cache hit/miss data for every target. A platform service that reads BEP data and publishes per-target cache hit rates to a metrics store enables the team to identify which targets are consistently missing cache and investigate why.

The migration strategy from `go build` to Bazel follows a three-stage pattern that minimizes disruption. Stage one: run Bazel in parallel with `go build` without blocking CI on Bazel results. This surfaces hermeticity failures without breaking the build for engineers. At this stage, focus on getting Gazelle to generate correct BUILD files and fixing any generated code that has non-deterministic output.

Stage two: require Bazel for CI on a pilot set of services. Fix hermeticity issues that surface. Publish cache hit rate dashboards. Build internal documentation.

Stage three: migrate remaining services. Gate deployments on successful Bazel builds. Deprecate the parallel `go build` CI path.

The L7-level concern: after adoption, Bazel becomes load-bearing infrastructure for hundreds of engineers. Any outage in the remote cache or build event service directly impacts developer productivity. The platform team must treat the Bazel remote cache and BEP infrastructure with the same reliability posture as a production service: SLOs, on-call rotation, runbooks, and capacity planning for peak load (which correlates with merge freeze periods before major releases).

---
