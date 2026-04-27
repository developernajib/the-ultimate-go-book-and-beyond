export default `## 10C.37 Misunderstanding new() vs make()

Go has two allocation built-ins - \`new\` and \`make\` - that serve fundamentally different purposes. \`new(T)\` allocates zeroed memory and returns a pointer. \`make(T, ...)\` initializes slices, maps, and channels and returns a **value** (not a pointer). Using the wrong one for maps, slices, or channels creates nil references that panic on use.

### The Disaster

\`new(map[string]int)\` allocates a pointer to a nil map, the map itself is not initialized. Any write to the map through that pointer panics with "assignment to entry in nil map." \`make\` must be used for maps, slices, and channels because it initializes the internal data structures they need to function.

\`\`\`go
package main

import "fmt"

func main() {
    // --- DISASTER 1: new(map) creates a pointer to a nil map ---
    m := new(map[string]int) // m is *map[string]int, pointing to a nil map

    fmt.Println(m)  // &map[]
    fmt.Println(*m) // map[] - LOOKS like an empty map, but it's nil!

    // (*m)["key"] = 1 // PANIC: assignment to entry in nil map
    // The map pointer exists, but the map itself was never initialized.

    // --- DISASTER 2: new([]int) creates a pointer to a nil slice ---
    s := new([]int) // s is *[]int, pointing to a nil slice

    fmt.Println(s)  // &[]
    fmt.Println(*s) // [] - looks empty but is nil

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
\`\`\`

### Why It's Dangerous

- \`new(map[K]V)\` returns a \`*map[K]V\` pointing to \`nil\` - writing to it panics
- \`new(chan T)\` returns a \`*chan T\` pointing to \`nil\` - sending/receiving deadlocks forever
- \`new([]T)\` returns a \`*[]int\` pointing to \`nil\` - rarely useful, confusing pointer semantics
- The zero value prints as \`map[]\` or \`[]\`, making it look initialized when it is not
- The bug surfaces only when you **write** to the map or **send** on the channel

### The Fix: Use make() for Slices, Maps, and Channels

Use \`make\` for slices, maps, and channels because these types require internal data structure initialization. Use \`new\` or \`&T{}\` for structs and scalar types where the zero value is a valid starting state.

\`\`\`go
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

    cfg := new(Config) // cfg is *Config with all zero values - valid and useful
    cfg.Host = "localhost"
    cfg.Port = 8080
    fmt.Println(cfg) // &{localhost 8080 false}

    // Equivalent to:
    cfg2 := &Config{} // same as new(Config) - more idiomatic in Go
    _ = cfg2

    // SUMMARY:
    // ┌───────────────┬─────────────────────────────────────────────────────┐
    // │ Built-in      │ Use for                                            │
    // ├───────────────┼─────────────────────────────────────────────────────┤
    // │ new(T)        │ Structs, scalars - returns *T with zeroed memory   │
    // │ make(T, ...)  │ Slices, maps, channels - returns T (initialized)   │
    // │ &T{}          │ Struct literal - same as new(T) but with init vals │
    // └───────────────┴─────────────────────────────────────────────────────┘
    //
    // NEVER use new() for: map, slice, channel - use make() instead
    // NEVER use make() for: struct, int, string - use new() or &T{} instead
}
\`\`\`

**The Rule:** Use \`make()\` for slices, maps, and channels, these types require internal initialization beyond zero memory. Use \`new()\` or \`&T{}\` for structs and scalar types where the zero value is meaningful. Never use \`new()\` for maps, slices, or channels.

---
`;
