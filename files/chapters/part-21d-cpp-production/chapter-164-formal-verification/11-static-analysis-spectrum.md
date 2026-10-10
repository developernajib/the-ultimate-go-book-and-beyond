## The Static Analysis Spectrum

Static analysis is the most widely deployed verification technology in industry. Every serious C++ codebase runs at least clang-tidy in CI. Whether that counts as "verification" depends entirely on the **soundness** of the analysis, a property most engineers never think to ask about.

### Sound vs unsound

A static analyser is **sound** for a property class if, when it reports the code clean, the property holds. False negatives (missed bugs) are impossible by construction. False positives (alarms on correct code) are accepted as the price of soundness.

A static analyser is **unsound** if it can miss bugs. It optimizes for low false-positive rate at the cost of completeness. Most commercial tools and all linters are unsound.

Both are useful. The mistake is treating them as interchangeable.

| Tool | Sound? | Approach | Typical false positive rate |
| --- | --- | --- | --- |
| clang-tidy | No | Pattern matching | Low |
| Coverity | No | Symbolic + heuristic | Low (tuned for low FP) |
| Klocwork | No | Symbolic + heuristic | Low |
| CodeChecker | Variable | Wraps multiple analysers | Depends |
| PVS-Studio | No | Pattern + dataflow | Moderate |
| Astrée | Yes | Abstract interpretation | High initially, drops with config |
| Polyspace Code Prover | Yes | Abstract interpretation | High initially, drops with config |
| Frama-C Eva | Yes | Abstract interpretation | High |
| Infer | Mostly unsound | Separation logic, bi-abduction | Low |
| CppCheck | No | Pattern matching | Moderate |

### Astrée

Astrée (AbsInt, Saarbrücken) is the gold standard for sound static analysis on C/C++. The proven property class:

- No division by zero.
- No integer overflow (signed and unsigned).
- No out-of-bound array access.
- No invalid pointer dereference.
- No use of uninitialized variables.
- No data race (with the concurrent extension).
- No floating-point invalid operation, division by zero, or overflow.

Astrée was used to prove absence of runtime errors in:

- Airbus A380 primary flight control software (132 KLOC).
- Airbus A340 fly-by-wire.
- Automated railway control software.
- Multiple ECU components in automotive ASIL-D.

Cost: license is six figures USD per seat per year. Configuration time for a new codebase: weeks to months. The trade-off is that once configured, Astrée is the strongest sound checker in the C/C++ space.

### Polyspace Code Prover

Polyspace (MathWorks) is the closest commercial alternative to Astrée. Same family of techniques (abstract interpretation), strong tooling integration with Simulink and the rest of MathWorks. Common in automotive and aerospace where Simulink-generated code is already in the toolchain.

Polyspace gives every operation a color:

- Green: proven safe.
- Red: proven unsafe.
- Orange: unproven (potential issue, may be false positive).
- Grey: unreachable.

The discipline: drive orange to green or red through code restructuring or annotation, not by suppression. Suppression breaks soundness.

### Coverity

Coverity (Synopsys) is the dominant unsound commercial tool. Originally Coverity Prevent from a Stanford spinout, now part of Synopsys's security suite. Uses path-sensitive symbolic analysis with heuristic models.

Strengths:

- Low false positive rate, sustainable in CI.
- Wide coverage of bug classes (memory, concurrency, security, API misuse).
- Good triage UI.
- Used by hundreds of major projects, including Linux kernel (via the Coverity Scan free service for open source).

Limitations:

- No soundness claim. Real bugs slip through.
- Inter-procedural analysis is bounded.
- Custom checker writing requires Synopsys SDK and is non-trivial.

Coverity is the right choice when you want to lower bug escape rate cheaply across a large codebase. It is the wrong choice when you need a positive assurance argument.

### Klocwork

Klocwork (Perforce) is the other big commercial unsound checker. Comparable feature set to Coverity, stronger in some embedded toolchains (older GCC versions, niche compilers). The choice between Coverity and Klocwork is largely organizational.

### Infer

Infer (Meta, open-source) uses **separation logic with bi-abduction** to do compositional, bottom-up analysis. Compositional means it analyses each procedure in isolation, computing summaries that callers use. This scales to massive codebases.

Meta uses Infer on the Facebook, Instagram, Messenger, and WhatsApp codebases. The interesting story: Infer reports are surfaced in code review at PR time, not on full builds. The integration model (analyze only changes) is what makes adoption feasible at scale.

By 2026 Infer supports C, C++, Java, Hack, and a growing fragment of Erlang. The C++ support handles a substantial subset, with limitations on heavy template metaprogramming.

### CodeChecker

CodeChecker (Ericsson, open-source) is a wrapper around Clang Static Analyzer plus optional plugins (CSA, clang-tidy, gcc analyzer). Provides a web UI for triage and historical baseline tracking. Free, no commercial pressure to inflate the bug count.

The Clang Static Analyzer underneath is unsound but well-engineered. It is the realistic free option for serious C++ shops without a Coverity budget.

### PVS-Studio

PVS-Studio is a Russian-headquartered commercial unsound checker, popular in game development and the Windows ecosystem. Marketing-heavy but the tool itself is competent. Strong in catching cut-and-paste bugs and idiomatic Windows API misuse. Less common in Linux/embedded.

### False positive vs false negative tradeoffs in CI deployment

Three deployment patterns:

#### 1. Gatekeeper

Block merges on any new alarm. Works only for **low-FP unsound** tools (Coverity, Klocwork, clang-tidy with curated ruleset). Sound tools generate too many alarms to gate this way without a long burndown period.

#### 2. Baseline

Establish a baseline of known alarms, fail only on new alarms. The pragmatic compromise. Most large codebases adopt this for both Infer-style tools and sound tools after initial rollout. The risk is that baseline becomes permanent technical debt, never burned down.

#### 3. Reporter

Run the analyser, surface results, do not gate merges. Useful for noisy tools and exploratory deployment. Often the first step before tightening to baseline or gatekeeper.

### What CI integration actually looks like

Realistic pipeline for a safety-critical C++ project in 2026:

```
on: pull_request

stages:
  - clang-format check                    (gatekeeper)
  - clang-tidy with curated checks        (gatekeeper)
  - cppcheck                              (reporter)
  - Coverity scan on main, PR delta       (gatekeeper on new alarms)
  - CodeChecker against baseline          (gatekeeper)
  - Astrée or Polyspace nightly           (manual triage, gatekeeper on red only)
  - libFuzzer / OSS-Fuzz continuous       (off-CI)
  - CBMC harnesses on changed modules     (gatekeeper)
```

Total wall-clock for the PR-time stages: under 15 minutes for a 500 KLOC project on competent CI hardware. Astrée and the fuzzers run separately because their cost makes per-PR execution impractical.

### The honest soundness conversation

When a vendor says their tool is "sound", ask:

1. Sound for what property class? Memory safety? Functional correctness? Specific CWE categories?
2. Sound under what assumptions? Single-threaded? No system calls? Bounded loops?
3. What is the modeled C++ subset? Templates? Exceptions? Inline assembly?
4. What is the alarm rate on a typical codebase before tuning?

Astrée and Polyspace can answer these questions precisely. Most other tools cannot, because the soundness claim is marketing.

### Decision matrix

| Goal | Right tool |
| --- | --- |
| Minimize CI cost, catch common bugs | clang-tidy + Coverity Scan (free for OSS) |
| Drive bug count down at scale | Coverity or Klocwork commercially |
| Compositional analysis on huge codebase | Infer |
| Sound proof of no runtime errors | Astrée or Polyspace Code Prover |
| Verified small kernels | Frama-C Eva + WP |
| Pre-merge change-only analysis | Infer or CodeChecker with baseline |

### What static analysis cannot do

Even sound static analysis cannot prove **functional correctness**. Astrée proves your code does not crash, not that it computes the correct result. For functional correctness you need Frama-C WP, CBMC, Coq, or test-based methods.

The other limitation: spec-gap. A static analyser reports what it can prove about generic safety properties. Domain-specific properties (no PHI leaves the medical-device boundary, no transaction commits without two-phase quorum) require either custom checkers (Coverity SDK, clang plugins) or higher-level tooling (TLA+, model-based testing).

> **Senior at FAANG.** The most common static analysis failure I have seen is teams running Coverity, treating its silence as proof of correctness, and being surprised by a bug that landed in production. Coverity is unsound. Silence is not proof. If you need a positive assurance argument, you need either a sound tool, a deductive proof, or both. Pick the level that matches the stakes, and stop calling everything "static analysis" as if the term were monolithic.
