## 18.12 Complete Application: Production Test Framework

As a project grows, test setup code tends to scatter across dozens of files with subtle inconsistencies in cleanup, assertion formatting, and mock wiring. A shared test toolkit consolidates these concerns into one package, giving every test file a consistent API for assertions, HTTP request building, fixture loading, and database setup. The `testkit` package below shows the shape this converges on at most organizations that run a large service catalog: a single `Suite` object owning the lifecycle of every test resource.

```go
// testkit/testkit.go
package testkit

import (
    "bytes"
    "context"
    "database/sql"
    "encoding/json"
    "errors"
    "fmt"
    "io"
    "net/http"
    "net/http/httptest"
    "os"
    "path/filepath"
    "reflect"
    "strings"
    "sync"
    "testing"
    "time"
)

// Suite is a test suite with setup/teardown and assertions
type Suite struct {
    t          *testing.T
    assertions *Assertions
    fixtures   *FixtureManager
    mocks      *MockRegistry
    server     *httptest.Server
    db         *sql.DB
    ctx        context.Context
    cancel     context.CancelFunc
    cleanup    []func()
    mu         sync.Mutex
}

// New creates a new test suite
func New(t *testing.T) *Suite {
    t.Helper()
    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)

    s := &Suite{
        t:          t,
        assertions: NewAssertions(t),
        fixtures:   NewFixtureManager(),
        mocks:      NewMockRegistry(),
        ctx:        ctx,
        cancel:     cancel,
        cleanup:    make([]func(), 0),
    }

    t.Cleanup(func() {
        cancel()
        s.runCleanup()
    })

    return s
}

// Context returns the test context
func (s *Suite) Context() context.Context {
    return s.ctx
}

// Assert returns the assertions helper
func (s *Suite) Assert() *Assertions {
    return s.assertions
}

// OnCleanup registers a cleanup function
func (s *Suite) OnCleanup(fn func()) {
    s.mu.Lock()
    defer s.mu.Unlock()
    s.cleanup = append(s.cleanup, fn)
}

func (s *Suite) runCleanup() {
    s.mu.Lock()
    defer s.mu.Unlock()

    // Run in reverse order (LIFO)
    for i := len(s.cleanup) - 1; i >= 0; i-- {
        s.cleanup[i]()
    }
}

// ============================================================================
// ASSERTIONS
// ============================================================================

// Assertions provides fluent assertion methods
type Assertions struct {
    t *testing.T
}

// NewAssertions creates a new assertions helper
func NewAssertions(t *testing.T) *Assertions {
    return &Assertions{t: t}
}

// Equal asserts two values are equal.
//
// This uses reflect.DeepEqual for zero dependencies. For anything larger
// than a small struct, prefer go-cmp: see "Equality: go-cmp vs
// reflect.DeepEqual" below for why the failure output matters so much.
func (a *Assertions) Equal(expected, actual any) {
    a.t.Helper()
    if !reflect.DeepEqual(expected, actual) {
        a.t.Errorf("\nExpected: %+v\nActual:   %+v", expected, actual)
    }
}

// NotEqual asserts two values are not equal
func (a *Assertions) NotEqual(expected, actual any) {
    a.t.Helper()
    if reflect.DeepEqual(expected, actual) {
        a.t.Errorf("Expected values to be different, but both are: %+v", actual)
    }
}

// Nil asserts a value is nil
func (a *Assertions) Nil(value any) {
    a.t.Helper()
    if !isNil(value) {
        a.t.Errorf("Expected nil, got: %+v", value)
    }
}

// NotNil asserts a value is not nil
func (a *Assertions) NotNil(value any) {
    a.t.Helper()
    if isNil(value) {
        a.t.Error("Expected non-nil value, got nil")
    }
}

// NoError asserts an error is nil
func (a *Assertions) NoError(err error) {
    a.t.Helper()
    if err != nil {
        a.t.Errorf("Expected no error, got: %v", err)
    }
}

// Error asserts an error is not nil
func (a *Assertions) Error(err error) {
    a.t.Helper()
    if err == nil {
        a.t.Error("Expected error, got nil")
    }
}

// ErrorIs asserts an error matches a target
func (a *Assertions) ErrorIs(err, target error) {
    a.t.Helper()
    if !errors.Is(err, target) {
        a.t.Errorf("Expected error %v, got %v", target, err)
    }
}

// ErrorContains asserts error message contains substring
func (a *Assertions) ErrorContains(err error, substring string) {
    a.t.Helper()
    if err == nil {
        a.t.Error("Expected error, got nil")
        return
    }
    if !strings.Contains(err.Error(), substring) {
        a.t.Errorf("Expected error containing %q, got %q", substring, err.Error())
    }
}

// True asserts a condition is true
func (a *Assertions) True(condition bool, msgAndArgs ...any) {
    a.t.Helper()
    if !condition {
        msg := "Expected true, got false"
        if len(msgAndArgs) > 0 {
            msg = fmt.Sprintf(msgAndArgs[0].(string), msgAndArgs[1:]...)
        }
        a.t.Error(msg)
    }
}

// False asserts a condition is false
func (a *Assertions) False(condition bool, msgAndArgs ...any) {
    a.t.Helper()
    if condition {
        msg := "Expected false, got true"
        if len(msgAndArgs) > 0 {
            msg = fmt.Sprintf(msgAndArgs[0].(string), msgAndArgs[1:]...)
        }
        a.t.Error(msg)
    }
}

// Contains asserts a collection contains an element
func (a *Assertions) Contains(collection any, element any) {
    a.t.Helper()
    v := reflect.ValueOf(collection)
    switch v.Kind() {
    case reflect.Slice, reflect.Array:
        for i := 0; i < v.Len(); i++ {
            if reflect.DeepEqual(v.Index(i).Interface(), element) {
                return
            }
        }
    case reflect.Map:
        for _, key := range v.MapKeys() {
            if reflect.DeepEqual(key.Interface(), element) {
                return
            }
        }
    case reflect.String:
        if strings.Contains(v.String(), element.(string)) {
            return
        }
    }
    a.t.Errorf("Expected %+v to contain %+v", collection, element)
}

// Len asserts a collection has a specific length
func (a *Assertions) Len(collection any, length int) {
    a.t.Helper()
    v := reflect.ValueOf(collection)
    if v.Len() != length {
        a.t.Errorf("Expected length %d, got %d", length, v.Len())
    }
}

// Empty asserts a collection is empty
func (a *Assertions) Empty(collection any) {
    a.t.Helper()
    v := reflect.ValueOf(collection)
    if v.Len() != 0 {
        a.t.Errorf("Expected empty collection, got %d items", v.Len())
    }
}

// NotEmpty asserts a collection is not empty
func (a *Assertions) NotEmpty(collection any) {
    a.t.Helper()
    v := reflect.ValueOf(collection)
    if v.Len() == 0 {
        a.t.Error("Expected non-empty collection")
    }
}

// Panics asserts a function panics
func (a *Assertions) Panics(fn func()) {
    a.t.Helper()
    defer func() {
        if r := recover(); r == nil {
            a.t.Error("Expected panic, but function did not panic")
        }
    }()
    fn()
}

// NotPanics asserts a function does not panic
func (a *Assertions) NotPanics(fn func()) {
    a.t.Helper()
    defer func() {
        if r := recover(); r != nil {
            a.t.Errorf("Expected no panic, but got: %v", r)
        }
    }()
    fn()
}

// Eventually asserts a condition becomes true within timeout
func (a *Assertions) Eventually(condition func() bool, timeout time.Duration, tick time.Duration) {
    a.t.Helper()
    deadline := time.Now().Add(timeout)
    for time.Now().Before(deadline) {
        if condition() {
            return
        }
        time.Sleep(tick)
    }
    a.t.Error("Condition never became true")
}

// Never asserts a condition never becomes true
func (a *Assertions) Never(condition func() bool, duration time.Duration, tick time.Duration) {
    a.t.Helper()
    deadline := time.Now().Add(duration)
    for time.Now().Before(deadline) {
        if condition() {
            a.t.Error("Condition became true when it should never")
            return
        }
        time.Sleep(tick)
    }
}

// JSONEqual asserts two JSON values are equal
func (a *Assertions) JSONEqual(expected, actual string) {
    a.t.Helper()
    var expectedObj, actualObj any

    if err := json.Unmarshal([]byte(expected), &expectedObj); err != nil {
        a.t.Errorf("Failed to parse expected JSON: %v", err)
        return
    }

    if err := json.Unmarshal([]byte(actual), &actualObj); err != nil {
        a.t.Errorf("Failed to parse actual JSON: %v", err)
        return
    }

    if !reflect.DeepEqual(expectedObj, actualObj) {
        a.t.Errorf("\nExpected JSON: %s\nActual JSON:   %s", expected, actual)
    }
}

func isNil(value any) bool {
    if value == nil {
        return true
    }
    v := reflect.ValueOf(value)
    switch v.Kind() {
    case reflect.Chan, reflect.Func, reflect.Interface, reflect.Map, reflect.Ptr, reflect.Slice:
        return v.IsNil()
    }
    return false
}

// ============================================================================
// HTTP TESTING
// ============================================================================

// HTTPClient is a test HTTP client
type HTTPClient struct {
    t       *testing.T
    server  *httptest.Server
    headers map[string]string
}

// NewHTTPClient creates a test HTTP client
func (s *Suite) NewHTTPClient(handler http.Handler) *HTTPClient {
    s.t.Helper()
    server := httptest.NewServer(handler)
    s.OnCleanup(func() {
        server.Close()
    })

    return &HTTPClient{
        t:       s.t,
        server:  server,
        headers: make(map[string]string),
    }
}

// WithHeader adds a header to all requests
func (c *HTTPClient) WithHeader(key, value string) *HTTPClient {
    c.headers[key] = value
    return c
}

// WithAuth adds authorization header
func (c *HTTPClient) WithAuth(token string) *HTTPClient {
    return c.WithHeader("Authorization", "Bearer "+token)
}

// Request represents an HTTP request
type Request struct {
    client *HTTPClient
    method string
    path   string
    body   io.Reader
}

// GET creates a GET request
func (c *HTTPClient) GET(path string) *Request {
    return &Request{client: c, method: "GET", path: path}
}

// POST creates a POST request
func (c *HTTPClient) POST(path string) *Request {
    return &Request{client: c, method: "POST", path: path}
}

// PUT creates a PUT request
func (c *HTTPClient) PUT(path string) *Request {
    return &Request{client: c, method: "PUT", path: path}
}

// DELETE creates a DELETE request
func (c *HTTPClient) DELETE(path string) *Request {
    return &Request{client: c, method: "DELETE", path: path}
}

// PATCH creates a PATCH request
func (c *HTTPClient) PATCH(path string) *Request {
    return &Request{client: c, method: "PATCH", path: path}
}

// WithBody sets the request body
func (r *Request) WithBody(body any) *Request {
    data, err := json.Marshal(body)
    if err != nil {
        r.client.t.Fatalf("Failed to marshal body: %v", err)
    }
    r.body = bytes.NewReader(data)
    return r
}

// WithJSONBody sets JSON body
func (r *Request) WithJSONBody(jsonStr string) *Request {
    r.body = strings.NewReader(jsonStr)
    return r
}

// Response represents an HTTP response
type Response struct {
    t          *testing.T
    StatusCode int
    Headers    http.Header
    Body       []byte
}

// Do executes the request and returns the response
func (r *Request) Do() *Response {
    r.client.t.Helper()

    url := r.client.server.URL + r.path
    req, err := http.NewRequest(r.method, url, r.body)
    if err != nil {
        r.client.t.Fatalf("Failed to create request: %v", err)
    }

    for k, v := range r.client.headers {
        req.Header.Set(k, v)
    }
    req.Header.Set("Content-Type", "application/json")

    resp, err := http.DefaultClient.Do(req)
    if err != nil {
        r.client.t.Fatalf("Request failed: %v", err)
    }
    defer resp.Body.Close()

    body, _ := io.ReadAll(resp.Body)

    return &Response{
        t:          r.client.t,
        StatusCode: resp.StatusCode,
        Headers:    resp.Header,
        Body:       body,
    }
}

// ExpectStatus asserts the response status code
func (r *Response) ExpectStatus(code int) *Response {
    r.t.Helper()
    if r.StatusCode != code {
        r.t.Errorf("Expected status %d, got %d\nBody: %s", code, r.StatusCode, string(r.Body))
    }
    return r
}

// ExpectJSON asserts the response body equals expected JSON
func (r *Response) ExpectJSON(expected any) *Response {
    r.t.Helper()
    expectedBytes, _ := json.Marshal(expected)

    var expectedObj, actualObj any
    json.Unmarshal(expectedBytes, &expectedObj)
    json.Unmarshal(r.Body, &actualObj)

    if !reflect.DeepEqual(expectedObj, actualObj) {
        r.t.Errorf("\nExpected: %s\nActual:   %s", expectedBytes, r.Body)
    }
    return r
}

// ExpectHeader asserts a header value
func (r *Response) ExpectHeader(key, value string) *Response {
    r.t.Helper()
    actual := r.Headers.Get(key)
    if actual != value {
        r.t.Errorf("Expected header %s=%s, got %s", key, value, actual)
    }
    return r
}

// Decode decodes the response body into a value
func (r *Response) Decode(v any) *Response {
    r.t.Helper()
    if err := json.Unmarshal(r.Body, v); err != nil {
        r.t.Fatalf("Failed to decode response: %v", err)
    }
    return r
}

// ============================================================================
// FIXTURE MANAGEMENT
// ============================================================================

// FixtureManager manages test fixtures
type FixtureManager struct {
    basePath string
    cache    map[string][]byte
    mu       sync.RWMutex
}

// NewFixtureManager creates a new fixture manager
func NewFixtureManager() *FixtureManager {
    return &FixtureManager{
        basePath: "testdata",
        cache:    make(map[string][]byte),
    }
}

// Load loads a fixture file
func (f *FixtureManager) Load(name string) []byte {
    f.mu.RLock()
    if data, ok := f.cache[name]; ok {
        f.mu.RUnlock()
        return data
    }
    f.mu.RUnlock()

    path := filepath.Join(f.basePath, name)
    data, err := os.ReadFile(path)
    if err != nil {
        panic(fmt.Sprintf("Failed to load fixture %s: %v", name, err))
    }

    f.mu.Lock()
    f.cache[name] = data
    f.mu.Unlock()

    return data
}

// LoadJSON loads and parses a JSON fixture
func (f *FixtureManager) LoadJSON(name string, v any) {
    data := f.Load(name)
    if err := json.Unmarshal(data, v); err != nil {
        panic(fmt.Sprintf("Failed to parse JSON fixture %s: %v", name, err))
    }
}

// Golden compares output to a golden file
func (f *FixtureManager) Golden(t *testing.T, name string, actual []byte) {
    t.Helper()

    goldenPath := filepath.Join(f.basePath, "golden", name)

    // Update golden file if flag is set
    if os.Getenv("UPDATE_GOLDEN") == "true" {
        os.MkdirAll(filepath.Dir(goldenPath), 0755)
        os.WriteFile(goldenPath, actual, 0644)
        return
    }

    expected, err := os.ReadFile(goldenPath)
    if err != nil {
        t.Fatalf("Failed to read golden file %s: %v\nRun with UPDATE_GOLDEN=true to create", goldenPath, err)
    }

    if !bytes.Equal(expected, actual) {
        t.Errorf("Golden file mismatch:\nExpected:\n%s\nActual:\n%s", expected, actual)
    }
}

// ============================================================================
// MOCK REGISTRY
// ============================================================================

// MockRegistry manages mock objects
type MockRegistry struct {
    mocks map[string]any
    mu    sync.RWMutex
}

// NewMockRegistry creates a new mock registry
func NewMockRegistry() *MockRegistry {
    return &MockRegistry{
        mocks: make(map[string]any),
    }
}

// Register registers a mock
func (r *MockRegistry) Register(name string, mock any) {
    r.mu.Lock()
    defer r.mu.Unlock()
    r.mocks[name] = mock
}

// Get retrieves a mock
func (r *MockRegistry) Get(name string) any {
    r.mu.RLock()
    defer r.mu.RUnlock()
    return r.mocks[name]
}

// ============================================================================
// DATABASE TESTING
// ============================================================================

// TestDB wraps a database connection for testing
type TestDB struct {
    t  *testing.T
    DB *sql.DB
}

// SetupTestDB creates a test database
func (s *Suite) SetupTestDB(driver, dsn string) *TestDB {
    s.t.Helper()

    db, err := sql.Open(driver, dsn)
    if err != nil {
        s.t.Fatalf("Failed to open database: %v", err)
    }

    s.OnCleanup(func() {
        db.Close()
    })

    return &TestDB{t: s.t, DB: db}
}

// Exec executes SQL
func (d *TestDB) Exec(query string, args ...any) {
    d.t.Helper()
    _, err := d.DB.Exec(query, args...)
    if err != nil {
        d.t.Fatalf("Exec failed: %v\nQuery: %s", err, query)
    }
}

// QueryRow queries a single row
func (d *TestDB) QueryRow(query string, args ...any) *sql.Row {
    return d.DB.QueryRow(query, args...)
}

// Seed seeds the database with test data
func (d *TestDB) Seed(filename string) {
    d.t.Helper()
    data, err := os.ReadFile(filepath.Join("testdata", filename))
    if err != nil {
        d.t.Fatalf("Failed to read seed file: %v", err)
    }

    statements := strings.Split(string(data), ";")
    for _, stmt := range statements {
        stmt = strings.TrimSpace(stmt)
        if stmt == "" {
            continue
        }
        d.Exec(stmt)
    }
}

// Truncate truncates tables
func (d *TestDB) Truncate(tables ...string) {
    d.t.Helper()
    for _, table := range tables {
        d.Exec("DELETE FROM " + table)
    }
}
```

### Equality: go-cmp vs `reflect.DeepEqual`

The framework above uses `reflect.DeepEqual` to stay dependency-free, which is a defensible choice for a shared library. For everyday test assertions, `github.com/google/go-cmp` is the better tool, and the reason is not correctness but **diagnosis**.

`DeepEqual` returns a single `bool`. When a 12-field struct fails to match, the assertion can only dump both values and leave you to diff them by eye:

```
equal? false
Expected: {ID:1 Name:Alice Email:a@x.com Tags:[a b] Addr:{City:Berlin Zip:10115} private:}
Actual:   {ID:1 Name:Alice Email:a@x.com Tags:[a c] Addr:{City:Berlin Zip:10999} private:}
```

`cmp.Diff` returns the difference itself:

```
  gc.User{
        ID:    1,
        Name:  "Alice",
        Email: "a@x.com",
        Tags: []string{
                "a",
-               "b",
+               "c",
        },
        Addr: gc.Address{
                City: "Berlin",
-               Zip:  "10115",
+               Zip:  "10999",
        },
  }
```

Two fields differ, and you know which ones without reading a single character of the matching fields. Scale that to a nested API response and the difference between the two outputs is minutes per failure.

The idiomatic form puts `want` first so the `-`/`+` signs read correctly:

```go
if diff := cmp.Diff(want, got); diff != "" {
    t.Errorf("mismatch (-want +got):\n%s", diff)
}
```

**Know the three places they genuinely differ in behavior, not just output.**

*Unexported fields.* `DeepEqual` compares them silently. `go-cmp` refuses, by design, and panics:

```
cannot handle unexported field at {gc.User}.private
```

This is deliberate: reaching into another package's private state makes a test depend on implementation details. Opt in explicitly with `cmp.AllowUnexported(User{})` when the type is yours, or better, compare through an exported view.

*Semantic equality.* `DeepEqual` is strictly structural, so `[]string{"b","a"}` and `[]string{"a","b"}` are unequal even when order is irrelevant to your code. `go-cmp` takes options:

```go
cmp.Diff(a, b, cmpopts.SortSlices(func(x, y string) bool { return x < y })) // "" -> equal
```

`cmpopts` also covers the cases that bite constantly: `EquateApprox` for floats, `EquateEmpty` for the `nil` slice versus empty slice distinction, and `IgnoreFields` for timestamps and generated IDs.

*Typed nil.* Both share the trap covered in 18.3, and it is worth repeating because it is the one that silently passes:

```
reflect.DeepEqual(p, nil) = false   <-- p is a nil *User
p == nil                  = true
```

Never compare against a bare `nil` with either tool. Use `isNil` from this framework, or `errors.Is` for errors.

The trade is one dependency. `go-cmp` is maintained by the Go team, is test-only, and does not ship in your binary. For a codebase of any size, take it.

### Using the Test Framework

With the `testkit` package in place, you can now write expressive, fluent tests that wire up real services, in-memory databases, and mock HTTP handlers with minimal boilerplate. The suite's built-in cleanup registration ensures every resource is released in the correct reverse order once the test finishes, even when subtests fail.

```go
// user_service_test.go
package service

import (
    "testing"
    "myapp/testkit"
)

func TestUserService(t *testing.T) {
    suite := testkit.New(t)

    t.Run("CreateUser", func(t *testing.T) {
        db := suite.SetupTestDB("sqlite3", ":memory:")
        db.Exec(`CREATE TABLE users (
            id INTEGER PRIMARY KEY,
            email TEXT UNIQUE,
            name TEXT
        )`)

        service := NewUserService(db.DB)

        user, err := service.Create(&User{
            Email: "alice@example.com",
            Name:  "Alice",
        })

        suite.Assert().NoError(err)
        suite.Assert().NotNil(user)
        suite.Assert().Equal("alice@example.com", user.Email)
    })

    t.Run("CreateUser_DuplicateEmail", func(t *testing.T) {
        db := suite.SetupTestDB("sqlite3", ":memory:")
        db.Exec(`CREATE TABLE users (
            id INTEGER PRIMARY KEY,
            email TEXT UNIQUE,
            name TEXT
        )`)
        db.Exec(`INSERT INTO users (email, name) VALUES ('alice@example.com', 'Alice')`)

        service := NewUserService(db.DB)

        _, err := service.Create(&User{
            Email: "alice@example.com",
            Name:  "Alice Clone",
        })

        suite.Assert().Error(err)
        suite.Assert().ErrorContains(err, "duplicate")
    })
}

func TestUserAPI(t *testing.T) {
    suite := testkit.New(t)

    // Setup mock service
    mockService := &MockUserService{
        CreateFunc: func(u *User) (*User, error) {
            u.ID = 1
            return u, nil
        },
    }

    handler := NewUserHandler(mockService)
    client := suite.NewHTTPClient(handler)

    t.Run("POST /users creates user", func(t *testing.T) {
        client.POST("/users").
            WithBody(map[string]string{
                "email": "bob@example.com",
                "name":  "Bob",
            }).
            Do().
            ExpectStatus(201).
            ExpectJSON(map[string]any{
                "id":    float64(1),
                "email": "bob@example.com",
                "name":  "Bob",
            })
    })

    t.Run("POST /users with invalid email returns 400", func(t *testing.T) {
        client.POST("/users").
            WithBody(map[string]string{
                "email": "invalid",
                "name":  "Bob",
            }).
            Do().
            ExpectStatus(400)
    })
}
```

### Complete Test Configuration

Every Go package that needs global setup, such as registering feature flags, enabling goroutine-leak detection, or controlling golden-file updates, should implement a `TestMain` function. The configuration below wires `goleak` into the test runner so any goroutine left running after the suite finishes causes an immediate failure, catching concurrency bugs that would otherwise be silent.

```go
// testkit/testmain.go
package testkit

import (
    "flag"
    "os"
    "testing"

    "go.uber.org/goleak"
)

var (
    updateGolden = flag.Bool("update-golden", false, "Update golden files")
    integration  = flag.Bool("integration", false, "Run integration tests")
)

// TestMain is a reusable test main
func TestMain(m *testing.M) {
    flag.Parse()

    if *updateGolden {
        os.Setenv("UPDATE_GOLDEN", "true")
    }

    // Check for goroutine leaks
    goleak.VerifyTestMain(m,
        goleak.IgnoreTopFunction("go.opencensus.io/stats/view.(*worker).start"),
        goleak.IgnoreTopFunction("database/sql.(*DB).connectionOpener"),
    )
}
```

### Makefile Integration

Centralising test commands in a `Makefile` prevents developers from forgetting critical flags like `-race` or `-covermode=atomic` and makes CI pipelines trivial to configure. Each target below maps to a distinct concern, unit correctness, data-race detection, coverage reporting, and fuzz testing, so engineers can run exactly the level of verification their workflow requires.

```makefile
# Makefile

.PHONY: test test-unit test-integration test-race test-coverage

# Run all unit tests
test-unit:
	go test -v -short ./...

# Run integration tests
test-integration:
	go test -v -tags=integration ./...

# Run tests with race detector
test-race:
	go test -v -race ./...

# Run tests with coverage
test-coverage:
	go test -coverprofile=coverage.out -covermode=atomic ./...
	go tool cover -func=coverage.out
	go tool cover -html=coverage.out -o coverage.html

# Run all tests
test: test-unit test-race

# Update golden files
test-golden:
	go test -v -update-golden ./...

# Benchmark tests
bench:
	go test -bench=. -benchmem ./...

# Fuzz tests (run for 30 seconds - -fuzz must match exactly one target,
# so pass it explicitly: make fuzz TARGET=FuzzParseJSON)
fuzz:
	go test -fuzz=$(TARGET) -fuzztime=30s ./...

# Generate test mocks
generate-mocks:
	go generate ./...

# Clean test artifacts
clean-test:
	rm -f coverage.out coverage.html
	rm -rf testdata/golden/*.new
```

### Staff Lens: Test Framework as Shared Asset

The framework above is heavy. Most teams do not need this much infrastructure. Before building it, ask: what do we actually gain from each piece?

- Golden files: yes, for complex output verification.
- Test helpers: yes, for consistency.
- Custom mock generators: only if the interface is genuinely large.
- Property-based testing wrappers: only if the team has the expertise to use them.

Start with the minimal framework (helpers + table-driven tests + `goleak`). Grow as needed. A team that over-builds test infrastructure early often builds tools no one actually uses.

### Principal Lens: Test Infrastructure Must Pay Back

Every piece of test infrastructure costs maintenance time. The payback is faster tests, more coverage, fewer bugs. Measure the payback. If a test utility is never used, retire it. If a common pattern is reimplemented in every test, abstract it. Treat test infrastructure as a product with users (the engineers) and a budget (their time).

---
