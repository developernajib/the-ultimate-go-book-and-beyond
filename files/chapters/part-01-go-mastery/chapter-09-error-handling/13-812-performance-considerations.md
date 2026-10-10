## 9.12 Performance Considerations

### Error Allocation

Every call to `errors.New` or `fmt.Errorf` allocates a new object on the heap. In most code this is negligible, but on hot paths handling millions of requests per second, these allocations add up and increase GC pressure. The difference between a pre-allocated sentinel and a dynamically formatted error can be two orders of magnitude in allocation overhead.

```go
// This allocates every time
func validate(x int) error {
    if x < 0 {
        return fmt.Errorf("invalid: %d", x)  // Allocates!
    }
    return nil
}

// Sentinel errors don't allocate
var ErrNegative = errors.New("value cannot be negative")

func validateFast(x int) error {
    if x < 0 {
        return ErrNegative  // No allocation
    }
    return nil
}
```

### Benchmark Comparison

The following benchmarks compare the allocation overhead of different error-creation strategies. Pre-allocated sentinel errors are cheapest. Dynamically formatted errors allocate once per call.

```go
func BenchmarkErrorAllocation(b *testing.B) {
    b.Run("fmt.Errorf", func(b *testing.B) {
        for b.Loop() {
            _ = fmt.Errorf("error: %d", 42)
        }
    })

    b.Run("errors.New", func(b *testing.B) {
        for b.Loop() {
            _ = errors.New("error")
        }
    })

    b.Run("sentinel", func(b *testing.B) {
        err := errors.New("error")
        b.ResetTimer()
        for b.Loop() {
            _ = err
        }
    })
}

// Typical shape of the results on any machine:
// fmt.Errorf allocates per call (formatting plus the error value),
// errors.New allocates once per call,
// and returning a sentinel allocates nothing, running orders of
// magnitude faster than either.
```

### Using sync.Pool for Errors

When error objects are large (carrying stack traces, detail slices, timestamps) and created frequently, a `sync.Pool` reuses them instead of allocating fresh ones each time. The caller must return the error to the pool after use, and the reset logic must clear all fields to avoid leaking data between requests.

```go
var errorPool = sync.Pool{
    New: func() any {
        return &AppError{}
    },
}

func NewPooledError(code ErrorCode, message string) *AppError {
    err := errorPool.Get().(*AppError)
    err.Code = code
    err.Message = message
    err.Details = err.Details[:0]
    err.Timestamp = time.Now()
    return err
}

func ReleaseError(err *AppError) {
    if err == nil {
        return
    }
    err.internal = nil
    err.stack = err.stack[:0]
    errorPool.Put(err)
}

// Usage
err := NewPooledError(CodeNotFound, "user not found")
// ... use error ...
defer ReleaseError(err)
```

### Avoiding Allocations in Hot Paths

In performance-critical paths, error creation can contribute to allocation pressure. Reusing error values or using error-free signaling eliminates this overhead for the common case.

```go
// Hot path: avoid allocations
type FastError struct {
    code    ErrorCode
    message string
}

func (e FastError) Error() string {
    // Don't use fmt.Sprintf in hot path
    return string(e.code) + ": " + e.message
}

// Pre-allocate common errors
var (
    errInvalidInput = FastError{CodeInvalidArgument, "invalid input"}
    errNotFound     = FastError{CodeNotFound, "not found"}
)
```

### When Error Performance Matters

For a senior engineer, error allocation is rarely the bottleneck. The exceptions: tight loops that expect many errors (validation of large inputs), hot paths that wrap every error, and services with extreme allocation budgets. For those, use preallocated sentinels and avoid `fmt.Errorf` per call. For everything else, readability wins over performance.

---
