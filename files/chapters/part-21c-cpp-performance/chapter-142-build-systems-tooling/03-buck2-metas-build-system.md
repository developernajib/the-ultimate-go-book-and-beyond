## Buck2: Meta's Build System

Meta open-sourced Buck2 in 2023 after several years of internal use. It replaced the original Buck (used since 2013) across Meta's entire monorepo, one of the largest in the world, containing code for Facebook, Instagram, WhatsApp, React Native, PyTorch, Folly, and dozens of internal infrastructure projects. The rewrite was motivated by performance bottlenecks in the original Buck's execution model and a desire for a cleaner, more extensible rule system.

### Why Meta Rewrote Buck

The original Buck used Java for its rules and build logic. At Meta's scale, hundreds of thousands of targets, thousands of concurrent engineers, the JVM startup time, memory overhead, and the difficulty of writing correct incremental rules in Java became limiting factors.

Buck2 addresses these with three architectural decisions:

1. **Starlark for all rules**: Starlark (the same language Bazel uses) is a deterministic, sandboxed subset of Python. Rules written in Starlark cannot have side effects, which makes them trivially memoizable and parallelizable.

2. **Rust execution engine**: The core of Buck2 is written in Rust. The action graph evaluation, file system watching, and critical path analysis are all implemented with Rust's ownership model preventing the data races that plagued the original Java implementation.

3. **Fully parallel action graph**: Buck2 evaluates the build graph as a DAG where every node that has its inputs available can execute immediately. There is no "phase" model, configuration, analysis, and execution overlap where possible.

### Core Concepts

C++20 concepts provide first-class syntax for expressing template constraints, replacing the SFINAE idiom with readable, compiler-enforced requirements. Constraints are checked at the call site, producing clear error messages when a type does not satisfy the required interface.
```
Meta Monorepo/
├── .buckconfig              # Workspace configuration
├── toolchains/
│   └── BUCK                 # Toolchain definitions
├── third-party/
│   ├── BUCK                 # Third-party library targets
│   └── ...
└── src/
    └── falcon/
        ├── BUCK             # Package build file
        ├── include/
        └── *.cpp
```

**Cell**: A directory tree with its own `.buckconfig`. A monorepo typically has one root cell plus cells for large external dependencies.

**Target pattern**: `//src/falcon:falcon_lib`, cell-relative path from the root, colon, target name.

### A Production BUCK File

Buck2 `BUCK` files use Starlark rules like `cxx_library` and `cxx_binary`, with the same explicit `srcs`/`deps` declaration model as Bazel but driven by Buck2's async, Rust-based execution engine. The `visibility` attribute enforces module boundaries at the build-system level, preventing libraries from being consumed outside their intended scope without a deliberate policy change.
```python
# src/falcon/BUCK

load("@prelude//cxx:cxx.bzl", "cxx_library", "cxx_binary", "cxx_test")

# ── Library ──────────────────────────────────────────────────────────────────
cxx_library(
    name = "falcon_lib",
    srcs = [
        "scheduler.cpp",
        "connection_pool.cpp",
        "request_parser.cpp",
    ],
    headers = {
        "falcon/scheduler.h":        "include/falcon/scheduler.h",
        "falcon/connection_pool.h":  "include/falcon/connection_pool.h",
        "falcon/request_parser.h":   "include/falcon/request_parser.h",
    },
    compiler_flags = [
        "-std=c++20",
        "-Wall",
        "-Wextra",
        "-Werror",
    ],
    deps = [
        "//src/util:logging",
        "//third-party/folly:folly",
        "//third-party/fmt:fmt",
    ],
    # Controls who can depend on this target
    visibility = ["PUBLIC"],
)

# ── Binary ───────────────────────────────────────────────────────────────────
cxx_binary(
    name = "falcon_server",
    srcs = ["main.cpp"],
    deps = [
        ":falcon_lib",
        "//third-party/gflags:gflags",
    ],
)

# ── Tests ────────────────────────────────────────────────────────────────────
cxx_test(
    name = "falcon_test",
    srcs = [
        "scheduler_test.cpp",
        "parser_test.cpp",
    ],
    deps = [
        ":falcon_lib",
        "//third-party/gtest:gtest",
    ],
)
```

### Starlark Rules

The power of Buck2 is that build rules are just Starlark functions. You can write custom rules for code generation, protocol buffers, or anything else without touching the Buck2 core:

```python
# rules/cpp_grpc.bzl

def cpp_grpc_library(
    name,
    proto_src,
    deps = [],
    visibility = None,
):
    """Generate a C++ gRPC library from a .proto file."""

    # Step 1: Run protoc to generate .pb.cc and .pb.h
    proto_name = name + "_proto_gen"
    native.genrule(
        name = proto_name,
        srcs = [proto_src],
        out = "generated",
        cmd = """
            mkdir -p $OUT
            protoc --cpp_out=$OUT --grpc_out=$OUT \
                   --plugin=protoc-gen-grpc=$(location //tools:grpc_cpp_plugin) \
                   $SRCS
        """,
    )

    # Step 2: Compile the generated files into a library
    cxx_library(
        name = name,
        srcs = [":{}[generated]".format(proto_name)],
        deps = deps + [
            "//third-party/grpc:grpc++",
            "//third-party/protobuf:protobuf",
        ],
        visibility = visibility,
    )
```

### Buck2 Execution Model

Buck2's execution model is a key advantage over the original Buck and comparable to Bazel's remote execution:

```bash
# Build with local execution
buck2 build //src/falcon:falcon_server

# Build with remote execution (Meta's RE2 protocol or open-source Reindeer)
buck2 build //src/falcon:falcon_server \
  --config buck2.remote_execution_enabled=true \
  --config buck2.re_use_case=my-platform

# Run tests in parallel
buck2 test //src/falcon:falcon_test -- --jobs 32

# Query the build graph
buck2 cquery "deps(//src/falcon:falcon_server)"
buck2 cquery "rdeps(//..., //third-party/fmt:fmt, 3)"

# Analyze what changed
buck2 audit changes-since HEAD~1
```

### .buckconfig

`.buckconfig` is the repository-level configuration file that names the repo, sets the C++ toolchain, and points to the remote cache endpoint. Setting `cache.mode = dir,http` enables both a local directory cache and a remote HTTP cache so that CI machines and developer laptops share build artifacts without recompiling unchanged targets.
```ini
[repository]
    name = falcon_monorepo

[build]
    execution_platforms = //toolchains:platforms

[buck2]
    # Use the prelude from the open-source release
    prelude = //prelude

[cxx]
    default_platform = linux-x86_64
    cxxflags = -std=c++20 -fPIC

[test]
    # Default test runner timeout
    timeout = 300
```

### Buck2 vs Bazel

Both systems share the same foundational philosophy: hermetic builds, content-addressed caching, Starlark rules. The differences are primarily in execution:

| Property | Buck2 | Bazel |
|----------|-------|-------|
| Execution engine | Rust (faster startup, less memory) | JVM (slower startup, more mature) |
| Rule language | Starlark (same as Bazel) | Starlark |
| Remote execution protocol | RE2 (open standard) | gRPC Remote Execution API |
| Open-source ecosystem | Growing (newer) | Larger (10+ years) |
| Used by | Meta (FB, Instagram, PyTorch) | Google, Uber, Dropbox, Stripe |
| Toolchain support | Prelude rules for C++/Python/Rust | rules_cc, rules_go, etc. |

Buck2 is the better choice if you are building a new monorepo today and want the fastest possible local builds. Bazel is the better choice if you need the broader ecosystem of existing rules and remote execution providers.

---
