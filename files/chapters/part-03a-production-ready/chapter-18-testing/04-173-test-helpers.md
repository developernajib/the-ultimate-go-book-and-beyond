## 18.3 Test Helpers

### Helper Functions

Test helper functions reduce boilerplate by extracting repetitive setup, assertion, and teardown logic into reusable utilities. Calling `t.Helper()` at the start of a helper instructs the test framework to attribute failures to the call site rather than the helper itself, producing clearer error messages. Using `t.Cleanup` inside helpers ensures resources are released automatically when the test ends, even if it panics or calls `t.Fatal`.

```go
import (
    "database/sql"
    "reflect"
    "testing"

    _ "modernc.org/sqlite" // registers the "sqlite" driver, no cgo required
)

func TestUserService(t *testing.T) {
    db := setupTestDB(t)
    service := NewUserService(db)

    user, err := service.Create(validUser)
    assertNoError(t, err)
    assertNotNil(t, user)
    assertEqual(t, user.Email, validUser.Email)
}

func setupTestDB(t *testing.T) *sql.DB {
    t.Helper() // failures are attributed to the caller, not to this line

    db, err := sql.Open("sqlite", ":memory:")
    if err != nil {
        t.Fatalf("open db: %v", err)
    }

    t.Cleanup(func() {
        db.Close()
    })

    if _, err := db.Exec(schema); err != nil {
        t.Fatalf("create schema: %v", err)
    }

    return db
}

func assertNoError(t *testing.T, err error) {
    t.Helper()
    if err != nil {
        t.Fatalf("unexpected error: %v", err)
    }
}

func assertEqual[T comparable](t *testing.T, got, want T) {
    t.Helper()
    if got != want {
        t.Errorf("got %v, want %v", got, want)
    }
}

// assertNotNil reports a failure if v is nil, INCLUDING a typed nil such as
// a (*User)(nil) stored in an interface. See the note below: the obvious
// `if v == nil` version does not work.
func assertNotNil(t *testing.T, v any) {
    t.Helper()
    if isNil(v) {
        t.Fatal("expected non-nil value")
    }
}

func isNil(v any) bool {
    if v == nil { // untyped nil: the interface itself is empty
        return true
    }
    // A non-empty interface can still hold a nil pointer, map, slice,
    // channel, func, or interface. Only these kinds can be nil at all -     // calling IsNil on any other kind panics.
    rv := reflect.ValueOf(v)
    switch rv.Kind() {
    case reflect.Ptr, reflect.Map, reflect.Slice, reflect.Chan,
        reflect.Func, reflect.Interface, reflect.UnsafePointer:
        return rv.IsNil()
    default:
        return false
    }
}
```

**Why `assertNotNil` cannot just be `if v == nil`.** This is the single most common broken test helper in Go, and it fails silently in the direction that matters: it passes when it should fail.

An `any` is a two-word value, a type and a pointer. It equals `nil` only when *both* words are empty. Passing a nil `*User` sets the type word to `*User`, so the interface is not nil even though the pointer inside it is:

```
user == nil (typed, direct)        : true
any(user) == nil (what helper sees): false   <-- the trap
reflect.DeepEqual(user, nil)       : false   <-- same trap, same reason
```

So the naive helper accepts a nil pointer without complaint, the test goes green, and the first real dereference panics with `invalid memory address or nil pointer dereference`. Note that `reflect.DeepEqual(v, nil)` is not a fix, it is the identical bug wearing a different hat: it compares against an *untyped* nil interface and is false for every typed nil.

The same trap bites production code, not just tests. A function returning a concrete `*MyError` into an `error` return value produces a non-nil `error` holding a nil pointer, which is why the rule is to return a bare `nil` rather than a nil-valued concrete pointer.

### Using t.Cleanup

`t.Cleanup` registers a function to be called when the test and all its subtests finish, regardless of pass or fail. This is the idiomatic alternative to `defer` inside a test because it also works correctly when called from within helper functions, where `defer` would run too early. Multiple cleanup functions are executed in last-in, first-out order, mirroring how `defer` stacks work.

```go
func TestWithTempFile(t *testing.T) {
    f, err := os.CreateTemp("", "test")
    if err != nil {
        t.Fatal(err)
    }
    t.Cleanup(func() {
        os.Remove(f.Name())
    })

    // Use file...
}
```

### Staff Lens: Shared Helpers Package

Every test helper used in more than one place should live in a shared `internal/testutil` or similar package. Typical contents: database setup, HTTP server builders, common assertion helpers, fixture loaders. Without this package, helpers are duplicated across test files and diverge over time. With it, the team has a consistent test vocabulary.

The review discipline: when you see a helper copy-pasted twice, propose promoting it to the shared package.

---
