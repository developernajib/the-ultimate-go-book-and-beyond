## Static Analysis in C++

Static analyzers find bugs without running the code. They are the cheapest tool in the reliability toolkit: they cost nothing at runtime, they find bugs before code review, and they encode institutional knowledge ("we never call `gets`, we never raw-`new`, we never dereference iterators after a vector resize") into automated rules.

The downside: false positives. A team that drowns in static-analysis noise stops looking at the alerts, and the tool becomes worse than useless. Managing the false-positive rate is the reliability discipline that this chapter is mostly about.

### The Tool Map

**clang-tidy**. The default, ships with LLVM. Roughly 400 checks across categories: `bugprone-*`, `cert-*`, `cppcoreguidelines-*`, `performance-*`, `readability-*`, `modernize-*`, `concurrency-*`. Fast (incremental, integrates with `compile_commands.json`). Usually run on every save and on every commit.

**clang-static-analyzer (CSA / scan-build)**. Path-sensitive analysis: tracks symbolic execution along control-flow paths. Catches null-deref, leak, division by zero, uninitialized read on specific paths. Slower than clang-tidy. Run nightly.

**Coverity** (commercial). Path-sensitive at industrial scale, with a deduplication and triage UI. The standard at most large enterprises. Famous for catching the Apple "goto fail" bug that the Apple team had not. The cost is real (six figures per year for medium-size teams) but the catch rate justifies it.

**Klocwork** (commercial, Perforce). Coverity's main competitor. Strong on MISRA-C++ and CERT-C++ rule enforcement, popular in automotive, aerospace, and safety-critical domains.

**Semgrep**. Pattern-based static analysis with an open ruleset. Not as deep as Coverity, but the rule language is approachable, and you can write a custom rule (`forbid raw new() in this directory`) in five minutes. A sweet spot for codebase-specific policies.

**libASTMatchers** (clang). The substrate behind clang-tidy. When the off-the-shelf checks miss your rule, you write a custom matcher in C++. Steep learning curve, infinite power.

**cppcheck**. Older, simpler, less precise. Useful for legacy codebases that are not on a modern build system. Skip if you have clang-tidy.

**include-what-you-use (IWYU)**. Not a bug finder, but a discipline tool: keeps `#include` directives minimal and accurate. Reduces compile times and keeps interfaces honest.

### What Each Tool Catches

**clang-tidy** catches:

- `bugprone-use-after-move`: passing an object after `std::move`.
- `bugprone-string-literal-with-embedded-nul`: a `\0` in a string literal that confuses the C-string consumer.
- `bugprone-suspicious-missing-comma`: two adjacent string literals that look like a comma was dropped.
- `cert-flp30-c`: floating-point loop counters.
- `concurrency-mt-unsafe`: calls to thread-unsafe libc functions like `gmtime`, `strtok`, `getenv` without `_r`.
- `cppcoreguidelines-pro-type-reinterpret-cast`: discouraged cast.
- `performance-unnecessary-copy-initialization`: a `const auto x = container[k]` where `const auto& x` would suffice.
- `modernize-use-emplace`: `push_back(T(args))` where `emplace_back(args)` is cheaper.

**clang-static-analyzer** catches:

- Null pointer dereference along a path where a function returns null.
- Memory leaks where a path forgets to `delete`.
- Use of uninitialized scalars on certain branches.
- Logic errors like a `switch` that misses a value.

**Coverity** catches everything CSA does, plus inter-procedural taint tracking (an external input flows to a sink without sanitization), data-race detection in some configurations, and resource leaks across complex ownership transfers.

**Semgrep** catches whatever you write rules for. Examples that pay off:

- `forbid std::system, std::popen, exec*` (security policy).
- `every Status return must be checked` (custom annotation).
- `forbid raw pointer storage in class members` (ownership policy).

### Setting Up clang-tidy

The minimum config for a serious C++ project, in `.clang-tidy`:

```yaml
Checks: >
  bugprone-*,
  cert-*,
  clang-analyzer-*,
  concurrency-*,
  cppcoreguidelines-*,
  modernize-*,
  performance-*,
  readability-*,
  -modernize-use-trailing-return-type,
  -readability-identifier-length,
  -cppcoreguidelines-pro-bounds-array-to-pointer-decay
WarningsAsErrors: 'bugprone-*,clang-analyzer-*,concurrency-*,cert-*'
HeaderFilterRegex: '^(src|include)/'
```

Run it:

```bash
$ run-clang-tidy -p build/ -j 16 src/
```

In CI, fail the build on any warning in the `WarningsAsErrors` set. The other categories are advisory.

### False Positive Management

Every static analyzer produces false positives. The discipline:

1. **Triage every new warning.** A new warning in the build output is a signal that decays in value. Decide within 24 hours: real bug, false positive, or wontfix.
2. **Suppress with rationale, not silently.** A `// NOLINT(bugprone-use-after-move): the move only happens if the function returns early` is informative. A bare `// NOLINT` is a future-bug landing zone.
3. **Suppress at the smallest scope.** Per-line, not per-file, not per-directory.
4. **Review suppressions periodically.** A team meeting, once a quarter, that walks through the NOLINT list and asks "is this still needed?" Most can be removed as the code evolves.
5. **Treat repeated false positives as a tool bug.** File an upstream issue, contribute a fix, or write a custom matcher that has a lower false-positive rate.

### Custom AST Matchers

When the off-the-shelf checks miss your rule, you write a clang-tidy check. A minimal example: forbid `std::shared_ptr` field members in a specific class hierarchy where ownership is supposed to flow through a different mechanism.

```cpp
#include "clang/ASTMatchers/ASTMatchers.h"
using namespace clang::ast_matchers;

auto Matcher = fieldDecl(
    hasType(classTemplateSpecializationDecl(
        hasName("::std::shared_ptr"))),
    hasParent(cxxRecordDecl(isDerivedFrom("MyBase"))))
  .bind("bad_field");
```

Run the matcher over the AST. For each match, emit a diagnostic with the rationale. This pattern scales: a team can encode dozens of project-specific rules into a single shared check binary.

### What This Looks Like in CI

The pattern that works at scale:

- Pre-commit hook: clang-format, clang-tidy on changed files, Semgrep on changed files. Fast (under 10 seconds for a normal commit).
- Pull request build: full clang-tidy across the codebase, Semgrep across the codebase, IWYU. Fail on any error-level warning.
- Nightly: clang-static-analyzer over the full codebase. Coverity scan if licensed. Diff against yesterday's report, surface only new issues.
- Weekly: a humans-look-at-it review of all wontfix-tagged issues. Are any of them now fixable? Are any new ones masquerading as old ones?

### A Real Bug Static Analysis Found

Apple's "goto fail" SSL bug (CVE-2014-1266) was a duplicated `goto fail` line that caused a TLS verification function to return success without verifying the signature. Coverity flags this pattern (unreachable code) and the bug would have been caught at submit time if Apple had been running Coverity on this file. The cost of the bug to Apple's reputation and security posture was high. The cost of running Coverity on the file would have been seconds.

This is the reliability frame: every static-analyzer rule that fires once is one less postmortem.

### Senior at FAANG: The Cultural Move

The senior move is not "I run clang-tidy on my code." It is: "I integrated clang-tidy into the pre-commit hook, set the WarningsAsErrors policy, wrote three project-specific custom matchers for our ownership rules, set up the nightly Coverity scan with auto-triage to JIRA, and own the suppression-review process." Static analysis is infrastructure, not a tool. Treat it like infrastructure.

---
