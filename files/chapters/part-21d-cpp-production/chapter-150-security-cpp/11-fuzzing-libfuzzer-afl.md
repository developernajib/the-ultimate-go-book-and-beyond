## Fuzzing: libFuzzer, AFL++, and Continuous Coverage

Fuzzing is the second non-negotiable safety net after sanitizers. It catches input-driven bugs that tests never reach because no human thought to write them. Every parser, every deserializer, every protocol decoder, every format-specific reader in a C++ codebase must have a fuzz target, and those targets must run continuously.

### libFuzzer target anatomy

libFuzzer is in-process and fastest for fine-grained targets. A target is a single function:

```cpp
#include <cstddef>
#include <cstdint>
#include "mylang/parser.h"

extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
    if (size > 64 * 1024) return 0;  // bound input size
    std::string_view src(reinterpret_cast<const char*>(data), size);
    mylang::Parser p;
    auto result = p.Parse(src);    // must not crash, must not UAF
    (void)result;
    return 0;
}
```

Build with:

```
clang++ -O1 -g -fsanitize=fuzzer,address,undefined \
        -fno-sanitize-recover=all \
        parser_fuzz.cc -o parser_fuzz
./parser_fuzz -max_len=65536 corpus/ -jobs=8 -workers=8
```

Combining `fuzzer` with `address` and `undefined` turns every coverage-guided case that triggers UB into a crash report with a minimal reproducer. This is the point of fuzzing, a raw crash without sanitizers tells you only that the input crashes, not why.

### AFL++ for process-level and out-of-process targets

AFL++ is fork-based and handles targets that cannot be driven from a single function (consumes command-line args, reads from a socket, has hard-to-reset global state). Instrument with `afl-clang-fast++` and run:

```
afl-clang-fast++ -fsanitize=address parser_main.cc -o parser_afl
AFL_NO_UI=1 afl-fuzz -i corpus_in -o out -- ./parser_afl @@
```

AFL++ persistent mode brings throughput close to libFuzzer while retaining process isolation. Use it for targets where per-case state contamination is a real risk.

### Structure-aware fuzzing

Random bytes rarely reach deep parser logic. Use `FuzzedDataProvider` to carve typed fields out of the input, or Protobuf-based fuzzing to generate valid-ish protos:

```cpp
#include <fuzzer/FuzzedDataProvider.h>

extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
    FuzzedDataProvider fdp(data, size);
    auto name = fdp.ConsumeRandomLengthString(256);
    auto count = fdp.ConsumeIntegralInRange<int>(0, 1'000'000);
    auto payload = fdp.ConsumeRemainingBytes<uint8_t>();

    mylang::Config c{name, count};
    mylang::Processor p(c);
    p.Feed(payload.data(), payload.size());
    return 0;
}
```

For protobufs, `libprotobuf-mutator` mutates at the message level, preserving invariants that raw byte mutation would break in the first frame. This improves useful coverage by 10x or more for protobuf-heavy services.

### Corpus discipline

A fuzz corpus is a tested asset. Three rules:

1. Seed the corpus with real inputs from production logs. PII-scrub first.
2. Minimize the corpus nightly: `./fuzz -merge=1 corpus_min corpus` keeps only cases that add coverage. Otherwise the corpus grows to millions of redundant files.
3. Version the corpus alongside the target. A corpus drifting from code means hours of re-exploration on every run.

### Dictionary tuning

Fuzzers waste cycles guessing magic values and keywords. Supply a dictionary:

```
# parser.dict
"fn"
"return"
"\xff\xfe\x00\x00"
"SELECT"
"\x7fELF"
```

`./fuzz -dict=parser.dict corpus/`. For a SQL parser, a dictionary doubles the depth reached in the first hour.

### Continuous fuzzing

Running a fuzzer for an hour before merging a PR is not enough. The real bugs hide past 10 hours of exploration. Production practice:

- A fleet of workers runs every fuzz target 24/7.
- Each crash is deduplicated by stack signature and filed as a ticket automatically.
- Coverage reports are posted weekly, and any target with flat coverage for two weeks is reviewed (either the code is fully explored, or the target is broken).
- OSS-Fuzz (for open-source projects) or ClusterFuzz (self-hosted) provide this machinery out of the box.

### Crash triage workflow

A crash produces `crash-<sha1>` plus a stack from the sanitizer. The triage:

1. Minimize: `./fuzz -minimize_crash=1 -runs=100000 crash-<sha1>` reduces the reproducer to the smallest input that still crashes. Often 2KB shrinks to 20 bytes.
2. Classify by stack. UAF, OOB read, signed overflow, null deref, assertion. Priority P0/P1 for UAF and OOB, P2 for assertions that are defensive (reachable with bad input but not exploitable).
3. Write a unit test from the minimized input before writing the fix. The test prevents the bug from returning.
4. Fix, verify the test passes, re-run the fuzzer on the target for at least an hour to confirm no related bug remains.

### What to fuzz

Fuzz any code that accepts external input. Parsers, serializers, lexers, protocol handlers (HTTP, gRPC, custom wire formats), compression and encryption (roundtrip targets), image/audio/video codecs, query planners, and configuration readers. Internal-only APIs that only ever see trusted input are lower priority, but a defense-in-depth program fuzzes them too.

### Coverage exit criteria

A fuzz target is "done enough" when edge coverage saturates for 72 hours across 16 cores. That is the signal to refine the dictionary, add structure-aware mutation, or write a new target for a code path the current target cannot reach. A target that never saturates is more valuable than one that saturates in a day, because saturation is often a sign that the target is too shallow.
