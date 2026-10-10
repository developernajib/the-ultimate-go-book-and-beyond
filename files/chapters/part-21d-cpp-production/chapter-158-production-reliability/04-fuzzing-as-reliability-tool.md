## Fuzzing as a Reliability Tool

Fuzzing is the most cost-effective bug-finding tool in C++. It costs CPU, which is cheap. It finds bugs that a human reviewer cannot find, because a human reviewer cannot reason about every input edge case. At Google, OSS-Fuzz has found over 36,000 bugs in open-source C and C++ libraries, most of them security-relevant.

This chapter is about turning fuzzing from a research tool into a reliability practice that runs continuously against your service.

### The Three Engines

**libFuzzer** (LLVM, in-process). Lives inside your binary. The fuzz target is a function. libFuzzer mutates the input, calls the function, observes coverage via SanCov, and keeps inputs that hit new edges. Fastest of the three for in-process targets, because it does not fork.

**AFL++** (out-of-process). Runs your binary as a child process, mutates input on stdin or via file, observes coverage via shared-memory bitmap. More flexible (works with any binary, including closed-source if instrumented via QEMU). Slower per execution but better at long campaigns.

**honggfuzz**. Like AFL++, with hardware-counter-driven feedback (Intel PT, BTS) and good support for persistent mode. Used heavily in security research.

For a C++ service, the default choice is libFuzzer for fast in-process targets and AFL++ for end-to-end binary fuzzing. honggfuzz fills niches.

### A First Fuzz Target

Take a C++ HTTP-header parser. The fuzz target:

```cpp
// fuzz_http_parser.cc
#include <cstddef>
#include <cstdint>
#include "http_parser.h"

extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
    HttpParser parser;
    parser.Feed(data, size);  // must not crash
    return 0;
}
```

Build:

```bash
$ clang++ -O1 -g -fsanitize=fuzzer,address,undefined \
    fuzz_http_parser.cc http_parser.cc -o fuzz_http_parser
$ mkdir corpus
$ ./fuzz_http_parser corpus/
```

Within seconds, libFuzzer is generating millions of inputs per minute. Within hours, it has hit every reachable line of `HttpParser::Feed`.

When it finds a crash:

```
==18293==ERROR: AddressSanitizer: heap-buffer-overflow on ...
SUMMARY: libFuzzer: deadly signal
artifact_prefix='./'; Test unit written to ./crash-da39a3...
```

The `crash-da39a3...` file is the input that triggered the crash. Save it. Add it to your regression corpus. Reproduce with `./fuzz_http_parser crash-da39a3...`.

### OSS-Fuzz and ClusterFuzz

OSS-Fuzz is Google's continuous-fuzzing infrastructure for open-source projects. ClusterFuzz is the engine. The pattern they use is the standard for production C++ services:

1. Each library has one or more fuzz targets (the `LLVMFuzzerTestOneInput` functions).
2. Targets are built nightly with several sanitizer combinations (ASan, UBSan, MSan).
3. ClusterFuzz runs each target across thousands of CPUs for hours.
4. Crashes are deduplicated by stack-hash.
5. New crashes are filed as bugs automatically. Existing crashes are tracked.
6. Every commit triggers a regression-corpus run (every previously-found crashing input is tested again).
7. Bisection finds the commit that introduced the bug.

For a private codebase, you replicate this with internal infrastructure: a Kubernetes cron job, a corpus stored in object storage, a deduplication service, and a JIRA integration.

### Corpus Management

The corpus is the set of interesting inputs. It is the most valuable artifact of a long-running fuzz campaign and must be treated as a first-class asset.

Discipline:

- Store the corpus in version control or object storage with versioning.
- Run `libFuzzer -merge=1 corpus/ new_inputs/` to add new inputs without bloat. The merge keeps only inputs that contribute new coverage.
- Snapshot the corpus weekly. A corrupted corpus has destroyed weeks of fuzzing work in real outages.
- Maintain a separate **regression corpus** of every input that ever caused a crash, even after the bug is fixed. Run it on every CI build.

A typical mature C++ project has a corpus of 10,000 to 1,000,000 inputs per fuzz target. At Google, OSS-Fuzz's corpora for projects like FFmpeg run into the millions.

### Structure-Aware Fuzzing for Protocol Parsers

Random byte fuzzing is poor at hitting deep code in structured parsers. A protobuf parser will reject 99.99% of random bytes at the first field tag, and the fuzzer never gets to interesting code paths.

The solution is structure-aware fuzzing. Two patterns:

**libprotobuf-mutator (LPM)**. The fuzzer mutates a protobuf message structurally (add fields, mutate values, swap submessages) and serializes it before feeding to the target.

```cpp
#include "src/libfuzzer/libfuzzer_macro.h"
#include "myproto.pb.h"

DEFINE_PROTO_FUZZER(const myproto::Request& req) {
    Server server;
    server.Handle(req);  // Process structured input
}
```

**Custom mutators**. Define a mutation function that knows the input grammar (HTTP messages, SQL queries, JSON). libFuzzer accepts a `LLVMFuzzerCustomMutator` callback.

For a binary protocol parser, structure-aware fuzzing finds bugs an order of magnitude faster.

### Coverage Targets

A good fuzz target hits every reachable line of the function under test. Measure with:

```bash
$ ./fuzz_http_parser -runs=1000000 corpus/
$ llvm-profdata merge -sparse default.profraw -o coverage.profdata
$ llvm-cov report ./fuzz_http_parser -instr-profile=coverage.profdata
```

A coverage report below 70% on the function under test means the corpus or the mutators are not exercising the function deeply. Causes: required magic numbers in the input format, checksums the fuzzer cannot guess, deep state machines.

The fixes:

- Disable checksum verification under a `FUZZING_BUILD_MODE_UNSAFE_FOR_PRODUCTION` macro.
- Provide seed inputs that cover known states (hand-crafted samples in the initial corpus).
- Use a dictionary file (`-dict=http.dict`) of known tokens so the mutator finds the magic strings faster.

### Crash Deduplication

A long fuzz run produces thousands of crash files, but most of them are the same bug found in different inputs. Deduplication is essential.

Standard approach: run each crash input under the binary with `-symbolize_inline_frames=1`, capture the top N frames of the resulting stack, normalize, hash. Crashes with the same hash are the same bug. Tools: ClusterFuzz's `clusterfuzz/python/crash_analysis/stack_parser`, or `afl-tmin` followed by your own hash function.

A common trap: a bug in `std::vector::operator[]` will produce a stack hash that includes only library frames. Skip frames in the standard library and any framework code, and hash only the application frames.

### Fuzzing in CI

The pattern that scales:

- Every pull request runs each fuzz target for 1 to 5 minutes against the regression corpus.
- Nightly, every fuzz target runs for 30 minutes to multiple hours, with the result corpus merged back.
- Weekend, a long campaign runs for 24 hours.
- Any new crash blocks the PR until triaged.

The regression-corpus run is the cheap and valuable part. It catches re-introduction of fixed bugs and runs in seconds. Put it in CI today.

### Real Bugs Fuzzing Found

OpenSSL had a Heartbleed-class out-of-bounds read in DTLS that fuzzing would have found in minutes. After Heartbleed, OpenSSL adopted oss-fuzz, and dozens of bugs followed.

SQLite has been fuzzed for years and is one of the most fuzzing-hardened C libraries. Its high reliability is largely due to this practice.

Chrome's PDF parser, V8, libxml2, libpng, ImageMagick: all have hundreds of bugs found by fuzzing, most before they shipped to production.

### Senior at FAANG: The Reliability Frame

Fuzzing is not a security tool that the security team owns. It is a reliability tool that finds the long-tail crashes which page your on-call engineer at 3 AM. A staff engineer ensures that every external input boundary in their service has a fuzz target, that those targets run continuously, and that crashes block releases. This is the reliability frame, and it is what distinguishes a senior contribution from a feature contribution.

---
