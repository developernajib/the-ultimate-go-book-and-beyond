## 18.11 Testing Best Practices

### Test Naming

The naming convention `TestSubject_Method_Condition_ExpectedOutcome` makes test failures self-documenting: when a test fails in CI, the test name alone communicates what was being tested and what was expected without needing to read the test body. Consistent naming also makes it easy to filter related tests with `go test -run TestUserService`.

```go
func TestUserService_Create_ValidInput_Success(t *testing.T) {}
func TestUserService_Create_DuplicateEmail_ReturnsError(t *testing.T) {}
func TestUserService_Delete_NonexistentUser_ReturnsNotFound(t *testing.T) {}
```

### Test Independence

Tests that share state are order-dependent: passing in isolation but failing when run in parallel or in a different order. Each test should set up and tear down its own state using helpers like `setupCleanDB(t)` with `t.Cleanup`, ensuring complete isolation regardless of execution order or parallelism.

```go
// Each test should be independent
func TestCreate(t *testing.T) {
    db := setupCleanDB(t)  // Fresh state
    // Test...
}

func TestDelete(t *testing.T) {
    db := setupCleanDB(t)  // Fresh state
    // Test...
}
```

### Testing Private Functions

Go's `_test.go` files in the same package (without the `_test` suffix in the package name) can access unexported identifiers directly. This allows testing internal helper logic without exposing it through the public API, while test files with the `_test` suffix use only the exported interface and serve as documentation of the public contract.

```go
// user_internal_test.go (same package)
package user

func TestPrivateHelper(t *testing.T) {
    result := privateHelper("input")
    // Can test private functions
}
```

### Avoid Test Pollution

Global state mutations in one test can silently affect subsequent tests, producing intermittent failures that are difficult to reproduce or diagnose. Passing configuration and dependencies as local values rather than modifying package-level globals ensures each test starts from a known clean state.

```go
// Bad: mutating a package-level global. The change outlives the test
// and leaks into whatever runs next.
var globalConfig Config

func TestWithConfig_Bad(t *testing.T) {
    globalConfig.Debug = true // Affects other tests!
}

// Good: keep it local and pass it in.
func TestWithConfig_Good(t *testing.T) {
    cfg := Config{Debug: true}
    service := NewService(cfg)
    _ = service
}
```

### Environment Variables: use `t.Setenv`

Environment variables are the most common form of global state in Go tests, and the standard library has a purpose-built tool for them. `t.Setenv` sets the variable and registers a `Cleanup` that restores the previous value, so no test can leak a variable into the next one:

```go
func TestSetenvRestores(t *testing.T) {
    os.Setenv("MY_VAR", "original")

    t.Run("sub", func(t *testing.T) {
        t.Setenv("MY_VAR", "overridden")
        // inside subtest: MY_VAR="overridden"
    })

    // after subtest:  MY_VAR="original"  <-- restored, no manual cleanup
}
```

**`t.Setenv` is incompatible with `t.Parallel`, and this is enforced.** The environment is process-wide, so a parallel test mutating it would corrupt every other test running at that moment. Rather than let you create that race, the testing package panics:

```
panic: testing: test using t.Setenv, t.Chdir, or cryptotest.SetGlobalRandom
can not use t.Parallel
```

Note that the restriction covers tests with parallel *ancestors* too, not just the test that calls `Setenv`. The same applies to `t.Chdir` (Go 1.24+), for the same reason: the working directory is process-wide.

This is a genuine design constraint rather than a limitation to work around. If a test needs to control the environment, the code under test is reading global state, and the fix that unlocks parallelism is to inject the configuration instead of reading `os.Getenv` deep in the call stack. That is the same lesson as the `globalConfig` example above, with the compiler and runtime enforcing it.

### Staff Lens: Test Naming as Documentation

Test names are documentation. A test named `TestUser_Create_DuplicateEmail_ReturnsConflict` tells a reader exactly what is being tested without opening the code. A test named `TestCreate2` tells them nothing.

Reference format:

```
TestType_Method_Scenario_ExpectedBehavior
```

Or for table-driven cases:

```go
t.Run("returns ErrConflict when email already exists", ...)
```

Engineers skim test output to understand failures. Well-named tests turn the output into a specification.

---
