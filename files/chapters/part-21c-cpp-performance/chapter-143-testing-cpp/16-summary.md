## Key Takeaways

- **gtest is the industry default.** Google Test + Google Mock covers the vast majority of C++ testing needs and is used at Google, Meta, Microsoft, and most serious open-source projects. When in doubt about framework choice, start here.

- **EXPECT_ continues. ASSERT_ aborts.** Use `ASSERT_*` when a failure would cause a crash or make subsequent assertions meaningless (e.g., assert a container size before indexing into it). Use `EXPECT_*` everywhere else to collect all failures in one run.

- **Sanitizers are not optional.** Running tests under ASan + UBSan as a standard CI job catches entire classes of bugs, use-after-free, buffer overflows, signed integer overflow, that unit tests with `EXPECT_EQ` cannot detect. TSan catches data races in concurrent code. These are the most cost-effective bug-finding tools in C++.

- **Fakes beat mocks for complex dependencies.** Over-mocking produces tests that break on every internal refactor and give false confidence. Write in-memory fakes for storage, queues, and state machines. Reserve mocks for side-effect verification and simple interaction contracts.

- **Hermetic tests are reliable tests.** Inject time, randomness, filesystem, and network dependencies. A test that depends on a real clock or a real port will eventually fail in CI for reasons unrelated to the code under test.

- **libFuzzer finds the bugs unit tests miss.** Coverage-guided fuzzing discovers parser crashes, integer overflows, and memory corruption that no amount of handwritten test cases reaches. Add a libFuzzer target for any code that processes untrusted input.

- **Google Benchmark is the professional microbenchmark tool.** `DoNotOptimize`, fixture-based setup, multi-dimensional argument sweeps, custom counters, and JSON output for CI regression detection make it far more rigorous than wall-clock timing. Always combine with a comparison baseline in CI.

- **llvm-cov provides region-level coverage.** Unlike gcov line coverage, llvm-cov tracks individual expressions within a line and produces export formats compatible with Codecov and Coveralls. Branch coverage is a more meaningful floor than line coverage.

- **Test sizing prevents CI collapse.** Classify every test as Small (< 1s, no I/O), Medium (< 5 min, localhost I/O), or Large (real services). Run Small tests on every commit, Medium tests in presubmit, Large tests nightly. This discipline is what keeps CI under 5 minutes at scale.

- **The Go advantage is ergonomics. The C++ advantage is depth.** Go's `go test ./...` with zero configuration is a real productivity win. C++ sanitizers (ASan, MSan, UBSan, TSan), industrial-strength fuzzing (libFuzzer, AFL++), and typed mock generation (gmock) provide deeper correctness guarantees when properly deployed. The right answer is to use both languages' strengths: Go for services where iteration speed matters, C++ testing tools for systems where memory safety and performance correctness are non-negotiable.

---

| [◀ Chapter 142: Build Systems and Tooling](../chapter-142-build-systems-tooling/00-introduction.md) | [Chapter 143: Testing in C++](00-introduction.md) | [Chapter 144: FAANG C++ Libraries](../../part-21d-cpp-production/chapter-144-faang-cpp-libraries/00-introduction.md) ▶ |
