## Exercises

These exercises are designed to be implemented, compiled, and run. Each one targets a specific skill from this chapter. The expected time for each is 30-90 minutes.

---

### Exercise 1: Parameterized gtest for a Hash Map

Implement a parameterized test suite for an `std::unordered_map<std::string, int>` that covers edge cases across different initial sizes and key sets.

Your `SortTestCase` struct should include: a vector of `(key, value)` pairs to insert, a vector of `(key, expected_value)` lookup pairs (for keys that exist), and a vector of keys that must NOT be found.

Requirements:
- Use `TEST_P` with `INSTANTIATE_TEST_SUITE_P`
- Include at least 5 parameterized cases: empty map, single entry, large map (>1000 entries), duplicate insertions (last write wins), and keys containing special characters
- Use `ASSERT_EQ` before index-based accesses that would crash on failure
- Verify `.count()` returns 0 for missing keys (not just `.find() == .end()`)
- Use `::testing::ValuesIn` with a `const std::vector<MapTestCase>` defined outside the test

```cpp
// Skeleton to complete:
struct MapTestCase {
    std::string description;
    std::vector<std::pair<std::string, int>> insertions;
    std::vector<std::pair<std::string, int>> expected_finds;
    std::vector<std::string> expected_missing;
};

class HashMapTest : public ::testing::TestWithParam<MapTestCase> {};

TEST_P(HashMapTest, InsertsAndLooksUpCorrectly) {
    // TODO: implement
}

const std::vector<MapTestCase> kTestCases = { /* TODO */ };
INSTANTIATE_TEST_SUITE_P(AllCases, HashMapTest, ::testing::ValuesIn(kTestCases));
```

---

### Exercise 2: Mock a File System Interface with gmock

Define a `FileSystem` interface and mock it with gmock. Write a test that verifies the exact call sequence made by a `LogWriter` class that opens a file, writes lines, and closes it.

Your `LogWriter` should:
1. Call `open(path)` exactly once in the constructor
2. Call `write_line(line)` for each log entry
3. Call `close()` exactly once in the destructor

Requirements:
- Use `::testing::InSequence` to enforce that `open` happens before any `write_line`, and `close` happens after the last `write_line`
- Verify `open` is called with the exact filename passed to the constructor
- Use `EXPECT_CALL(...).Times(::testing::Exactly(N))` for `write_line`
- Use `::testing::StrictMock` to fail on any unexpected call
- Capture the argument passed to `write_line` using `DoAll(SaveArg<0>(&captured), Return())` and verify its content

```cpp
class FileSystem {
public:
    virtual ~FileSystem() = default;
    virtual bool open(const std::string& path) = 0;
    virtual bool write_line(const std::string& line) = 0;
    virtual void close() = 0;
};
// TODO: MockFileSystem, LogWriter, and tests
```

---

### Exercise 3: libFuzzer Target for a JSON-Like Parser

Write a libFuzzer target for a simple key-value parser that handles the format `key1=val1;key2=val2;`. The parser should:
- Split on `;` to get pairs
- Split each pair on `=` to get key and value
- Return a `std::map<std::string, std::string>`

Requirements:
- Implement the parser function `parse_kv(const char* data, size_t size) -> std::map<std::string, std::string>`
- Write the fuzz target `LLVMFuzzerTestOneInput` that calls the parser
- The fuzz target must not crash on any input, reject malformed inputs by returning an empty map or throwing `std::invalid_argument` (which you catch in the fuzz target)
- Add the compilation command as a comment at the top of the file: `// clang++ -fsanitize=fuzzer,address -g -O1 fuzz_kv.cpp -o fuzz_kv`
- Add a seed corpus: at least 3 seed input strings that are valid, stored as C-string literals in a `seeds[]` array (for documentation. LibFuzzer seeds come from files, but show what you would put in the corpus directory)
- Add `ASAN_OPTIONS=detect_leaks=1` as a comment showing how to run

---

### Exercise 4: RapidCheck Property Tests for a Balanced BST

Implement a simple BST (binary search tree, does not need to self-balance) and use RapidCheck to verify four properties:

1. **Search after insert**: after inserting a value, `contains(value)` must return true
2. **In-order traversal is sorted**: `inorder()` must return a sorted vector for any sequence of insertions
3. **Size is correct**: after inserting N distinct values, `size()` must equal N
4. **Delete correctness**: after inserting a set and then deleting one element, `contains(deleted)` is false and all others return true

Requirements:
- Use `RC_GTEST_PROP` for all four properties
- Use `rc::gen::unique<std::vector<int>>(rc::gen::arbitrary<int>())` (or equivalent) to generate sets of distinct integers for properties 3 and 4
- Demonstrate that RapidCheck shrinks a failure: introduce a deliberate bug in the `delete` implementation, run the test, and include the shrunk counterexample in a comment
- Provide the BST with `insert(int)`, `contains(int) const`, `remove(int)`, `size() const`, and `inorder() const -> std::vector<int>`

---

### Exercise 5: CMake Coverage and Sanitizer Targets

Create a `CMakeLists.txt` for a project with a `math_utils` library and a `math_utils_test` binary. The CMakeLists.txt must provide three build presets or CMake options:

1. **Default Debug build**: no sanitizers, `-g -O0`
2. **ASan+UBSan build**: `-DENABLE_ASAN_UBSAN=ON` enables `-fsanitize=address,undefined -fno-omit-frame-pointer`
3. **Coverage build**: `-DENABLE_COVERAGE=ON` enables `-fprofile-instr-generate -fcoverage-mapping -O0 -g` (for llvm-cov)

Requirements:
- Use a CMake function `target_add_sanitizers(target)` that applies the flags to both compile and link steps
- Add a custom CMake target `coverage` that runs `cmake --build`, executes the test binary with `LLVM_PROFILE_FILE`, runs `llvm-profdata merge`, runs `llvm-cov report`, and exits non-zero if line coverage is below 80%
- The coverage target should work via `cmake --build build --target coverage`
- Provide `CMakePresets.json` with three presets: `debug`, `asan`, `coverage`, each setting the appropriate `-D` option and a unique `binaryDir`
- Include the `FetchContent` block for gtest v1.14.0 and `gtest_discover_tests`

```cmake
# Skeleton:
cmake_minimum_required(VERSION 3.25)
project(math_utils_project CXX)
set(CMAKE_CXX_STANDARD 20)

option(ENABLE_ASAN_UBSAN "Build with AddressSanitizer and UBSan" OFF)
option(ENABLE_COVERAGE   "Build with llvm-cov coverage"          OFF)

function(target_add_sanitizers target)
    # TODO
endfunction()

# TODO: FetchContent for gtest, add_library, add_executable, coverage target
```

---
