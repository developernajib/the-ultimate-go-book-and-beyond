## Code Formatting: clang-format and Include-What-You-Use

Code formatting debates waste engineering time. Every hour spent arguing about brace placement or column width is an hour not spent solving real problems. The solution is an automated formatter that enforces a single canonical style with zero configuration per engineer. Go solved this with `gofmt` in 2013 and eliminated the debate entirely. C++ has `clang-format`, which is nearly as good, the only difference is that teams must agree on a configuration once rather than having the language author decide.

### clang-format

clang-format is part of the LLVM project and formats C, C++, Java, JavaScript, TypeScript, and Objective-C. It is AST-aware, meaning it correctly handles complex C++ constructs like template argument lists, lambda captures, and initializer lists that regex-based formatters mangle.

#### Production .clang-format

A production `.clang-format` file starts from a well-known base style (`Google`, `LLVM`, or `Mozilla`) and overrides specific options to match team conventions, column width, brace breaking style, include ordering, and pointer alignment. Committing this file to the repository root ensures every developer and CI job formats code identically, eliminating whitespace-only diffs in code review.
```yaml
# .clang-format (YAML, placed at project root)
# Based on Google style with production customizations

Language: Cpp
BasedOnStyle: Google

# Column limit -- 100 is common at FAANG, 80 is traditional
ColumnLimit: 100

# Indentation
IndentWidth: 4
TabWidth: 4
UseTab: Never
IndentCaseLabels: true
IndentPPDirectives: BeforeHash

# Brace wrapping (Google style keeps opening braces on same line)
BreakBeforeBraces: Attach

# Constructor initializer lists
BreakConstructorInitializers: BeforeComma
PackConstructorInitializers: Never

# Templates
AlwaysBreakTemplateDeclarations: Yes

# Access modifiers
AccessModifierOffset: -4

# Includes
SortIncludes: CaseSensitive
IncludeBlocks: Regroup
IncludeCategories:
  # 1. This file's own header (e.g., foo.cpp includes foo.h first)
  - Regex:           '^".*\.h"'
    Priority:        1
    SortPriority:    0
  # 2. Project headers
  - Regex:           '^"(falcon|src)/'
    Priority:        2
  # 3. Third-party headers
  - Regex:           '^<(fmt|spdlog|boost|gtest)/'
    Priority:        3
  # 4. System/standard library headers
  - Regex:           '^<'
    Priority:        4

# Function parameters
AllowAllParametersOfDeclarationOnNextLine: false
BinPackArguments: false
BinPackParameters: false

# Short functions/lambdas on one line
AllowShortFunctionsOnASingleLine: Inline
AllowShortLambdasOnASingleLine: All
AllowShortIfStatementsOnASingleLine: Never
AllowShortLoopsOnASingleLine: false

# Trailing commas
InsertTrailingCommas: Wrapped

# Spaces
SpaceAfterCStyleCast: false
SpaceBeforeAssignmentOperators: true
SpaceBeforeParens: ControlStatements
SpacesInAngles: Never
SpacesInContainerLiterals: false
```

#### Running clang-format

`clang-format -i` rewrites files in-place, while `--dry-run --Werror` exits non-zero on any formatting difference, the flag combination used in CI to enforce formatting without modifying sources. The `git diff --exit-code` check after running clang-format is the standard CI pattern for failing a pull request that contains unformatted code.
```bash
# Format a single file in-place
clang-format -i src/scheduler.cpp

# Format all C++ files in the project
find src include tests -name "*.cpp" -o -name "*.h" | xargs clang-format -i

# Check formatting without modifying (for CI)
# Returns exit code 1 if any file needs reformatting
clang-format --dry-run --Werror src/scheduler.cpp

# Show a diff of what would change
clang-format src/scheduler.cpp | diff - src/scheduler.cpp

# Format only changed lines (Git integration)
git diff -U0 HEAD | clang-format-diff -p1 -i
```

#### CMake Targets for CI

Adding a `format-check` target to CMake lets CI fail the build when files are not formatted. The custom target below runs clang-format in `--dry-run` mode and exits non-zero on any formatting diff.
```cmake
# cmake/ClangFormat.cmake

find_program(CLANG_FORMAT_EXE
    NAMES clang-format-17 clang-format
    DOC "Path to clang-format"
)

if(CLANG_FORMAT_EXE)
    # Collect all C++ source files
    file(GLOB_RECURSE ALL_CXX_SOURCE_FILES
        "${CMAKE_SOURCE_DIR}/src/*.cpp"
        "${CMAKE_SOURCE_DIR}/src/*.h"
        "${CMAKE_SOURCE_DIR}/include/*.h"
        "${CMAKE_SOURCE_DIR}/tests/*.cpp"
    )

    # Target to format in-place
    add_custom_target(format
        COMMAND ${CLANG_FORMAT_EXE} -i ${ALL_CXX_SOURCE_FILES}
        COMMENT "Formatting source files..."
        VERBATIM
    )

    # Target for CI: fail if files are not formatted
    add_custom_target(format-check
        COMMAND ${CLANG_FORMAT_EXE} --dry-run --Werror ${ALL_CXX_SOURCE_FILES}
        COMMENT "Checking source formatting..."
        VERBATIM
    )
endif()
```

Developers run `cmake --build build --target format` to fix formatting. CI runs `cmake --build build --target format-check` and fails the build if any file differs.

#### GitHub Actions Integration

Continuous integration automatically builds and tests every commit, catching regressions before they reach the main branch. The workflow definition below configures the build matrix, runs the test suite under multiple compilers, and uploads coverage reports as artifacts.
```yaml
# .github/workflows/format.yml

name: Format Check

on:
  pull_request:
    branches: [main]

jobs:
  clang-format:
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@v4

      - name: Install clang-format
        run: sudo apt install -y clang-format-17

      - name: Check formatting
        run: |
          find src include tests \
            \( -name "*.cpp" -o -name "*.h" -o -name "*.cxx" \) \
            -exec clang-format-17 --dry-run --Werror {} \;
```

### Include-What-You-Use (IWYU)

C++ translation units accumulate spurious `#include` directives over time. A header includes another header for internal use, and callers accidentally depend on that transitive include. When the internal header changes, callers break, but only on some platforms or with some compilers, depending on include ordering. This is the classic "works on my machine" problem at the header level.

Include-What-You-Use (IWYU) is an LLVM-based tool that analyzes each translation unit and tells you exactly which headers you need to include, and which you are including unnecessarily.

#### The Problem IWYU Solves

Headers like `<iostream>` and `<algorithm>` in `scheduler.h` below are not used by that header, they were added during debugging or belong only to the `.cpp` file. Carrying unnecessary includes inflates preprocessing time, increases transitive include fan-out, and makes header dependencies harder to reason about during refactoring.
```cpp
// scheduler.h (before IWYU)
#pragma once

#include <string>       // used: std::string
#include <vector>       // used: std::vector
#include <iostream>     // NOT used here -- was used during debugging
#include <algorithm>    // NOT used here -- used in scheduler.cpp only
#include <fmt/format.h> // NOT used here -- transitive from a removed feature

class Scheduler {
    std::string name_;
    std::vector<int> queue_;
public:
    explicit Scheduler(std::string name);
    void enqueue(int task_id);
};
```

Every file that includes `scheduler.h` pays the compilation cost of `<iostream>`, `<algorithm>`, and `<fmt/format.h>` even though it needs none of them. On a header included by 500 translation units, this is measurable in build time.

#### Running IWYU

`iwyu_tool.py` reads the `compile_commands.json` database generated by CMake or Bazel and runs IWYU on each translation unit, emitting `add` and `remove` directives. Running `fix_includes.py` with the output automatically applies those directives to source files, so large-scale include cleanup can be done mechanically rather than header-by-header.
```bash
# Install
sudo apt install iwyu  # or: brew install include-what-you-use

# Run on a single file using the compilation database
iwyu_tool.py -p build/ src/scheduler.cpp

# Run on the entire project and save suggestions
iwyu_tool.py -p build/ -- --mapping_file=iwyu.imp > iwyu-suggestions.txt 2>&1

# Apply suggestions (the fix_includes.py script)
fix_includes.py < iwyu-suggestions.txt

# Run with specific IWYU flags
iwyu_tool.py -p build/ src/ -- \
  --cxx17ns \
  --transitive_includes_only \
  --max_line_length=100
```

#### IWYU Pragma Annotations

For cases where IWYU's analysis is incorrect:

```cpp
#include <memory>    // IWYU pragma: export  -- we re-export this to our users

#include <string>    // IWYU pragma: keep    -- needed at link time, not compile time

// Tell IWYU: if someone needs Foo, they need this header
// (useful when Foo is defined via macro or template specialization)
#include "foo_impl.h"  // IWYU pragma: associated
```

#### CMake Integration

IWYU integrates with CMake through the `CXX_INCLUDE_WHAT_YOU_USE` target property. The snippet below detects IWYU at configure time and attaches it to all targets so that stale includes surface as build warnings.
```cmake
find_program(IWYU_EXE NAMES include-what-you-use iwyu)
find_program(IWYU_TOOL NAMES iwyu_tool.py)

if(IWYU_EXE)
    # Run IWYU as part of compilation (slower, shows inline)
    set(CMAKE_CXX_INCLUDE_WHAT_YOU_USE
        "${IWYU_EXE}"
        "-Xiwyu;--cxx17ns"
        "-Xiwyu;--max_line_length=100"
    )
endif()
```

#### Practical Impact

On a large project (300K lines), IWYU typically:
- Removes 20-40% of `#include` directives from headers
- Reduces total compilation time by 10-25% (fewer headers parsed per TU)
- Eliminates an entire category of build ordering bugs

Run IWYU once at project start and enforce it in CI. The ongoing cost is minimal. The one-time cleanup is significant.

### The Go Comparison

`gofmt` is built into the Go toolchain and is the single canonical formatter. There are no options, no configuration files, no style debates. C++ has `clang-format` which is nearly as good, but teams must still agree on a config once. IWYU has no Go equivalent, Go's import system is explicit by design, and the toolchain automatically removes unused imports. In C++, you have to earn that property by running IWYU.

---
