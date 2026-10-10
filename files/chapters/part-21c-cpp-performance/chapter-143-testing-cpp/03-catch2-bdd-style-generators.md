## Catch2: BDD-Style Testing and Generators

Catch2 is the second most popular C++ testing framework. Its killer features are expressive test names (plain English strings, not identifiers), a BDD-style `GIVEN/WHEN/THEN` syntax that reads like executable specification, and a powerful data generator system that gives you property-testing-lite without a separate library. Version 3 is a proper multi-file library. Version 2 was single-header, which made it popular for quick projects.

### Basic Structure

Catch2 tests are declared with `TEST_CASE` taking a free-form description string and optional tag list in brackets. There is no test class, fixture registration, or `main` boilerplate required. The `SECTION` macro creates nested sub-cases that each execute from the beginning of the `TEST_CASE`, giving each section a fresh copy of any locals declared before it, a unique feature that eliminates most need for explicit fixtures.
```cpp
#include <catch2/catch_test_macros.hpp>
#include <catch2/catch_approx.hpp>
#include <vector>
#include <algorithm>

// TEST_CASE takes a free-form description and optional tags
TEST_CASE("vector supports basic operations", "[vector][containers]") {
    std::vector<int> v;

    REQUIRE(v.empty());   // Like ASSERT: aborts this TEST_CASE on failure
    CHECK(v.size() == 0); // Like EXPECT: records failure, continues

    SECTION("push_back increases size") {
        v.push_back(1);
        v.push_back(2);

        CHECK(v.size() == 2);
        CHECK(v[0] == 1);
    }

    SECTION("clear resets to empty") {
        v.push_back(10);
        v.clear();
        CHECK(v.empty());
    }
    // Each SECTION runs from the beginning of the TEST_CASE with a fresh `v`
    // This is Catch2's unique re-execution model
}
```

The `SECTION` re-execution model is Catch2's defining structural feature. Each `SECTION` gets a fresh copy of everything declared before it in the enclosing scope. Nested sections form a tree, and Catch2 traverses every path through that tree.

### BDD Style

`SCENARIO`, `GIVEN`, `WHEN`, `THEN` are aliases for `TEST_CASE`, `SECTION`, `SECTION`, `SECTION`, just with more expressive naming:

```cpp
#include <catch2/catch_test_macros.hpp>

class BankAccount {
public:
    explicit BankAccount(int initial_balance) : balance_(initial_balance) {}

    bool deposit(int amount) {
        if (amount <= 0) return false;
        balance_ += amount;
        return true;
    }

    bool withdraw(int amount) {
        if (amount <= 0 || amount > balance_) return false;
        balance_ -= amount;
        return true;
    }

    int balance() const { return balance_; }

private:
    int balance_;
};

SCENARIO("bank account handles deposits and withdrawals", "[banking]") {
    GIVEN("an account with a balance of 100") {
        BankAccount account(100);
        REQUIRE(account.balance() == 100);

        WHEN("the user deposits 50") {
            bool ok = account.deposit(50);

            THEN("the deposit succeeds and balance is 150") {
                REQUIRE(ok);
                REQUIRE(account.balance() == 150);
            }
        }

        WHEN("the user withdraws 40") {
            bool ok = account.withdraw(40);

            THEN("the withdrawal succeeds and balance is 60") {
                REQUIRE(ok);
                REQUIRE(account.balance() == 60);
            }
        }

        WHEN("the user tries to withdraw more than the balance") {
            bool ok = account.withdraw(200);

            THEN("the withdrawal fails and balance is unchanged") {
                REQUIRE_FALSE(ok);
                REQUIRE(account.balance() == 100);
            }
        }

        WHEN("the user deposits a negative amount") {
            bool ok = account.deposit(-10);

            THEN("the deposit fails and balance is unchanged") {
                REQUIRE_FALSE(ok);
                REQUIRE(account.balance() == 100);
            }
        }
    }
}
```

### Matchers

Catch2 has its own matcher system for composable assertions:

```cpp
#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_vector.hpp>
#include <catch2/matchers/catch_matchers_string.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>

TEST_CASE("matchers compose cleanly", "[matchers]") {
    std::vector<int> v = {1, 2, 3, 4, 5};

    // Vector matchers
    REQUIRE_THAT(v, Catch::Matchers::Contains(3));
    REQUIRE_THAT(v, !Catch::Matchers::Contains(99));

    // String matchers
    std::string msg = "error: file not found";
    REQUIRE_THAT(msg, Catch::Matchers::StartsWith("error"));
    REQUIRE_THAT(msg, Catch::Matchers::ContainsSubstring("not found"));

    // Floating point
    double result = 1.0 / 3.0;
    REQUIRE_THAT(result, Catch::Matchers::WithinAbs(0.333, 0.001));
    REQUIRE_THAT(result, Catch::Matchers::WithinRel(0.333333, 0.001));
}
```

### Data Generators: Property-Testing Lite

Catch2's generators run a test case once for each generated value, making it trivial to test against a range of inputs without writing parameterized boilerplate:

```cpp
#include <catch2/catch_test_macros.hpp>
#include <catch2/generators/catch_generators.hpp>
#include <catch2/generators/catch_generators_range.hpp>
#include <catch2/generators/catch_generators_adapters.hpp>
#include <algorithm>
#include <vector>

TEST_CASE("sort works for all sizes", "[sort][generator]") {
    // GENERATE runs this test once per value
    auto n = GENERATE(0, 1, 2, 10, 100, 1000);

    std::vector<int> v(n);
    std::iota(v.begin(), v.end(), 0);
    std::shuffle(v.begin(), v.end(), std::mt19937{std::random_device{}()});

    std::sort(v.begin(), v.end());

    REQUIRE(std::is_sorted(v.begin(), v.end()));
    REQUIRE(v.size() == static_cast<size_t>(n));
}

TEST_CASE("integer square root", "[math][generator]") {
    // range(start, end) generates [start, end)
    auto n = GENERATE(range(1, 100));

    int isqrt = static_cast<int>(std::sqrt(n));
    REQUIRE(isqrt * isqrt <= n);
    REQUIRE((isqrt + 1) * (isqrt + 1) > n);
}

// Table generator: pairs of (input, expected)
TEST_CASE("to_string conversions", "[string][generator]") {
    auto [input, expected] = GENERATE(table<int, std::string>({
        {0,  "0"},
        {1,  "1"},
        {-1, "-1"},
        {42, "42"},
        {INT_MAX, "2147483647"},
    }));

    REQUIRE(std::to_string(input) == expected);
}

// Composing generators with filter
TEST_CASE("only even numbers pass", "[generator][filter]") {
    auto n = GENERATE(filter([](int x){ return x % 2 == 0; }, range(1, 20)));

    REQUIRE(n % 2 == 0);
}
```

Generators compose: `take(5, range(1, 1000))` limits to 5 values. `map([](int x){ return x*x. }, range(1,10))` transforms values. `chunk(3, range(1, 100))` groups into vectors of 3.

### Benchmarks (Catch2 v3)

Catch2 v3 includes a benchmarking facility. It is less feature-rich than Google Benchmark but useful for quick comparisons:

```cpp
#include <catch2/catch_test_macros.hpp>
#include <catch2/benchmark/catch_benchmark.hpp>
#include <vector>
#include <list>
#include <algorithm>

TEST_CASE("container traversal benchmarks", "[.][benchmark]") {
    const int N = 10'000;

    std::vector<int> vec(N);
    std::list<int> lst(vec.begin(), vec.end());
    std::iota(vec.begin(), vec.end(), 0);

    BENCHMARK("vector sum") {
        volatile long sum = 0;
        for (int x : vec) sum += x;
        return sum;
    };

    BENCHMARK("list sum") {
        volatile long sum = 0;
        for (int x : lst) sum += x;
        return sum;
    };
}
```

Run with `./tests "[benchmark]"`, the `.` tag prefix means benchmarks do not run by default.

### When to Choose Catch2 over gtest

- **Prototyping and solo projects**: no CMake subproject needed (v2 is single-header), faster to set up.
- **BDD preference**: `GIVEN/WHEN/THEN` reads better in stories-driven teams.
- **Generator-driven tests**: when you want range/table generators without `INSTANTIATE_TEST_SUITE_P` boilerplate.
- **Readable failure output**: Catch2 prints the entire expression `REQUIRE(a + b == 7)` with actual values, without needing `EXPECT_EQ(a + b, 7)`.

Choose gtest when: you need gmock, your team already uses gtest, or you need typed tests for generic code.

### CMake Setup

Setting up the toolchain correctly is the prerequisite for all subsequent work. The commands below install the necessary compiler, standard library headers, and build tools, ensuring a consistent development environment across the team.
```cmake
include(FetchContent)
FetchContent_Declare(
    Catch2
    GIT_REPOSITORY https://github.com/catchorg/Catch2.git
    GIT_TAG        v3.5.2
)
FetchContent_MakeAvailable(Catch2)

add_executable(my_catch_tests
    bank_account_test.cpp
    sort_test.cpp
)

target_link_libraries(my_catch_tests PRIVATE
    Catch2::Catch2WithMain  # provides main()
    my_library
)

include(CTest)
include(Catch)
catch_discover_tests(my_catch_tests)  # registers with CTest
```

### Go Comparison

Catch2's `SECTION` re-execution model is closest to Go's `t.Run()` subtests, but Go subtests are explicitly invoked, while Catch2 implicitly re-runs the surrounding scope. Catch2's `GENERATE` is analogous to Go's table-driven test slice, but terser. Go's `testing.T` has no BDD syntax. Teams that want `Given/When/Then` in Go use third-party frameworks like `goconvey` or `ginkgo`. Catch2 has that built in.

---
