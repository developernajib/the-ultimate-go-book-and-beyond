## Remote Execution and Distributed Builds

A single-machine build for a large C++ codebase hits a wall at around ten million lines. Incremental builds are fine, but a full rebuild (release, sanitizer, PGO) takes hours. Remote Build Execution (RBE) solves this by shipping compile actions to a fleet of worker machines and caching their outputs by content hash. A 4-hour build on one machine becomes a 6-minute build across 500 workers. Google, Meta, and Microsoft all run production RBE clusters serving their internal monorepos.

### The Remote Execution API

The REAPI (Remote Execution API), standardized by Bazel, Buck2, and BuildBarn, defines a gRPC protocol with four services:

1. **ContentAddressableStorage (CAS)**: stores blobs keyed by SHA-256. Source files, tool binaries, and compile outputs all live here.
2. **Execution**: receives an `Action` (input-root digest, command, output paths) and returns an `ActionResult`.
3. **ActionCache**: maps action digests to prior results, enabling cross-user cache hits.
4. **Capabilities**: advertises supported platforms, compression, and timeouts.

The build tool computes, for every compile step, an `Action` digest that hashes inputs, command line, and environment. If the `ActionCache` already has that digest, the cached outputs are fetched from CAS and no work runs. Otherwise, the action is dispatched to a worker, which fetches inputs from CAS, runs the command, and uploads outputs.

### Setting Up Bazel with RBE

```python
# .bazelrc
build:remote --remote_executor=grpcs://rbe.mycompany.com
build:remote --remote_cache=grpcs://cache.mycompany.com
build:remote --remote_instance_name=projects/mycompany/instances/default
build:remote --remote_download_minimal
build:remote --jobs=500
build:remote --experimental_remote_merkle_tree_cache
build:remote --remote_timeout=3600
build:remote --google_default_credentials

# Platform constraint: workers must match this toolchain
build:remote --extra_execution_platforms=//platforms:linux_x86_64_clang17
build:remote --host_platform=//platforms:linux_x86_64_clang17
```

`--remote_download_minimal` tells Bazel not to download intermediate outputs, only the final artifacts. On a slow link this is the difference between a 6-minute build and a 40-minute build bottlenecked by downloading object files that will never be linked locally.

### Hermeticity Is Non-Negotiable

RBE only works if every compile action is hermetic: it depends on its declared inputs and nothing else. A single `#include </usr/include/stdlib.h>` that reads the system header leaks the worker's OS version into the output, breaking reproducibility and cache stability.

Enforce hermeticity with:
- A **sysroot toolchain**: the C++ compiler, libc headers, and linker all ship as inputs to every action. Bazel's `rules_cc` and Buck2's `cxx_toolchain` support this out of the box.
- **Sandboxing**: workers run each action in a chroot or container that sees only the declared inputs. Any access to a non-declared file is an error.
- **Determinism flags**: `-fdebug-prefix-map`, `-fmacro-prefix-map`, `SOURCE_DATE_EPOCH`, `-frandom-seed`. Two workers must produce byte-identical outputs for the same action.

Verify hermeticity by running `bazel build //... --config=remote` twice with different cache states and comparing artifact hashes. Any difference is a bug.

### Buck2 with Remote Execution

Buck2 uses the same REAPI but with a different configuration surface:

```python
# .buckconfig
[buck2]
use_action_cache = true

[build]
execution_platforms = //platforms:linux_x86_64_clang17

[buck2_re_client]
action_cache_address = grpcs://cache.mycompany.com
engine_address = grpcs://rbe.mycompany.com
cas_address = grpcs://cas.mycompany.com
instance = prod
```

Buck2's incremental graph is more aggressive than Bazel's: it tracks every rule's transitive dependency hash and skips rebuilding even when an upstream rule's action outputs did not change (only its declared outputs did). This gives Buck2 a roughly 2x advantage on incremental builds in Meta's measurements.

### Choosing a Worker Backend

For a production deployment, three options dominate:

| Backend | Origin | Best for |
| --- | --- | --- |
| BuildBarn | Community (Go) | Full control, on-prem |
| Buildfarm | Bazel project (Java) | Bazel-first shops |
| BuildBuddy | Commercial, Go | Managed, with UI |

All three speak REAPI. BuildBarn is the most flexible for custom schedulers and works with Buck2 out of the box. Buildfarm integrates tightly with Bazel's authentication. BuildBuddy provides a managed cache plus UI for viewing every action, including cache hit rates and regression analysis.

### The Payoff

A well-run RBE cluster with 95%+ action cache hit rate (typical after the first full build) gives every developer the equivalent of a 500-core workstation. Local CI rebuilds drop from hours to minutes. The investment (toolchain hermeticity, cluster operation, monitoring) is substantial, but at the scale where C++ build times dominate engineer productivity, it is the only path. For a 100-engineer team, an RBE cluster typically pays back within a quarter in recovered engineer hours.
