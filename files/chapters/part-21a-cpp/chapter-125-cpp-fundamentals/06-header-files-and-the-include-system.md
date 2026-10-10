## Header Files and the Include System

This is one of the most fundamental differences between Go and C++. Go's import system is simple and modern. C++ inherits a 1970s-era textual inclusion model that every C++ developer must understand deeply.

### How Go's Import Works

Go's import resolves a package by reading its pre-compiled binary metadata, the compiler never re-parses the source of dependencies. Each package is compiled exactly once and its type information is stored in a binary object file, giving Go's build system predictable, dependency-ordered compilation without any textual inclusion.
```go
import "fmt"           // compiler reads compiled package metadata
import "net/http"      // dependency resolved automatically
// Done. No forward declarations, no headers, no include guards.
```

Go compiles each package once and produces a binary package object. When you import, the compiler reads the package's type information directly. There is no textual inclusion.

### How C++ #include Works

In C++, `#include` is a preprocessor directive that performs **textual substitution**. It literally copies the entire contents of the included file into the current file before compilation begins.

```cpp
// mymath.h - the HEADER file (declarations only)
#ifndef MYMATH_H       // include guard: prevents double inclusion
#define MYMATH_H

int add(int a, int b);         // declaration (no body)
double multiply(double a, double b); // declaration

#endif // MYMATH_H

// mymath.cpp - the IMPLEMENTATION file (definitions)
#include "mymath.h"    // includes our header

int add(int a, int b) {        // definition (has body)
    return a + b;
}

double multiply(double a, double b) {
    return a * b;
}

// main.cpp - uses the library
#include "mymath.h"    // includes declarations
#include <iostream>    // includes standard library header

int main() {
    std::cout << add(3, 4) << "\n";
    std::cout << multiply(2.5, 3.0) << "\n";
    return 0;
}
```

### Include Guards vs #pragma once

Every header file needs protection against being included multiple times (which would cause "redefinition" errors).

```cpp
// Method 1: Traditional include guards
#ifndef MY_PROJECT_UTILS_MATH_H  // if not defined
#define MY_PROJECT_UTILS_MATH_H  // define it

// ... header contents ...

#endif // MY_PROJECT_UTILS_MATH_H

// Method 2: #pragma once (non-standard but universally supported)
#pragma once

// ... header contents ...
// Simpler, less error-prone, supported by all major compilers
```

`#pragma once` is not part of the C++ standard but is supported by GCC, Clang, MSVC, and all other major compilers. Most modern projects use it for simplicity.

### The Declaration vs Definition Distinction

This is a concept that does not exist in Go. In Go, you define a function once and it is visible everywhere in the package. In C++, you must separate **declarations** (what exists) from **definitions** (how it works).

```cpp
// DECLARATION: tells the compiler "this function exists"
// Does not generate any machine code
int add(int a, int b);

// DEFINITION: provides the implementation
// Generates machine code
int add(int a, int b) {
    return a + b;
}

// You can declare something many times:
int add(int a, int b);  // OK: repeated declaration
int add(int a, int b);  // OK: same declaration again

// But you can define it only ONCE (One Definition Rule):
// int add(int a, int b) { return a + b; }  // ERROR if already defined
```

**Why the split?** Because C++ compiles each `.cpp` file independently (called a **translation unit**). When `main.cpp` calls `add()`, the compiler needs to know the function signature (declaration) to generate the call, but it does not need the implementation (definition), which lives in `mymath.cpp`. The linker connects them later.

### System vs User Headers

Angle brackets (`<header>`) direct the preprocessor to search only the compiler's system include paths, standard library headers and installed third-party libraries. Quotes (`"header.h"`) search the current directory first, then fall back to system paths, making them appropriate for project-local headers where the relative location is known.
```cpp
#include <iostream>    // angle brackets: search system/standard paths
#include "myheader.h"  // quotes: search local directory first, then system paths
```

### Forward Declarations

To avoid including heavy headers when you only need to mention a type by name:

```cpp
// Instead of: #include "database.h" (which might include hundreds of headers)

class Database;  // forward declaration: "Database is a class that exists"

class UserService {
    Database* db;  // OK: we only need a pointer, not the full definition
    // Database db; // ERROR: compiler needs full definition for value types
};
```

This technique significantly improves compile times in large C++ projects. Go does not need this because its import system is already efficient.

### C++20 Modules (The Future)

C++20 introduced modules, which work more like Go's import system:

```cpp
// math.cppm - module definition
export module math;

export int add(int a, int b) {
    return a + b;
}

// main.cpp - uses the module
import math;

int main() {
    return add(3, 4);
}
```

Modules eliminate headers, include guards, and the textual inclusion model. However, as of the mid-2020s, compiler support is still maturing and most production C++ codebases still use headers.

---

### Junior → FAANG: The Include System as a Build Time Problem

Go engineers are surprised by how much C++ build time is dominated by header parsing. Every `#include <string>` in a `.cpp` file causes the preprocessor to recursively expand all headers that `<string>` includes, which can be thousands of lines. When you include a header in 500 translation units, you are parsing those thousands of lines 500 times.

The immediate first-job habit: use "Include What You Use" (IWYU) to ensure every `.cpp` file includes only what it directly uses, and that every `#include` in a header is actually needed. IWYU is a clang-based tool that can generate a report of superfluous includes and missing includes. Running it on a new PR reduces build time for everyone who depends on your header.

Practice exercise: take a header file that includes `<string>`, `<vector>`, `<map>`, and `<iostream>`, and trace what each of those brings in by running `clang++ -E` (preprocess only) and counting lines. The result is instructive.

### Senior @ FAANG: Header Inclusion Policy, Precompiled Headers, and Module Migration

At the staff level, header inclusion is a build performance governance issue.

**Precompiled headers (PCH).** For large headers that are included everywhere (project-wide base headers, Abseil or Folly headers), precompiled headers can dramatically reduce build time by parsing the header once and caching the result. The tradeoff: PCHs are fragile (any change to the PCH header invalidates the cache for all translation units), and they can mask IWYU violations. A staff engineer decides whether PCH is appropriate for the codebase, and if so, which headers belong in it and how changes to those headers are managed.

**Module migration planning.** Moving from headers to C++20 modules is a multi-year project for large codebases. The migration is not binary: you can use modules for new code while keeping headers for existing code, as long as you use a "module interface unit" that imports the header (a "module wrapper"). A staff engineer writes the migration plan with three phases: (1) wrap key internal headers in module interfaces, (2) migrate new code to import those modules, (3) migrate existing code incrementally with measurable build time gains per milestone. Each phase is gated on compiler support stability and CI build time regression tests.

**Include order enforcement.** Google's style guide mandates a specific include order: related header first, then C system headers, then C++ standard library headers, then other headers. This order helps detect when a header is missing an include (the related header cannot "accidentally" get a dependency from an earlier include). Enforcing this via clang-format's `SortIncludes` and a CI check prevents the common bug where a header works only when included in a specific order.

