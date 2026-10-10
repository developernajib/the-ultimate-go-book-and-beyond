# Chapter 143: Testing in C++

> "Testing is not about finding bugs. It's about building confidence.", Kent Beck

Go engineers coming to C++ for the first time encounter an immediate culture shock around testing. In Go, you run `go test ./...` and everything just works, the test runner, coverage tool, fuzzer, and benchmark harness are all built into the standard toolchain. C++ offers none of that out of the box. There is no standard test runner, no canonical framework, and no agreed-upon way to invoke tests in a build system. Instead, there is an ecosystem of powerful but separately installed tools: gtest for unit testing, gmock for mocking, Catch2 for BDD-style tests, libFuzzer for fuzzing, Google Benchmark for microbenchmarking, and gcov/llvm-cov for coverage.

That fragmentation is the cost of C++'s history. The language predates the concept of integrated toolchains. But the tools themselves, once you understand them, are at least as capable as Go's, and in several areas (fuzzing depth, sanitizer granularity, property-based testing) they go further.

This chapter covers the complete C++ testing stack for engineers who already know how to test well in Go:

- **Google Test (gtest)**: the industry-standard unit test framework, with fixtures, parameterized tests, typed tests, and death tests
- **Google Mock (gmock)**: type-safe mocking with rich matchers and expectation syntax
- **Catch2**: BDD-style testing with a powerful data generator system
- **libFuzzer and AFL++**: coverage-guided fuzzing and structure-aware mutation
- **RapidCheck**: property-based testing, C++'s answer to QuickCheck
- **gcov and llvm-cov**: line, branch, and function coverage instrumentation
- **Google Benchmark**: production-grade microbenchmarking
- **Sanitizers as tests**: ASan, TSan, UBSan, MSan in CI pipelines
- **Large-codebase strategies**: test sizing, hermeticity, sharding, flake management

By the end of this chapter you will know how to set up a full testing pipeline for a production C++ project, understand the tradeoffs between frameworks, and translate your Go testing instincts directly into C++.

---
