## Google Mock (gmock): Type-Safe Mocking

Mocking lets you isolate a unit under test from its dependencies, replace a real database with an in-memory fake, replace an HTTP client with a stub that returns controlled responses, or verify that a method was called a specific number of times with specific arguments. gmock is built on top of gtest and provides a macro-based system that generates type-safe mock implementations from interface declarations.

### Defining a Mock

Start with a pure virtual interface. gmock generates the mock from that interface.

```cpp
#include <gmock/gmock.h>
#include <string>
#include <vector>
#include <optional>

// The interface your production code depends on
class UserRepository {
public:
    virtual ~UserRepository() = default;

    virtual std::optional<std::string> find_by_id(int id) const = 0;
    virtual bool save(int id, const std::string& name) = 0;
    virtual std::vector<std::string> find_all() const = 0;
    virtual void delete_user(int id) = 0;
};

// The mock - use MOCK_METHOD(return_type, method_name, (arg_types...), (qualifiers))
class MockUserRepository : public UserRepository {
public:
    MOCK_METHOD(std::optional<std::string>, find_by_id, (int id), (const, override));
    MOCK_METHOD(bool, save, (int id, const std::string& name), (override));
    MOCK_METHOD(std::vector<std::string>, find_all, (), (const, override));
    MOCK_METHOD(void, delete_user, (int id), (override));
};
```

The `MOCK_METHOD` macro takes `(ReturnType, MethodName, (ArgTypes...), (Qualifiers...))`. The fourth argument is a parenthesized list of qualifiers like `const`, `override`, `noexcept`.

### EXPECT_CALL: Setting Expectations

`EXPECT_CALL` is how you specify what calls you expect and what the mock should return. Expectations are checked when the mock object goes out of scope (or when `Mock::VerifyAndClear` is called).

```cpp
#include <gtest/gtest.h>
#include <gmock/gmock.h>

// System under test - depends on UserRepository via injection
class UserService {
public:
    explicit UserService(UserRepository& repo) : repo_(repo) {}

    std::string get_username(int id) {
        auto name = repo_.find_by_id(id);
        return name.value_or("unknown");
    }

    bool create_user(int id, const std::string& name) {
        if (name.empty()) return false;
        return repo_.save(id, name);
    }

private:
    UserRepository& repo_;
};

TEST(UserServiceTest, ReturnsUsernameWhenFound) {
    MockUserRepository mock_repo;

    // Expect find_by_id to be called once with argument 42
    // and return "alice"
    EXPECT_CALL(mock_repo, find_by_id(42))
        .Times(1)
        .WillOnce(::testing::Return(std::optional<std::string>{"alice"}));

    UserService svc(mock_repo);
    EXPECT_EQ(svc.get_username(42), "alice");
}

TEST(UserServiceTest, ReturnsUnknownWhenNotFound) {
    MockUserRepository mock_repo;

    EXPECT_CALL(mock_repo, find_by_id(::testing::_))  // _ matches any argument
        .WillOnce(::testing::Return(std::optional<std::string>{}));

    UserService svc(mock_repo);
    EXPECT_EQ(svc.get_username(99), "unknown");
}

TEST(UserServiceTest, RefusesToCreateUserWithEmptyName) {
    MockUserRepository mock_repo;

    // save() must NOT be called - Times(0) enforces this
    EXPECT_CALL(mock_repo, save(::testing::_, ::testing::_)).Times(0);

    UserService svc(mock_repo);
    EXPECT_FALSE(svc.create_user(1, ""));
}
```

### Matchers

Matchers let you specify what arguments an expectation applies to. They compose into powerful argument constraints.

```cpp
using ::testing::_;
using ::testing::Eq;
using ::testing::Ne;
using ::testing::Lt;
using ::testing::Gt;
using ::testing::HasSubstr;
using ::testing::StartsWith;
using ::testing::EndsWith;
using ::testing::ContainerEq;
using ::testing::ElementsAre;
using ::testing::Contains;
using ::testing::AllOf;
using ::testing::AnyOf;
using ::testing::Not;

// Matching by value
EXPECT_CALL(mock, method(Eq(42)));          // argument == 42
EXPECT_CALL(mock, method(Ne(0)));           // argument != 0
EXPECT_CALL(mock, method(Lt(100)));         // argument < 100

// String matchers
EXPECT_CALL(mock, log(HasSubstr("error"))); // string contains "error"
EXPECT_CALL(mock, log(StartsWith("WARN:"))); 

// Container matchers (used in EXPECT_THAT assertions)
std::vector<int> result = {1, 2, 3};
EXPECT_THAT(result, ElementsAre(1, 2, 3));
EXPECT_THAT(result, Contains(2));
EXPECT_THAT(result, Not(Contains(99)));

// Combining matchers
EXPECT_CALL(mock, method(AllOf(Gt(0), Lt(100))));   // 0 < x < 100
EXPECT_CALL(mock, method(AnyOf(Eq(1), Eq(2))));     // x == 1 || x == 2
```

### Custom Matchers

When built-in matchers are not sufficient, define your own with `MATCHER_P`:

```cpp
// MATCHER_P(Name, param, description) { return ... - }
MATCHER_P(HasUserId, expected_id, "has user id " + std::to_string(expected_id)) {
    return arg.user_id == expected_id;
}

MATCHER_P2(InRange, low, high, "is in range [" + std::to_string(low) + ", " + std::to_string(high) + "]") {
    return arg >= low && arg <= high;
}

// Usage
EXPECT_CALL(mock_repo, save(InRange(1, 1000), ::testing::_));
```

### Actions: Controlling Return Values

Actions determine what a mock does when called.

```cpp
using ::testing::Return;
using ::testing::ReturnRef;
using ::testing::Invoke;
using ::testing::DoAll;
using ::testing::SaveArg;
using ::testing::Throw;

// Return a value
EXPECT_CALL(mock, find_by_id(1))
    .WillOnce(Return(std::optional<std::string>{"bob"}));

// Return a reference (careful - ref must outlive the mock)
std::string name = "charlie";
EXPECT_CALL(mock, get_name())
    .WillRepeatedly(ReturnRef(name));

// Invoke a lambda or function
EXPECT_CALL(mock, find_by_id(::testing::_))
    .WillRepeatedly(Invoke([](int id) -> std::optional<std::string> {
        if (id > 0) return "user_" + std::to_string(id);
        return std::nullopt;
    }));

// Capture an argument, then return a value
int captured_id = 0;
EXPECT_CALL(mock, delete_user(::testing::_))
    .WillOnce(DoAll(SaveArg<0>(&captured_id), Return()));

// Throw an exception
EXPECT_CALL(mock, find_by_id(::testing::_))
    .WillOnce(Throw(std::runtime_error("connection lost")));
```

### Sequences: Ordered Calls

When call order matters, use `::testing::InSequence`:

```cpp
TEST(UserServiceTest, SaveThenVerifyOrder) {
    MockUserRepository mock_repo;

    {
        ::testing::InSequence seq;  // RAII: enforces ordering while in scope

        EXPECT_CALL(mock_repo, find_by_id(1))
            .WillOnce(Return(std::optional<std::string>{}));
        EXPECT_CALL(mock_repo, save(1, "alice"))
            .WillOnce(Return(true));
    }

    UserService svc(mock_repo);
    // ... call methods that trigger find then save
}
```

### Multiple Returns: WillOnce Chaining

`WillOnce` chains let an `EXPECT_CALL` return a different value on each successive call, then `WillRepeatedly` specifies what to return for all subsequent invocations once the `WillOnce` chain is exhausted. This is the standard way to simulate database cursors, retry logic, or any interface that changes its response based on call count without writing a stateful custom action.
```cpp
EXPECT_CALL(mock, find_by_id(::testing::_))
    .WillOnce(Return(std::optional<std::string>{"first"}))
    .WillOnce(Return(std::optional<std::string>{"second"}))
    .WillRepeatedly(Return(std::optional<std::string>{}));  // all subsequent calls
```

### NiceMock and StrictMock

By default, an unexpected call on a mock generates a warning but does not fail the test. `NiceMock` suppresses those warnings. `StrictMock` turns them into failures.

```cpp
// NiceMock: silences "Uninteresting mock function call" warnings.
// Use when you only care about a subset of interactions.
::testing::NiceMock<MockUserRepository> nice_mock;

// StrictMock: ANY unexpected call fails the test immediately.
// Use to enforce that the SUT only calls what you explicitly expect.
::testing::StrictMock<MockUserRepository> strict_mock;
EXPECT_CALL(strict_mock, find_by_id(42)).Times(1).WillOnce(Return(std::nullopt));
// If any other method is called, the test fails.
```

### Mock Destruction Order

A mock verifies expectations when it is destroyed. If the system under test holds a reference to the mock and outlives it, you get a use-after-free. Always declare mocks before the system under test so they are destroyed after it.

```cpp
TEST(OrderTest, MockOutlivesSystemUnderTest) {
    // Correct order: mock declared first, destroyed last
    MockUserRepository mock_repo;  // destroyed second
    UserService svc(mock_repo);    // destroyed first

    EXPECT_CALL(mock_repo, find_by_id(1)).Times(1).WillOnce(Return(std::nullopt));
    svc.get_username(1);

    // ~UserService() runs first, then ~MockUserRepository() verifies expectations
}
```

### Go Comparison

Go's idiomatic mocking uses interfaces and hand-written fakes or `testify/mock`. The contrast:

- `testify/mock` uses runtime reflection and string-based method registration. gmock uses compile-time code generation via macros, if the interface changes, the mock fails to compile immediately.
- Go's lack of generics (until 1.18) made typed mock generation harder. Gmock has always been fully typed.
- `EXPECT_CALL` cardinality checks (`.Times(2)`) are built in. `testify/mock` has `.Times(n)` but it requires calling `AssertExpectations(t)` manually at the end of the test, gmock checks automatically on mock destruction.
- Both approaches share the same fundamental philosophy: depend on interfaces, inject dependencies, replace with mocks in tests.

---
