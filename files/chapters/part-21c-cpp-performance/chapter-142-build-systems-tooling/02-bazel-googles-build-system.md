## Bazel: Google's Build System

Bazel was open-sourced by Google in 2015 as a version of their internal Blaze build system. It powers virtually every major Google project: Search, Maps, Android, Chrome, TensorFlow, gRPC, and Abseil. At the scale of monorepos with millions of files and thousands of engineers, the properties Bazel guarantees are not optional features, they are survival requirements.

### Why Google Built Bazel

**Hermeticity**: A Bazel build cannot read files outside the declared sandbox. If your `BUILD` file does not declare a dependency on a header, the build fails, even if that header is physically present on disk. This eliminates the "it works on CI but not locally" class of failures caused by accidental transitive includes.

**Reproducibility**: Given the same inputs, a Bazel build produces byte-for-byte identical outputs. This is enforced by running each action in a sandbox with no access to environment variables, the system clock, or undeclared files.

**Incrementality**: Bazel's action graph is content-addressed. If you change one `.cpp` file, only that file and its dependents recompile. On a million-line codebase this reduces a "change one function" build from 20 minutes to 3 seconds.

**Remote caching and remote execution**: Build outputs are uploaded to a content-addressed cache. When a colleague builds the same commit, their machine downloads prebuilt artifacts rather than recompiling. With remote execution, actions run in a cluster, a 1000-action build runs in parallel across 100 machines.

### Core Concepts

| Concept | Meaning |
|---------|---------|
| Workspace | The root directory, identified by a `WORKSPACE` file |
| Package | A directory with a `BUILD` file |
| Target | A named buildable unit within a package (`//path/to/pkg:name`) |
| Rule | The type of target (`cc_library`, `cc_binary`, `cc_test`) |
| Label | A reference to a target (`//src/net:http_client`) |

### A Production BUILD File

A Bazel `BUILD` file declares targets as DAG nodes using `cc_library`, `cc_binary`, and `cc_test` rules, each listing its own `srcs`, `hdrs`, and `deps`. Bazel's hermetic sandbox and content-addressed cache mean that only targets whose transitive inputs have changed are rebuilt, giving reliable incremental builds even across machines in a distributed CI environment.
```python
# src/falcon/BUILD

load("@rules_cc//cc:defs.bzl", "cc_library", "cc_binary", "cc_test")

# ── Library ──────────────────────────────────────────────────────────────────
cc_library(
    name = "falcon",
    srcs = [
        "scheduler.cpp",
        "connection_pool.cpp",
        "request_parser.cpp",
    ],
    hdrs = [
        "include/falcon/scheduler.h",
        "include/falcon/connection_pool.h",
        "include/falcon/request_parser.h",
    ],
    includes = ["include"],
    copts = [
        "-std=c++20",
        "-Wall",
        "-Wextra",
        "-Werror",
    ],
    deps = [
        "//src/util:logging",
        "@abseil-cpp//absl/strings",
        "@abseil-cpp//absl/synchronization",
        "@com_github_fmtlib_fmt//:fmt",
    ],
    visibility = ["//visibility:public"],
)

# ── Binary ───────────────────────────────────────────────────────────────────
cc_binary(
    name = "falcon_server",
    srcs = ["main.cpp"],
    deps = [
        ":falcon",
        "@abseil-cpp//absl/flags:flag",
        "@abseil-cpp//absl/flags:parse",
    ],
)

# ── Tests ────────────────────────────────────────────────────────────────────
cc_test(
    name = "falcon_test",
    size = "small",     # small: <1min, medium: <5min, large: <15min
    srcs = [
        "scheduler_test.cpp",
        "parser_test.cpp",
    ],
    deps = [
        ":falcon",
        "@com_google_googletest//:gtest_main",
    ],
    # Tests run in a sandbox - declare any data files explicitly
    data = ["testdata/requests.json"],
)
```

### WORKSPACE: External Dependencies

Bazel pins external dependencies in the WORKSPACE (or MODULE.bazel) file with explicit versions and checksums, which is what makes its builds reproducible across machines and years.
```python
# WORKSPACE

workspace(name = "falcon_project")

load("@bazel_tools//tools/build_defs/repo:http.bzl", "http_archive")

# ── Google Test ──────────────────────────────────────────────────────────────
http_archive(
    name = "com_google_googletest",
    sha256 = "8ad598c73ad796e0d8280b082cebd82a630d73e73cd3c70057938a6501bba5d7",
    strip_prefix = "googletest-1.14.0",
    urls = ["https://github.com/google/googletest/archive/v1.14.0.tar.gz"],
)

# ── Abseil ───────────────────────────────────────────────────────────────────
http_archive(
    name = "abseil-cpp",
    sha256 = "59d2976af9d6ecf001a81a35749a6e551a335b949d34918cfade07737b9d93c5",
    strip_prefix = "abseil-cpp-20240116.1",
    urls = ["https://github.com/abseil/abseil-cpp/archive/20240116.1.tar.gz"],
)

load("@abseil-cpp//absl:workspace0.bzl", "abseil_workspace0")
abseil_workspace0()

# ── {fmt} ────────────────────────────────────────────────────────────────────
http_archive(
    name = "com_github_fmtlib_fmt",
    sha256 = "5dea48d1fcddc3ec571ce2058e13910a0d4a6bab4cc09a809d8b1dd1c88ae6f2",
    strip_prefix = "fmt-10.2.1",
    urls = ["https://github.com/fmtlib/fmt/archive/10.2.1.tar.gz"],
    build_file = "@//third_party:fmt.BUILD",
)
```

### Building and Testing

Bazel's `//src/falcon:falcon_server` syntax names targets by their repository-relative package path, making builds fully reproducible regardless of the current working directory. The `bazel test //...` wildcard runs every test in the repository, and Bazel skips any test whose inputs, including all transitive dependencies, haven't changed since the last cached result.
```bash
# Build a specific target
bazel build //src/falcon:falcon_server

# Build everything in the repo
bazel build //...

# Run all tests
bazel test //...

# Run tests matching a pattern
bazel test //src/falcon:falcon_test --test_output=streamed

# Build with remote caching (e.g., Buildbuddy or Google Cloud Storage)
bazel build //... \
  --remote_cache=grpcs://remote.buildbuddy.io \
  --remote_header=x-buildbuddy-api-key=${BUILDBUDDY_API_KEY}

# Build with remote execution (distributes across a cluster)
bazel build //... \
  --remote_executor=grpcs://remote.buildbuddy.io \
  --remote_header=x-buildbuddy-api-key=${BUILDBUDDY_API_KEY} \
  --jobs=200
```

### Platforms and Cross-Compilation

Bazel's platform system defines target architectures and toolchains declaratively. The example below registers two platforms and configures a cross-compilation toolchain for ARM64.
```python
# platforms/BUILD
platform(
    name = "linux_x86_64",
    constraint_values = [
        "@platforms//os:linux",
        "@platforms//cpu:x86_64",
    ],
)

platform(
    name = "linux_aarch64",
    constraint_values = [
        "@platforms//os:linux",
        "@platforms//cpu:aarch64",
    ],
)
```

```bash
# Cross-compile for ARM64
bazel build //src/falcon:falcon_server \
  --platforms=//platforms:linux_aarch64 \
  --crosstool_top=@arm_gcc_toolchain//:toolchain
```

### Bazel vs CMake

| Property | Bazel | CMake |
|----------|-------|-------|
| Build model | Hermetic sandbox | File-system based |
| Reproducibility | Guaranteed | Requires discipline |
| Remote execution | First-class | Requires distcc/icecc |
| Learning curve | High (Starlark, labels) | Medium (CMake DSL) |
| IDE integration | Good (IntelliJ, VS Code) | Excellent (most IDEs) |
| Open-source ecosystem | Growing | Dominant |
| Best for | Monorepos, 100+ engineers | Projects with external deps, OSS |

Bazel excels when you own the entire dependency graph (monorepo). CMake excels when your project must integrate with the broader OSS ecosystem where every library ships `CMakeLists.txt`. Most FAANG companies run Bazel internally and ship CMake for public-facing libraries, Abseil and gRPC support both.

---
