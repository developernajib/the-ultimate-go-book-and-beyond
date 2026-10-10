## The Compilation Model

Go has a single command: `go build`. It handles everything. C++ has a multi-stage pipeline that you must understand to debug build issues, optimize compile times, and write correct code.

### Go's Build Model (Simple)

Go's build model compiles an entire package as a unit in one pass, all `.go` files are parsed, type-checked, and code-generated together before the linker produces a single static binary. There is no separate preprocessing or assembly stage exposed to the developer.
```text
source.go --[go build]--> binary

The Go compiler:
1. Parses all .go files in the package
2. Type-checks
3. Generates machine code
4. Links
5. Produces a single static binary
All in one step.
```

### C++ Build Pipeline (Four Stages)

C++ compilation is a four-stage pipeline: the preprocessor expands `#include` and macros into a single expanded source file. The compiler converts that to assembly. The assembler produces a relocatable object file (`.o`). And the linker resolves symbols across all object files and libraries to produce the final executable or shared library.
```text
source.cpp
    |
    v
[1. Preprocessor] --> expanded source (text substitution)
    |
    v
[2. Compiler] --> assembly code (.s)
    |
    v
[3. Assembler] --> object file (.o / .obj)
    |
    v
[4. Linker] --> executable binary (or library)
```

Let us examine each stage in detail.

### Stage 1: Preprocessor

The preprocessor runs before the compiler sees your code. It performs textual transformations: macro expansion, file inclusion, and conditional compilation.

```cpp
// Before preprocessing:
#include <iostream>
#define MAX_SIZE 1024
#define SQUARE(x) ((x) * (x))

#ifdef DEBUG
    #define LOG(msg) std::cerr << msg << "\n"
#else
    #define LOG(msg)  // expands to nothing in release
#endif

int main() {
    int arr[MAX_SIZE];          // becomes: int arr[1024];
    int val = SQUARE(5);        // becomes: int val = ((5) * (5));
    LOG("starting");            // becomes nothing (or cerr output)
    return 0;
}
```

You can see the preprocessor output with:

```bash
# GCC/Clang: -E flag shows preprocessor output
g++ -E main.cpp -o main.i

# The output is typically thousands of lines because <iostream>
# pulls in a massive chain of headers
```

**Preprocessor pitfalls:**

```cpp
// DANGEROUS macro: no parentheses
#define BAD_SQUARE(x) x * x
int val = BAD_SQUARE(2 + 3);  // expands to: 2 + 3 * 2 + 3 = 11, not 25!

// SAFE macro: fully parenthesized
#define GOOD_SQUARE(x) ((x) * (x))
int val2 = GOOD_SQUARE(2 + 3); // expands to: ((2 + 3) * (2 + 3)) = 25

// BETTER: use constexpr function instead of macro
constexpr int square(int x) { return x * x; }
// Type-safe, scoped, debuggable
```

### Stage 2: Compiler

The compiler takes the preprocessed source and produces assembly code. This is where type checking, optimization, and code generation happen.

```bash
# Compile to assembly
g++ -S main.cpp -o main.s

# Compile to object file (assembly + assembler in one step)
g++ -c main.cpp -o main.o
```

Each `.cpp` file is compiled independently into an **object file**. This is called a **translation unit**. The compiler knows nothing about other `.cpp` files. It only knows what you told it via `#include` directives (declarations).

### Stage 3: Assembler

The assembler converts assembly code into machine code, producing an object file (`.o` on Linux/macOS, `.obj` on Windows).

```bash
# This step is usually combined with compilation:
g++ -c main.cpp -o main.o
# Internally does: preprocess -> compile -> assemble
```

Object files contain machine code, but with unresolved references to functions defined in other files. These unresolved references are recorded in a symbol table.

### Stage 4: Linker

The linker combines all object files and resolves cross-references.

```bash
# Linking multiple object files into an executable
g++ main.o mymath.o -o myprogram

# Or let g++ handle everything:
g++ main.cpp mymath.cpp -o myprogram
```

**Common linker errors:**

```text
# Undefined reference: you declared a function but never defined it
undefined reference to `add(int, int)'
# Fix: make sure the .cpp file with the definition is included in the build

# Multiple definition: you defined a function in a header without inline
multiple definition of `add(int, int)'
# Fix: use inline, or move definition to a .cpp file
```

### Putting It All Together

The following complete example integrates the individual techniques covered in this chapter into a cohesive program that demonstrates how they interact in practice. Reading through the code in its entirety before examining individual sections provides essential context for understanding the design decisions.
```bash
# Full build command with common flags
g++ -std=c++20     \  # use C++20 standard
    -Wall -Wextra  \  # enable most warnings
    -Werror        \  # treat warnings as errors
    -O2            \  # optimization level 2
    -g             \  # include debug symbols
    main.cpp mymath.cpp utils.cpp \
    -o myprogram

# Using a build system (CMake) - the standard in industry
# CMakeLists.txt:
# cmake_minimum_required(VERSION 3.20)
# project(MyProject)
# set(CMAKE_CXX_STANDARD 20)
# add_executable(myprogram main.cpp mymath.cpp utils.cpp)
```

**For Go developers:** Think of the preprocessor as doing what `go generate` does, the compiler as what `go build` does per-file, and the linker as the final assembly step. The big difference is that Go hides all this complexity behind a single command.

---

### Junior → FAANG: Using the Compilation Model to Diagnose Build Errors Faster

When a C++ build fails, the error message is often cryptic. Knowing which stage produced it cuts diagnosis time dramatically. A "file not found" error is a preprocessor error: the include path is wrong. A "no matching function" error is a compiler error: overload resolution failed or a type is wrong. An "undefined reference" error is a linker error: the implementation is not compiled or the library is not linked.

Practical exercise: intentionally produce each type of error (remove an include, introduce a type mismatch, omit a library from the link step) and read the resulting error message. This builds the pattern recognition that makes build failures recoverable in under five minutes instead of thirty.

Interview note: "what is the One Definition Rule (ODR)?" is a common C++ interview question. The answer: a given symbol may be defined only once across all translation units (with specific exceptions for `inline` functions and class definitions in headers). ODR violations are undefined behavior and produce bugs that are often very hard to trace because the linker may silently accept the first definition and ignore the rest.

### Senior @ FAANG: Link Time Optimization, Symbol Visibility, and the ODR as a Production Risk

At the staff level, the compilation model determines binary performance, binary size, and the security surface of your shared libraries.

**Link Time Optimization (LTO).** LTO defers optimization from the compile step to the link step, allowing the optimizer to see the entire program and perform cross-translation-unit inlining, dead code elimination, and devirtualization. The result is typically 5 to 15 percent faster binaries. The cost: much slower link times (the linker now does heavy optimization work) and harder-to-debug intermediate representations. A staff engineer decides when LTO is worth the link-time cost: typically yes for release binaries where link time is amortized over many users, and no for developer builds where fast iteration matters more than peak performance.

**Symbol visibility control.** In a shared library, every exported symbol is a security and ABI surface. The best practice is to mark all symbols as hidden by default (`-fvisibility=hidden` in Clang/GCC) and explicitly export only the public API (`__attribute__((visibility("default")))` or a visibility macro). This reduces the attack surface (fewer symbols can be interposed by `LD_PRELOAD`), reduces the shared library's export table size, and enables more aggressive inlining of internal functions. A staff engineer adds this to the build system defaults for all new shared libraries.

**ODR violations as production risks.** In a monorepo that links many libraries into a single binary, ODR violations are a latent risk: two libraries define the same symbol with different implementations, and the linker silently picks one. The result is usually a very subtle bug (a function that behaves correctly in isolation but incorrectly when linked with the other library). Detection: `gold --detect-odr-violations`, `clang`'s `-Wodr` flag, and careful dependency hygiene (avoid duplicating code across libraries, share through a common library). A staff engineer adds ODR violation detection to CI for release builds.

