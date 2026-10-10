## 4. Testing Tools

### 4.1 Test Organization

Go tests live alongside the code they test, in files ending with `_test.go`. Use table-driven tests for systematic coverage and `t.Parallel()` to run independent tests concurrently.

```go
// File: user_test.go
package user_test

import (
    "testing"
    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
)

func TestUserCreate(t *testing.T) {
    t.Parallel() // Run in parallel with other tests

    // Table-driven test
    tests := []struct {
        name    string
        input   string
        want    User
        wantErr bool
    }{
        {
            name:  "valid user",
            input: "john@example.com",
            want:  User{Email: "john@example.com"},
        },
        {
            name:    "invalid email",
            input:   "invalid",
            wantErr: true,
        },
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            t.Parallel()

            got, err := NewUser(tt.input)
            if tt.wantErr {
                require.Error(t, err)
                return
            }

            require.NoError(t, err)
            assert.Equal(t, tt.want, got)
        })
    }
}

// Benchmark
func BenchmarkUserCreate(b *testing.B) {
    b.ReportAllocs()

    for b.Loop() {
        _, _ = NewUser("test@example.com")
    }
}

// Fuzz test (Go 1.18+)
func FuzzParseEmail(f *testing.F) {
    // Seed corpus
    f.Add("test@example.com")
    f.Add("user+tag@domain.co.uk")

    f.Fuzz(func(t *testing.T, email string) {
        _, err := ParseEmail(email)
        // Should not panic
        _ = err
    })
}

// Example (appears in documentation)
func ExampleUser_String() {
    u := User{Name: "John", Email: "john@example.com"}
    fmt.Println(u.String())
    // Output: John <john@example.com>
}
```

### 4.2 Test Helpers

```go
// Test helper
func setupTestDB(t *testing.T) *sql.DB {
    t.Helper() // Mark as helper for better error reporting

    db, err := sql.Open("sqlite3", ":memory:")
    if err != nil {
        t.Fatalf("failed to open test db: %v", err)
    }

    t.Cleanup(func() {
        db.Close()
    })

    return db
}

// Subtests
func TestUserOperations(t *testing.T) {
    db := setupTestDB(t)

    t.Run("Create", func(t *testing.T) {
        // Test create
    })

    t.Run("Update", func(t *testing.T) {
        // Test update
    })

    t.Run("Delete", func(t *testing.T) {
        // Test delete
    })
}
```

### 4.3 Coverage Analysis

```bash
# Generate coverage report
go test -coverprofile=coverage.out ./...

# View coverage summary
go tool cover -func=coverage.out

# View in browser
go tool cover -html=coverage.out

# Coverage by package
go test -coverprofile=coverage.out -coverpkg=./... ./...

# Atomic coverage mode (for concurrent code)
go test -covermode=atomic -coverprofile=coverage.out ./...

# Filter coverage output
go tool cover -func=coverage.out | grep -v "100.0%"

# Convert to HTML with line-by-line view
go tool cover -html=coverage.out -o coverage.html
```

### 4.4 Test Flags Reference

```bash
# Running tests
-v                  # Verbose output
-run REGEXP         # Run tests matching regexp
-count n            # Run each test n times
-parallel n         # Run at most n tests in parallel
-timeout d          # Timeout after duration d
-short              # Run quick tests only
-failfast           # Stop on first failure

# Coverage
-cover              # Enable coverage
-covermode MODE     # set, count, atomic
-coverprofile FILE  # Write coverage to file
-coverpkg PATTERN   # Apply coverage to packages matching pattern

# Benchmarks
-bench REGEXP       # Run benchmarks matching regexp
-benchtime d        # Run for duration d or Nx iterations
-benchmem           # Print memory stats
-cpuprofile FILE    # Write CPU profile
-memprofile FILE    # Write memory profile

# Race detection
-race               # Enable race detector
-vet list           # Configure vet checks

# Fuzzing
-fuzz REGEXP        # Run fuzzing
-fuzztime d         # Fuzz for duration d
-fuzzminimizetime d # Minimize for duration d
```

---
