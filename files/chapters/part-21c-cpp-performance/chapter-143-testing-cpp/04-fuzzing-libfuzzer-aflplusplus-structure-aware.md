## Fuzzing: libFuzzer, AFL++, and Structure-Aware Fuzzing

Fuzzing is the single most cost-effective technique for finding security vulnerabilities in C++ code. Coverage-guided fuzzers have discovered Heartbleed, dozens of ImageMagick CVEs, hundreds of browser engine bugs, and thousands of memory-safety issues across the open-source ecosystem. Go added fuzzing in 1.18 as a built-in `testing.F`, C++ has had mature fuzzing tools for nearly a decade.

### What Fuzzing Finds

- **Memory corruption**: buffer overflows, heap-use-after-free, null dereferences
- **Integer overflows**: unchecked arithmetic, malformed size calculations
- **Parser bugs**: infinite loops on crafted input, incorrect state machine transitions
- **Assertion failures**: invariant violations triggered only by unusual inputs
- **Hangs**: inputs that cause O(n²) or worse behavior

### libFuzzer: LLVM's Coverage-Guided Fuzzer

libFuzzer is built into Clang. It instruments every edge in the compiled binary and uses that coverage map to guide mutation toward unexplored code paths.

#### The Fuzz Target

A fuzz target is a function with a specific signature that receives raw bytes from the fuzzer. It must not crash on bad input, instead, bad input should trigger sanitizer errors or `abort()`.

```cpp
// fuzzer_target.cpp

#include <cstdint>
#include <cstddef>
#include <string>
#include <stdexcept>

// The function you want to fuzz
std::string parse_config(const char* data, size_t len);

// The entry point for libFuzzer
// Must be named exactly: LLVMFuzzerTestOneInput
extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
    // Convert raw bytes to the input type
    std::string input(reinterpret_cast<const char*>(data), size);

    try {
        // Call the code under test
        parse_config(input.data(), input.size());
    } catch (const std::invalid_argument&) {
        // Expected rejection of bad input - not a bug
    } catch (...) {
        // Unexpected exception types ARE bugs
        __builtin_trap();  // Force a crash that the fuzzer catches
    }

    return 0;  // Non-zero return means "interesting input" - avoid unless intentional
}
```

#### Compilation

libFuzzer requires specific compiler flags to instrument the binary for coverage-guided fuzzing. The flags below enable AddressSanitizer alongside the fuzzer so that memory errors are caught immediately during fuzz runs.
```bash
# Compile with address sanitizer + fuzzer instrumentation
clang++ -std=c++17 \
    -fsanitize=fuzzer,address \
    -fno-omit-frame-pointer \
    -g \
    -O1 \
    fuzzer_target.cpp \
    my_library.cpp \
    -o fuzz_config_parser
```

Never use `-O0` for fuzzing, the fuzzer needs inlined code for better coverage. Use `-O1` or `-O2`.

#### Seed Corpus

A seed corpus is a directory of starting inputs. Good seeds dramatically accelerate coverage:

```bash
mkdir corpus/
# Add minimal valid examples of your input format
echo '{"key": "value"}' > corpus/minimal_json.txt
echo '{}' > corpus/empty_json.txt
echo 'key=value' > corpus/key_value.txt

# Run the fuzzer
./fuzz_config_parser corpus/ \
    -max_len=4096 \        # maximum input size in bytes
    -jobs=8 \              # parallel fuzzing jobs
    -workers=8 \
    -timeout=30            # kill inputs that run longer than 30s
```

#### Crash Reproduction

When the fuzzer finds a crash, it writes a `crash-<hash>` file. Reproduce it:

```bash
# Run with a specific crashing input (no corpus directory)
./fuzz_config_parser crash-abc1234def5678

# Or with ASan and verbose output for investigation
ASAN_OPTIONS=symbolize=1 \
ASAN_SYMBOLIZER_PATH=$(which llvm-symbolizer) \
./fuzz_config_parser crash-abc1234def5678
```

#### Minimizing Crash Inputs

libFuzzer can minimize a crashing input to its smallest reproducing form:

```bash
./fuzz_config_parser -minimize_crash=1 \
    -exact_artifact_path=minimized_crash \
    crash-abc1234def5678
```

### AFL++: Gray-Box Fuzzing for Real-World Programs

AFL++ is the community-maintained successor to AFL. Unlike libFuzzer (in-process), AFL++ runs your program as a subprocess, making it suitable for programs that use global state, signal handlers, or are not easily harness-able as a library function.

```bash
# Instrument with AFL++ compiler wrapper
afl-clang-fast++ -std=c++17 -O2 -g target.cpp -o target_afl

# Create seed directory
mkdir seeds/
echo 'test input' > seeds/seed1.txt

# Run the fuzzer
# -i: input corpus  -o: output directory  --: program arguments
# @@ is replaced by AFL with the path to each generated input file
afl-fuzz -i seeds/ -o findings/ -- ./target_afl @@

# Parallel fuzzing (one main, multiple secondaries)
afl-fuzz -i seeds/ -o findings/ -M fuzzer01 -- ./target_afl @@
afl-fuzz -i seeds/ -o findings/ -S fuzzer02 -- ./target_afl @@
afl-fuzz -i seeds/ -o findings/ -S fuzzer03 -- ./target_afl @@
```

#### AFL++ vs libFuzzer

| Aspect | libFuzzer | AFL++ |
|---|---|---|
| Integration | In-process library | Subprocess |
| Speed | Faster (no fork) | Slower (fork per input) |
| Best for | Library functions | CLI tools, servers |
| Sanitizer | Full ASan support | Full ASan support |
| Mutation | LLVM-native | Highly configurable |
| State reset | Relies on you | Automatic via fork |

### Structure-Aware Fuzzing

Random byte mutation generates syntactically invalid inputs that are immediately rejected by parsers, wasting time on error-handling paths rather than semantic logic. Structure-aware fuzzing teaches the mutator to generate valid inputs.

#### Custom Mutator

A custom mutator is compiled as a shared library and loaded by AFL++ or libFuzzer at runtime via `LLVMFuzzerCustomMutator`. It receives the current input buffer, its size, a maximum size cap, and a seed for randomness, then returns the number of bytes written to the mutated output. By generating structurally valid inputs, correct magic bytes, valid field lengths, legal enum values, the mutator spends its budget exploring deep semantic logic rather than repeatedly hitting top-level parsing error paths.
```cpp
// custom_mutator.cpp - compiled as a shared library loaded by AFL++ or libFuzzer

#include <cstdint>
#include <cstddef>
#include <cstring>
#include <random>
#include <string>

// libFuzzer custom mutator
extern "C" size_t LLVMFuzzerCustomMutator(
    uint8_t* data, size_t size, size_t max_size, unsigned int seed)
{
    std::mt19937 rng(seed);

    // Parse current input as a simple key=value format
    std::string input(reinterpret_cast<char*>(data), size);
    
    // Generate a new valid input instead of random bytes
    std::vector<std::string> keys = {"name", "age", "email", "role"};
    std::vector<std::string> vals = {"alice", "42", "a@b.com", "admin"};

    std::uniform_int_distribution<size_t> dist(0, keys.size() - 1);
    size_t idx = dist(rng);
    
    std::string mutated = keys[idx] + "=" + vals[idx];
    
    // Occasionally add a random mutation on top
    if (rng() % 4 == 0) {
        size_t pos = rng() % mutated.size();
        mutated[pos] = static_cast<char>(rng() % 256);
    }

    if (mutated.size() > max_size) return size; // can't fit, return original
    
    std::memcpy(data, mutated.data(), mutated.size());
    return mutated.size();
}
```

#### Protobuf-Based Fuzzing

For complex structured inputs (network protocols, configuration formats), libprotobuf-mutator generates valid protobuf messages and converts them to your format:

```protobuf
// config.proto
syntax = "proto3";
message Config {
    string name = 1;
    int32  port  = 2;
    repeated string tags = 3;
    oneof auth {
        string api_key = 4;
        string token   = 5;
    }
}
```

```cpp
// proto_fuzzer.cpp
#include <libprotobuf-mutator/src/libfuzzer/libfuzzer_macro.h>
#include "config.pb.h"

// libprotobuf-mutator generates valid Config protos, not random bytes
DEFINE_PROTO_FUZZER(const Config& config) {
    std::string serialized = config_to_string(config);  // your converter
    parse_config(serialized.data(), serialized.size());
}
```

### OSS-Fuzz: Continuous Fuzzing at Scale

OSS-Fuzz is Google's free continuous fuzzing infrastructure for open-source projects. It runs your fuzz targets 24/7 on Google's infrastructure, files bugs automatically, and bisects regressions. Integration requires a Docker-based build configuration:

```dockerfile
# Dockerfile for OSS-Fuzz integration
FROM gcr.io/oss-fuzz-base/base-builder

RUN apt-get update && apt-get install -y cmake

COPY . /src/myproject
WORKDIR /src/myproject

COPY build.sh $SRC/
```

```bash
# build.sh - compiled by OSS-Fuzz
cmake -B build -DCMAKE_BUILD_TYPE=RelWithDebInfo
cmake --build build

# Copy all fuzz targets to $OUT
cp build/fuzz_* $OUT/
```

OSS-Fuzz has found over 10,000 vulnerabilities in projects like OpenSSL, FFmpeg, SQLite, and the Linux kernel.

### Go Comparison

Go's `testing.F` (added in 1.18) is built into the toolchain: write `func FuzzXxx(f *testing.F)`, call `f.Add(seedCorpus...)`, and run with `go test -fuzz=FuzzXxx`. It is simpler and integrated, but less powerful:

- Go fuzzing uses random byte mutation without structure-awareness by default
- libFuzzer has custom mutators, protobuf-mutator, and deeper LLVM integration
- AFL++ handles subprocess-based programs that Go's in-process model cannot
- Go's fuzzer automatically manages the corpus in `testdata/fuzz/`, libFuzzer requires you to manage your corpus directory

For most Go engineers, `testing.F` is sufficient. For security-critical C++ parsing code, libFuzzer with ASan is the professional standard.

---
