## 159.18 Build and Tooling

Building Chromium from source is a humbling experience. The first build from scratch takes 45 minutes to several hours depending on hardware. The release binary is around 250 MB. The build system and the surrounding infrastructure (depot_tools, distributed compilation, code review, try bots) are themselves a substantial engineering achievement.

### GN: The Build Description

GN is a Google-internal build description language, open-sourced for Chromium. It generates Ninja build files. GN replaces the older GYP system around 2015. Source files declare targets in `BUILD.gn`:

```python
# Example BUILD.gn for a small library.
import("//build/config/c++/c++.gni")

source_set("foo") {
  sources = [
    "foo.cc",
    "foo.h",
  ]
  deps = [
    "//base",
    "//third_party/abseil-cpp:absl",
  ]
  configs += [ "//build/config/compiler:wexit_time_destructors" ]
}

executable("foo_unittests") {
  testonly = true
  sources = [ "foo_unittest.cc" ]
  deps = [
    ":foo",
    "//testing/gtest",
  ]
}
```

GN is fast: re-running `gn gen` on a no-op change takes ~1 second on a modern machine, even for the full Chromium build graph (millions of targets).

Args are configured through `args.gn`:

```python
# out/Release/args.gn
is_debug = false
is_component_build = false
symbol_level = 1
target_cpu = "x64"
use_remoteexec = true
```

`is_component_build = true` builds Chromium as many shared libraries instead of one giant binary. Component builds are the developer default: link times are seconds instead of minutes.

### Ninja: The Build Executor

Ninja runs the actual compilation. It is intentionally minimal: no globbing, no rules, just an explicit dependency graph that Ninja walks in parallel.

Ninja's design choice: optimize for null-build performance and incremental builds. After GN regenerates `build.ninja`, a no-op `ninja chrome` returns in under a second.

### Distributed Compilation: Reclient and Goma

A from-scratch build of Chrome compiles around 50,000 translation units. On a 16-core developer machine that is roughly an hour. Distributed compilation slashes this.

- **Goma.** Google's original distributed compiler. Sends preprocessed source to a fleet of compile workers, gets back .o files. Used internally for most of Chromium's history.
- **Reclient.** Successor to Goma, based on Bazel's Remote Execution API (RE-API). Open source. The current standard tool.

With Reclient, a Googler compiling Chrome runs the build locally but offloads each `clang` invocation to remote workers. From-scratch build drops from an hour to 5 to 15 minutes.

External contributors who do not have access to Reclient compile locally. With ccache or a similar local cache, an incremental build is usually fast enough.

### depot_tools

`depot_tools` is the suite of scripts every Chromium developer uses:

- `gclient`: dependency manager, sync the source tree (Chromium has hundreds of `DEPS` entries that pull pinned versions of third-party repos).
- `git cl`: Gerrit code review CLI. `git cl upload` creates a CL.
- `gn` and `ninja`: vendored copies of the build tools.
- `autoninja`: wrapper that figures out the right `-j` parallelism.
- Helper scripts for common workflows.

A typical first-time setup:

```bash
git clone https://chromium.googlesource.com/chromium/tools/depot_tools.git
export PATH="$PWD/depot_tools:$PATH"
mkdir chromium && cd chromium
fetch --no-history chromium
cd src
gn gen out/Default
autoninja -C out/Default chrome
```

`fetch` rather than direct `git clone` because it sets up the gclient hooks that drive the polyrepo dependency graph.

### Gerrit Code Review

Chromium uses Gerrit, not GitHub PRs. The flow:

1. Make a local change.
2. `git cl upload`: create a CL on Gerrit with a Change-Id.
3. Add reviewers (OWNERS files dictate who can approve which areas).
4. Reviewers leave comments, request changes, or +1.
5. After +2 from an OWNER, run "CQ+2" to commit.
6. The Commit Queue runs the full try bot suite, on green it lands the CL.

Each file path in the source tree has an OWNERS file. Reviewers must include at least one OWNER for every modified path. This is the social mechanism that scales code review across thousands of contributors.

### Try Bots and the Commit Queue

The Commit Queue runs builds and tests across:

- Linux, macOS (x64 + arm64), Windows (x64 + arm64), Android (multiple ARM configs), ChromeOS, iOS, Fuchsia.
- Debug and release builds.
- ASAN, MSAN, TSAN, UBSAN sanitizer builds.
- LeakSanitizer.
- Coverage runs.

A CL that touches even one file commonly runs 30+ bots. Latency from CQ+2 to landed: 30 to 90 minutes typical.

For pre-CQ exploration, developers run `git cl try` to launch a subset of try jobs against an in-progress CL. Used for confirming a fix, testing flakiness, profiling with the right toolchain.

### Findit and Sheriff Tools

When a CL lands and breaks a test, the auto-revert and Findit systems kick in:

- **Findit** correlates failing tests with recent CLs, ranks suspects by blame and code-distance.
- **Auto-revert** reverts CLs that broke a green tree, reducing developer impact and forcing the original author to re-land with a fix.
- **Sheriff rotation**: a small group of engineers per timezone monitor the tree, manually triage what auto-revert misses.

### Code Search

`source.chromium.org` (a public deployment of Kythe-backed code search) cross-references every symbol in the tree. Click a function call, jump to its definition. Right-click, find call sites. This is the primary way Chromium engineers navigate 35M lines of code.

For the same searches in V8 (and other dependent repos), `source.chromium.org` includes them via the polyrepo manifest.

### Sanitizer Builds

ASAN, MSAN, TSAN, UBSAN are integral to Chromium's quality process:

- **ASAN** (AddressSanitizer): use-after-free, heap buffer overflow, double-free.
- **MSAN** (MemorySanitizer): use of uninitialized memory.
- **TSAN** (ThreadSanitizer): data races.
- **UBSAN**: undefined behavior (signed overflow, null deref, alignment).

The CI fleet runs the full test suite under each sanitizer continuously. Catches bugs before they ship that traditional tests miss.

### Perfetto and Tracing

Chromium uses Perfetto for tracing (was the home-grown `chrome://tracing` infrastructure, replaced by Perfetto around 2020). A trace is a multi-process recording with categories.

Capture:

```bash
# Record a trace via DevTools Protocol or chrome://tracing, then:
perfetto --txt -c trace_config.pbtx -o trace.pftrace
```

The trace can be loaded in `ui.perfetto.dev` for analysis: flame graphs, slice tables, SQL queries over events.

### Pinpoint and Bisection

When a perf bot detects a regression, it triggers Pinpoint, a bisection service that runs the affected benchmark on commits between the last known good and the regressed run. Bisection narrows down to the offending CL automatically. The CL author gets a bug report with the bisection result.

Pinpoint is also accessible to engineers manually: "find what regressed Speedometer 3 between revs X and Y" runs as a bisection job and returns within hours.

### Profile-Guided Optimization (PGO)

Chrome ships with PGO. The build pipeline:

1. Compile an instrumented Chrome.
2. Run a "training" workload (page loads, scrolling, interactions).
3. Collect profile data.
4. Re-compile with the profile, letting the optimizer make hot-path-aware decisions.

PGO yields ~10% performance improvement on common workloads. ThinLTO (link-time optimization, thin variant for parallel compilation) adds another ~5%.

### Senior Interview Material

- "Why did Chromium move from GYP to GN?"
- "What does Reclient give you that local compilation does not?"
- "Walk me through how a CL becomes a commit, including OWNERS, try bots, and CQ."
- "How do sanitizer builds fit into Chromium's quality process? What does each catch?"
- "Explain Pinpoint and how a perf regression makes it from a perf bot to a fix."

The next section moves to the perf side specifically.

---
