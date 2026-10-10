## 80.2 Core Language Questions

### Variables and Types

**Q: What's the difference between `var x int` and `x := 0`?**

```go
package main

import "fmt"

func main() {
    // var declaration - explicit, works at package level
    var x int  // x = 0 (zero value)

    // Short declaration - only inside functions
    y := 0  // Type inferred

    // Key differences:
    // 1. var works at package level, := doesn't
    // 2. var can declare without initializing
    // 3. := requires initialization
    // 4. := can redeclare in multi-variable assignment

    var a int
    a, b := 1, 2  // 'a' is reassigned, 'b' is new

    fmt.Println(x, y, a, b)
}

// Package level - only var works
var packageVar = 10
// packageVar := 10  // Error: non-declaration statement
```

**Answer Framework:**
1. Scope: `var` works at package level, `:=` only in functions
2. Zero values: `var` can declare without initialization
3. Redeclaration: `:=` allows redeclaration with at least one new variable
4. Type inference: Both support it, but `var` can specify type without value

---

**Q: Explain Go's zero values and why they matter.**

```go
package main

import (
    "bytes"
    "fmt"
    "sync"
)

type Config struct {
    Host    string
    Port    int
    Enabled bool
    Tags    []string
    Meta    map[string]string
}

func main() {
    var c Config

    // All fields have zero values - safe to use immediately
    fmt.Printf("Host: %q\n", c.Host)      // ""
    fmt.Printf("Port: %d\n", c.Port)       // 0
    fmt.Printf("Enabled: %v\n", c.Enabled) // false
    fmt.Printf("Tags: %v\n", c.Tags)       // nil (but len = 0, safe to append)
    fmt.Printf("Meta: %v\n", c.Meta)       // nil (NOT safe to assign)

    // Zero values enable patterns like:
    // 1. sync.Mutex ready to use without initialization
    var mu sync.Mutex
    mu.Lock()  // Works immediately
    mu.Unlock()

    // 2. bytes.Buffer ready to use
    var buf bytes.Buffer
    buf.WriteString("Hello")

    // 3. Nil slices are functional
    var slice []int
    slice = append(slice, 1, 2, 3)  // Works

    // CAUTION: Nil maps panic on write
    var m map[string]int
    // m["key"] = 1  // PANIC!
    m = make(map[string]int)  // Must initialize
    m["key"] = 1  // Now works
}
```

**Interview Insight:** Zero values are a core Go design decision. They eliminate null pointer exceptions for value types and enable "make the zero value useful" patterns (like sync.Mutex, bytes.Buffer).

---

### Slices and Maps Deep Dive

**Q: What happens when you append to a slice? Explain the memory implications.**

```go
package main

import "fmt"

func main() {
    // Slice internals: {pointer, length, capacity}
    s := make([]int, 3, 5)
    fmt.Printf("len=%d cap=%d addr=%p\n", len(s), cap(s), s)

    // Append within capacity - reuses backing array
    s = append(s, 4)
    fmt.Printf("len=%d cap=%d addr=%p\n", len(s), cap(s), s)

    // Append beyond capacity - allocates new array (roughly 2x growth)
    s = append(s, 5, 6, 7)
    fmt.Printf("len=%d cap=%d addr=%p\n", len(s), cap(s), s)

    // Slice aliasing pitfall
    original := []int{1, 2, 3, 4, 5}
    slice1 := original[1:3]  // {2, 3}
    slice2 := original[1:3]  // Same backing array

    slice1[0] = 99
    fmt.Println(original)  // [1 99 3 4 5] - modified!
    fmt.Println(slice2)    // [99 3] - also affected!

    // Safe copy to avoid aliasing
    safeCopy := make([]int, len(original))
    copy(safeCopy, original)
}

// Growth pattern demonstration
func demonstrateGrowth() {
    var s []int
    prevCap := 0

    for i := 0; i < 100; i++ {
        s = append(s, i)
        if cap(s) != prevCap {
            fmt.Printf("len=%d cap=%d (growth: %.2fx)\n",
                len(s), cap(s), float64(cap(s))/float64(max(prevCap, 1)))
            prevCap = cap(s)
        }
    }
}
// Output shows ~2x growth for small slices, ~1.25x for large
```

**Key Points for Interview:**
1. Slice header: pointer + length + capacity (24 bytes on 64-bit)
2. Append may or may not allocate new memory
3. Growth factor: ~2x for small, ~1.25x for large (>256 elements in Go 1.18+)
4. Aliasing through slicing shares backing array
5. Pre-allocation with `make([]T, 0, capacity)` for performance

---

**Q: How do Go maps work internally? What are the performance characteristics?**

```go
package main

import (
    "fmt"
)

// Simplified map bucket structure (actual is more complex)
// In real Go runtime, buckets use unsafe pointers and concrete types.
// Here we use any to illustrate the concept:
type bucket struct {
    tophash  [8]uint8        // Top 8 bits of hash for quick comparison
    keys     [8]any  // 8 keys per bucket
    values   [8]any  // 8 values per bucket
    overflow *bucket         // Link to overflow bucket
}

func main() {
    // Map creation options
    m1 := make(map[string]int)      // Default capacity
    m2 := make(map[string]int, 100) // Hint for 100 elements
    m3 := map[string]int{"a": 1}    // Literal
    _ = m3

    // Key operations - O(1) average
    m1["key"] = 42       // Insert/Update
    v, ok := m1["key"]   // Lookup with existence check
    fmt.Println(v, ok)
    delete(m1, "key")    // Delete

    // Iteration is randomized - no guaranteed order
    for k, v := range m2 {
        fmt.Println(k, v)
    }

    // Map growth happens at load factor ~6.5
    // Triggers incremental rehashing
}

// Custom type as map key - must be comparable
type Point struct {
    X, Y int
}

func customKeyExample() {
    // Structs with all comparable fields can be keys
    m := map[Point]string{
        {0, 0}: "origin",
        {1, 1}: "diagonal",
    }

    // Slices, maps, functions CANNOT be keys
    // var invalid map[[]int]string  // Error!
}

// Interview question: Concurrent map access
func concurrentMapProblem() {
    m := make(map[int]int)

    // WRONG - race condition, may crash
    go func() {
        for i := 0; i < 1000; i++ {
            m[i] = i
        }
    }()
    go func() {
        for i := 0; i < 1000; i++ {
            _ = m[i]
        }
    }()

    // Solutions:
    // 1. sync.RWMutex for general use
    // 2. sync.Map for specific patterns
    // 3. Sharded map for high concurrency
}
```

**Interview Points:**
1. Hash buckets with 8 key-value pairs each
2. Load factor ~6.5 triggers growth
3. NOT safe for concurrent access
4. Iteration order is randomized (intentional since Go 1.0 to prevent order dependence)
5. Only comparable types can be keys

---

### Interfaces and Type System

**Q: Explain interface satisfaction in Go. How is it different from other languages?**

```go
package main

import (
    "fmt"
    "io"
)

// Implicit interface satisfaction - no "implements" keyword
type Writer interface {
    Write([]byte) (int, error)
}

// ConsoleWriter satisfies Writer without declaring it
type ConsoleWriter struct{}

func (cw ConsoleWriter) Write(data []byte) (int, error) {
    fmt.Print(string(data))
    return len(data), nil
}

// Empty interface - satisfied by everything
func printAny(v any) {  // Or: func printAny(v any)
    fmt.Printf("Type: %T, Value: %v\n", v, v)
}

// Type assertion
func processValue(v any) {
    // Single assertion - panics if wrong
    s := v.(string)

    // Safe assertion with ok
    s, ok := v.(string)
    if ok {
        fmt.Println("String:", s)
    }

    // Type switch - idiomatic for multiple types
    switch x := v.(type) {
    case string:
        fmt.Println("String:", x)
    case int:
        fmt.Println("Int:", x)
    case io.Reader:
        fmt.Println("Reader:", x)
    default:
        fmt.Printf("Unknown: %T\n", x)
    }
}

// Interface composition
type ReadWriter interface {
    io.Reader
    io.Writer
}

// Pointer vs value receivers matter for interface satisfaction
type Counter struct {
    count int
}

func (c *Counter) Increment() {  // Pointer receiver
    c.count++
}

func (c Counter) Value() int {   // Value receiver
    return c.count
}

type Incrementer interface {
    Increment()
}

func main() {
    var c Counter
    // var i Incrementer = c   // Error! Counter doesn't satisfy
    var i Incrementer = &c     // OK! *Counter satisfies
    i.Increment()
}
```

**Interview Answer Framework:**
1. Implicit satisfaction - structural typing, not nominal
2. Empty interface (any) accepts all types
3. Type assertions for runtime type checking
4. Pointer receivers require pointer to satisfy interface
5. Interface composition through embedding

---

**Q: What's the difference between `nil` interface and interface with `nil` value?**

```go
package main

import "fmt"

type MyError struct {
    Message string
}

func (e *MyError) Error() string {
    if e == nil {
        return "nil error"
    }
    return e.Message
}

func getError(fail bool) error {
    var err *MyError  // nil pointer of type *MyError

    if fail {
        err = &MyError{"something failed"}
    }

    return err  // TRAP! Returns non-nil interface with nil value
}

func main() {
    // Nil interface - interface value itself is nil
    var err1 error  // nil
    fmt.Println(err1 == nil)  // true

    // Interface with nil concrete value
    err2 := getError(false)
    fmt.Println(err2 == nil)       // FALSE! Interface is not nil
    fmt.Printf("(%T, %v)\n", err2, err2)  // (*main.MyError, <nil>)

    // The interface has: (type: *MyError, value: nil)
    // This is NOT equal to nil interface: (type: nil, value: nil)
}

// Correct pattern - return nil explicitly
func getErrorCorrect(fail bool) error {
    if fail {
        return &MyError{"something failed"}
    }
    return nil  // Explicitly return nil interface
}
```

**This is a FAMOUS Go Interview Question!**

```
Interface internals:
┌────────────────────────────────┐
│       Nil Interface            │
│  type: nil                     │
│  value: nil                    │
│  (nil == nil) → true           │
└────────────────────────────────┘

┌────────────────────────────────┐
│  Interface with nil value      │
│  type: *MyError                │
│  value: nil                    │
│  (nil == nil) → FALSE          │
└────────────────────────────────┘
```

---

### Junior → FAANG: Getting Core Language Mechanics Interview-Ready

Core language questions are the foundation of every Go phone screen. Candidates who stumble on the difference between `var x int` and `x := 0` lose credibility early, making the rest of the session harder. The fix is not to memorize answers but to understand the model: Go's zero-value guarantee, short variable declaration scope rules, and named versus unnamed types each reflect a coherent design decision, and knowing the "why" lets you derive answers rather than recall them.

Most common junior gap: interface satisfaction. Many candidates know that a struct implements an interface if it has the required methods, but cannot explain why a pointer receiver implementation does not satisfy an interface when the variable is a value type. Work through five or six concrete examples until the method-set rules are intuitive.

First-job habit: review the Go spec section on assignability and conversion once a week during preparation. It is short, precise, and covers the category of core language questions that trip up candidates who learned Go by example rather than by reading the specification.

### Senior @ FAANG: Core Language as Production Reliability Signal

For senior candidates, core language questions are not about passing a knowledge quiz. They are about demonstrating that you have internalized Go's type system deeply enough to reason about correctness in code you have not written before.

The bar at L5/L6 for core language questions: can you identify the bug in a 10-line snippet involving interface nil checks without running it? The classic `(*MyError)(nil)` versus `error(nil)` non-equality is a real production bug pattern, not an academic exercise. Describing a real incident where this category of bug manifested and how you diagnosed it is a bar-raiser answer.

ADR framing applied to core language: senior engineers make deliberate choices at the type system level. "We used a named type for `UserID` rather than a plain `int64` to prevent accidental mixing of ID types at compile time" is an architectural decision with type-system grounding. Being able to discuss two or three such decisions from production experience demonstrates that core language knowledge is not theoretical for you.

L6/L7 signal: the ability to identify when Go's type system cannot enforce a constraint you want (for example, Go has no sum types or sealed interfaces) and to describe the pattern you use instead (e.g., an unexported interface method to restrict implementors to the current package) shows that you operate at the language-design boundary, not just the application-code level.
