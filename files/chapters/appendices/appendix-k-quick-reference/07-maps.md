## Maps

Maps are Go's built-in hash table type that store key-value pairs. You must initialize a map with `make` or a literal before adding entries, writing to a nil map causes a panic. Use the two-value assignment form `value, ok := m[key]` to safely check whether a key exists. Maps are reference types, so assigning one map variable to another means both variables point to the same underlying data.

```go
// Declaration
var m map[string]int                // nil map (can't add to it!)
m := make(map[string]int)           // Empty map
m := map[string]int{}               // Empty map
m := map[string]int{                // With initialization
    "one":   1,
    "two":   2,
    "three": 3,
}

// With capacity hint
m := make(map[string]int, 100)

// Set value
m[key] = value

// Get value
value := m[key]  // Returns zero value if key doesn't exist

// Check if key exists
value, ok := m[key]
if ok {
    // key exists
}

// Shorthand
if value, ok := m[key]; ok {
    // use value
}

// Delete key
delete(m, key)  // Safe even if key doesn't exist

// Length
len(m)

// Iterate
for key, value := range m {
    // Order is random!
}

// Keys only
for key := range m {
    // ...
}

// Clear map (Go 1.21+)
clear(m)

// Clear map (pre-1.21)
for k := range m {
    delete(m, k)
}
// Or
m = make(map[string]int)

// Map of structs
type Person struct {
    Name string
    Age  int
}
people := make(map[string]Person)
people["alice"] = Person{"Alice", 30}

// Can't modify struct fields directly
// people["alice"].Age = 31  // ERROR!

// Use pointer to struct
peoplePtr := make(map[string]*Person)
peoplePtr["alice"] = &Person{"Alice", 30}
peoplePtr["alice"].Age = 31  // OK

// Nested maps
m := make(map[string]map[string]int)
m["outer"] = make(map[string]int)
m["outer"]["inner"] = 42

// Check and initialize pattern
if m["outer"] == nil {
    m["outer"] = make(map[string]int)
}
m["outer"]["inner"] = 42

// Map as set
set := make(map[string]struct{})  // struct{} uses zero bytes
set["item"] = struct{}{}
if _, exists := set["item"]; exists {
    // item in set
}
delete(set, "item")

// Sync map (concurrent-safe, Go 1.9+)
import "sync"

var m sync.Map
m.Store(key, value)
value, ok := m.Load(key)
m.Delete(key)
m.LoadOrStore(key, value)
m.Range(func(key, value any) bool {
    // return false to stop iteration
    return true
})

// Common gotchas
var m map[string]int  // nil map
m["key"] = 1          // PANIC: assignment to nil map

// Must initialize
m = make(map[string]int)
m["key"] = 1  // OK

// Maps are reference types
m1 := make(map[string]int)
m2 := m1
m2["key"] = 1  // m1["key"] is now 1
```

---
