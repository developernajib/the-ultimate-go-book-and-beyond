## Modules Deep Dive

C++20 modules replace the textual `#include` model with a binary interface. A module is compiled once into a Binary Module Interface (BMI), and consumers import that BMI instead of re-parsing the header. The promised wins are isolation from macros, faster builds, and a single declaration of every entity. The reality in 2026 is mixed adoption with strong tooling support on Clang, GCC, and MSVC, and growing CMake integration.

### Module Interface Unit

A module interface unit declares the module and exports the names that consumers see.

```cpp
// math.cppm  (interface unit)
export module math;

export int add(int a, int b) { return a + b; }
export int sub(int a, int b) { return a - b; }

int internal_helper(int x) { return x * x; }   // not exported
```

The `export` keyword on the `module` line marks this translation unit as the **primary module interface unit**. Each named module has exactly one primary interface unit. Names declared with `export` are visible to importers. Names without `export` have module linkage. They live in the module but are invisible outside.

```cpp
// app.cpp
import math;

int main() { return add(2, 3); }
```

`import math;` reads the BMI for `math`, makes the exported names available, and brings nothing else. Macros defined inside `math.cppm` do not leak into `app.cpp`. Includes done inside the module's purview do not leak either. This is the macro-isolation guarantee.

## Implementation Unit

The body of an exported function can move to an implementation unit. The implementation unit names the module without `export`.

```cpp
// math.cppm
export module math;
export int add(int a, int b);
export int sub(int a, int b);

// math.impl.cpp
module math;
int add(int a, int b) { return a + b; }
int sub(int a, int b) { return a - b; }
```

Implementation units can see internal-linkage entities of the module without re-declaring them. They share the module purview, which means an implementation unit of `math` can call `internal_helper` defined in the interface unit without including anything.

## Partitions

Large modules split into **partitions**. Each partition is its own translation unit, owns its declarations, and the primary interface re-exports the ones that should be public.

```cpp
// math-vec.cppm
export module math:vec;
export struct vec3 { double x, y, z; };

// math-mat.cppm
export module math:mat;
import :vec;
export struct mat3 { vec3 rows[3]; };

// math.cppm  (primary, glues everything)
export module math;
export import :vec;
export import :mat;
```

`export import :partition` re-exports a partition's exported names through the parent module. Inside the module, partitions reference each other with `:partition_name`. Outside the module, partitions are invisible. Consumers only see `import math;`.

This is how you decompose what would have been thirty headers into one logical unit without exposing the internal seams.

### import std (C++23)

Before C++23, importing the standard library required `import <vector>;` (header units) or `#include <vector>` from inside a module. C++23 added `import std;` and `import std.compat;`.

```cpp
import std;

int main() {
    std::vector<int> v{1, 2, 3};
    std::print("{}\n", v);
}
```

`import std` brings the whole `std::` namespace. `import std.compat` adds the global names that the C headers historically dumped, like `::printf`. Compiler vendors ship a precompiled BMI for `std`, which means `import std` is one of the fastest imports in the language. A trivial hello-world that took 800 ms to compile with `<iostream>` drops below 100 ms with `import std`.

GCC 14 supports `import std`. Clang 18 supports it with `-stdlib=libc++ -fmodules`. MSVC 17.10 ships it on by default with `/std:c++latest /experimental:module`.

## Header Units

Header units are the migration tool. Any header can be imported as a module without rewriting it.

```cpp
import <vector>;
import "my_legacy_header.h";
```

The compiler synthesises a BMI from the header. Macros defined in the header are still exported (header units preserve macro semantics, named modules do not). Header units are slower than a real module but faster than `#include` because the BMI is cached. Use them as the on-ramp while migrating a codebase.

## Module ABI

A BMI is **not** an ABI. It is the compiler's internal representation, sensitive to the compiler version, flags, and standard library version. You cannot ship a BMI to consumers using a different toolchain. Modules do not change runtime ABI. A function exported from a module has the same name mangling and calling convention it would have had in a header. Linker behavior is unchanged. The module system runs entirely at compile time.

This means a closed-source library still ships headers, or a header unit, or a hand-written module interface that forwards to the precompiled object. Modules improve the **build** boundary, not the **distribution** boundary.

## Build System Support

Modules require the build system to discover the dependency graph before compilation, because importing a module needs the BMI of that module to exist first. Header-based C++ has no such constraint.

**CMake.** Module support stabilised in CMake 3.28 (late 2023) and improved through 3.30+. Enable with:

```cmake
cmake_minimum_required(VERSION 3.28)
project(myapp CXX)
set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_SCAN_FOR_MODULES ON)

add_library(math)
target_sources(math
    PUBLIC FILE_SET cxx_modules TYPE CXX_MODULES FILES
        math.cppm
        math-vec.cppm
        math-mat.cppm)

add_executable(app app.cpp)
target_link_libraries(app PRIVATE math)
```

`FILE_SET cxx_modules` is the new keyword. CMake invokes the compiler in scan mode to extract `import` and `export module` declarations, builds a dependency graph, and orders compilation. Ninja 1.11+ understands the dynamic dependency files (`*.ddi`) the scanner produces.

**MSBuild.** Visual Studio 17.5+ supports modules through `.ixx` files (the MSVC convention for primary interface units). The IDE handles dependency scanning automatically. `import std` works in 17.10+.

**build2.** Has supported modules since 2018 and offers the most mature implementation.

**Bazel.** Module support is experimental as of 2026. Most large internal C++ codebases at FAANG companies that use Bazel have stayed on headers because of build-graph constraints.

### Real-World Adoption (2026)

Microsoft's STL ships as both headers and modules. The Windows SDK has a `std.ixx` for in-tree builds.

LLVM's libc++ ships `import std` support. Chromium has experimented with modules for some components but kept the bulk on headers due to Bazel-like build-graph requirements.

Google's internal C++ remains predominantly header-based. The migration cost across hundreds of millions of lines is the blocker, not the feature.

New projects started after 2023 that use CMake 3.28+ and a modern compiler are increasingly module-first. Greenfield Bloomberg components and several HPC frameworks (Kokkos preview, SYCL implementations) ship as named modules.

The empirical compile-time win for a fresh codebase ranges from 30 percent to 5x depending on header bloat. Teams that previously used precompiled headers see less improvement because PCH already solved part of the problem.

### Junior to FAANG / Senior at FAANG

A junior should write `import std;` in new code, structure a small library with a single primary interface and one or two implementation units, and configure CMake with `FILE_SET cxx_modules`. They should know that BMIs are not portable across toolchains.

A senior is expected to design partition boundaries that minimize cross-partition imports, decide when a header unit is the right migration step, set up Ninja-driven dependency scanning in a polyglot build, and quantify compile-time wins. They should understand why modules do not solve ABI, why mixing modules and headers needs care around `extern "C++"` linkage and ODR, and why Bazel-shaped build systems lag CMake here.
