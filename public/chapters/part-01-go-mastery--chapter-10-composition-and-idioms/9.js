export default `## 10.8 Testing Idioms

Go's testing package is deliberately minimal, but idiomatic patterns have emerged that make tests readable, maintainable, and easy to extend.

### Table-Driven Tests

Table-driven tests define inputs and expected outputs as a slice of structs, then loop over them with \`t.Run\`. Adding a new test case is a single struct literal, no new function, no duplicated assertion logic. This is the dominant testing pattern in Go:

\`\`\`go
func TestParseURL(t *testing.T) {
    tests := []struct {
        name    string
        input   string
        want    *URL
        wantErr bool
    }{
        {
            name:  "simple URL",
            input: "https://example.com",
            want:  &URL{Scheme: "https", Host: "example.com"},
        },
        {
            name:  "with path",
            input: "https://example.com/path/to/resource",
            want:  &URL{Scheme: "https", Host: "example.com", Path: "/path/to/resource"},
        },
        {
            name:  "with query",
            input: "https://example.com?foo=bar",
            want:  &URL{Scheme: "https", Host: "example.com", Query: "foo=bar"},
        },
        {
            name:    "empty string",
            input:   "",
            wantErr: true,
        },
        {
            name:    "invalid URL",
            input:   "://invalid",
            wantErr: true,
        },
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            got, err := ParseURL(tt.input)

            if (err != nil) != tt.wantErr {
                t.Errorf("ParseURL(%q) error = %v, wantErr %v", tt.input, err, tt.wantErr)
                return
            }

            if !tt.wantErr && !reflect.DeepEqual(got, tt.want) {
                t.Errorf("ParseURL(%q) = %+v, want %+v", tt.input, got, tt.want)
            }
        })
    }
}
\`\`\`

### Test Helpers

Test helpers extract repeated setup or assertion logic into functions. Calling \`t.Helper()\` ensures failure messages point to the test function, not the helper, producing clearer test output.

\`\`\`go
// assertEqual compares values and reports differences
func assertEqual[T comparable](t *testing.T, got, want T) {
    t.Helper()
    if got != want {
        t.Errorf("got %v, want %v", got, want)
    }
}

// assertDeepEqual compares complex structures
func assertDeepEqual[T any](t *testing.T, got, want T) {
    t.Helper()
    if !reflect.DeepEqual(got, want) {
        t.Errorf("got %+v, want %+v", got, want)
    }
}

// assertNoError fails if error is not nil
func assertNoError(t *testing.T, err error) {
    t.Helper()
    if err != nil {
        t.Fatalf("unexpected error: %v", err)
    }
}

// assertError fails if error is nil
func assertError(t *testing.T, err error) {
    t.Helper()
    if err == nil {
        t.Fatal("expected error, got nil")
    }
}

// assertErrorIs fails if err doesn't match target
func assertErrorIs(t *testing.T, err, target error) {
    t.Helper()
    if !errors.Is(err, target) {
        t.Errorf("got error %v, want %v", err, target)
    }
}

// assertPanics fails if fn doesn't panic
func assertPanics(t *testing.T, fn func()) {
    t.Helper()
    defer func() {
        if r := recover(); r == nil {
            t.Error("expected panic")
        }
    }()
    fn()
}
\`\`\`

### Test Fixtures with Cleanup

\`t.Cleanup\` registers a function to run when the test completes, regardless of success or failure. This is the modern replacement for \`defer\` in tests, properly handling subtests and parallel execution.

\`\`\`go
func setupTestDB(t *testing.T) *sql.DB {
    t.Helper()

    db, err := sql.Open("postgres", "postgres://localhost/test?sslmode=disable")
    if err != nil {
        t.Fatalf("open db: %v", err)
    }

    // Cleanup runs after test completes
    t.Cleanup(func() {
        db.Close()
    })

    // Run migrations
    if _, err := db.Exec(schema); err != nil {
        t.Fatalf("migrate: %v", err)
    }

    return db
}

func setupTestServer(t *testing.T, handler http.Handler) *httptest.Server {
    t.Helper()

    server := httptest.NewServer(handler)
    t.Cleanup(server.Close)

    return server
}

func TestUserRepository(t *testing.T) {
    db := setupTestDB(t)
    repo := NewUserRepository(db)

    // Test code - db automatically closes when test ends
}
\`\`\`

### Mocking with Interfaces

Interfaces defined for testability allow injecting mock implementations that record calls, return preset values, and verify interaction patterns. This is the foundation of unit testing without external mock frameworks.

\`\`\`go
// Define interface for dependency
type EmailSender interface {
    Send(ctx context.Context, to, subject, body string) error
}

// Real implementation
type SMTPSender struct {
    host string
    port int
}

func (s *SMTPSender) Send(ctx context.Context, to, subject, body string) error {
    // Real email sending logic
    return nil
}

// Mock for testing
type MockEmailSender struct {
    mu    sync.Mutex
    Calls []EmailCall
    Err   error
}

type EmailCall struct {
    To, Subject, Body string
}

func (m *MockEmailSender) Send(ctx context.Context, to, subject, body string) error {
    m.mu.Lock()
    defer m.mu.Unlock()
    m.Calls = append(m.Calls, EmailCall{to, subject, body})
    return m.Err
}

func TestNotificationService(t *testing.T) {
    mock := &MockEmailSender{}
    service := NewNotificationService(mock)

    err := service.NotifyUser(context.Background(), "user@example.com", "Welcome!")
    assertNoError(t, err)

    if len(mock.Calls) != 1 {
        t.Fatalf("expected 1 email, got %d", len(mock.Calls))
    }

    assertEqual(t, mock.Calls[0].To, "user@example.com")
    if !strings.Contains(mock.Calls[0].Body, "Welcome") {
        t.Error("email body should contain 'Welcome'")
    }
}

func TestNotificationService_EmailError(t *testing.T) {
    mock := &MockEmailSender{Err: errors.New("SMTP error")}
    service := NewNotificationService(mock)

    err := service.NotifyUser(context.Background(), "user@example.com", "Welcome!")
    assertError(t, err)
}
\`\`\`

### Parallel Tests

\`t.Parallel()\` allows tests to run concurrently with other parallel tests, reducing total suite execution time. Tests that run in parallel must not share mutable global state.

\`\`\`go
func TestUserService(t *testing.T) {
    tests := []struct {
        name string
        // ...
    }{
        {"test1", /* ... */},
        {"test2", /* ... */},
    }

    for _, tt := range tests {
        tt := tt // Capture range variable
        t.Run(tt.name, func(t *testing.T) {
            t.Parallel() // Run tests in parallel
            // Test code
        })
    }
}
\`\`\`

### Test Discipline

For a senior engineer reviewing test PRs:

1. **Table-driven tests are the default for multi-case logic.** Scatter of individual test functions is usually refactorable to a table.
2. **\`t.Parallel()\` speeds CI but requires race-safe test code.** Audit before enabling.
3. **Go 1.22+ loop-variable fix.** The \`tt := tt\` capture is no longer necessary. Drop in new code.

### Golden Files

For tests that assert on large outputs (generated SQL, rendered HTML, serialised JSON, compiler output), golden files are the idiomatic Go pattern. The test reads an expected output from a file in \`testdata/\`, compares against it, and with a \`-update\` flag regenerates the golden when intentional changes land.

\`\`\`go
var update = flag.Bool("update", false, "update golden files")

func TestRender(t *testing.T) {
    got := Render(input)
    path := filepath.Join("testdata", "render.golden")
    if *update {
        os.WriteFile(path, got, 0644)
    }
    want, _ := os.ReadFile(path)
    if !bytes.Equal(got, want) {
        t.Errorf("output mismatch:\\n%s", diff(want, got))
    }
}
\`\`\`

The discipline: review the golden file diff as carefully as the code diff. A golden-file change that "just works" can be a regression no one noticed.

### \`testing/synctest\` (Go 1.25+)

Go 1.25 added \`testing/synctest\` for testing time-dependent code deterministically. Instead of mocking \`time.Now\` with a hand-rolled clock interface, wrap the test in a bubble and advance time explicitly.

\`\`\`go
func TestCacheExpiry(t *testing.T) {
    synctest.Test(t, func(t *testing.T) {
        c := NewCache(time.Minute)
        c.Set("k", "v")
        time.Sleep(30 * time.Second) // does not actually sleep
        if _, ok := c.Get("k"); !ok { t.Fatal("expired too early") }
        time.Sleep(31 * time.Second)
        if _, ok := c.Get("k"); ok { t.Fatal("did not expire") }
    })
}
\`\`\`

This replaces several patterns (custom clock interfaces, explicit time injection, flaky \`time.After\` tests) with a single stdlib mechanism. For new code, prefer it over hand-rolled time abstractions when \`synctest\` fits.

### Fuzzing (Go 1.18+)

Fuzz targets are first-class tests in modern Go. For any function that parses untrusted input (parser, deserialiser, validator), add a fuzz target. The cost is one \`go test -fuzz\` run in CI. The benefit is discovering edge cases the test author did not think of.

\`\`\`go
func FuzzParseInput(f *testing.F) {
    f.Add("valid input")
    f.Fuzz(func(t *testing.T, s string) {
        _, err := ParseInput(s) // should not panic
        _ = err
    })
}
\`\`\`

The staff-level rule: any function that accepts untrusted bytes gets a fuzz target. Not as a nice-to-have. As a requirement that blocks merge.

### Staff Lens: The Test Suite as Documentation

A well-written table-driven test suite is the best documentation of expected behaviour that exists in a Go codebase. Readers who want to know what a function does read the tests. The staff-level instinct: when reviewing tests, ask "would a new engineer reading these tests understand the contract of this function?" If not, the test names are wrong, the cases are incomplete, or both. Test naming is part of the test. A case named "edge case" teaches nothing. A case named "returns ErrQuotaExceeded when daily limit reached" teaches everything.

### Principal Lens: Test Time as a Budget

A large codebase accumulates tests. Eventually, the test suite takes an hour to run, CI is slow, and developers skip local runs. The principal-level intervention is to treat test wall-clock time as a budget. Set a target (ten minutes for unit tests, thirty for integration), measure against it, and refactor when the budget is exceeded. The techniques are well-known: \`t.Parallel()\`, smaller fixture databases, avoiding sleep-based synchronisation, sharding in CI. The discipline is the unusual part. Most teams let the test suite grow unbounded. Principal engineers who intervene early keep CI fast, which keeps developer velocity high, which pays for itself forever.

---
`;
