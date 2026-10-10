## Docker for C++ Builds

The "works on my machine" problem is more severe in C++ than in almost any other language. The same source code compiled with GCC 12 vs GCC 13, with `-std=c++17` vs `-std=c++20`, against `libstdc++` vs `libc++`, or on Ubuntu 20.04 vs Ubuntu 22.04, can produce different binaries, different bugs, and different runtime behavior. Docker solves this by packaging the entire build environment, compiler, system libraries, headers, package manager state, into a reproducible image. Whatever builds in the container builds everywhere the container runs.

### Choosing a Base Image

C++ build containers have three common starting points: a minimal OS image where you install all toolchain components yourself, an official compiler image like `gcc:13.2` with the compiler pre-installed, or a `silkeh/clang` image that includes Clang, libc++, and LLVM tools. The right choice depends on how much control you need over the exact toolchain version versus how much setup time you want to avoid in each CI run.
```dockerfile
# Option 1: OS base (most control, most work)
FROM ubuntu:22.04

# Option 2: Compiler-specific image (GCC or Clang pre-installed)
FROM gcc:13.2
FROM silkeh/clang:17-bookworm

# Option 3: LLVM's official image
FROM ghcr.io/llvm/llvm-project:llvmorg-17.0.6-ubuntu-22.04
```

For production use, pin to a specific digest rather than a tag, tags are mutable:

```dockerfile
# Pin to exact image digest (immutable)
FROM ubuntu:22.04@sha256:a6d2b38300ce0316684ae97f2af6252b0e1a5c9f5bfeb3e45a4aa53d1d3b1f42
```

### Production Multi-Stage Dockerfile

Multi-stage builds separate the heavy build environment from the minimal runtime image. The final image contains only the binary and its runtime dependencies, no compiler, no headers, no source code:

```dockerfile
# Dockerfile

# ─────────────────────────────────────────────────────────────────────────────
# Stage 1: dependency cache
# Separate stage so package install layer is cached independently of source
# ─────────────────────────────────────────────────────────────────────────────
FROM ubuntu:22.04 AS deps

ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    clang-17 \
    clang++-17 \
    cmake \
    ninja-build \
    git \
    curl \
    zip \
    unzip \
    pkg-config \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install vcpkg
RUN git clone https://github.com/microsoft/vcpkg.git /opt/vcpkg \
    && /opt/vcpkg/bootstrap-vcpkg.sh -disableMetrics

ENV VCPKG_ROOT=/opt/vcpkg
ENV PATH="${VCPKG_ROOT}:${PATH}"

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2: dependency install
# Copy only the manifest so this layer is cached when source changes but
# dependencies do not
# ─────────────────────────────────────────────────────────────────────────────
FROM deps AS dep-install

WORKDIR /workspace

# Copy manifests BEFORE source -- stable layers first
COPY vcpkg.json vcpkg-configuration.json ./

# Install all vcpkg dependencies (this is the expensive step)
RUN vcpkg install \
    --triplet x64-linux-release \
    --no-print-usage

# ─────────────────────────────────────────────────────────────────────────────
# Stage 3: build
# ─────────────────────────────────────────────────────────────────────────────
FROM dep-install AS builder

WORKDIR /workspace

# Copy CMake config BEFORE full source (cache it separately)
COPY CMakeLists.txt CMakePresets.json cmake/ ./

# Now copy all source
COPY src/ src/
COPY include/ include/
COPY tests/ tests/

# Configure
RUN cmake --preset ci \
    -DCMAKE_CXX_COMPILER=clang++-17 \
    -DCMAKE_TOOLCHAIN_FILE=${VCPKG_ROOT}/scripts/buildsystems/vcpkg.cmake

# Build
RUN cmake --build --preset ci --parallel $(nproc)

# Run tests inside builder stage (fail the build if tests fail)
RUN ctest --test-dir build/ci --output-on-failure --parallel 4

# ─────────────────────────────────────────────────────────────────────────────
# Stage 4: runtime (minimal image)
# ─────────────────────────────────────────────────────────────────────────────
FROM debian:bookworm-slim AS runtime

# Install only runtime dependencies (no compiler, no headers)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libssl3 \
    libstdc++6 \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Create a non-root user for the service
RUN useradd --uid 1001 --create-home --shell /bin/bash falcon

# Copy only the compiled binary from the builder stage
COPY --from=builder /workspace/build/ci/falcon_server /usr/local/bin/falcon_server
RUN chmod +x /usr/local/bin/falcon_server

USER falcon
WORKDIR /home/falcon

EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/falcon_server"]
CMD ["--port=8080", "--workers=4"]
```

### Layer Caching Strategy

Layer caching is the key to fast Docker builds. Docker invalidates a layer and all subsequent layers when any input changes. Order layers from most-stable to least-stable:

```
1. Base OS + compiler install         (changes: monthly)
2. vcpkg dependencies                 (changes: when vcpkg.json changes)
3. CMake configuration                (changes: when CMakeLists.txt changes)
4. Source code                        (changes: every commit)
```

If you copy source first and then install dependencies, every source change triggers a full dependency reinstall. The Dockerfile above correctly separates these layers.

### GitHub Actions with Docker Build Cache

BuildKit's GitHub Actions cache backend lets you reuse layers between CI runs:

```yaml
# .github/workflows/docker.yml

name: Docker Build

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-22.04

    steps:
      - uses: actions/checkout@v4

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Login to GHCR
        if: github.event_name == 'push'
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Build and push
        uses: docker/build-push-action@v5
        with:
          context: .
          target: runtime
          push: ${{ github.event_name == 'push' }}
          tags: |
            ghcr.io/${{ github.repository }}:latest
            ghcr.io/${{ github.repository }}:${{ github.sha }}
          # GitHub Actions cache backend: shares layers between runs
          cache-from: type=gha
          cache-to: type=gha,mode=max
          build-args: |
            BUILDKIT_INLINE_CACHE=1
```

### Cross-Compilation with Docker

Docker BuildKit supports cross-compilation via `--platform`. Combined with QEMU emulation, you can build for ARM64 on an x86_64 CI runner:

```dockerfile
# Cross-compile for linux/arm64
FROM --platform=linux/arm64 ubuntu:22.04 AS builder-arm64

RUN apt-get update && apt-get install -y \
    gcc-aarch64-linux-gnu \
    g++-aarch64-linux-gnu \
    cmake ninja-build

# cmake toolchain for cross-compilation
COPY cmake/aarch64-linux-gnu.cmake /opt/toolchain.cmake

WORKDIR /workspace
COPY . .

RUN cmake -B build -S . -G Ninja \
    -DCMAKE_TOOLCHAIN_FILE=/opt/toolchain.cmake \
    -DCMAKE_BUILD_TYPE=Release
RUN cmake --build build --parallel
```

```yaml
# GitHub Actions: build for multiple architectures
- name: Set up QEMU
  uses: docker/setup-qemu-action@v3
  with:
    platforms: linux/amd64,linux/arm64

- name: Build multi-arch image
  uses: docker/build-push-action@v5
  with:
    platforms: linux/amd64,linux/arm64
    push: true
    tags: ghcr.io/myorg/falcon:latest
```

### Conan Inside Docker

When using Conan, cache the `~/.conan2` directory as a separate layer to avoid rebuilding all package binaries on each image build:

```dockerfile
FROM deps AS conan-packages

# Install Conan
RUN pip3 install conan==2.4.0

# Copy profiles and recipe first
COPY conanfile.py profiles/ ./

# Create profile
RUN conan profile detect
COPY profiles/linux-clang-release /root/.conan2/profiles/default

# Install all dependencies into the Conan cache
# This layer is cached until conanfile.py changes
RUN conan install . \
    --output-folder=build \
    --build=missing \
    --profile default

FROM conan-packages AS builder
COPY src/ include/ tests/ CMakeLists.txt ./
RUN cmake --preset conan-release && cmake --build --preset conan-release
```

### The Go Comparison

A Go multi-stage Dockerfile that produces a production binary looks like this:

```dockerfile
FROM golang:1.27-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /falcon ./cmd/falcon

FROM scratch
COPY --from=builder /falcon /falcon
ENTRYPOINT ["/falcon"]
```

That is 10 lines. The equivalent C++ Dockerfile is 80+ lines. The difference is not Docker, it is the C++ build environment itself: multiple compilers, system library dependencies, package manager state, and compiler flags that affect ABI compatibility. Go's simplicity here is a direct consequence of its design choices: one compiler, static linking by default, no ABI concerns between packages.

---
