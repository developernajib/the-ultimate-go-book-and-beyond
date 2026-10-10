## Profile-Guided Optimization (PGO) and Link-Time Optimization (LTO)

### Profile-Guided Optimization

PGO uses runtime profiling data to inform compiler optimization decisions. The compiler sees which branches are taken, which functions are hot, and which loops execute many times.

```bash
# Step 1: Build with instrumentation
g++ -O2 -fprofile-generate -o myapp_instrumented main.cpp

# Step 2: Run with representative workload to collect profile
./myapp_instrumented --typical-workload input_data.bin
# This generates .gcda files with profile data

# Step 3: Rebuild using the collected profile
g++ -O2 -fprofile-use -o myapp_optimized main.cpp

# Clang equivalent:
clang++ -O2 -fprofile-instr-generate -o myapp_instr main.cpp
./myapp_instr --typical-workload input_data.bin
llvm-profdata merge -output=default.profdata default.profraw
clang++ -O2 -fprofile-instr-use=default.profdata -o myapp_opt main.cpp
```

PGO typically yields 10-20% performance improvement. For branch-heavy code, improvements can reach 30%+. The optimizations PGO enables include:

- **Branch layout:** Hot paths placed in fall-through position
- **Function inlining:** Hot call sites inlined more aggressively
- **Basic block ordering:** Hot blocks placed for better instruction cache use
- **Register allocation:** Hot paths get priority for register assignment
- **Vectorization hints:** Loop trip counts inform vectorization decisions

### Link-Time Optimization (LTO)

LTO allows the compiler to optimize across translation unit boundaries at link time, enabling cross-module inlining, dead code elimination, and interprocedural optimization:

```bash
# GCC LTO
g++ -O2 -flto -c file1.cpp -o file1.o
g++ -O2 -flto -c file2.cpp -o file2.o
g++ -O2 -flto file1.o file2.o -o myapp

# Single command (easier)
g++ -O2 -flto file1.cpp file2.cpp -o myapp

# ThinLTO with Clang (faster link times than full LTO)
clang++ -O2 -flto=thin file1.cpp file2.cpp -o myapp

# Combining PGO + LTO for maximum performance
g++ -O2 -flto -fprofile-use file1.cpp file2.cpp -o myapp
```

LTO typically provides 5-15% improvement. The combination of PGO + LTO is the standard approach for production builds at companies like Google, where it is applied to virtually all performance-critical C++ binaries.

### CMake Integration

The CMake configuration below wires PGO and LTO into the build as optional flags. You can toggle them via command-line presets or CI variables without modifying the build files.
```cmake
# CMakeLists.txt with LTO and PGO support
cmake_minimum_required(VERSION 3.16)
project(perf_demo CXX)

set(CMAKE_CXX_STANDARD 20)

# Enable LTO
include(CheckIPOSupported)
check_ipo_supported(RESULT ipo_supported)
if(ipo_supported)
    set(CMAKE_INTERPROCEDURAL_OPTIMIZATION TRUE)
endif()

# PGO: generate profile
option(PGO_GENERATE "Build with profile generation" OFF)
option(PGO_USE "Build with profile-guided optimization" OFF)

if(PGO_GENERATE)
    add_compile_options(-fprofile-generate)
    add_link_options(-fprofile-generate)
elseif(PGO_USE)
    add_compile_options(-fprofile-use -fprofile-correction)
    add_link_options(-fprofile-use)
endif()

add_executable(myapp main.cpp engine.cpp physics.cpp)
target_compile_options(myapp PRIVATE -O3 -march=native)
```

---
