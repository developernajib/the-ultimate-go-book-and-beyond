## MISRA and Static Analysis

MISRA stands for Motor Industry Software Reliability Association, a UK-based consortium that publishes coding guidelines for safety-critical software. MISRA C is the most widely used coding standard in the world for safety-critical embedded software. MISRA C++ is its C++ counterpart. The newest is MISRA C++ 2023, which unified the previous AUTOSAR C++14 rules back into the MISRA family.

If you write C++ for any car, plane, train, medical device, or industrial controller, you will encounter MISRA. Senior engineers know which rules matter, which are filler, and how to navigate a static analysis report without losing a week to false positives.

### What MISRA Looks Like

A MISRA rule has a number, a category, and a description. Categories are:

- **Required**: must be followed unless a documented deviation is approved
- **Advisory**: should be followed but deviation is acceptable with weaker justification
- **Mandatory**: must be followed, no deviations permitted

Examples of high-impact rules:

**Rule 5-0-15 (Required, MISRA C++ 2008)**: Array indexing shall be the only form of pointer arithmetic.
```cpp
// Compliant
int x = arr[3];

// Non-compliant
int* p = arr + 3;
int x = *p;
```

**Rule 6-4-1 (Required)**: An `if` ( condition ) construct shall be followed by a compound statement.
```cpp
// Non-compliant
if (x) y = 1;

// Compliant
if (x) { y = 1; }
```

**Rule 7-3-1 (Required)**: The global namespace shall only contain `main`, namespace declarations and `extern "C"` declarations.

**Rule 14-5-2 (Required)**: A copy assignment operator shall be declared when there is a template assignment operator with a parameter that is a generic parameter.

**Rule A18-9-1 (AUTOSAR C++14, now MISRA C++ 2023)**: The `std::bind` shall not be used. Lambdas are preferred for clarity and lack of heap allocation.

The full rule set is several hundred items. No project complies with all of them out of the gate. The work is to triage, fix what is fixable, and document deviations for what is not.

### Common Rule Categories

A handful of rule families catch most issues:

**Single entry/single exit.** A function should have one return statement. The intent is to make control flow analyzable. The downside is that the resulting code uses nested ifs instead of guard clauses, which many engineers find harder to read. Most modern interpretations of the rule (MISRA C++ 2023) relax this to "early returns are acceptable if they handle precondition failures clearly."

**No `goto`.** Forbidden in nearly all subsets. The exception is "forward `goto` to a single cleanup label" which some shops allow because RAII covers most use cases anyway.

**Signed/unsigned mixing.** Mixing signed and unsigned in arithmetic causes implicit conversions that surprise everyone. The fix is to pick one and stick with it. Most embedded codebases use unsigned integers (`std::uint32_t`) for hardware values and signed integers for indices.

**Implicit conversions.** Narrowing conversions from a wider type to a narrower one without an explicit cast are forbidden. `int x = static_cast<int>(some_uint32)` is acceptable. `int x = some_uint32` is not.

**No unbounded loops.** Every loop must have a clearly bounded iteration count. `while (true)` is acceptable in the top-level task body but not in a function that returns. The iteration bound makes WCET (worst-case execution time) analysis tractable.

**Magic numbers.** Numeric literals must be named constants. `for (int i = 0; i < 16; ++i)` becomes `constexpr std::size_t kChannelCount = 16;` and `for (std::size_t i = 0; i < kChannelCount; ++i)`.

**No dynamic memory after init.** The most expensive rule to comply with. Either every allocation happens before `main` returns from init, or you use static-storage containers (`etl::vector`, `etl::map`).

### Deviation Process

Real codebases cannot follow every MISRA rule. The deviation process is the formal mechanism for justifying non-compliance:

1. The engineer identifies a rule that the code does not follow.
2. The engineer writes a deviation request: which rule, why, where in the code, what the alternative protections are.
3. A reviewer (typically a senior engineer or a safety engineer) approves or rejects.
4. The deviation is recorded with a unique ID, attached to the source file as a comment, and listed in the safety case.

A typical deviation comment in code:

```cpp
// MISRA-DEV-2024-0042: Use of reinterpret_cast on hardware register pointer
// Rule: A5-2-2 (reinterpret_cast shall not be used)
// Justification: hardware registers are at fixed addresses - reinterpret_cast is
// the standard idiom for accessing memory-mapped I/O. Alternative is asm volatile
// which is harder to read and offers no additional safety.
auto* reg = reinterpret_cast<volatile std::uint32_t*>(0x40020000);
```

Auditors and analyzers see the comment, link to the deviation document, and the violation is acknowledged rather than blocking the build.

### Static Analyzers

Static analysis is the only way to enforce MISRA on a real codebase. The big three commercial tools:

**Polyspace (MathWorks).** Owned by MathWorks since the Polyspace acquisition. Two products: Polyspace Bug Finder (rules-based, MISRA enforcement, fast) and Polyspace Code Prover (formal analysis, proves absence of certain runtime errors, slow). Very strong on MISRA C and C++ compliance reports. Common in automotive and aerospace.

**LDRA Testbed.** UK-based, dedicated to safety-critical industries. Strongest in DO-178C aerospace, also strong in MISRA. Integrates with VectorCAST or has its own LDRA TBrun for unit testing.

**Coverity (Synopsys, formerly Black Duck/Bell Labs origin).** Very strong defect detection beyond MISRA, including taint analysis, concurrency bug detection, and use-after-free. SpaceX, NVIDIA, and Apple use Coverity heavily. Less MISRA-focused than Polyspace but compensates with deeper analysis.

Open-source alternatives:

**Clang-Tidy.** Free, integrates with the Clang toolchain. Has MISRA checks (`misra-*` checks) but coverage is partial. Useful as a pre-commit gate and for catching the easy violations before they reach the commercial tool.

**cppcheck.** Free, simpler than Clang-Tidy, has a MISRA add-on. Useful for small projects and CI sanity checks.

A typical pipeline:

1. Pre-commit: clang-tidy with MISRA-relevant checks, cppcheck
2. CI: Polyspace Bug Finder on changed files
3. Nightly: Polyspace Code Prover on the full codebase
4. Release: full Polyspace report attached to the safety case

### Reading a Polyspace Report

The output of Polyspace is a list of findings, each with:

- File and line
- Rule violated
- Category (required, advisory, mandatory)
- Code snippet
- Severity (red = certain, orange = potential, green = certain not)

The triage workflow:

**Red findings.** Always real. Fix the code or write a deviation.

**Orange findings.** May or may not be real. The analyzer cannot prove the issue. Most of the engineer time goes here. Either prove the analyzer wrong (reasoning about the code paths) and mark as justified, or fix the code defensively.

**Green findings.** No action needed.

A typical project starts with thousands of orange findings, gets them down to hundreds through fixes, and ends with a documented set of justified deviations for the rest. The shape of the curve over a development cycle looks like:

```
Day 1:   3000 red, 8000 orange, 50000 green
Month 1:  100 red, 2000 orange (after major fixes)
Month 6:    0 red,  300 orange (after deviations and minor fixes)
Release:    0 red,  150 orange (acknowledged deviations)
```

Zero red findings is the bar for ASIL D release. Some shops also require zero orange in safety-critical modules.

### Audit-Friendly C++ Subset

A practical C++ subset that maps well to MISRA C++ 2023, AUTOSAR C++14, and ISO 26262 expectations:

```
Allowed:
  - constexpr, consteval, constinit
  - templates (with bounded instantiation depth, monitor code bloat)
  - virtual functions (used deliberately)
  - inheritance (single, public)
  - RAII for all resources
  - std::array, std::span, std::optional, std::variant, std::bit_cast
  - lambdas (preferred over std::bind)
  - std::expected (C++23) for error reporting
  - structured bindings, designated initializers (C++20)
  - concepts (C++20) preferred over SFINAE
  - inline, static, thread_local

Forbidden:
  - exceptions (-fno-exceptions)
  - RTTI and dynamic_cast (-fno-rtti)
  - reinterpret_cast except for hardware register access (deviation per use)
  - new/delete after init
  - std::vector, std::string, std::map, std::shared_ptr, std::function
  - std::iostream, std::regex
  - multiple inheritance with virtual base
  - goto
  - C-style casts
  - implicit narrowing conversions
  - VLAs (variable length arrays)
  - macros except for include guards and platform conditionals
  - friend declarations
```

This subset is roughly what AUTOSAR C++14 codifies, what most automotive Tier 1s enforce, and what Apple, NVIDIA, and SpaceX use as a starting point for their internal coding standards.

---
