## Testing

Go has a built-in testing framework in the `testing` package, no external libraries are required. Test files must end with `_test.go` and test functions must start with `Test` followed by an uppercase letter. Table-driven tests are the idiomatic pattern in Go, where you define a slice of test cases and loop over them with `t.Run` for clear subtests. The `httptest` package makes it easy to test HTTP handlers and servers without starting a real network listener.

```go
import "testing"

// Basic test
func TestAdd(t *testing.T) {
    result := Add(2, 3)
    expected := 5

    if result != expected {
        t.Errorf("Add(2, 3) = %d; want %d", result, expected)
    }
}

// Table-driven tests
func TestAdd(t *testing.T) {
    tests := []struct {
        name     string
        a, b     int
        expected int
    }{
        {"positive", 2, 3, 5},
        {"negative", -2, -3, -5},
        {"zero", 0, 0, 0},
        {"mixed", -2, 3, 1},
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            result := Add(tt.a, tt.b)
            if result != tt.expected {
                t.Errorf("Add(%d, %d) = %d; want %d",
                    tt.a, tt.b, result, tt.expected)
            }
        })
    }
}

// Subtests
func TestFoo(t *testing.T) {
    t.Run("subtest1", func(t *testing.T) {
        // Test code
    })

    t.Run("subtest2", func(t *testing.T) {
        // Test code
    })
}

// Parallel tests
func TestParallel(t *testing.T) {
    t.Parallel()  // Run in parallel with other parallel tests
    // Test code
}

// Skip test
func TestSkip(t *testing.T) {
    if testing.Short() {
        t.Skip("skipping test in short mode")
    }
    // Test code
}

// Fatal vs Error
t.Error("continues after error")
t.Fatal("stops test immediately")

t.Errorf("formatted: %v", value)
t.Fatalf("formatted: %v", value)

// Helper function
func assertEqual(t *testing.T, got, want any) {
    t.Helper()  // Reports error at call site, not here
    if got != want {
        t.Errorf("got %v; want %v", got, want)
    }
}

// Setup and teardown
func TestMain(m *testing.M) {
    // Setup
    setup()

    // Run tests
    code := m.Run()

    // Teardown
    teardown()

    os.Exit(code)
}

// Per-test setup/teardown
func TestSomething(t *testing.T) {
    // Setup
    db := setupDatabase(t)
    defer db.Close()  // Teardown

    // Test code
}

// Cleanup (Go 1.14+)
func TestCleanup(t *testing.T) {
    db := setupDatabase()
    t.Cleanup(func() {
        db.Close()
    })
    // Test code
}

// Test coverage
// go test -cover
// go test -coverprofile=coverage.out
// go tool cover -html=coverage.out

// Test with race detector
// go test -race

// Verbose output
// go test -v

// Run specific tests
// go test -run TestAdd
// go test -run TestAdd/positive

// Short mode
// go test -short

// Timeout
// go test -timeout 10s

// Testing private functions
// Use same package with _test suffix
package mypackage

// Or export for testing
// mypackage_test.go uses package mypackage_test
// Can import mypackage and test exported functions

// HTTP handler testing
func TestHandler(t *testing.T) {
    req := httptest.NewRequest("GET", "/path", nil)
    w := httptest.NewRecorder()

    handler(w, req)

    resp := w.Result()
    body, _ := io.ReadAll(resp.Body)

    if resp.StatusCode != http.StatusOK {
        t.Errorf("status = %d; want %d", resp.StatusCode, http.StatusOK)
    }

    expected := "expected response"
    if string(body) != expected {
        t.Errorf("body = %s; want %s", body, expected)
    }
}

// HTTP server testing
func TestServer(t *testing.T) {
    server := httptest.NewServer(http.HandlerFunc(handler))
    defer server.Close()

    resp, err := http.Get(server.URL)
    if err != nil {
        t.Fatal(err)
    }
    defer resp.Body.Close()

    // Check response
}

// Examples (appear in documentation)
func ExampleAdd() {
    result := Add(2, 3)
    fmt.Println(result)
    // Output: 5
}

func ExampleAdd_negative() {
    result := Add(-2, -3)
    fmt.Println(result)
    // Output: -5
}

// Fuzz testing (Go 1.18+)
func FuzzAdd(f *testing.F) {
    // Seed corpus
    f.Add(2, 3)
    f.Add(-1, 1)
    f.Add(0, 0)

    f.Fuzz(func(t *testing.T, a, b int) {
        result := Add(a, b)
        // Check properties
        if result != a+b {
            t.Errorf("Add(%d, %d) = %d; want %d", a, b, result, a+b)
        }
    })
}

// Run fuzzing
// go test -fuzz=FuzzAdd
// go test -fuzz=FuzzAdd -fuzztime=10s
```

---
