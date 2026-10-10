## Testing Strategies for Large C++ Codebases

Writing good individual tests is necessary but insufficient. At scale, hundreds of engineers, tens of millions of lines, thousands of CI runs per day, the structure of your test suite determines whether testing accelerates or impedes development. This section covers the organizational strategies that distinguish a test suite that scales from one that collapses under its own weight.

### Test Organization

Google's approach to test organization, used across all major C++ monorepos, is co-location with strict separation of concerns:

```
src/
  payments/
    payment_processor.h
    payment_processor.cpp
    payment_processor_test.cpp   ← lives next to the source
    payment_gateway.h
    payment_gateway.cpp
    payment_gateway_test.cpp
    testdata/
      valid_response.json
      invalid_response.json
    testing/
      fake_payment_gateway.h     ← fake for use by other test files
      fake_payment_gateway.cpp
```

Each source file has exactly one `_test.cpp` counterpart. Test helpers and fakes that other modules need live in a `testing/` subdirectory, not mixed into the production source. Fakes in `testing/` are compiled into a `testonly` library that cannot be linked into production binaries.

```cmake
# CMakeLists.txt for the payments module
add_library(payments
    payment_processor.cpp
    payment_gateway.cpp
)

# Fake is a separate library only for test use
add_library(payments_testing STATIC
    testing/fake_payment_gateway.cpp
)
target_link_libraries(payments_testing PUBLIC payments)

# Test binary links against both the real library and the fake
add_executable(payments_test
    payment_processor_test.cpp
    payment_gateway_test.cpp
)
target_link_libraries(payments_test PRIVATE
    payments
    payments_testing
    GTest::gtest_main
    GTest::gmock
)
gtest_discover_tests(payments_test)
```

### Hermetic Tests

A hermetic test produces the same result regardless of the environment it runs in: no network, no real filesystem, no real clock, no randomness. Hermetic tests never fail because a port was in use, a remote service was down, or the clock jumped during a slow CI machine.

```cpp
// Non-hermetic: uses real system clock
TEST(ReportGeneratorTest, InsertsTimestamp) {
    ReportGenerator gen;
    std::string report = gen.generate("data");
    // Brittle: depends on what time it is right now
    EXPECT_THAT(report, HasSubstr(current_date_string()));
}

// Hermetic: inject a fake clock
class FakeClock : public Clock {
public:
    explicit FakeClock(std::chrono::system_clock::time_point t) : now_(t) {}
    std::chrono::system_clock::time_point now() const override { return now_; }

    void advance(std::chrono::seconds s) { now_ += s; }

private:
    std::chrono::system_clock::time_point now_;
};

TEST(ReportGeneratorTest, InsertsFixedTimestamp) {
    auto fixed_time = std::chrono::system_clock::from_time_t(1700000000);
    FakeClock clock(fixed_time);

    ReportGenerator gen(clock);  // inject the fake
    std::string report = gen.generate("data");

    EXPECT_THAT(report, HasSubstr("2023-11-14"));  // deterministic
}
```

Inject all sources of non-determinism: time, randomness (via a seeded generator), file I/O (via an in-memory fake), network (via an in-process stub server or fake HTTP client), and process ID.

### Fakes vs Mocks

The single most important architectural decision in unit test design is whether to use a fake or a mock for each dependency.

**Fakes** are lightweight real implementations. An in-memory database is a fake, it behaves like a real database (inserts persist, queries return the right data) but operates entirely in memory. Fakes are correct, maintainable, and do not break when you refactor implementation details.

**Mocks** verify interactions. They record which methods were called, with which arguments, how many times. Mocks are appropriate for testing side-effect contracts ("payment gateway must be called exactly once with the right amount"). They are inappropriate for testing data transformation logic, overuse of mocks creates tests that break on any internal refactor.

```cpp
// Fake: in-memory implementation - correct, does not break on refactors
class InMemoryUserRepository : public UserRepository {
public:
    std::optional<std::string> find_by_id(int id) const override {
        auto it = store_.find(id);
        if (it == store_.end()) return std::nullopt;
        return it->second;
    }

    bool save(int id, const std::string& name) override {
        store_[id] = name;
        return true;
    }

    std::vector<std::string> find_all() const override {
        std::vector<std::string> result;
        for (const auto& [id, name] : store_) result.push_back(name);
        return result;
    }

    void delete_user(int id) override { store_.erase(id); }

    // Test helper: direct access to verify state
    size_t size() const { return store_.size(); }

private:
    std::map<int, std::string> store_;
};

TEST(UserServiceIntegrationTest, CreatesAndRetrievesUser) {
    InMemoryUserRepository repo;  // fake, not mock
    UserService svc(repo);

    EXPECT_TRUE(svc.create_user(1, "alice"));
    EXPECT_EQ(svc.get_username(1), "alice");
    EXPECT_EQ(repo.size(), 1u);
}
```

Rule of thumb: use a fake when the dependency has complex behavior (storage, state machines, protocol logic). Use a mock when you need to verify a side-effect contract (how many times, with what arguments) or when the behavior is simple enough that a one-liner `WillOnce(Return(...))` suffices.

### Test Sizing

Google's test sizing taxonomy classifies tests by their resource usage:

| Size | Time limit | I/O | Threads | External services |
|---|---|---|---|---|
| Small | < 1 second | No (in-memory only) | Single thread | None |
| Medium | < 5 minutes | Localhost allowed | Multiple | None |
| Large | No limit | Any | Any | Real services allowed |

Every test in your suite should be classified. Small tests run on every change. Medium tests run in presubmit (before merging). Large tests run in post-submit or nightly. This prevents a single slow integration test from blocking developer iteration.

```cpp
// Mark test size in a comment or via a custom gtest tag
// Small: pure in-memory, single-threaded
TEST(HashMapTest, LookupMiss) { /* ... */ }

// Medium: uses a localhost port, may involve real filesystem
// [medium] in Catch2 notation, or a custom gtest listener that skips
// based on --gtest_filter='-*Large*:*Slow*'
TEST(DatabaseIntegrationTest, MEDIUM_InsertsAndQueries) { /* ... */ }
```

### Test Sharding

gtest supports sharding for parallel CI:

```bash
# Run shard 0 of 4 (on CI worker 1)
./my_tests --gtest_shard_index=0 --gtest_total_shards=4

# Run shard 1 of 4 (on CI worker 2)
./my_tests --gtest_shard_index=1 --gtest_total_shards=4
```

CTest handles sharding automatically:

```cmake
include(CTest)
set(CTEST_PARALLEL_LEVEL 4)  # run 4 test binaries in parallel
```

### Flaky Test Management

A flaky test is a test that sometimes passes and sometimes fails without code changes. Flaky tests are worse than no tests, they desensitize the team to failure signals and waste CI time.

Standard practice:

1. **Quarantine immediately**: disable the test (`DISABLED_` prefix in gtest) within hours of the flake being reported.
2. **Root cause**: determine whether the flake is a test bug (timing assumption, shared state, port collision) or a real bug in the production code.
3. **Fix and restore**: fix the root cause, run the test 100 times locally (`--gtest_repeat=100`), then re-enable.
4. **Track flakiness rate**: a test with >0.1% flake rate must be fixed before merge.

```cpp
// Quarantine a flaky test with DISABLED_ prefix
TEST(NetworkTest, DISABLED_HandlesConnectionTimeout) {
    // Flaky: assumes connection timeout is exactly 5s
    // Quarantined 2024-01-15, ticket: BUG-4521
}
```

### The Over-Mocking Anti-Pattern

Over-mocking is the most common test design mistake in large C++ codebases. It produces tests that:

- Break every time you refactor internal implementation details (even when behavior is unchanged)
- Give false confidence, the mock returns what you tell it to, so the test always passes even if the interaction is wrong
- Are difficult to read, the `EXPECT_CALL` setup is longer than the production code being tested

The signal that you are over-mocking: your test setup has more lines of `EXPECT_CALL` than actual assertions. When you see this, switch to a fake.

```cpp
// Over-mocked: breaks on any internal refactor
TEST(OrderServiceTest_Overmocked, PlacesOrder) {
    MockInventory mock_inv;
    MockPaymentGateway mock_pay;
    MockNotifier mock_notify;
    MockAuditLog mock_audit;

    EXPECT_CALL(mock_inv, reserve(42, 1)).WillOnce(Return(true));
    EXPECT_CALL(mock_pay, charge(100.0)).WillOnce(Return(true));
    EXPECT_CALL(mock_notify, send_confirmation(::testing::_)).Times(1);
    EXPECT_CALL(mock_audit, log_order(::testing::_)).Times(1);

    OrderService svc(mock_inv, mock_pay, mock_notify, mock_audit);
    EXPECT_TRUE(svc.place_order(42, 1, 100.0));
    // This test verifies HOW the service works, not WHAT it does.
    // Any refactor of internal call order breaks it.
}

// Better: fakes verify observable behavior
TEST(OrderServiceTest_Fakes, PlacesOrder) {
    FakeInventory inv;
    FakePaymentGateway pay;
    FakeNotifier notify;
    FakeAuditLog audit;

    inv.add_item(42, /*qty=*/5);

    OrderService svc(inv, pay, notify, audit);
    EXPECT_TRUE(svc.place_order(42, 1, 100.0));

    // Verify observable outcomes, not internal call sequence
    EXPECT_EQ(inv.quantity(42), 4);      // item was reserved
    EXPECT_EQ(pay.total_charged(), 100.0);  // payment was made
    EXPECT_EQ(notify.notification_count(), 1);  // user was notified
}
```

### Go Comparison

Go's testing conventions align closely with these principles. The standard Go library uses table-driven tests and fakes almost universally, `httptest.NewServer`, `httptest.NewRecorder`, `testing/fstest.MapFS` for filesystem, `net.Pipe()` for network. Mocking frameworks like `testify/mock` exist but are not idiomatic.

The primary difference: Go does not have a formal test-sizing taxonomy or official sharding support. Go's `go test -parallel=N` runs test functions in parallel but does not shard across binaries. For very large monorepos, Go relies on external tools (Bazel) or CI-level parallelism, the same as C++.

---
