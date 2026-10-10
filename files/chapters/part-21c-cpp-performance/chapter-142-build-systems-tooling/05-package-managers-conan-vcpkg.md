## Package Managers: Conan and vcpkg

The C++ dependency problem is the most painful part of the ecosystem for developers coming from Go. In Go, `go get github.com/some/library@v1.2.3` fetches, pins, and integrates a dependency in one command. The hash goes into `go.sum`. Future builds are hermetic. There is one module system and one registry.

C++ has none of that. Libraries distribute as source tarballs, OS packages, vendored directories, or prebuilt binaries of unknown provenance. There is no standard ABI: a library built with GCC 12 and `-std=c++17` is binary-incompatible with a build using GCC 13 and `-std=c++20`. Every consumer must either compile from source (slow) or match the exact build configuration (fragile). Two package managers have emerged as the industry standard: Conan (open-source, language-neutral) and vcpkg (Microsoft, deep CMake integration).

### Conan 2.0

Conan is the more mature and flexible of the two. Version 2.0 (released 2023) is a significant rewrite with a cleaner API and better support for cross-compilation and custom binary configurations.

#### conanfile.py

A `conanfile.py` at the root of your project describes dependencies and build integration:

```python
# conanfile.py

from conan import ConanFile
from conan.tools.cmake import CMake, CMakeToolchain, cmake_layout


class FalconConan(ConanFile):
    name = "falcon"
    version = "1.4.2"
    settings = "os", "compiler", "build_type", "arch"
    generators = "CMakeToolchain", "CMakeDeps"

    def requirements(self):
        self.requires("fmt/10.2.1")
        self.requires("spdlog/1.13.0")
        self.requires("boost/1.84.0")
        self.requires("openssl/3.2.1")
        # Test-only dependency: not propagated to consumers
        self.requires("gtest/1.14.0", test=True)

    def build_requirements(self):
        # Tools needed at build time but not at runtime
        self.tool_requires("cmake/3.28.1")
        self.tool_requires("ninja/1.11.1")

    def layout(self):
        cmake_layout(self)

    def generate(self):
        tc = CMakeToolchain(self)
        tc.variables["FALCON_ENABLE_TESTS"] = "ON"
        tc.generate()

    def build(self):
        cmake = CMake(self)
        cmake.configure()
        cmake.build()

    def package(self):
        cmake = CMake(self)
        cmake.install()
```

#### Conan Profiles

Profiles pin the exact build configuration, ensuring binary compatibility:

```ini
# ~/.conan2/profiles/linux-clang-release

[settings]
os=Linux
arch=x86_64
compiler=clang
compiler.version=17
compiler.libcxx=libc++
compiler.cppstd=20
build_type=Release

[conf]
tools.build:compiler_executables={"c": "clang-17", "cpp": "clang++-17"}
tools.cmake.cmaketoolchain:generator=Ninja
tools.build:jobs=16
```

#### Installing Dependencies

Setting up the toolchain correctly is the prerequisite for all subsequent work. The commands below install the necessary compiler, standard library headers, and build tools, ensuring a consistent development environment across the team.
```bash
# Install all dependencies, generating CMake integration files
conan install . \
  --output-folder=build \
  --build=missing \
  --profile linux-clang-release

# Configure and build
cmake --preset conan-release
cmake --build --preset conan-release

# Create a binary package for caching
conan create . --profile linux-clang-release

# Upload to a private Artifactory server for team caching
conan upload falcon/1.4.2 --remote my-artifactory
```

#### CMakeLists.txt with Conan

After Conan generates the dependency metadata, your CMakeLists.txt uses standard `find_package` calls. The snippet below shows a project that pulls in Abseil, Protobuf, and gRPC through Conan.
```cmake
cmake_minimum_required(VERSION 3.20)
project(Falcon VERSION 1.4.2 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)

# find_package works because Conan generated FooConfig.cmake files
find_package(fmt      REQUIRED)
find_package(spdlog   REQUIRED)
find_package(Boost    REQUIRED COMPONENTS system filesystem)
find_package(OpenSSL  REQUIRED)

add_library(falcon
    src/scheduler.cpp
    src/connection_pool.cpp
)

target_link_libraries(falcon
    PUBLIC
        Boost::system
        Boost::filesystem
    PRIVATE
        fmt::fmt
        spdlog::spdlog
        OpenSSL::SSL
        OpenSSL::Crypto
)

if(FALCON_ENABLE_TESTS)
    find_package(GTest REQUIRED)
    add_executable(falcon_test tests/scheduler_test.cpp)
    target_link_libraries(falcon_test PRIVATE falcon GTest::gtest_main)
    include(GoogleTest)
    gtest_discover_tests(falcon_test)
endif()
```

### vcpkg

vcpkg is Microsoft's package manager, shipped as part of the Visual C++ toolchain but fully usable with GCC and Clang on Linux and macOS. Its key strengths are deep CMake integration (it hooks directly into CMake's toolchain mechanism) and a large curated registry of 2,400+ ports.

#### Manifest Mode (vcpkg.json)

Manifest mode is the modern way to use vcpkg, declare dependencies in a `vcpkg.json` file at the project root:

```json
{
  "$schema": "https://raw.githubusercontent.com/microsoft/vcpkg-tool/main/docs/vcpkg.schema.json",
  "name": "falcon",
  "version": "1.4.2",
  "description": "High-performance request processing library",
  "dependencies": [
    "fmt",
    "spdlog",
    {
      "name": "boost-system",
      "version>=": "1.84.0"
    },
    {
      "name": "boost-filesystem",
      "version>=": "1.84.0"
    },
    "openssl",
    {
      "name": "gtest",
      "features": ["gmock"]
    }
  ],
  "builtin-baseline": "2024.01.12",
  "overrides": [
    { "name": "fmt", "version": "10.2.1" }
  ]
}
```

#### CMake Integration

vcpkg integrates by injecting a toolchain file. You pass it once and `find_package` works for everything in `vcpkg.json`:

```bash
# Configure: pass vcpkg toolchain file
cmake -B build \
  -S . \
  -DCMAKE_TOOLCHAIN_FILE=/opt/vcpkg/scripts/buildsystems/vcpkg.cmake \
  -DVCPKG_TARGET_TRIPLET=x64-linux-release \
  -G Ninja

cmake --build build --parallel
```

In CI, set the toolchain file via an environment variable to avoid hardcoding the vcpkg path:

```yaml
# .github/workflows/build.yml (partial)
- name: Configure CMake
  env:
    VCPKG_ROOT: ${{ github.workspace }}/vcpkg
  run: |
    cmake -B build -S . \
      -DCMAKE_TOOLCHAIN_FILE=$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake \
      -DVCPKG_TARGET_TRIPLET=x64-linux-release \
      -G Ninja \
      -DCMAKE_BUILD_TYPE=Release
```

#### vcpkg Registries and Versioning

For private libraries not in the public registry:

```json
{
  "registries": [
    {
      "kind": "git",
      "repository": "https://github.com/myorg/vcpkg-registry",
      "baseline": "a4b2c3d4e5f6...",
      "packages": ["internal-lib", "private-proto"]
    },
    {
      "kind": "default",
      "packages": ["*"]
    }
  ]
}
```

### Conan vs vcpkg

| Property | Conan 2.0 | vcpkg |
|----------|-----------|-------|
| Configuration model | Profiles (explicit ABI) | Triplets (implicit) |
| Binary caching | Excellent (Artifactory, S3) | Good (GitHub Actions cache) |
| Package count | ~1,700 (Conan Center) | ~2,400 ports |
| Cross-compilation | First-class | Good |
| Custom packages | Easy (conanfile.py) | Easy (port files) |
| CMake integration | Via generated files | Direct toolchain hook |
| Best for | Large teams, custom binaries | Quick setup, OSS projects |

Choose Conan when you need fine-grained control over build configurations and binary caching across teams. Choose vcpkg when you want the fastest path to "just works" with CMake and the public port registry is sufficient.

### The Go Comparison

Go's module system solves a fundamentally simpler problem: Go has a single compiler, a stable ABI across standard builds, and no concept of compiler flags that affect binary compatibility. `go.sum` works because a given `go get github.com/foo/bar@v1.2.3` always produces the same binary. In C++, `vcpkg install fmt` can produce dozens of different binaries depending on your compiler, flags, and platform, all legitimately named `libfmt.a`. This is why C++ package managers must track build configurations, not just versions.

---
