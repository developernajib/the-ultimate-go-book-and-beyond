## Go 1.20 (February 2023)

### Profile-Guided Optimization (PGO)

Use production profiles to optimize builds.

```bash
# 1. Collect CPU profile from production
go build -o myapp
./myapp # This generates cpu.pprof during runtime

# 2. Place profile in main package directory as default.pgo
mv cpu.pprof default.pgo

# 3. Build with PGO (automatic if default.pgo exists)
go build -o myapp-optimized

# Or specify profile explicitly
go build -pgo=cpu.pprof -o myapp-optimized

# Typical improvements: 2-7% CPU performance gain
```

### errors.Join

Combine multiple errors into one.

```go
import "errors"

func ProcessFiles(files []string) error {
    var errs []error

    for _, file := range files {
        if err := processFile(file); err != nil {
            errs = append(errs, fmt.Errorf("processing %s: %w", file, err))
        }
    }

    if len(errs) > 0 {
        return errors.Join(errs...)
    }
    return nil
}

// Unwrapping joined errors
err := ProcessFiles([]string{"a.txt", "b.txt"})
if err != nil {
    // errors.Is works with any error in the tree
    if errors.Is(err, fs.ErrNotExist) {
        fmt.Println("Some files not found")
    }

    // Get all errors
    for _, e := range err.(interface{ Unwrap() []error }).Unwrap() {
        fmt.Println(e)
    }
}
```

### Slice to Array Conversion

Convert slices to arrays safely.

```go
// Compile-time known size
s := []byte("hello")
arr := [5]byte(s) // OK: len(s) == 5
fmt.Println(arr)  // [104 101 108 108 111]

// Runtime check
func toArray(s []byte) [5]byte {
    return [5]byte(s) // Panics if len(s) != 5
}

// Useful for crypto and encoding
var key [32]byte = sha256.Sum256(data)     // Before
var key [32]byte = [32]byte(slice[:32])    // Now (with runtime check)
```

### Comparable Type Parameter

More precise generic constraints.

```go
// Before: any types allowed, == fails at compile time
func Index[T any](s []T, e T) int {
    for i, v := range s {
        if v == e { // Compile error if T not comparable
            return i
        }
    }
    return -1
}

// After: explicit comparable constraint
func Index[T comparable](s []T, e T) int {
    for i, v := range s {
        if v == e { // OK: T is comparable
            return i
        }
    }
    return -1
}
```

---
