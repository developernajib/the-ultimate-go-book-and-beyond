## Variable Declarations

Go provides several ways to declare and initialize variables. You can use the `var` keyword for explicit declarations or the short `:=` syntax inside functions for concise type-inferred assignments. Constants are declared with `const` and can use `iota` for auto-incrementing enumerations. Every type in Go has a zero value, which is the default value assigned when no explicit initializer is provided.

```go
// Declare with type
var name string
var age int
var isActive bool

// Declare with initialization
var name string = "Alice"
var age int = 30

// Type inference
var name = "Alice"
var age = 30

// Short declaration (inside functions only)
name := "Alice"
age := 30

// Multiple declarations
var (
    name     string
    age      int
    isActive bool
)

// Multiple assignments
var x, y int = 1, 2
a, b := "hello", 42

// Constants
const Pi = 3.14159
const (
    StatusOK       = 200
    StatusNotFound = 404
)

// iota enumeration
const (
    Sunday = iota    // 0
    Monday           // 1
    Tuesday          // 2
    Wednesday        // 3
    Thursday         // 4
    Friday           // 5
    Saturday         // 6
)

// iota with expressions
const (
    _  = iota             // 0 (ignored)
    KB = 1 << (10 * iota) // 1 << 10 = 1024
    MB                    // 1 << 20 = 1048576
    GB                    // 1 << 30 = 1073741824
    TB                    // 1 << 40
)

// Zero values
var i int       // 0
var f float64   // 0.0
var b bool      // false
var s string    // ""
var p *int      // nil
var slice []int // nil
var m map[K]V   // nil
var ch chan int // nil
var fn func()   // nil
var iface I     // nil
```

---
