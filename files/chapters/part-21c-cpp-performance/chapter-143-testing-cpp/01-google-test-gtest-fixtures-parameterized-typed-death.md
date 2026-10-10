## Google Test (gtest): The Industry Standard

Google Test is the most widely deployed C++ unit testing framework in the industry. Google, Meta, Microsoft, and virtually every FAANG company use it. It ships as a CMake subproject, integrates with Bazel natively, and has IDE support everywhere. When in doubt about which framework to choose, gtest is the safe default.

### Basic Test Structure

The two fundamental macros are `TEST()` for standalone tests and `TEST_F()` for fixture-based tests.

```cpp
#include <gtest/gtest.h>

// Standalone test: TEST(SuiteName, TestName)
TEST(MathUtils, AddsTwoPositiveIntegers) {
    EXPECT_EQ(3 + 4, 7);
}

TEST(MathUtils, HandlesNegativeNumbers) {
    EXPECT_EQ(-3 + 4, 1);
    EXPECT_LT(-5, 0);
    EXPECT_GT(5, 0);
}

int main(int argc, char** argv) {
    ::testing::InitGoogleTest(&argc, argv);
    return RUN_ALL_TESTS();
}
```

### EXPECT vs ASSERT

`EXPECT_*` records a failure and continues the test. `ASSERT_*` records a failure and immediately aborts the current test function (via `return`). Use `ASSERT_*` when continuing after a failure would cause a crash or produce meaningless subsequent results.

```cpp
TEST(StringUtils, SplitReturnsCorrectParts) {
    auto parts = split("a,b,c", ',');

    // If this assert fails, the indexing below would crash
    ASSERT_EQ(parts.size(), 3u);

    EXPECT_EQ(parts[0], "a");
    EXPECT_EQ(parts[1], "b");
    EXPECT_EQ(parts[2], "c");
}
```

Common assertion macros:

| Macro | Purpose |
|---|---|
| `EXPECT_EQ(a, b)` | `a == b` |
| `EXPECT_NE(a, b)` | `a != b` |
| `EXPECT_LT/LE/GT/GE` | Ordering |
| `EXPECT_TRUE/FALSE` | Boolean |
| `EXPECT_STREQ(a, b)` | C-string equality |
| `EXPECT_FLOAT_EQ(a, b)` | Float with 4 ULP tolerance |
| `EXPECT_NEAR(a, b, abs)` | `\|a - b\| <= abs` |
| `EXPECT_THROW(expr, type)` | Expression throws given type |
| `EXPECT_NO_THROW(expr)` | Expression does not throw |

### Test Fixtures

A fixture is a class that provides shared setup and teardown for a group of related tests. It solves the same problem as Go's `TestMain` or per-test setup helpers, but more granularly, each test method gets a fresh fixture instance.

```cpp
#include <gtest/gtest.h>
#include <memory>
#include <string>

// Simulate an expensive-to-construct dependency
class DatabaseConnection {
public:
    explicit DatabaseConnection(const std::string& dsn) {
        // Imagine: opens a socket, authenticates, etc.
        connected_ = true;
    }
    ~DatabaseConnection() { connected_ = false; }

    bool is_connected() const { return connected_; }
    int query_count(const std::string& table) { return 42; } // stub

private:
    bool connected_{false};
};

// The fixture class inherits from ::testing::Test
class DatabaseTest : public ::testing::Test {
protected:
    // Called before EACH test in this fixture
    void SetUp() override {
        db_ = std::make_unique<DatabaseConnection>("sqlite://test.db");
        ASSERT_TRUE(db_->is_connected()) << "Failed to connect to test database";
    }

    // Called after EACH test - runs even if the test failed
    void TearDown() override {
        db_.reset(); // explicit cleanup before destructor
    }

    // Shared across all TEST_F methods in this fixture
    std::unique_ptr<DatabaseConnection> db_;
};

// TEST_F uses the fixture class name as the first argument
TEST_F(DatabaseTest, QueriesUserTable) {
    int count = db_->query_count("users");
    EXPECT_GT(count, 0);
}

TEST_F(DatabaseTest, QueriesOrderTable) {
    int count = db_->query_count("orders");
    EXPECT_EQ(count, 42);
}
```

For expensive setup shared across all tests in a suite (not per-test), use `SetUpTestSuite()` and `TearDownTestSuite()` (static methods). The fixture object is shared, tests must not mutate shared state.

```cpp
class ExpensiveFixture : public ::testing::Test {
protected:
    static void SetUpTestSuite() {
        // Called once before all tests in the suite
        shared_resource_ = std::make_unique<ExpensiveResource>();
    }

    static void TearDownTestSuite() {
        shared_resource_.reset();
    }

    static std::unique_ptr<ExpensiveResource> shared_resource_;
};

// Definition required outside class body
std::unique_ptr<ExpensiveResource> ExpensiveFixture::shared_resource_;
```

### Parameterized Tests

Parameterized tests run the same test logic with different inputs. This is gtest's answer to Go's table-driven tests, more boilerplate, but the failure output clearly identifies which parameter set failed.

```cpp
#include <gtest/gtest.h>
#include <algorithm>
#include <vector>

// The fixture for parameterized tests inherits from
// ::testing::TestWithParam<T>
struct SortTestCase {
    std::vector<int> input;
    std::vector<int> expected;
};

class SortTest : public ::testing::TestWithParam<SortTestCase> {};

TEST_P(SortTest, ProducesCorrectOutput) {
    auto tc = GetParam();
    std::sort(tc.input.begin(), tc.input.end());
    EXPECT_EQ(tc.input, tc.expected);
}

// INSTANTIATE_TEST_SUITE_P(InstantiationName, FixtureName, ValuesGenerator)
INSTANTIATE_TEST_SUITE_P(
    BasicCases,
    SortTest,
    ::testing::Values(
        SortTestCase{{3, 1, 4, 1, 5}, {1, 1, 3, 4, 5}},
        SortTestCase{{},              {}},
        SortTestCase{{1},             {1}},
        SortTestCase{{2, 1},          {1, 2}}
    )
);

// ValuesIn from a container defined elsewhere
const std::vector<SortTestCase> kLargeCases = {
    {{100, 99, 98}, {98, 99, 100}},
    {{-1, -2, -3},  {-3, -2, -1}},
};

INSTANTIATE_TEST_SUITE_P(LargeCases, SortTest, ::testing::ValuesIn(kLargeCases));
```

Failure output looks like `BasicCases/SortTest.ProducesCorrectOutput/0`, pinpointing the exact case.

### Typed Tests

Typed tests run the same test suite against multiple concrete types. This is invaluable when testing generic containers or algorithms that must satisfy the same contract for several types.

```cpp
#include <gtest/gtest.h>
#include <list>
#include <vector>
#include <deque>

// The interface contract we want to verify
template <typename Container>
class SequenceContainerTest : public ::testing::Test {
protected:
    Container c_;
};

// List the types to test against
using SequenceTypes = ::testing::Types<
    std::vector<int>,
    std::list<int>,
    std::deque<int>
>;

TYPED_TEST_SUITE(SequenceContainerTest, SequenceTypes);

TYPED_TEST(SequenceContainerTest, IsEmptyOnConstruction) {
    EXPECT_TRUE(this->c_.empty());
    EXPECT_EQ(this->c_.size(), 0u);
}

TYPED_TEST(SequenceContainerTest, PushBackIncreasesSize) {
    this->c_.push_back(42);
    EXPECT_EQ(this->c_.size(), 1u);
    EXPECT_FALSE(this->c_.empty());
}

TYPED_TEST(SequenceContainerTest, FrontAfterPushBack) {
    this->c_.push_back(10);
    this->c_.push_back(20);
    EXPECT_EQ(this->c_.front(), 10);
}
```

### Death Tests

Death tests verify that a piece of code terminates the process, either via `std::abort()`, `assert()`, or an uncaught exception that kills the process. They are essential for testing precondition violations in debug builds.

```cpp
#include <gtest/gtest.h>
#include <cassert>
#include <stdexcept>

class BoundedBuffer {
public:
    explicit BoundedBuffer(size_t cap) : cap_(cap) {}

    void push(int val) {
        assert(size_ < cap_ && "BoundedBuffer overflow");
        data_[size_++] = val;
    }

    int pop() {
        assert(size_ > 0 && "BoundedBuffer underflow");
        return data_[--size_];
    }

private:
    size_t cap_;
    size_t size_{0};
    int data_[256]{};
};

// Death tests must be in a *DeathTest fixture or named *DeathTest
// to run in a separate process
TEST(BoundedBufferDeathTest, OverflowTriggersAssert) {
    BoundedBuffer buf(2);
    buf.push(1);
    buf.push(2);
    // EXPECT_DEATH runs the expression in a forked process
    // and verifies the process dies with output matching the regex
    EXPECT_DEATH(buf.push(3), "overflow");
}

TEST(BoundedBufferDeathTest, UnderflowTriggersAssert) {
    BoundedBuffer buf(4);
    EXPECT_DEATH(buf.pop(), "underflow");
}

// ASSERT_DEATH aborts the test immediately if the process does NOT die
TEST(BoundedBufferDeathTest, ThrowingFunctionDies) {
    auto bad_fn = [] {
        throw std::runtime_error("fatal error");
    };
    // On platforms where uncaught exceptions call terminate()
    EXPECT_DEATH(bad_fn(), "");
}
```

Death tests run the expression in a forked subprocess (on POSIX) or a new process (on Windows). The `"overflow"` regex is matched against the process's stderr output. Use `::testing::KilledBySignal(SIGABRT)` or `::testing::ExitedWithCode(1)` for precise exit condition checking.

### Running Tests from the Command Line

`--gtest_filter` accepts glob patterns and colon-separated lists, so you can run a single fixture (`DatabaseTest.*`), combine patterns (`*Param*:*Death*`), or exclude noisy tests with a leading `-`. The `--gtest_repeat` and `--gtest_shuffle` flags are especially useful for surfacing order-dependent failures and flaky tests in CI by running the same suite multiple times in a randomized order.
```bash
# Run all tests
./my_tests

# Run only tests matching a pattern (glob, not regex)
./my_tests --gtest_filter='DatabaseTest.*'
./my_tests --gtest_filter='*Param*:*Death*'

# Exclude a pattern
./my_tests --gtest_filter='-*Slow*'

# Repeat tests (catch non-deterministic failures)
./my_tests --gtest_repeat=100

# Shuffle test order each run (surfaces order dependencies)
./my_tests --gtest_shuffle --gtest_random_seed=42

# Show each test's elapsed time
./my_tests --gtest_print_time=1

# Emit JUnit XML for CI systems
./my_tests --gtest_output=xml:results.xml
```

### CMake Integration

CMake's `FetchContent` module downloads and builds GoogleTest as part of your project, so you do not need a separate installation step. The snippet below fetches a pinned release and links it to your test targets.
```cmake
include(FetchContent)
FetchContent_Declare(
    googletest
    URL https://github.com/google/googletest/archive/v1.14.0.zip
)
FetchContent_MakeAvailable(googletest)

enable_testing()

add_executable(my_tests
    math_utils_test.cpp
    string_utils_test.cpp
)

target_link_libraries(my_tests PRIVATE
    my_library
    GTest::gtest_main   # provides main() automatically
    GTest::gmock
)

include(GoogleTest)
gtest_discover_tests(my_tests)  # registers each TEST() with CTest
```

### Go Comparison

Go's `testing.T` and gtest's `TEST()` macro serve the same role. The key differences:

- Go's table-driven tests use a `[]struct{...}` slice with `t.Run(tc.name, ...)`, gtest uses `INSTANTIATE_TEST_SUITE_P`. Both achieve named sub-test iteration. Gtest's output is marginally more verbose.
- Go fixtures are typically handled with `TestMain` or helper functions. gtest fixtures are proper classes with lifecycle methods, which scales better for complex shared state.
- Death tests have no direct Go equivalent, Go uses `recover()` for panics but cannot easily test `os.Exit()` calls without subprocess tricks.
- Running: `go test -run=TestFoo/bar` → `./binary --gtest_filter=Foo.bar`.

---
