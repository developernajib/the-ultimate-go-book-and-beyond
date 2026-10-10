## 10C.37 Misunderstanding new() vs make()

Go has two allocation built-ins, `new` and `make`, and they serve different purposes. `new(T)` allocates zeroed memory and returns a `*T`. `make(T, ...)` builds the runtime structure a slice, map, or channel needs and returns a **value**, not a pointer. The distinction matters because for these three types, zeroed memory is not a usable value: the zero map has no hash table, the zero channel has no queue. `new` gives you a pointer to that emptiness, and it panics or deadlocks on first use.

### The Disaster

`new(map[string]int)` allocates a pointer to a nil map, the map itself is not initialized. Any write to the map through that pointer panics with "assignment to entry in nil map." `make` must be used for maps, slices, and channels because it initializes the internal data structures they need to function.

```go
package main

import "fmt"

func main() {
    // --- DISASTER 1: new(map) creates a pointer to a nil map ---
    m := new(map[string]int) // m is *map[string]int, pointing to a nil map

    fmt.Println(m)  // &map[]
    fmt.Println(*m) // map[], identical to how an empty map prints

    // (*m)["key"] = 1 // PANIC: assignment to entry in nil map
    // The map pointer exists, but the map itself was never initialized.

    // --- DISASTER 2: new([]int) creates a pointer to a nil slice ---
    s := new([]int) // s is *[]int, pointing to a nil slice

    fmt.Println(s)  // &[]
    fmt.Println(*s) // [], identical to how an empty slice prints

    // *s = append(*s, 1) // works (append handles nil slices)
    // But: passing s to a function expecting []int requires dereferencing
    // This is almost never what you want.

    // --- DISASTER 3: new(chan int) creates a pointer to a nil channel ---
    ch := new(chan int) // ch is *chan int, pointing to a nil channel

    // *ch <- 1 // DEADLOCK: sending on a nil channel blocks forever
    // <-*ch    // DEADLOCK: receiving from a nil channel blocks forever

    _ = m
    _ = s
    _ = ch
}
```

### Why It's Dangerous

- `new(map[K]V)` returns a `*map[K]V` pointing at a nil map, and writing through it panics
- `new(chan T)` returns a `*chan T` pointing at a nil channel, and sending or receiving blocks forever
- `new([]T)` returns a `*[]T` pointing at a nil slice. This one does not even fail, it just gives you pointer-to-slice semantics that nobody wants.
- The zero value prints as `map[]` or `[]`, which is exactly what an empty map or slice prints. Printing it is not a test.
- The bug only surfaces on a **write** to the map or a **send** on the channel. Reads succeed, `len` works, `range` runs zero times. Every cheap check you would reach for says the value is fine.

### The Fix: Use make() for Slices, Maps, and Channels

Use `make` for slices, maps, and channels because these types require internal data structure initialization. Use `new` or `&T{}` for structs and scalar types where the zero value is a valid starting state.

```go
package main

import "fmt"

func main() {
    // CORRECT: Use make() for maps, slices, and channels
    m := make(map[string]int)    // initialized, ready to use
    s := make([]int, 0, 10)     // initialized with length 0, capacity 10
    ch := make(chan int, 5)      // initialized buffered channel

    m["key"] = 1
    s = append(s, 42)
    ch <- 99

    fmt.Println(m)    // map[key:1]
    fmt.Println(s)    // [42]
    fmt.Println(<-ch) // 99

    // Use new() for structs and scalar types where zero value is useful:
    type Config struct {
        Host    string
        Port    int
        Verbose bool
    }

    // For a struct, zeroed memory IS a usable value, so new works fine.
    cfg := new(Config)
    cfg.Host = "localhost"
    cfg.Port = 8080
    fmt.Println(cfg) // &{localhost 8080 false}

    // Identical, and what you will actually see in Go code, because it
    // extends to setting fields at construction.
    cfg2 := &Config{Host: "localhost", Port: 8080}
    _ = cfg2

    // SUMMARY:
    // ┌──────────────┬──────────────────────────────────────────────────────┐
    // │ Built-in     │ Use for                                              │
    // ├──────────────┼──────────────────────────────────────────────────────┤
    // │ new(T)       │ structs, scalars. Returns *T over zeroed memory.     │
    // │ make(T, ...) │ slices, maps, channels only. Returns an initialized T│
    // │ &T{}         │ structs. Same as new(T), but can set fields.         │
    // └──────────────┴──────────────────────────────────────────────────────┘
    //
    // The asymmetry is worth noticing, because only one direction is your
    // problem:
    //   make(Config) or make(int) → COMPILE ERROR. The compiler stops you.
    //   new(map[string]int)       → compiles cleanly, panics at runtime.
    // So there is exactly one rule to remember: never `new` a map, slice, or
    // channel. The other mistake cannot survive a build.
}
```

**The Rule:** `make` for slices, maps, and channels, because these need runtime structure that zeroed memory does not provide. `&T{}` for structs, which is `new(T)` with the option of setting fields. And in practice, `new` barely appears in idiomatic Go at all: `&T{}` covers every case it does, more legibly. If you see `new` in a diff, the useful question is which of the two above it should have been.

---
