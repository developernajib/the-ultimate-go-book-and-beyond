## 10C.29 Trim Function Misuse

This is a consistently misunderstood function in Go's standard library. `strings.Trim` does not remove a prefix or suffix string, it removes individual **characters** from a cutset.

### The Disaster

`strings.Trim` removes any leading or trailing character that belongs to the cutset, treating the second argument as a set of individual runes, not a substring. Passing `"error:"` as the cutset removes any combination of `e`, `r`, `o`, `:` characters from the edges, which can strip valid characters from the result.

```go
package main

import (
    "fmt"
    "strings"
)

func main() {
    // WRONG: Developer thinks Trim removes the string "Hello" as a prefix
    result := strings.Trim("Hello, World!", "Hello")
    fmt.Println(result) // ", World!" ← the right answer, for the wrong reason

    // The REAL behavior: Trim removes any CHARACTER found in "Hello" (H, e, l, o)
    // from BOTH ends of the string. It happened to work because the leading chars
    // are H, e, l, l, o and the trailing char '!' is not in the cutset.

    // Where it goes WRONG:
    result2 := strings.Trim("Hello-Hello World Hello-Hello", "Hello")
    fmt.Println(result2) // "-Hello World Hello-"
    // Each end is eaten until a rune outside the cutset appears, which is
    // the '-' in both directions. The two middle "Hello" words survive,
    // because Trim only ever touches the ends.

    // The example that removes any doubt:
    result3 := strings.Trim("Helicopter", "Hello")
    fmt.Println(result3) // "icopter"
    // Left: H, e, l are all in the cutset, then 'i' is not, so it stops.
    // Right: 'r' is not in the cutset, so it stops immediately.
    // Nothing here contains the word "Hello" at all.

    // What the developer ACTUALLY wanted:
    prefix := strings.TrimPrefix("Hello, World!", "Hello")
    fmt.Println(prefix) // ", World!", the exact prefix "Hello" removed once

    suffix := strings.TrimSuffix("data.json.bak", ".bak")
    fmt.Println(suffix) // "data.json", the exact suffix ".bak" removed once
    // And note the quiet virtue of these two: if the prefix or suffix is
    // not there, they return the string unchanged rather than mangling it.
}
```

### Why It's Dangerous

- `strings.Trim(s, cutset)` treats `cutset` as a **set of individual characters**, not a substring
- It removes characters from **both ends** of the string, not just one end
- It often appears to work correctly in simple cases, hiding the bug until edge cases surface
- The same trap applies to `strings.TrimLeft` and `strings.TrimRight`, which also take cutsets, and whose names sound even more like "remove this string from the left"

### The Fix: Use the Right Function

The `strings` package provides distinct functions for character-set trimming and substring removal. The table below clarifies which function to use for each case.

```go
package main

import (
    "fmt"
    "strings"
)

func main() {
    path := "///api/v1/users///"

    // The same argument "/" means two different things below: a cutset for
    // Trim/TrimLeft/TrimRight, and a literal string for TrimPrefix/TrimSuffix.
    // That is the whole confusion in one line.

    // Trim: cutset, both ends, greedy
    fmt.Println(strings.Trim(path, "/")) // "api/v1/users"

    // TrimPrefix: literal string, left end, exactly once
    fmt.Println(strings.TrimPrefix(path, "/")) // "//api/v1/users///"

    // TrimSuffix: literal string, right end, exactly once
    fmt.Println(strings.TrimSuffix(path, "/")) // "///api/v1/users//"

    // TrimLeft: cutset, left end, greedy
    fmt.Println(strings.TrimLeft(path, "/")) // "api/v1/users///"

    // TrimRight: cutset, right end, greedy
    fmt.Println(strings.TrimRight(path, "/")) // "///api/v1/users"

    // Summary:
    // ┌──────────────────────┬────────────────────────────────────────────┐
    // │ Function             │ What it does                               │
    // ├──────────────────────┼────────────────────────────────────────────┤
    // │ Trim(s, cutset)      │ Remove chars in cutset from BOTH ends      │
    // │ TrimLeft(s, cutset)  │ Remove chars in cutset from LEFT end       │
    // │ TrimRight(s, cutset) │ Remove chars in cutset from RIGHT end      │
    // │ TrimPrefix(s, prefix)│ Remove exact prefix string (once)          │
    // │ TrimSuffix(s, suffix)│ Remove exact suffix string (once)          │
    // │ TrimSpace(s)         │ Remove whitespace from both ends           │
    // └──────────────────────┴────────────────────────────────────────────┘
}
```

**The Rule:** If you want to remove a specific prefix or suffix string, use `TrimPrefix`/`TrimSuffix`. Only use `Trim`/`TrimLeft`/`TrimRight` when you genuinely want to strip individual characters from a set.

---
