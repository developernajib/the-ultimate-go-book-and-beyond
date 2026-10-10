## 18.4 Mocking and Interfaces

### Interface-Based Mocking

Go's implicit interface satisfaction makes it straightforward to swap real dependencies with test doubles: any struct that implements the required methods satisfies the interface without explicit declaration. A common pattern is to expose function fields on the mock struct so individual tests can inject custom behavior without creating a new type for each scenario. This keeps tests self-contained and makes it obvious at a glance exactly what behavior is being exercised.

```go
// Define interface
type UserRepository interface {
    Get(id int) (*User, error)
    Create(user *User) error
}

// Mock implementation
type MockUserRepository struct {
    GetFunc    func(id int) (*User, error)
    CreateFunc func(user *User) error
}

func (m *MockUserRepository) Get(id int) (*User, error) {
    if m.GetFunc == nil {
        // Fail loudly rather than returning a zero value. See the note below.
        panic("MockUserRepository.Get called but GetFunc is not set")
    }
    return m.GetFunc(id)
}

func (m *MockUserRepository) Create(user *User) error {
    if m.CreateFunc == nil {
        panic("MockUserRepository.Create called but CreateFunc is not set")
    }
    return m.CreateFunc(user)
}

// Usage in tests
func TestUserService_GetUser(t *testing.T) {
    expectedUser := &User{ID: 1, Name: "Alice"}

    mock := &MockUserRepository{
        GetFunc: func(id int) (*User, error) {
            if id == 1 {
                return expectedUser, nil
            }
            return nil, ErrNotFound
        },
    }

    service := NewUserService(mock)

    user, err := service.GetUser(1)
    assertNoError(t, err)
    assertEqual(t, user.Name, "Alice")
}
```

**Why the unset-func case panics instead of returning `nil, nil`.** The tempting default is to return zero values when a func field is not configured, and it is a trap. A test that exercises a code path the author did not anticipate gets a silent `(nil, nil)`: no user, and no error saying so. That is a state the real repository can never produce, so the service is now being tested against a fiction:

```
GetUser -> user=<nil> err=<nil>
DEFECT: assertion on the result panics: invalid memory address or nil pointer dereference
```

The panic eventually arrives, but at the assertion, not at the cause, and the message says nothing about a misconfigured mock. Panicking in the mock puts the failure exactly where the bug is, with a message naming the missing field. A mock is test infrastructure: when it is used wrong, it should say so immediately and in plain words.

If a particular test genuinely wants "not found", it should say so explicitly, which is also more readable:

```go
mock := &MockUserRepository{
    GetFunc: func(int) (*User, error) { return nil, ErrNotFound },
}
```

### Recording Mock

A recording mock captures every method call and its arguments in a log, enabling assertions about interaction patterns rather than just return values. This is useful when testing that a service calls its dependencies in the correct order or the expected number of times, which plain return-value checks cannot verify. The recorded call log acts as a lightweight spy that gives tests visibility into the collaboration between components.

```go
import (
    "fmt"
    "slices"
    "sync"
)

type RecordingRepository struct {
    mu    sync.Mutex // a mock is shared state, see the note below
    calls []string
    Users map[int]*User
}

func (r *RecordingRepository) Get(id int) (*User, error) {
    r.mu.Lock()
    r.calls = append(r.calls, fmt.Sprintf("Get(%d)", id))
    user, ok := r.Users[id]
    r.mu.Unlock()

    if !ok {
        return nil, ErrNotFound
    }
    return user, nil
}

func (r *RecordingRepository) Create(user *User) error {
    r.mu.Lock()
    defer r.mu.Unlock()
    r.calls = append(r.calls, fmt.Sprintf("Create(%v)", user))
    r.Users[user.ID] = user
    return nil
}

// Calls returns a copy, so the caller cannot race with in-flight calls
// and cannot mutate the mock's records.
func (r *RecordingRepository) Calls() []string {
    r.mu.Lock()
    defer r.mu.Unlock()
    return slices.Clone(r.calls)
}

func TestServiceCallsRepository(t *testing.T) {
    repo := &RecordingRepository{Users: make(map[int]*User)}
    service := NewUserService(repo)

    if err := service.CreateUser(&User{ID: 1, Name: "Alice"}); err != nil {
        t.Fatalf("create: %v", err)
    }
    if _, err := service.GetUser(1); err != nil {
        t.Fatalf("get: %v", err)
    }

    want := []string{"Create(&{1 Alice})", "Get(1)"}
    if got := repo.Calls(); !slices.Equal(got, want) {
        t.Errorf("calls = %v, want %v", got, want)
    }
}
```

**A recording mock is shared mutable state, so it needs a mutex.** This is not hypothetical caution. The unsynchronized version looks fine and passes as long as the code under test happens to be sequential. Point any concurrent caller at it, which is exactly what you do when testing a service that fans out, and `-race` lights up while calls silently vanish:

```
WARNING: DATA RACE
WARNING: DATA RACE
--- FAIL: TestConcurrentUseOfRecordingMock
    recorded 5 calls (expected 8)
```

Three of eight `append`s were lost to the race. A mock that drops the very calls it exists to record is worse than no mock, and because this chapter insists on `-race` everywhere, an unsynchronized mock is a time bomb waiting for the first test that adds a goroutine.

Note also the assertion. Checking `len(repo.Calls) != 2` only confirms *how many* calls happened, which passes just as happily if the service called `Get` twice and never called `Create`. Comparing the actual sequence costs nothing extra and tests something real.

### Hand-Rolled Fakes vs Generated Mocks

For narrow interfaces (1-3 methods), hand-rolled fakes are usually cleaner than generated mocks (`mockgen`, `mockery`, `testify/mock`). They are shorter, type-safe, and produce readable test code.

For wider interfaces, generated mocks reduce boilerplate at the cost of readability. Use them only when the interface is genuinely unavoidable.

The pattern: keep interfaces narrow (Chapter 6's rule). Hand-roll fakes. Reach for mock generators only as a last resort.

### Staff Lens: Do Not Over-Mock

A test that mocks every dependency tests the mock, not the code. The test will pass even if the logic is wrong. It only fails if the wiring changes. The review question: "what is this test actually verifying?" If the answer is "that the function calls these mocked methods in this order", the test is fragile and probably useless.

Prefer tests that use real dependencies where possible: in-memory SQLite for database, `httptest.NewServer` for HTTP. Mock only at external-service boundaries where real dependencies are unavailable or too slow.

---
