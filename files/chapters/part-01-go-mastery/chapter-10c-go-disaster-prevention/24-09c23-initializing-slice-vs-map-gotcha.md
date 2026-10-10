## 10C.23 Initializing Slice vs Map Gotcha

In Go, there is a subtle but important difference between a nil slice/map and an empty one. A nil slice (`var s []int`) and an empty slice (`s := []int{}`) both have length zero and work identically with `append`, `len`, and `range`. However, they behave differently with JSON marshaling: a nil slice encodes to `null` while an empty slice encodes to `[]`. For maps, the difference is more dangerous: reading from a nil map is safe and returns the zero value, but writing to a nil map causes an immediate panic.

```go
package main

import "fmt"

func main() {
    // TRAP: var s []int is nil, make([]int, 0) is empty, and both have len 0
    var nilSlice []int
    emptySlice := make([]int, 0)
    emptySlice2 := []int{}

    fmt.Println(nilSlice == nil)    // true
    fmt.Println(emptySlice == nil)  // false
    fmt.Println(emptySlice2 == nil) // false

    // Both behave identically for append, len, range:
    nilSlice = append(nilSlice, 1)     // works fine
    emptySlice = append(emptySlice, 1) // works fine

    // BUT JSON marshaling differs:
    // json.Marshal(nilSlice)    → null
    // json.Marshal(emptySlice)  → []
    // Nil maps do the same: null rather than {}.
    //
    // This bites where you least want it. A handler that returns
    // `results []Item` from a query that matched nothing sends `null`, and
    // every JavaScript client doing `data.results.map(...)` throws. The fix
    // is to make the zero value explicit at the boundary:
    //     if results == nil { results = []Item{} }
    // Or use `omitempty` and let the field vanish, if that is the contract.
    // The one thing that does not work is hoping nobody notices, since it
    // only reproduces when the result set is empty.

    // TRAP: a nil map is readable, so the bug hides until the first write
    var nilMap map[string]int
    fmt.Println(nilMap["key"])   // 0, reading is safe
    fmt.Println(len(nilMap))     // 0, safe
    v, ok := nilMap["key"]       // 0 false, safe
    fmt.Println(v, ok)
    // nilMap["key"] = 1         // panic: assignment to entry in nil map

    // The usual way this reaches production: a map field on a struct. The
    // zero value of the struct leaves it nil, and every constructor path
    // that fills it in works fine, so only the one path that forgot panics.
    type Config struct {
        Tags map[string]string
    }
    var c Config
    fmt.Println(c.Tags["env"]) // "", safe, and reassuring
    // c.Tags["env"] = "prod"  // panic, from a struct that looked fine

    // CORRECT: initialize before writing
    nilMap = make(map[string]int)
    nilMap["key"] = 1 // safe
}
```

---
