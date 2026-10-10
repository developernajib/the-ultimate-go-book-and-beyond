## Go 1.24 (February 2025)

### Generic Type Aliases

Type aliases can now have their own type parameters.

```go
// Generic type alias
type MySlice[T any] = []T
type MyMap[K comparable, V any] = map[K]V

var s MySlice[int] = []int{1, 2, 3}
var m MyMap[string, int] = map[string]int{"a": 1}

// Useful for API compatibility
// Old API
type StringSet = map[string]bool

// New API with generics, but maintain compatibility
type Set[T comparable] map[T]bool

// Alias provides smooth migration
type StringSet = Set[string]

// Complex example: Result type
type Result[T any] = struct {
    Value T
    Error error
}

func Divide(a, b float64) Result[float64] {
    if b == 0 {
        return Result[float64]{Error: errors.New("division by zero")}
    }
    return Result[float64]{Value: a / b}
}

// Partial application via alias
type IntResult = Result[int]
type StringResult = Result[string]
```

### Swiss Map Implementation

More efficient map implementation based on Swiss Tables (Google's Abseil).

```go
// No API changes, but performance improvements:
// - 15-20% faster map operations on average
// - Better cache locality
// - Reduced memory overhead for small maps
// - More predictable performance

m := make(map[string]int, 1000)
for i := 0; i < 1000; i++ {
    m[fmt.Sprintf("key_%d", i)] = i
}
// This is faster in Go 1.24+ due to Swiss map implementation
```

### Weak Pointers (experimental)

Weak references that don't prevent garbage collection.

```go
import "weak"

type Cache struct {
    items map[string]weak.Pointer[Data]
}

type Data struct {
    Content []byte
}

func (c *Cache) Set(key string, data *Data) {
    c.items[key] = weak.Make(data)
}

func (c *Cache) Get(key string) *Data {
    if wp, ok := c.items[key]; ok {
        if data := wp.Value(); data != nil {
            return data
        }
        // Data was garbage collected
        delete(c.items, key)
    }
    return nil
}

// Useful for caching without memory leaks
cache := &Cache{items: make(map[string]weak.Pointer[Data])}
data := &Data{Content: make([]byte, 1024*1024)}
cache.Set("key1", data)

// Data can be GC'd even though cache holds reference
data = nil
runtime.GC()

// May return nil if GC ran
if cached := cache.Get("key1"); cached != nil {
    fmt.Println("Still cached")
} else {
    fmt.Println("Was garbage collected")
}
```

### godebug Improvements

Better runtime debugging controls.

```go
// Set via environment variable or code
import _ "runtime/godebug"

// In code
godebug.New("gotypesalias=1")

// Via environment
// GODEBUG=gotypesalias=1,asyncpreemptoff=1 go run main.go

// Common settings:
// - gotypesalias=1: Enable generic type aliases
// - gctrace=1: Print GC trace
// - schedtrace=1000: Print scheduler trace every 1000ms
// - inittrace=1: Print init function timing
```

---
