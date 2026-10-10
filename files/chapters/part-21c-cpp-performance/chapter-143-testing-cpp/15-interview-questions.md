## Interview Questions

---

**Q1: When would you choose Catch2 over gtest for a new project?**

Choose Catch2 when: (a) you want BDD-style `GIVEN/WHEN/THEN` syntax that reads as executable specification without adding Gherkin or a third-party layer. (b) you need the SECTION re-execution model, where each `SECTION` gets a fresh copy of the test preamble, which is more natural than gtest's `SetUp/TearDown` for branching state machines. (c) you want generator-driven tests (`GENERATE(range(0, 100))`) without the `INSTANTIATE_TEST_SUITE_P` boilerplate. Or (d) you are writing a standalone library and want a single-header test framework (Catch2 v2) that CI can check in without a package manager.

Choose gtest when: you need gmock (Catch2 has no built-in mock framework), when the team is already on gtest, when you need typed tests (`TYPED_TEST_SUITE`), or when you are at a company where the build system (Bazel, CMake) already has first-class gtest support. For most production C++ work, gtest + gmock is the safer default.

---

**Q2: What is the difference between a mock and a fake? When do you use each?**

A **fake** is a lightweight but correct implementation of an interface. An in-memory key-value store is a fake database, it behaves like the real thing (inserts persist, queries return matching data) but operates entirely in RAM without a network connection. Fakes survive refactoring: the test verifies observable behavior, not the internal call sequence.

A **mock** is an object that records interactions and verifies expectations. `EXPECT_CALL(mock, charge(100.0)).Times(1)` verifies that `charge` was called exactly once with the right amount. Mocks are correct for testing side-effect contracts, "the payment gateway must be called exactly once", but wrong for testing data transformation logic, because they encode implementation details that break when you refactor.

Use fakes for complex subsystems with stateful behavior (storage, queues, state machines). Use mocks for simple interaction verification or when you genuinely need to assert call count and argument values. The symptom of over-mocking: your test setup has more `EXPECT_CALL` lines than assertions.

---

**Q3: How does libFuzzer's coverage-guided mutation work? Why is it more effective than random fuzzing?**

libFuzzer instruments every branch edge in the compiled binary using LLVM's SanitizerCoverage. It maintains a coverage bitmap where each bit represents a (source, destination) branch edge. After each input, it checks which new edges were hit. Inputs that hit new edges are added to an in-memory corpus and become seeds for future mutation. Inputs that add no new coverage are discarded.

This guidance is what makes libFuzzer orders of magnitude more effective than random byte mutation. A random fuzzer generating 4-byte sequences for a 4-byte magic-number check (`if (*(int*)data != 0xDEADBEEF)`) would take on average 4 billion tries to hit the true branch. libFuzzer notices when it gets one byte right, retains that input, and mutates from there, reaching the true branch in seconds.

The combination with ASan is what makes it practically useful: libFuzzer finds the input that reaches the vulnerable code path, ASan detects the out-of-bounds access or use-after-free at the moment of execution, and libFuzzer reports the minimal crashing input.

---

**Q4: Explain TSan false positives. How do you handle them in a lock-free data structure?**

TSan reports a data race when two threads access the same memory location without a synchronizing operation between them, and at least one access is a write. For correct lock-free code using `std::atomic` with proper memory ordering, TSan generally does not false-positive because atomic operations are visible to the TSan runtime.

False positives arise in three scenarios: (1) **benign races**, intentional reads of a shared variable without synchronization where the developer has proven the race is harmless. (2) **custom synchronization primitives** that are correct but use primitives TSan does not understand (e.g., Linux futex directly via syscall). (3) **third-party code** compiled without TSan instrumentation.

The correct fix for lock-free code is almost always to use `std::atomic` with the right memory ordering, not to suppress. If you have genuinely benign races or custom synchronization, annotate using `__tsan_acquire(addr)` / `__tsan_release(addr)` at the points where synchronization conceptually occurs. These annotations tell TSan to treat the corresponding operations as a mutex acquire/release, suppressing the false race. Use suppression files (`TSAN_OPTIONS=suppressions=file`) only for third-party code you cannot modify.

---

**Q5: What does 100% line coverage guarantee? What does it not guarantee?**

100% line coverage guarantees that every line of code was executed by at least one test. It does not guarantee: (a) that branches within a line were fully exercised, `return a > 0 ? a : -a;` has one line but two branches, only one of which may be tested. (b) that the tests are correct, a test that calls the function and ignores the return value achieves coverage with zero verification. (c) that all interesting input combinations were tested, a function with three boolean parameters has 8 combinations, but 100% line coverage may require only 2 tests. (d) that concurrent code paths were exercised.

Branch coverage is a better floor than line coverage: it requires both sides of every conditional to be tested. Region coverage (llvm-cov) is better still, it tracks individual expressions. But even 100% branch coverage does not catch bugs that require specific combinations of paths across multiple function calls. Coverage is best used to find untested code (0% coverage on a function), not as a quality target to optimize.

---

**Q6: You have a lock-free queue that your TSan build reports as racy, but the queue is known correct (published in a peer-reviewed paper, proven safe with `seq_cst` atomics). What is your process?**

First, verify the TSan report is actually a false positive by checking that every load and store in the queue uses `std::atomic` with an appropriate memory order, not plain reads/writes. TSan does not false-positive on well-formed `std::atomic` usage.

If the report persists: (a) check whether any external caller accesses the queue's internal state directly. (b) check whether the queue uses any platform-specific intrinsic (x86 `CMPXCHG`) that TSan does not recognize. (c) check whether a dependency compiled without TSan instrumentation is involved.

If it is genuinely a false positive (custom synchronization the compiler cannot see), use `__tsan_acquire` / `__tsan_release` annotations at the synchronization points. As a last resort, add a targeted suppression for the specific function in a TSan suppressions file, document why it is a false positive, and link to the correctness proof. Never disable TSan globally.

---

**Q7: What are NiceMock and StrictMock? Give a concrete scenario where each is the right choice.**

`NiceMock<T>` suppresses "Uninteresting mock function call" warnings. Any method on the mock that is not explicitly expected can be called any number of times without the test failing or even printing a warning. Use it when the system under test calls multiple methods on a dependency, but your test only cares about one of them, you are testing a specific concern, not the full interaction protocol.

`StrictMock<T>` fails the test immediately on any unexpected call. Use it when you are specifically testing that the system under test calls exactly the right set of methods and nothing more, for example, testing that a caching layer calls the underlying storage exactly once per cache miss and zero times on a cache hit. `StrictMock` makes unexpected calls first-class test failures rather than silent noise.

The default (neither Nice nor Strict) prints a warning for unexpected calls but does not fail, a reasonable middle ground that shows potential test coverage gaps without being fragile.

---

**Q8: How would you test a C++ function that calls `std::terminate` on invalid input?**

Use gtest's `EXPECT_DEATH(expr, regex)` macro. `EXPECT_DEATH` forks a child process (on POSIX) or spawns a new process (on Windows), executes `expr` in that process, and asserts that the process exits abnormally (via signal, `abort()`, or `terminate()`) with stderr matching `regex`.

```cpp
TEST(ParserDeathTest, ThrowsOnNullInput) {
    EXPECT_DEATH(parse_document(nullptr, 0), "null.*input|Assertion.*failed");
}
```

Name the fixture or test `*DeathTest`, gtest uses this convention to know it should run the test in a separate process and apply a different timeout. Without the naming convention, death tests run in the same process and cannot safely catch `SIGABRT` or `SIGKILL`.

For debug-only assertions (`assert()` that compiles out in release), use `EXPECT_DEBUG_DEATH(expr, regex)`, it only expects the process to die in debug builds. In release builds it just executes `expr` and continues.

---

**Q9: Your CI has 2,000 gtest tests that take 45 minutes. How do you bring that under 5 minutes without deleting tests?**

Four complementary approaches:

1. **Sharding**: split the test binary across 10 CI workers with `--gtest_shard_index=N --gtest_total_shards=10`. Each worker runs ~200 tests. With enough workers, 45 minutes → 4-5 minutes without changing any test.

2. **Test sizing audit**: identify which tests make real I/O (database connections, filesystem, network). Move them to a separate `medium_tests` binary that runs in a separate CI job after the fast `unit_tests` binary. The unit_tests binary should complete in under 2 minutes.

3. **Parallelism within tests**: tests that do no global state mutation can run in parallel. Mark them with `GTEST_FLAG(parallel) = true` or separate into independent binaries that `ctest --parallel` runs concurrently.

4. **Build caching**: if 45 minutes includes compilation, use ccache (GCC/Clang compiler cache) and ensure your CI does not start from a clean build on every run. A warm ccache turns a 30-minute compile into 2 minutes.

The correct long-term answer is all four. Sharding solves the immediate pain. Test sizing prevents the problem from recurring. Parallelism and build caching address overhead that is not test execution.

---
