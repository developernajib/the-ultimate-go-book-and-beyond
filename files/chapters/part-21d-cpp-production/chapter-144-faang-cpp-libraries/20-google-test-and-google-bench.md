## GoogleTest and GoogleBenchmark

GoogleTest (gtest) and GoogleMock (gmock) are the de facto C++ testing stack at Google and across most large C++ shops. GoogleBenchmark (gbench) is the microbenchmarking counterpart. This file covers the patterns you actually use in production code, not just the hello-world API.

### TEST and TEST_F

The simplest form:

```cpp
TEST(MathTest, AddsTwoIntegers) {
  EXPECT_EQ(2 + 2, 4);
}
```

`TEST(SuiteName, TestName)` registers a test in the global registry. The test binary's `main` (provided by `gtest_main`) discovers and runs them.

When tests share setup, use a fixture:

```cpp
class CacheTest : public ::testing::Test {
 protected:
  void SetUp() override {
    cache_ = std::make_unique<Cache>(/*capacity=*/100);
  }
  void TearDown() override {
    cache_.reset();
  }
  std::unique_ptr<Cache> cache_;
};

TEST_F(CacheTest, InsertsAndRetrieves) {
  cache_->Insert("key", "value");
  EXPECT_EQ(cache_->Lookup("key"), "value");
}
```

`TEST_F` runs each test in a fresh fixture instance. Setup and teardown run per-test.

For one-time setup across the whole suite, use `SetUpTestSuite` / `TearDownTestSuite` (note: previously `SetUpTestCase`, renamed in gtest 1.10).

### ASSERT vs EXPECT

- `ASSERT_*` aborts the current test on failure.
- `EXPECT_*` records the failure and continues.

Use `ASSERT_` when later code would crash given the failure (null pointer, missing element). Use `EXPECT_` when you want to see all failures in one run. Multiple `EXPECT_EQ` in a single test give you a richer signal than chained ASSERTs that bail on the first.

### Matcher Library

The matcher library (in `<gmock/gmock-matchers.h>`) is the most powerful part of the stack:

```cpp
EXPECT_THAT(name, ::testing::HasSubstr("alice"));
EXPECT_THAT(numbers, ::testing::ElementsAre(1, 2, 3));
EXPECT_THAT(numbers, ::testing::UnorderedElementsAre(3, 1, 2));
EXPECT_THAT(numbers, ::testing::Each(::testing::Gt(0)));
EXPECT_THAT(maybe, ::testing::Optional(42));
EXPECT_THAT(status_or, ::testing::IsOkAndHolds(::testing::Eq(42)));
EXPECT_THAT(point, ::testing::AllOf(
    ::testing::Field(&Point::x, ::testing::Eq(3)),
    ::testing::Field(&Point::y, ::testing::Eq(4))));
```

`Field`, `Property`, `Pointee`, `Optional`, `Pair`, `Each`, `Contains`, `IsEmpty`, `SizeIs` compose into rich expectations. Failure messages are descriptive: "expected element 2 to be > 0, was -1".

Custom matchers via `MATCHER_P`:

```cpp
MATCHER_P(StatusIs, code, "") {
  return arg.code() == code;
}
EXPECT_THAT(s, StatusIs(absl::StatusCode::kNotFound));
```

### Parameterized Tests

When you want to run the same test against many inputs:

```cpp
class HashCorrectnessTest
    : public ::testing::TestWithParam<absl::string_view> {};

TEST_P(HashCorrectnessTest, IsDeterministic) {
  auto h1 = MyHash(GetParam());
  auto h2 = MyHash(GetParam());
  EXPECT_EQ(h1, h2);
}

INSTANTIATE_TEST_SUITE_P(
    Inputs, HashCorrectnessTest,
    ::testing::Values("", "a", "hello", std::string(1000, 'x')));
```

Each value generates a separately-named test. The test runner reports which input failed, not just "the test failed".

### Typed Tests

When the same logic should be tested across a list of types:

```cpp
template <typename T>
class ContainerTest : public ::testing::Test {};

using ContainerTypes = ::testing::Types<
    std::vector<int>,
    std::deque<int>,
    std::list<int>>;
TYPED_TEST_SUITE(ContainerTest, ContainerTypes);

TYPED_TEST(ContainerTest, IsEmptyOnConstruction) {
  TypeParam container;
  EXPECT_TRUE(container.empty());
}
```

Used in template-heavy library code. The Abseil hash containers tests do this for all hash table types.

### Death Tests

For testing CHECK failures or fatal asserts:

```cpp
TEST(MyDeathTest, AbortsOnNull) {
  EXPECT_DEATH(MyFunction(nullptr), "must not be null");
}
```

The matcher is a regex against the death output. Death tests fork a subprocess (or use threadsafe mode) so the test binary survives the abort. Required when testing `CHECK`, `LOG(FATAL)`, or `std::abort` paths.

The naming convention `MyDeathTest` (a test suite ending in `DeathTest`) ensures these tests run before non-death tests in the same binary, since forking after threads have started is unreliable.

### GoogleMock Mock Methods

Mocks let you stand in for an interface with controllable behavior:

```cpp
class StorageInterface {
 public:
  virtual ~StorageInterface() = default;
  virtual absl::Status Put(absl::string_view key, absl::string_view value) = 0;
  virtual absl::StatusOr<std::string> Get(absl::string_view key) = 0;
};

class MockStorage : public StorageInterface {
 public:
  MOCK_METHOD(absl::Status, Put,
              (absl::string_view key, absl::string_view value), (override));
  MOCK_METHOD(absl::StatusOr<std::string>, Get,
              (absl::string_view key), (override));
};
```

The `MOCK_METHOD` macro generates the override plus the gmock plumbing. Use the four-argument form (return, name, args, qualifiers). The legacy `MOCK_METHOD2` form is deprecated.

### EXPECT_CALL Ordering

```cpp
TEST(ServiceTest, RetriesOnTransientFailure) {
  MockStorage storage;
  using ::testing::_;
  using ::testing::Return;

  ::testing::InSequence seq;
  EXPECT_CALL(storage, Get("key"))
      .WillOnce(Return(absl::UnavailableError("temporary")));
  EXPECT_CALL(storage, Get("key"))
      .WillOnce(Return(std::string("value")));

  Service service(&storage);
  EXPECT_THAT(service.GetWithRetry("key"), ::testing::IsOkAndHolds("value"));
}
```

`InSequence` enforces the order of expectations. Without it, gmock allows any order. Other ordering tools:

- `EXPECT_CALL(...).Times(N)`: exactly N invocations.
- `EXPECT_CALL(...).Times(::testing::AtLeast(1))`.
- `Sequence`: explicit DAG of orderings (more flexible than `InSequence`).
- `After`: this expectation must come after another.

`WillOnce` provides one return per call. `WillRepeatedly` provides the same return for any further calls.

Strict mocks (`StrictMock<MockStorage>`) fail on any uninstantiated call. Naggy mocks (`NaggyMock`) warn. Nice mocks (`NiceMock`) silently ignore. Default is naggy. Most production tests use strict mocks for unintended-call detection.

### GoogleBenchmark Basics

```cpp
#include <benchmark/benchmark.h>

static void BM_StringConcat(benchmark::State& state) {
  std::string a(state.range(0), 'a');
  std::string b(state.range(0), 'b');
  for (auto _ : state) {
    std::string c = a + b;
    benchmark::DoNotOptimize(c);
  }
  state.SetBytesProcessed(int64_t(state.iterations()) * 2 * state.range(0));
}
BENCHMARK(BM_StringConcat)->Arg(8)->Arg(64)->Arg(1024)->Arg(65536);
```

The framework runs the inner loop enough times to get a stable measurement. `state.iterations()` is the count. `DoNotOptimize` prevents the optimizer from removing the result. `ClobberMemory` flushes pending writes if you need a memory-fence-style barrier.

### Templated Benchmarks

```cpp
template <class Map>
static void BM_MapInsert(benchmark::State& state) {
  for (auto _ : state) {
    Map m;
    for (int i = 0; i < state.range(0); ++i) m.emplace(i, i);
    benchmark::DoNotOptimize(m);
  }
}
BENCHMARK_TEMPLATE(BM_MapInsert, std::map<int, int>)->Range(8, 1 << 16);
BENCHMARK_TEMPLATE(BM_MapInsert, std::unordered_map<int, int>)->Range(8, 1 << 16);
BENCHMARK_TEMPLATE(BM_MapInsert, absl::flat_hash_map<int, int>)->Range(8, 1 << 16);
```

Run with `--benchmark_format=json` to get machine-readable output for CI charts.

### Statistics

`--benchmark_repetitions=10 --benchmark_report_aggregates_only=true` reports min, max, mean, median, stddev. Use this for any reported number. Single-run benchmarks lie under the influence of CPU frequency scaling and OS scheduler noise.

For the lowest-noise measurements:

- Disable Turbo Boost on the test machine.
- Pin the process to a single core (`taskset -c 0`).
- Use a real-time scheduler if the test allows it.

### Profiling Integration

Build the benchmark with debug symbols and run under `perf record`:

```bash
perf record -g ./my_benchmark --benchmark_filter=BM_StringConcat
perf report
```

For finer attribution, link against `gperftools` and trigger CPU profiling for a window:

```cpp
#include <gperftools/profiler.h>
static void BM_Hot(benchmark::State& state) {
  ProfilerStart("hot.prof");
  for (auto _ : state) HotFunction();
  ProfilerStop();
}
```

`pprof` reads `hot.prof` and produces flame graphs.

### Test Organization in google3

A typical layout:

```
//myproject/foo/
  BUILD
  foo.h
  foo.cc
  foo_test.cc                  - unit test, fast, no I/O
  foo_integration_test.cc      - real dependencies, slower
  foo_benchmark.cc             - perf benchmarks
  testing/                     - test helpers, fakes
    fake_storage.h
    fake_storage.cc
```

Bazel rules:

- `cc_test`: a unit test, runs under `blaze test`.
- `cc_test` with `tags = ["manual"]`: integration test, opt-in.
- `cc_binary` for benchmarks (not `cc_test`).

The test target should run in under 60 seconds. Anything longer becomes flakey under CI load and gets quarantined.

### Junior to FAANG: Test the Behavior, Not the Implementation

A junior writes "expect that internalCount == 5". A FAANG-track engineer writes "expect that the public API returns the right value when given the right input". The test stays green when you refactor internals. That is what makes test suites valuable instead of a tax.

### Senior at FAANG: Test Hygiene at Scale

Senior engineers own test reliability. They:

- Eliminate flaky tests (runs that pass and fail without code change). Every flake erodes trust in CI.
- Keep tests fast. A 5-minute test suite cripples velocity. Sharding (`--test_sharding_strategy=disabled` or auto-shard via Bazel) keeps runtime bounded.
- Avoid time-based flakes. Inject `Clock` interfaces. Use fake clocks in tests.
- Avoid filesystem and network in unit tests. In-memory fakes only.
- Treat the test code with the same review rigor as production code.

The test suite is the single largest piece of infrastructure most senior engineers shape.
