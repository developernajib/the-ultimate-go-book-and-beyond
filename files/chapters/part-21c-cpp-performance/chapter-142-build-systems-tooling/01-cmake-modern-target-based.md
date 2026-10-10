## CMake: Modern Target-Based Build

CMake is not a build system. It is a build system generator, it reads `CMakeLists.txt` files and emits Ninja build files, Makefiles, Visual Studio project files, or Xcode projects. That distinction matters: CMake describes your build graph in a cross-platform DSL, and the underlying executor handles parallelism and incremental rebuilds. At FAANG scale, CMake is the most common choice for open-source and internal C++ projects, including LLVM, OpenCV, Qt, and most of Google's public C++ infrastructure.

### The Old CMake Anti-Patterns

Pre-3.0 CMake code pollutes the global build state. If you inherit a project using these patterns, treat them as technical debt:

```cmake
# BAD: old-style global pollution -- do NOT write this
cmake_minimum_required(VERSION 2.8)
project(MyApp)

include_directories(${CMAKE_SOURCE_DIR}/include)       # global: infects everything
add_definitions(-DUSE_FEATURE_X)                       # global: leaks into all targets
link_directories(/usr/local/lib)                       # global: fragile on other machines
set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -Wall -O2")   # global: overrides user flags

add_executable(myapp src/main.cpp)
target_link_libraries(myapp mylib)
```

Every `include_directories` call affects every target defined after it. On a large project with dozens of libraries this creates invisible coupling and makes targets impossible to build in isolation.

### Modern CMake: Everything Is a Target

In modern CMake (3.15+), each target carries its own include paths, compile flags, and link dependencies. Propagation is explicit: `PRIVATE` means "this target only", `PUBLIC` means "this target and everything that links it", `INTERFACE` means "only consumers, not this target itself."

```cmake
cmake_minimum_required(VERSION 3.20)
project(
    Falcon
    VERSION 1.4.2
    DESCRIPTION "High-performance request processing library"
    LANGUAGES CXX
)

# ── Global C++ standard ──────────────────────────────────────────────────────
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# ── Library target ───────────────────────────────────────────────────────────
add_library(falcon
    src/scheduler.cpp
    src/connection_pool.cpp
    src/request_parser.cpp
)

# PUBLIC: consumers inherit these include paths and compile definitions
# PRIVATE: only this library's own translation units see them
target_include_directories(falcon
    PUBLIC
        $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
        $<INSTALL_INTERFACE:include>
    PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/src
)

target_compile_options(falcon
    PRIVATE
        $<$<CXX_COMPILER_ID:Clang,GNU>:-Wall -Wextra -Wpedantic -Werror>
        $<$<CXX_COMPILER_ID:MSVC>:/W4 /WX>
)

target_compile_definitions(falcon
    PUBLIC  FALCON_VERSION="${PROJECT_VERSION}"
    PRIVATE FALCON_INTERNAL_BUILD
)

# ── Executable target ────────────────────────────────────────────────────────
add_executable(falcon_server src/main.cpp)

target_link_libraries(falcon_server
    PRIVATE
        falcon
        Threads::Threads
)

# ── Tests ────────────────────────────────────────────────────────────────────
include(CTest)
enable_testing()

find_package(GTest REQUIRED)

add_executable(falcon_tests
    tests/scheduler_test.cpp
    tests/parser_test.cpp
)

target_link_libraries(falcon_tests
    PRIVATE
        falcon
        GTest::gtest_main
)

include(GoogleTest)
gtest_discover_tests(falcon_tests)
```

### Finding Dependencies with find_package

`find_package` locates installed dependencies and exposes them as imported targets that carry their include paths and link flags, so consuming a library is one `target_link_libraries` line.
```cmake
# Find Boost with required components
find_package(Boost 1.80 REQUIRED COMPONENTS
    system
    filesystem
    thread
)

target_link_libraries(falcon
    PUBLIC
        Boost::system
        Boost::filesystem
    PRIVATE
        Boost::thread
)

# Find OpenSSL
find_package(OpenSSL REQUIRED)
target_link_libraries(falcon PRIVATE OpenSSL::SSL OpenSSL::Crypto)

# Find pkg-config managed libraries
find_package(PkgConfig REQUIRED)
pkg_check_modules(LIBFMT REQUIRED fmt)
target_link_libraries(falcon PRIVATE ${LIBFMT_LIBRARIES})
target_include_directories(falcon PRIVATE ${LIBFMT_INCLUDE_DIRS})
```

### Exporting Targets for Downstream Projects

This is what separates a library that can be consumed with `find_package` from one that requires copying include paths manually:

```cmake
include(GNUInstallDirs)
include(CMakePackageConfigHelpers)

install(TARGETS falcon falcon_server
    EXPORT FalconTargets
    LIBRARY  DESTINATION ${CMAKE_INSTALL_LIBDIR}
    ARCHIVE  DESTINATION ${CMAKE_INSTALL_LIBDIR}
    RUNTIME  DESTINATION ${CMAKE_INSTALL_BINDIR}
    INCLUDES DESTINATION ${CMAKE_INSTALL_INCLUDEDIR}
)

install(DIRECTORY include/ DESTINATION ${CMAKE_INSTALL_INCLUDEDIR})

install(EXPORT FalconTargets
    FILE        FalconTargets.cmake
    NAMESPACE   Falcon::
    DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/Falcon
)

configure_package_config_file(
    cmake/FalconConfig.cmake.in
    ${CMAKE_CURRENT_BINARY_DIR}/FalconConfig.cmake
    INSTALL_DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/Falcon
)

write_basic_package_version_file(
    ${CMAKE_CURRENT_BINARY_DIR}/FalconConfigVersion.cmake
    VERSION      ${PROJECT_VERSION}
    COMPATIBILITY SameMajorVersion
)

install(FILES
    ${CMAKE_CURRENT_BINARY_DIR}/FalconConfig.cmake
    ${CMAKE_CURRENT_BINARY_DIR}/FalconConfigVersion.cmake
    DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/Falcon
)
```

After installation, downstream projects just write:

```cmake
find_package(Falcon 1.4 REQUIRED)
target_link_libraries(my_app PRIVATE Falcon::falcon)
```

### CMake Presets

`CMakePresets.json` standardizes configuration across machines and CI, eliminating "it builds on my laptop" problems:

```json
{
  "version": 6,
  "cmakeMinimumRequired": { "major": 3, "minor": 25 },
  "configurePresets": [
    {
      "name": "base",
      "hidden": true,
      "generator": "Ninja",
      "binaryDir": "${sourceDir}/build/${presetName}",
      "cacheVariables": {
        "CMAKE_CXX_STANDARD": "20",
        "CMAKE_EXPORT_COMPILE_COMMANDS": "ON"
      }
    },
    {
      "name": "release",
      "inherits": "base",
      "displayName": "Release",
      "cacheVariables": {
        "CMAKE_BUILD_TYPE": "Release",
        "CMAKE_CXX_COMPILER_LAUNCHER": "sccache"
      }
    },
    {
      "name": "asan",
      "inherits": "base",
      "displayName": "AddressSanitizer",
      "cacheVariables": {
        "CMAKE_BUILD_TYPE": "RelWithDebInfo",
        "CMAKE_CXX_FLAGS": "-fsanitize=address -fno-omit-frame-pointer",
        "CMAKE_EXE_LINKER_FLAGS": "-fsanitize=address"
      }
    },
    {
      "name": "ci",
      "inherits": "release",
      "displayName": "CI Build",
      "cacheVariables": {
        "CMAKE_CXX_CLANG_TIDY": "clang-tidy;--warnings-as-errors=*"
      }
    }
  ],
  "buildPresets": [
    { "name": "release", "configurePreset": "release" },
    { "name": "asan",    "configurePreset": "asan" },
    { "name": "ci",      "configurePreset": "ci" }
  ],
  "testPresets": [
    {
      "name": "release",
      "configurePreset": "release",
      "output": { "verbosity": "verbose" },
      "execution": { "jobs": 8, "stopOnFailure": false }
    }
  ]
}
```

Developers run `cmake --preset release && cmake --build --preset release`. CI runs the `ci` preset. No manual flag passing, no tribal knowledge.

### Go Comparison

Go's `go build ./...` is the equivalent of CMake + Ninja combined, but hardwired for a single language and module system. CMake is more powerful, it handles mixed C/C++/CUDA/Fortran projects, cross-compilation to embedded targets, and complex install hierarchies, but that power comes with a 300-page manual. The key insight is that modern CMake's target model maps directly to Go's package model: each target has explicit public and private interfaces, and propagation is the library's responsibility, not the consumer's.

---
