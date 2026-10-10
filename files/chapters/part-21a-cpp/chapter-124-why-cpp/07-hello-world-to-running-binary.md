## Hello World to Running Binary

Let us write, compile, and run a C++ program, then compare every step to the Go equivalent.

### The Program

This C++ program uses `std::vector` for dynamic arrays, structured initialization with `{name, age}` aggregate syntax, a range-based `for` loop with `const auto&`, and a lambda passed to `std::sort`, the idiomatic C++ equivalents of Go's slice literals, range expressions, and anonymous functions.
```cpp
// hello.cpp
#include <iostream>
#include <string>
#include <vector>
#include <algorithm>

// A simple struct (compare to Go's struct)
struct Person {
    std::string name;
    int age;
};

// A function that returns a filtered and sorted list
// Compare to Go: func getAdults(people []Person) []Person
std::vector<Person> get_adults(const std::vector<Person>& people) {
    std::vector<Person> adults;
    for (const auto& p : people) {
        if (p.age >= 18) {
            adults.push_back(p);
        }
    }
    // Sort by age (descending)
    std::sort(adults.begin(), adults.end(),
        [](const Person& a, const Person& b) {
            return a.age > b.age;
        });
    return adults;
}

int main() {
    std::vector<Person> people = {
        {"Alice", 30},
        {"Bob", 17},
        {"Charlie", 25},
        {"Diana", 15},
        {"Eve", 22},
    };

    std::cout << "All people:\n";
    for (const auto& p : people) {
        std::cout << "  " << p.name << " (age " << p.age << ")\n";
    }

    auto adults = get_adults(people);

    std::cout << "\nAdults (sorted by age, descending):\n";
    for (const auto& p : adults) {
        std::cout << "  " << p.name << " (age " << p.age << ")\n";
    }

    return 0;
}
```

### The Go Equivalent

Go's equivalent is structurally identical but removes all incidental ceremony: no header includes, no semicolons, no `std::` namespace prefix, and no explicit `return 0`. `sort.Slice` replaces `std::sort` with a less-verbose closure, and `fmt.Printf` unifies I/O without requiring separate `std::cout` includes.
```go
// hello.go
package main

import (
    "fmt"
    "sort"
)

type Person struct {
    Name string
    Age  int
}

func getAdults(people []Person) []Person {
    var adults []Person
    for _, p := range people {
        if p.Age >= 18 {
            adults = append(adults, p)
        }
    }
    sort.Slice(adults, func(i, j int) bool {
        return adults[i].Age > adults[j].Age
    })
    return adults
}

func main() {
    people := []Person{
        {"Alice", 30},
        {"Bob", 17},
        {"Charlie", 25},
        {"Diana", 15},
        {"Eve", 22},
    }

    fmt.Println("All people:")
    for _, p := range people {
        fmt.Printf("  %s (age %d)\n", p.Name, p.Age)
    }

    adults := getAdults(people)

    fmt.Println("\nAdults (sorted by age, descending):")
    for _, p := range adults {
        fmt.Printf("  %s (age %d)\n", p.Name, p.Age)
    }
}
```

### Side-by-Side Comparison

| Aspect | C++ | Go |
|--------|-----|-----|
| Include/Import | `#include <iostream>` | `import "fmt"` |
| Entry point | `int main()` | `func main()` |
| Struct definition | `struct Person { ... };` | `type Person struct { ... }` |
| Variable declaration | `auto x = 5;` | `x := 5` |
| Slice/Vector | `std::vector<Person>` | `[]Person` |
| Append | `vec.push_back(item)` | `slice = append(slice, item)` |
| Range loop | `for (const auto& p : vec)` | `for _, p := range slice` |
| Print | `std::cout << x << "\n"` | `fmt.Println(x)` |
| Sort | `std::sort(begin, end, cmp)` | `sort.Slice(s, less)` |
| Return | Explicit `return 0` | Implicit (no return code) |
| Const reference | `const std::vector<Person>&` | Passed by value (or pointer) |
| Semicolons | Required | Inserted by compiler |

### Compiling and Running

The commands below compile and run a C++ program with both major compilers. The `-std=c++20` flag selects the language standard, `-O2` enables optimizations, and `-Wall -Wextra` turns on common warnings.
```bash
# C++ with g++
g++ -std=c++20 -O2 -Wall -Wextra -o hello hello.cpp
./hello

# C++ with clang++
clang++ -std=c++20 -O2 -Wall -Wextra -o hello hello.cpp
./hello

# C++ with CMake
# CMakeLists.txt:
# cmake_minimum_required(VERSION 3.20)
# project(Hello LANGUAGES CXX)
# set(CMAKE_CXX_STANDARD 20)
# add_executable(hello hello.cpp)

mkdir build && cd build
cmake ..
cmake --build .
./hello

# Go
go build -o hello hello.go
./hello
# Or simply:
go run hello.go
```

### Compiler Flags Explained

Each `g++` flag controls a distinct phase: `-std=c++20` selects the language standard, `-O2` enables the optimizer, `-Wall -Wextra -Wpedantic` progressively widen the warning set, and `-Werror` promotes any remaining warning to a build-breaking error. Go's `go build` makes all these decisions implicitly, the toolchain always optimizes and always errors on problematic code.
```bash
g++ -std=c++20 -O2 -Wall -Wextra -Wpedantic -Werror -o hello hello.cpp
#    |           |    |      |       |          |       |
#    |           |    |      |       |          |       Output binary name
#    |           |    |      |       |          Treat warnings as errors
#    |           |    |      |       Strict ISO compliance warnings
#    |           |    |      Extra warnings beyond -Wall
#    |           |    Enable most warnings
#    |           Optimization level 2 (good balance of speed/compile time)
#    C++20 standard
```

In Go, `go build` handles everything. There are no optimization levels (the Go compiler always optimizes), no warning flags (the compiler reports errors, not warnings), and no standard version flags (you use the Go version in `go.mod`).

### A Multi-File Example

Real C++ projects split code across header files (`.h` or `.hpp`) and implementation files (`.cpp`).

```cpp
// person.hpp (header file - declarations)
#ifndef PERSON_HPP
#define PERSON_HPP

#include <string>
#include <vector>

struct Person {
    std::string name;
    int age;
};

std::vector<Person> get_adults(const std::vector<Person>& people);

#endif
```

```cpp
// person.cpp (implementation file - definitions)
#include "person.hpp"
#include <algorithm>

std::vector<Person> get_adults(const std::vector<Person>& people) {
    std::vector<Person> adults;
    for (const auto& p : people) {
        if (p.age >= 18) {
            adults.push_back(p);
        }
    }
    std::sort(adults.begin(), adults.end(),
        [](const Person& a, const Person& b) {
            return a.age > b.age;
        });
    return adults;
}
```

```cpp
// main.cpp
#include "person.hpp"
#include <iostream>

int main() {
    std::vector<Person> people = {
        {"Alice", 30}, {"Bob", 17}, {"Charlie", 25}
    };
    auto adults = get_adults(people);
    for (const auto& p : adults) {
        std::cout << p.name << " (" << p.age << ")\n";
    }
    return 0;
}
```

```bash
# Compile all files together
g++ -std=c++20 -O2 -o hello main.cpp person.cpp

# Or with CMake:
# add_executable(hello main.cpp person.cpp)
```

**Go comparison:** In Go, all `.go` files in a directory are automatically part of the same package. You do not need header files, include guards, or forward declarations. You write `package main` at the top and `go build` figures out the rest. The C++ header/source split exists because C++'s compilation model processes each `.cpp` file independently and links them later. Go's compiler processes entire packages at once.

---

### Junior → FAANG: Building the Mental Model of Compilation Before Writing More Code

The hello-world compile pipeline in C++ (preprocess, compile, assemble, link) is not academic. Every build error you will encounter maps to one stage: missing include (preprocess), type error (compile), undefined symbol (link). Knowing which stage produced the error tells you where to look.

Go engineers often feel the C++ compilation model is unnecessarily complex. The key insight is that C++ compiles translation units independently, which enables incremental builds and parallel compilation across thousands of files. Go compiles whole packages at once, which is simpler but means any change to a heavily imported package forces recompilation of everything that imports it.

First-job habit: when you see a linker error (`undefined reference to foo`), check three things in order: (1) is the implementation file included in the build target? (2) is the library that defines `foo` listed as a dependency? (3) is there an ODR (One Definition Rule) violation where two translation units define the same symbol with different types?

### Senior @ FAANG: Build Graph Ownership and Incremental Build Performance at Scale

At the staff level, the compilation model determines developer iteration speed, and slow builds are a tax on every engineer on the team.

**Build graph analysis.** In a Bazel monorepo, a C++ service with many transient dependencies can have a build graph with thousands of targets. When build times grow beyond a few minutes, a staff engineer performs a build graph analysis: which targets are on the critical path, which targets have excessive fanout (rebuilding too many downstream targets on any change), and which headers are included unnecessarily (driving up compilation times across many translation units). Tools: `bazel query`, `bazel cquery`, and `Include What You Use (IWYU)` for header pruning.

**Module adoption strategy.** C++20 modules promise to replace the header/source model with faster, cleaner compilation. But module adoption in large codebases is a multi-year project because modules and headers are not fully interoperable in all compilers, and Bazel/CMake module support is still maturing. A staff engineer who owns the build system must evaluate when module adoption makes sense: after the compiler support stabilizes, after the build system support lands, and after a pilot on a small isolated target confirms the speedup. The pilot approach is mandatory. Premature module adoption in a 5M LOC codebase is a months-long regression risk.

**Distributed build infrastructure.** At FAANG scale, local builds are the exception. CI uses remote execution (Google's RBE, Bazel Remote Execution API, or a self-hosted equivalent). A staff engineer evaluates: what is the cache hit rate on CI? What is the critical path latency of the build? Where are cache misses concentrated (non-deterministic actions, uncacheable targets)? Improving CI build time by 20% is a multiplier across every engineer and every PR. The ROI is high enough to justify dedicated engineering time.

**Binary size governance.** C++ template instantiation can silently grow binary sizes by megabytes. In a service with many template-heavy dependencies (Abseil, Folly, Boost.Asio), a staff engineer monitors binary size as a metric in CI and sets a budget. When the budget is exceeded, the debug process involves: `nm --size-sort`, `bloaty` (Google's binary size profiler), and identifying which template instantiations are contributing the most. The common fix is explicit template instantiation in a dedicated `.cpp` file to prevent repeated instantiation across translation units.

