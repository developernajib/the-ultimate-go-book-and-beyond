## 10C.10 Type Assertion Panics

A type assertion in Go extracts the concrete value from an interface. If you write `i.(int)` and `i` actually holds a string, the program panics immediately. This is one of the most common panics when working with `any` (formerly `interface{}`), JSON unmarshaling, or any code that passes values through generic interfaces. The safe way is to always use the comma-ok form `v, ok := i.(T)`, which returns `false` instead of panicking when the type does not match.

```go
package main

import (
    "encoding/json"
    "fmt"
)

func main() {
    var i any = "hello"

    // DISASTER: direct type assertion without ok check
    // n := i.(int) // panic: interface conversion: interface {} is string, not int

    // CORRECT: always use comma-ok form
    n, ok := i.(int)
    if !ok {
        fmt.Println("not an int") // safe
    }
    _ = n

    // TRAP: type assertion on nil interface
    var j any // nil interface
    // _ = j.(string) // panic: interface conversion: interface is nil, not string

    // CORRECT: comma-ok already handles nil. No nil guard needed, since a
    // nil interface simply fails the assertion rather than panicking.
    s, ok := j.(string)
    fmt.Println(s, ok) // "" false


    // THE JSON TRAP: every number decoded into an `any` is a float64, never
    // an int, no matter how integral it looks in the payload.
    var decoded any
    json.Unmarshal([]byte(`{"id": 42}`), &decoded)
    m := decoded.(map[string]any)
    // _ = m["id"].(int) // panic: interface conversion: interface {} is float64, not int
    id := int(m["id"].(float64)) // this is the assertion that works
    fmt.Println(id)              // 42

    // SAFE type switch pattern (preferred over multiple assertions)
    process(42)
    process("hello")
    process(3.14)
    process([]int{1, 2, 3})
}

func process(v any) {
    switch val := v.(type) {
    case int:
        fmt.Printf("int: %d\n", val)
    case string:
        fmt.Printf("string: %q\n", val)
    case float64:
        fmt.Printf("float64: %f\n", val)
    default:
        fmt.Printf("unknown type: %T = %v\n", val, val)
    }
}
```

---
