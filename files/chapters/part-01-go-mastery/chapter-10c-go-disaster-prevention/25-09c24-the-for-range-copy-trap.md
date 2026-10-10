## 10C.24 The for range Copy Trap

When you iterate over a slice with `for _, v := range s`, the variable `v` is a **copy** of each element, not a reference to it. Modifying `v` inside the loop has no effect on the original slice. This is especially surprising with slices of structs: changing `v.Field` does nothing to the struct in the slice. For large structs, this copying also has a performance cost on every iteration. To modify elements in place, use the index form `for i := range s` and access `s[i]` directly. Additionally, map iteration order in Go is intentionally randomized, so you must never write code that depends on a specific key order.

```go
package main

import (
    "fmt"
    "maps"
    "slices"
)

type BigStruct struct {
    Data [1024]byte
    ID   int
}

func main() {
    structs := []BigStruct{{ID: 1}, {ID: 2}, {ID: 3}}

    // TRAP 1: range copies the value, so writing to it writes to the copy.
    // The compiler cannot warn: assigning to a local is perfectly legal.
    for _, s := range structs {
        s.ID = 999 // writes to a copy that is discarded next iteration
    }
    fmt.Println(structs[0].ID) // 1, unchanged

    // FIX: index the slice to reach the real element
    for i := range structs {
        structs[i].ID = 999 // writes through to the backing array
    }
    fmt.Println(structs[0].ID) // 999

    // Equivalent, and easier to read when you touch several fields:
    for i := range structs {
        s := &structs[i] // a pointer to the element, not a copy of it
        s.ID = 999
    }

    // TRAP 2: that copy costs. BigStruct is 1KB+, so `for _, s := range`
    // memcpys a kilobyte per iteration for nothing. The index form copies
    // no payload at all, which is why it is the default for large elements.
    // A slice of pointers sidesteps both problems, at the cost of an
    // indirection per access and more work for the GC.
    ptrStructs := []*BigStruct{{ID: 1}, {ID: 2}, {ID: 3}}
    for _, s := range ptrStructs {
        s.ID = 888 // s is a copy of the POINTER, so this reaches the struct
    }
    fmt.Println(ptrStructs[0].ID) // 888

    // TRAP 3: map range order is deliberately randomized, per iteration.
    // Not "unspecified but stable in practice": the runtime picks a random
    // start point every time you range, precisely so that nobody can depend
    // on it. Code that passes a test once will fail the next run.
    m := map[string]int{"a": 1, "b": 2, "c": 3}
    for k, v := range m {
        fmt.Println(k, v) // a different order each run
    }

    // FIX: sort the keys when order matters
    keys := slices.Sorted(maps.Keys(m)) // Go 1.23+
    for _, k := range keys {
        fmt.Println(k, m[k]) // a b c, every run
    }
}
```

---
