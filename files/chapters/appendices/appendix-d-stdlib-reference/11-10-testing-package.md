## 10. Testing Package

### Basic Tests

Test functions must start with `Test`, take a `*testing.T` parameter, and live in `_test.go` files. Use `t.Error` or `t.Fatal` to report failures. `t.Fatal` stops the current test immediately. `t.Error` continues running.

```go
package main

import (
    "testing"
)

// Function to test
func Add(a, b int) int {
    return a + b
}

// Test function
func TestAdd(t *testing.T) {
    result := Add(2, 3)
    expected := 5

    if result != expected {
        t.Errorf("Add(2, 3) = %d; want %d", result, expected)
    }
}

// Table-driven tests
func TestAddTable(t *testing.T) {
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

// Helper functions
func TestWithHelper(t *testing.T) {
    assertEqual := func(t *testing.T, got, want int) {
        t.Helper() // Marks this as helper for better error reporting
        if got != want {
            t.Errorf("got %d, want %d", got, want)
        }
    }

    assertEqual(t, Add(2, 3), 5)
    assertEqual(t, Add(10, 5), 15)
}

// Subtests
func TestSubtests(t *testing.T) {
    t.Run("positive numbers", func(t *testing.T) {
        if Add(1, 2) != 3 {
            t.Error("failed")
        }
    })

    t.Run("negative numbers", func(t *testing.T) {
        if Add(-1, -2) != -3 {
            t.Error("failed")
        }
    })
}
```

### Test Assertions (t methods)

```go
package main

import (
    "testing"
)

func TestAssertions(t *testing.T) {
    // t.Error - mark test failed, continue
    if false {
        t.Error("This test failed")
    }

    // t.Errorf - formatted error
    if false {
        t.Errorf("Expected %d, got %d", 5, 3)
    }

    // t.Fatal - mark failed and stop immediately
    if false {
        t.Fatal("Critical failure, stopping test")
    }

    // t.Fatalf - formatted fatal
    if false {
        t.Fatalf("Expected %d, got %d", 5, 3)
    }

    // t.Skip - skip test
    if testing.Short() {
        t.Skip("Skipping in short mode")
    }

    // t.Skipf - formatted skip
    t.Skipf("Skipping because %s", "reason")

    // t.Log - log message (only shown if test fails or -v flag)
    t.Log("This is a log message")

    // t.Logf - formatted log
    t.Logf("Value: %d", 42)

    // t.Failed - check if test has failed
    if t.Failed() {
        t.Log("Test has failed")
    }

    // t.Parallel - run test in parallel
    t.Parallel()
}
```

### Benchmarks

```go
package main

import (
    "testing"
)

func BenchmarkAdd(b *testing.B) {
    for b.Loop() {
        Add(2, 3)
    }
}

// Benchmark with setup
func BenchmarkWithSetup(b *testing.B) {
    // Setup (not timed)
    data := make([]int, 1000)
    for i := range data {
        data[i] = i
    }

    b.ResetTimer() // Reset timer after setup

    for b.Loop() {
        // Benchmark this
        sum := 0
        for _, v := range data {
            sum += v
        }
    }
}

// Sub-benchmarks
func BenchmarkOperations(b *testing.B) {
    b.Run("Add", func(b *testing.B) {
        for b.Loop() {
            Add(2, 3)
        }
    })

    b.Run("Multiply", func(b *testing.B) {
        for b.Loop() {
            _ = 2 * 3
        }
    })
}

// Report allocations
func BenchmarkWithAllocs(b *testing.B) {
    b.ReportAllocs() // Include allocation stats

    for b.Loop() {
        s := make([]int, 100)
        _ = s
    }
}

// Custom metrics
func BenchmarkCustomMetrics(b *testing.B) {
    b.SetBytes(1024) // Set bytes processed per operation

    for b.Loop() {
        // Process 1024 bytes
    }
}

// Run benchmarks:
// go test -bench=. -benchmem
// go test -bench=Add -benchtime=10s
// go test -bench=. -cpuprofile=cpu.prof
```

### Fuzz Tests (Go 1.18+)

```go
package main

import (
    "testing"
    "unicode/utf8"
)

func Reverse(s string) string {
    r := []rune(s)
    for i, j := 0, len(r)-1; i < j; i, j = i+1, j-1 {
        r[i], r[j] = r[j], r[i]
    }
    return string(r)
}

func FuzzReverse(f *testing.F) {
    // Seed corpus
    testcases := []string{"Hello", "世界", " ", "!12345"}
    for _, tc := range testcases {
        f.Add(tc)
    }

    f.Fuzz(func(t *testing.T, orig string) {
        rev := Reverse(orig)
        doubleRev := Reverse(rev)

        // Property: reversing twice gives original
        if orig != doubleRev {
            t.Errorf("Reverse(%q) != %q", orig, doubleRev)
        }

        // Property: length preserved
        if utf8.RuneCountInString(orig) != utf8.RuneCountInString(rev) {
            t.Errorf("Length mismatch")
        }
    })
}

// Run fuzz tests:
// go test -fuzz=FuzzReverse -fuzztime=30s
```

### Example Tests

```go
package main

import (
    "fmt"
)

// Example function - appears in documentation
func ExampleAdd() {
    result := Add(2, 3)
    fmt.Println(result)
    // Output: 5
}

// Example with unordered output
func ExampleMultiple() {
    fmt.Println("B")
    fmt.Println("A")
    // Unordered output:
    // A
    // B
}

// Example for specific function
func ExampleReverse() {
    s := "Hello"
    fmt.Println(Reverse(s))
    // Output: olleH
}
```

### Test Fixtures and Cleanup

```go
package main

import (
    "os"
    "testing"
)

func TestMain(m *testing.M) {
    // Setup
    println("Global setup")

    // Run tests
    code := m.Run()

    // Teardown
    println("Global teardown")

    os.Exit(code)
}

func TestWithCleanup(t *testing.T) {
    // Setup
    tmpFile, err := os.CreateTemp("", "test")
    if err != nil {
        t.Fatal(err)
    }

    // Cleanup (deferred, LIFO order)
    t.Cleanup(func() {
        tmpFile.Close()
        os.Remove(tmpFile.Name())
    })

    // Test code
    t.Logf("Using temp file: %s", tmpFile.Name())
}
```

---
