## Question 9: Type Assertions and Type Switches

**Level**: Mid

**Question**: What's the difference between type assertions and type switches? What happens when they fail?

```go
func process(i any) {
    // Type assertion
    s := i.(string)
    fmt.Println("String:", s)

    // Type assertion with ok
    s2, ok := i.(string)
    fmt.Println("String:", s2, "OK:", ok)

    // Type switch
    switch v := i.(type) {
    case string:
        fmt.Println("String:", v)
    case int:
        fmt.Println("Int:", v)
    default:
        fmt.Printf("Unknown type: %T\n", v)
    }
}

func main() {
    process("hello")
    process(42)
}
```

**Answer**:

With `process("hello")`:
```
String: hello
String: hello OK: true
String: hello
```

With `process(42)`:
```
panic: interface conversion: interface {} is int, not string
```

**Explanation**:

**Type Assertion**: Extracts concrete value from interface

```go
// Single return (panics if wrong type):
s := i.(string)

// Double return (safe):
s, ok := i.(string)
if !ok {
    // i is not a string
}
```

**Type Switch**: Checks against multiple types

```go
switch v := i.(type) {
case string:
    // v is string
case int:
    // v is int
case bool:
    // v is bool
default:
    // v is any
}
```

**Detailed Examples**:

```go
var i any = "hello"

// Type assertion (unsafe)
s := i.(string)
fmt.Println(s)  // "hello"

i = 42
s = i.(string)  // PANIC: interface conversion: interface {} is int, not string

// Type assertion (safe)
s, ok := i.(string)
if ok {
    fmt.Println("String:", s)
} else {
    fmt.Println("Not a string")  // This prints
}

// Type switch
switch v := i.(type) {
case string:
    fmt.Println("String:", v)
case int:
    fmt.Println("Int:", v)  // This prints: Int: 42
case bool:
    fmt.Println("Bool:", v)
default:
    fmt.Printf("Unknown: %T\n", v)
}
```

**Type Switch with Multiple Types**:

```go
func describe(i any) {
    switch v := i.(type) {
    case nil:
        fmt.Println("nil")
    case int, int8, int16, int32, int64:
        fmt.Println("Signed integer:", v)
    case uint, uint8, uint16, uint32, uint64:
        fmt.Println("Unsigned integer:", v)
    case string:
        fmt.Println("String:", v)
    case error:
        fmt.Println("Error:", v.Error())
    case fmt.Stringer:
        fmt.Println("Stringer:", v.String())
    default:
        fmt.Printf("Unknown type: %T\n", v)
    }
}
```

**Important**: Type switch checks in order

```go
type MyError struct {
    msg string
}

func (e MyError) Error() string {
    return e.msg
}

func (e MyError) String() string {
    return "MyError: " + e.msg
}

func demonstrateSwitch() {
    var i any = MyError{msg: "test"}

    switch v := i.(type) {
    case error:
        fmt.Println("Error:", v.Error()) // Matches first!
    case fmt.Stringer:
        fmt.Println("Stringer:", v.String()) // Never reached
    }
}
```

**Empty Interface Type Switch**:

```go
package main

import "fmt"

func typeOf(i any) {
    switch i.(type) {
    case int:
        fmt.Println("int")
    case string:
        fmt.Println("string")
    }

    // Note: Without assigning to variable
    switch i.(type) {  // Can't use the value
    case int:
        // i is still any, not int!
    }

    // With assignment:
    switch v := i.(type) {  // v has concrete type in each case
    case int:
        fmt.Println(v + 1)  // v is int
    case string:
        fmt.Println(v + "!")  // v is string
    }
}
```

**Production Patterns**:

```go
// Pattern 1: Error type checking
func handleError(err error) {
    if err == nil {
        return
    }

    switch e := err.(type) {
    case *os.PathError:
        fmt.Printf("Path error: %s (op: %s)\n", e.Path, e.Op)
    case *net.OpError:
        fmt.Printf("Network error: %s (op: %s)\n", e.Err, e.Op)
    case interface{ Temporary() bool }:
        if e.Temporary() {
            fmt.Println("Temporary error, retry")
        }
    default:
        fmt.Println("Unknown error:", err)
    }
}

// Pattern 2: Interface capability checking
func write(w io.Writer, data []byte) error {
    // Check if writer supports WriteTo (more efficient)
    if wt, ok := w.(io.WriterTo); ok {
        _, err := wt.WriteTo(someReader)
        return err
    }

    // Fallback to regular Write
    _, err := w.Write(data)
    return err
}

// Pattern 3: Optional interface methods
type Validator interface {
    Validate() error
}

type DetailedValidator interface {
    Validator
    ValidateDetailed() []error  // Optional detailed validation
}

func validate(v Validator) error {
    // Try detailed validation first
    if dv, ok := v.(DetailedValidator); ok {
        errs := dv.ValidateDetailed()
        if len(errs) > 0 {
            return errs[0]  // Return first error
        }
        return nil
    }

    // Fallback to simple validation
    return v.Validate()
}
```

**Type Assertion on Nil Interface**:

```go
var i any  // nil interface

s, ok := i.(string)
fmt.Println(s, ok)  // "" false

// Type switch on nil
switch v := i.(type) {
case nil:
    fmt.Println("nil interface")  // This matches
case string:
    fmt.Println("string:", v)
}
```

**Performance Consideration**:

```go
// For performance-critical code, consider polymorphism alternatives:
type Handler interface {
    Handle()
}

type StringHandler struct{}
func (StringHandler) Handle() {}

type IntHandler struct{}
func (IntHandler) Handle() {}

// Use polymorphism instead of type switch
func process(h Handler) {
    h.Handle() // Single virtual call, no type checking
}

func demonstrate(i any) {
    // Type assertion is fast (single check)
    if s, ok := i.(string); ok {
        _ = s // One comparison
    }

    // Type switch with many cases is slower
    switch i.(type) {
    case string, int, bool, float64, []byte: // Multiple comparisons
        // ...
    }
}
```

**Companies that asked this**: Google, Meta, Uber, Stripe

---
