## Fuzzing as Poor Man's Verification

Fuzzing is the most cost-effective bug-finding technique in software engineering history. OSS-Fuzz alone has found over 10000 bugs across thousands of projects. Every major operating system, browser, language runtime, and crypto library is now fuzzed continuously. Coverage-guided fuzzing is the baseline expectation for any C++ code that touches untrusted input in 2026.

Fuzzing is not formal verification. It does not prove anything for all inputs. What it does is approximate verification with extraordinary cost-efficiency: machine time is cheap, fuzzers do not sleep, and the negative result (after billions of executions, no crash) is strong evidence of memory safety even if not a proof.

### libFuzzer

libFuzzer is the LLVM-native fuzzer, in-process and coverage-guided.

```cpp
#include <cstdint>
#include <cstddef>
#include "my_parser.h"

extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
    MyParser p;
    p.parse(std::string_view(reinterpret_cast<const char*>(data), size));
    return 0;
}
```

Build:

```sh
clang++ -fsanitize=fuzzer,address,undefined -O1 -g \
    fuzz_parser.cc my_parser.cc -o fuzz_parser
./fuzz_parser corpus/
```

libFuzzer mutates inputs, observes coverage via SanitizerCoverage, and saves any input that hits new edges to the corpus. Combined with AddressSanitizer (memory bugs) and UndefinedBehaviorSanitizer (UB), every interesting input runs through three checkers simultaneously.

The harness is the entire interface. `LLVMFuzzerTestOneInput` returns 0, the runner does the work.

### AFL++

AFL++ is the modern fork of American Fuzzy Lop, with hundreds of contributors and active development. Out-of-process, fork-server-based, with stronger mutation strategies than libFuzzer for some workloads.

```sh
afl-clang-fast++ -O2 -g harness.cc target.cc -o target
afl-fuzz -i corpus -o findings -- ./target
```

AFL++ supports persistent mode (in-process, like libFuzzer) and deferred-init mode (skip expensive setup). For large parsers it commonly outperforms libFuzzer on bug discovery rate, especially when paired with structure-aware mutators.

In 2026, the typical OSS-Fuzz deployment runs both libFuzzer and AFL++ on the same target, since each finds bugs the other misses.

### Structure-aware fuzzing

Random byte mutation works for parsers that accept any byte string. It struggles when the input must satisfy a strict format: a checksum, a length-prefix, a protobuf wire format, an SQL grammar.

**libprotobuf-mutator** lets the fuzzer mutate at the protobuf message level, generating only well-formed inputs:

```cpp
#include "src/libfuzzer/libfuzzer_macro.h"
#include "request.pb.h"

DEFINE_PROTO_FUZZER(const Request& req) {
    handle_request(req);
}
```

The fuzzer generates valid `Request` messages, mutates fields, and reaches code paths random bytes never would.

**syzkaller** (Google) does the equivalent for kernel system calls: a description of the syscall surface drives generation. Found hundreds of Linux kernel bugs.

**FuzzGen / FuzzTest** generate harnesses semi-automatically from API descriptions or examples.

### Atheris

Atheris is the libFuzzer integration for Python. Indirectly relevant to C++: most C++ libraries with Python bindings can be fuzzed through Atheris by exercising the binding layer.

For C++ specifically, the equivalent infrastructure (Fuzztest at Google) drives coverage-guided fuzz from typed C++ entry points without requiring you to write `LLVMFuzzerTestOneInput` manually.

### Fuzz drivers as code under review

A fuzz harness is code. It can have bugs. It can mask real bugs by handling exceptions in ways the production caller does not. The discipline:

1. **Fuzz the same entry point production calls**. A fuzz harness that pre-validates input is fuzzing the validator, not the parser.
2. **Treat the harness as production code**. Code review, version control, no shortcuts.
3. **Reproduce findings outside the fuzzer**. A crash on a fuzz input should be reproducible by feeding that input through the production binary.
4. **Triage seriously**. Every fuzz finding is a bug or a harness bug. Untriaged findings rot the corpus.

### Coverage as evidence

After hours or weeks of fuzzing, what have you proved?

- Every coverage edge marked "covered" has been exercised at least once.
- Every input in the corpus produces no crash, no UBSan trap, no ASan trap.
- The fuzzer found no inputs that hit new edges in the last N hours, suggesting saturation (or a corpus that is too narrow).

This is *evidence*, not proof. The right interpretation:

> "Under our fuzzing harness, no input the fuzzer found in 1 billion executions triggered a memory or UB sanitiser. This is significant negative evidence for memory safety on the fuzzed code paths, with no claim about paths the harness does not exercise."

Compare to a CBMC proof:

> "For all inputs up to depth k, no path in this function reaches an out-of-bound access."

The CBMC claim is a proof for a bounded subspace. The fuzz claim is statistical evidence over an unbounded but unstructured search.

### OSS-Fuzz

OSS-Fuzz (Google, 2016) runs continuous fuzzing for open-source projects. As of 2026:

- Over 1500 projects integrated.
- 10000+ bugs found and fixed.
- Average bug discovery time: under 30 minutes from a regression landing.
- Cost to integrate: roughly one engineer-week for a typical C++ library.

The integration template is well-documented. For any open-source C++ project that handles untrusted input and is not already in OSS-Fuzz, it is the cheapest assurance investment available.

For closed-source: ClusterFuzzLite (the open-source self-hosted runner) provides the same model on your own infrastructure. Most large companies run an internal equivalent.

### Differential fuzzing

Run two implementations on the same fuzz input, assert they agree:

```cpp
extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
    auto a = my_implementation::parse(data, size);
    auto b = reference_implementation::parse(data, size);
    if (a.has_value() != b.has_value()) abort();
    if (a && *a != *b) abort();
    return 0;
}
```

Useful for:

- Testing a new optimized implementation against a slow reference.
- Cross-validating two parsers (e.g., a fast custom parser vs. a flexible library parser).
- Validating compiler optimizations (Csmith for C, YARPGen for C++).
- Cross-version testing during refactors.

Differential fuzzing is the easiest way to catch optimization bugs and is how Csmith found hundreds of compiler bugs in gcc and clang.

### What fuzzing does NOT prove

State the limits clearly:

1. **Functional correctness**. A function that returns a wrong but consistent answer (e.g., always returns 0 instead of computing) will not be caught by fuzzing alone unless paired with a property check or differential test.
2. **Logic bugs without crashes**. A privilege escalation through a logic error does not crash. Fuzzing misses it.
3. **Slow paths and timing**. Performance regressions, timing side channels in crypto. Fuzzing is not measuring time precisely.
4. **Coverage gaps**. If your harness does not feed inputs that reach a code path, that path is unfuzzed. Always check coverage reports.
5. **Stateful bugs across sessions**. A bug that requires a sequence of API calls in a specific order. Stateful PBT finds these, standard fuzzing does not without state-aware harnesses.
6. **Concurrency bugs**. Most fuzzers are single-threaded by design. Use ThreadSanitizer plus targeted concurrency tests.

### Memory budget and performance

libFuzzer and AFL++ both report executions per second. Realistic numbers:

| Workload | Exec/s |
| --- | --- |
| Small parser, in-process, libFuzzer | 10000 to 1000000 |
| Large parser with allocations | 1000 to 10000 |
| Out-of-process AFL++ on a binary | 100 to 1000 |
| Sandboxed network protocol fuzzer | 10 to 100 |

The lower the throughput, the more important structure-aware mutation and good seed corpora become. Below 100 exec/s, you are essentially running PBT on a fuzz framework.

### Continuous fuzzing in CI

The deployment pattern that scales:

1. Per-PR: run each fuzz harness for 60 seconds against the corpus. Catches obvious regressions.
2. Nightly: run each harness for 30 minutes with new mutations. Catches deeper regressions.
3. Continuous (OSS-Fuzz / ClusterFuzzLite): run forever, distributed. Finds novel bugs.
4. Coverage report weekly. Identify under-fuzzed code.

### When to reach for fuzzing

Always, if your code touches untrusted input. Always, if your code is a parser, codec, deserializer, or VM. Always, if you are integrating a third-party library and have a public attack surface.

Fuzzing is the lowest barrier and highest yield bug-finding technique available. The teams that do not fuzz are the teams shipping memory-safety CVEs in 2026.

> **Senior at FAANG.** Treat fuzzing as a baseline expectation, not an optional enhancement. Every parser merged without a fuzz harness is technical debt with a CVE attached. Make harness review part of code review for any code touching external input. The investment is one engineer-day per harness, the return is years of automated bug-finding.
