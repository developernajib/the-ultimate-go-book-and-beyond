## C++20 and C++26 Modules in Build Systems

Modules solve problems that `#include` could not. Headers are textually included into every translation unit that names them, so a widely-used header is parsed thousands of times per build. Macros leak across inclusion boundaries, forcing defensive guards and hurting compile time. A module, by contrast, is a binary artifact (`.pcm` / `.ifc`) that the compiler produces once and consumes many times. Microsoft's Office codebase reports 5-10x compile-time reductions on heavily-included headers. Build-system support is the last mile, and as of 2026 it is finally production-ready.

### The Build-System Challenge

Modules introduce a dependency shape that predates the era of `make`: you must compile module interfaces **before** translation units that import them, even if the importing unit was modified more recently. Classic header-based dependency scanning (gcc -MMD) is insufficient because the dependency is on the module name, not a file path. The build system must parse every source file to discover its imports, then topologically sort the build graph.

The P1689 specification defines a JSON format for dependency discovery output. Every C++ compiler supporting modules can be asked to emit P1689:

```bash
clang++ -std=c++23 -fmodules-ts \
    -x c++-module \
    --scan-deps -format=p1689 \
    -o scanner.json \
    my_module.cppm
```

The JSON lists provided modules (what this file exports) and required modules (what it imports). The build system ingests this, builds a DAG of module interface units, and schedules compilation.

### CMake 3.28+ Module Support

CMake 3.28 (released late 2023) made module support stable. The key is declaring `.cppm` or `.ixx` files as module sources.

```cmake
cmake_minimum_required(VERSION 3.28)
project(modular LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_CXX_SCAN_FOR_MODULES ON)

add_library(math_utils)
target_sources(math_utils
    PUBLIC
        FILE_SET cxx_modules TYPE CXX_MODULES FILES
            math_utils/geometry.cppm
            math_utils/matrix.cppm
)

add_executable(app main.cpp)
target_link_libraries(app PRIVATE math_utils)
```

CMake invokes the compiler's dep-scanner, builds the module DAG, and emits a ninja file that compiles module interfaces before implementations. On Clang 17+, GCC 14+, and MSVC 19.36+, this works out of the box.

### Bazel Module Support

Bazel's `rules_cc` added a `cc_module` rule in 2024.

```python
cc_module(
    name = "geometry",
    srcs = ["geometry.cppm"],
    deps = [":vec3"],
)

cc_library(
    name = "renderer",
    srcs = ["renderer.cpp"],
    module_deps = [":geometry"],
)
```

Bazel handles the scanning pass transparently. Combined with remote execution, each module interface is compiled once across the fleet and cached by content hash. The compile-time savings are multiplicative with the RBE cache-hit rate.

### Buck2 Module Support

Buck2's `cxx_library` accepts `modules = True` to enable module compilation and gains access to Buck2's remote action graph caching. Meta uses this in production for internal C++26 libraries.

```python
cxx_library(
    name = "collections",
    srcs = glob(["*.cppm"]),
    visibility = ["PUBLIC"],
    modules = True,
    compiler_flags = ["-std=c++26"],
)
```

### C++26 Named Module Partitions

C++26 makes module **partitions** practical: a single logical module composed of many internal files that can be compiled in parallel.

```cpp
// geometry-primitives.cppm
export module geometry:primitives;
export struct Point { double x, y, z; };
export struct Vector { double dx, dy, dz; };

// geometry-operations.cppm
export module geometry:operations;
import :primitives;
export double dot(Vector a, Vector b);

// geometry.cppm (primary module interface)
export module geometry;
export import :primitives;
export import :operations;
```

Consumers `import geometry;` and see the combined interface. The build system compiles the partitions in parallel once their local dependencies are satisfied, giving a fan-out that was impossible with headers.

### The Remaining Gotchas

1. **Tooling lag**: clang-tidy, clang-format, IDE indexers are improving but not yet fully module-aware. Expect one more year of rough edges in tools that have to invoke the compiler to analyze code.
2. **ABI boundaries**: a module interface exposes types with their full linkage. Changing an inline function in a module still triggers rebuilds of every importer, just as with a header. The compile-time win comes from parse-time reduction, not ABI isolation.
3. **Third-party libraries**: until Boost, Abseil, and Protobuf ship module interfaces (tracked in each library's roadmap), you will mix header-based and module-based code. Both work, but the wins apply only to modular parts of the codebase.
4. **Cross-compiler interoperability**: `.pcm` files from Clang cannot be consumed by GCC. Every compiler produces its own binary format. Distributed builds therefore require per-compiler caching keys.

### The Migration Path

Start with new code as modules. Pick one widely-included internal header (a logging utility, a math library) and port it as a module. Measure the compile-time win. Over 6-12 months, migrate the rest. Full conversion of a legacy codebase takes years, but the incremental benefit starts at the first converted header. By 2027, module-first development is expected to be the default for new C++ code at FAANG scale.
