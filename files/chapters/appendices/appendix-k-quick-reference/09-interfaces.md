## Interfaces

Interfaces in Go define a set of method signatures that a type must implement. Unlike many other languages, Go interfaces are satisfied implicitly, there is no `implements` keyword, so any type that has the right methods automatically satisfies the interface. This makes Go code very flexible and loosely coupled. The empty interface `any` (or `interface{}`) can hold a value of any type, and type assertions or type switches let you extract the concrete value when needed.

```go
// Define interface
type Reader interface {
    Read(p []byte) (n int, err error)
}

type Writer interface {
    Write(p []byte) (n int, err error)
}

// Compose interfaces
type ReadWriter interface {
    Reader
    Writer
}

// Empty interface (any type)
var i any
i = 42
i = "hello"
i = struct{}{}

// any (alias for any, Go 1.18+)
var i any

// Implement interface (implicit)
type MyReader struct{}

func (r MyReader) Read(p []byte) (int, error) {
    // Implementation
    return len(p), nil
}

var r Reader = MyReader{}  // MyReader implements Reader

// Type assertion
var i any = "hello"
s := i.(string)            // Panics if wrong type
s, ok := i.(string)        // Safe, ok is false if wrong type

if s, ok := i.(string); ok {
    // use s
}

// Type switch
func describe(i any) {
    switch v := i.(type) {
    case int:
        fmt.Printf("Integer: %d\n", v)
    case string:
        fmt.Printf("String: %s\n", v)
    case bool:
        fmt.Printf("Boolean: %t\n", v)
    default:
        fmt.Printf("Unknown type: %T\n", v)
    }
}

// Common interfaces
type Stringer interface {
    String() string
}

type error interface {
    Error() string
}

// Interface values
var r Reader
// r == nil (nil interface)

r = &MyReader{}
// r != nil (contains type and value)

// Nil interface vs nil concrete value
var p *MyReader = nil
var r Reader = p
// r != nil (interface contains type *MyReader)
// r.(*MyReader) == nil (concrete value is nil)

// Check for nil correctly
if r != nil {
    if v, ok := r.(*MyReader); ok && v != nil {
        // r contains non-nil *MyReader
    }
}

// Comparable interface (Go 1.18+)
type comparable interface {
    // Built-in constraint for types that support == and !=
}

func Equal[T comparable](a, b T) bool {
    return a == b
}

// Generic interface (Go 1.18+)
type Number interface {
    int | int64 | float64
}

func Sum[T Number](nums []T) T {
    var sum T
    for _, n := range nums {
        sum += n
    }
    return sum
}

// Approximation constraint (Go 1.18+)
type Integer interface {
    ~int | ~int8 | ~int16 | ~int32 | ~int64
}
// ~int means "underlying type is int"

// Standard library constraints (Go 1.21+)
import "cmp"

func Min[T cmp.Ordered](a, b T) T {
    if a < b {
        return a
    }
    return b
}

// Common patterns
// Accept interfaces, return structs
func Process(r Reader) *Result {
    // ...
}

// Interface segregation
type Closer interface {
    Close() error
}

type ReadCloser interface {
    Reader
    Closer
}
```

---
