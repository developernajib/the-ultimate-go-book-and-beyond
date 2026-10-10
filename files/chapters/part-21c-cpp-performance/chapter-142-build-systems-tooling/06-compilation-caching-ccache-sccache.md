## Compilation Caching: ccache and sccache

A clean build of LLVM takes 45 minutes on a powerful workstation. A clean build of Chrome takes over an hour. These numbers reflect a fundamental truth about C++: template instantiation, header parsing, and code generation are expensive, and every translation unit pays the full cost on a clean build. When you add a `#include <boost/beast.hpp>`, you are pulling 400,000 lines of header code into your compilation unit.

Compilation caches solve this by storing object files keyed on a hash of the preprocessed source. If the hash matches a cached entry, the cached object file is returned immediately without invoking the compiler. On a warm cache, a "clean" build is nearly as fast as an incremental build.

### ccache: Local Compilation Cache

ccache is the original compilation cache, written by Andrew Tridgell (author of rsync and Samba) in 2002. It intercepts compiler invocations, computes a cache key from the preprocessed source and compiler flags, and returns cached results on hits. It is battle-tested, widely packaged, and has near-zero overhead on cache misses.

#### Installation and Basic Configuration

Setting up the toolchain correctly is the prerequisite for all subsequent work. The commands below install the necessary compiler, standard library headers, and build tools, ensuring a consistent development environment across the team.
```bash
# Ubuntu/Debian
sudo apt install ccache

# macOS
brew install ccache

# Check version and statistics
ccache --version
ccache --show-stats
```

```bash
# ~/.ccache/ccache.conf (or /etc/ccache.conf for system-wide)
# Maximum cache size
max_size = 20G

# Cache directory (can be on a fast SSD)
cache_dir = /home/user/.cache/ccache

# Hash the actual compiler binary (not just its name)
# Prevents stale cache hits when upgrading compiler
hash_dir = false
compiler_check = content

# Keep statistics across cache clears
stats = true

# Compression (saves ~50% disk, slight CPU overhead)
compression = true
compression_level = 1

# Treat missing includes as errors (safer cache keys)
sloppiness = pch_defines,time_macros
```

#### CMake Integration

Adding ccache to a CMake project requires setting `CMAKE_C_COMPILER_LAUNCHER` and `CMAKE_CXX_COMPILER_LAUNCHER` so every compiler invocation passes through the cache. The snippet below auto-detects ccache at configure time.
```cmake
# CMakeLists.txt

find_program(CCACHE_PROGRAM ccache)
if(CCACHE_PROGRAM)
    message(STATUS "ccache found: ${CCACHE_PROGRAM}")
    set(CMAKE_CXX_COMPILER_LAUNCHER "${CCACHE_PROGRAM}")
    set(CMAKE_C_COMPILER_LAUNCHER   "${CCACHE_PROGRAM}")
else()
    message(STATUS "ccache not found -- builds will not be cached")
endif()
```

Or via CMakePresets.json for opt-in per preset:

```json
{
  "name": "dev",
  "inherits": "base",
  "cacheVariables": {
    "CMAKE_CXX_COMPILER_LAUNCHER": "ccache",
    "CMAKE_C_COMPILER_LAUNCHER": "ccache"
  }
}
```

#### Cache Statistics

`ccache --show-stats` reports hit rate, cache size, and the number of calls rejected due to preprocessing errors or unsupported flags. A warm cache hit rate above 90% means CI clean builds are nearly as fast as incremental ones. A low hit rate typically indicates that `__DATE__`/`__TIME__` macros or non-reproducible compiler flags are busting cache keys.
```bash
# View detailed statistics
ccache --show-stats

# Example output after a warm build:
# Summary:
#   Hits:               1423 / 1498 (95.0%)
#   Misses:               75
#   Errors:                0
#   Uncacheable:           0
# Primary storage:
#   Hits:               1423 (95.0%)
#   Misses:               75
#   Cache size (GiB):   12.4 / 20.0

# Zero statistics (keep the cache, reset counters)
ccache --zero-stats

# Clear the entire cache
ccache --clear
```

A hit rate above 80% is good. Above 90% is excellent. If your hit rate is low, the common culprits are: `__DATE__`/`__TIME__` macros in headers (solved by `sloppiness = time_macros`), or absolute paths embedded in debug info (solved by `-fdebug-prefix-map=$(pwd)=.`).

### sccache: Distributed Compilation Cache

sccache (Shared Compilation Cache) is Mozilla's rewrite of ccache in Rust with one critical addition: a distributed cache backend. Instead of storing compiled objects on a local disk, sccache can store them in Amazon S3, Google Cloud Storage, Azure Blob Storage, or an in-process Redis server. In CI environments with ephemeral runners, local disk caches are useless, sccache with cloud storage is the solution.

#### Installation

Setting up the toolchain correctly is the prerequisite for all subsequent work. The commands below install the necessary compiler, standard library headers, and build tools, ensuring a consistent development environment across the team.
```bash
# Install from binary release
curl -L https://github.com/mozilla/sccache/releases/download/v0.7.7/sccache-v0.7.7-x86_64-unknown-linux-musl.tar.gz \
  | tar xz --strip-components=1 -C /usr/local/bin sccache-v0.7.7-x86_64-unknown-linux-musl/sccache

# Or via cargo
cargo install sccache
```

#### Configuration for AWS S3 Caching

sccache's TOML configuration points to an S3 bucket and region so that object files are stored remotely and shared across all CI agents and developer machines. The `key_prefix` field namespaces cache entries by project, preventing collisions when multiple repositories share the same S3 bucket, a common setup in monorepo environments.
```bash
# ~/.config/sccache/config (TOML format)
[cache.s3]
bucket = "my-org-sccache"
region = "us-east-1"
key_prefix = "sccache"
no_credentials = false    # Use IAM role / environment credentials
```

```bash
# Environment variables (set in CI)
export SCCACHE_BUCKET=my-org-sccache
export SCCACHE_REGION=us-east-1
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...

# Optional: set cache size limit
export SCCACHE_CACHE_SIZE=50G
```

#### GitHub Actions Integration

Continuous integration automatically builds and tests every commit, catching regressions before they reach the main branch. The workflow definition below configures the build matrix, runs the test suite under multiple compilers, and uploads coverage reports as artifacts.
```yaml
# .github/workflows/build.yml

name: Build

on: [push, pull_request]

jobs:
  build:
    runs-on: ubuntu-22.04

    steps:
      - uses: actions/checkout@v4

      - name: Install sccache
        uses: mozilla-actions/sccache-action@v0.0.5
        with:
          version: "v0.7.7"

      - name: Install build tools
        run: sudo apt install -y cmake ninja-build clang-17

      - name: Configure
        env:
          SCCACHE_GHA_ENABLED: "true"
          CMAKE_CXX_COMPILER_LAUNCHER: sccache
        run: |
          cmake -B build -S . \
            -G Ninja \
            -DCMAKE_BUILD_TYPE=Release \
            -DCMAKE_CXX_COMPILER=clang++-17 \
            -DCMAKE_CXX_COMPILER_LAUNCHER=sccache

      - name: Build
        env:
          SCCACHE_GHA_ENABLED: "true"
        run: cmake --build build --parallel

      - name: sccache statistics
        run: sccache --show-stats
```

### Typical Speedup Numbers

| Scenario | Without cache | With warm ccache | With warm sccache (S3) |
|----------|-------------|-----------------|------------------------|
| LLVM clean build | ~45 min | ~3 min (93% hit) | ~4 min (91% hit) |
| Chromium clean build | ~60 min | ~5 min (92% hit) | ~6 min (90% hit) |
| Medium project (50 TUs) | ~3 min | ~12 sec | ~20 sec |
| CI on fresh runner | ~3 min | N/A (no local cache) | ~25 sec |

The network overhead of S3 (~100-200ms per cache fetch) is why sccache is slightly slower than ccache on a warm local cache, but dramatically faster than ccache on a fresh CI runner with no local cache.

### The Go Comparison

Go has had a build cache since Go 1.10 (`$GOPATH/pkg/mod/cache`). It works on the same principle: hash the inputs, store the output. The difference is that Go's cache is built into the toolchain itself, there is nothing to install or configure. C++ compilation caching is an afterthought bolted onto a toolchain that was never designed with caching in mind, which is why achieving high hit rates requires tuning flags like `sloppiness` to handle edge cases like embedded timestamps.

---
