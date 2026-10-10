## 10C.7 Slice Out-of-Bounds Panics

Accessing a slice element at an index that is negative or greater than or equal to the slice's length causes an immediate panic. Unlike some languages that return a default value or raise a catchable exception, Go panics on out-of-bounds access, which crashes the goroutine (and the entire program if not recovered). This is especially common with off-by-one errors in loops, user-supplied indices, and slicing operations where the high bound exceeds the capacity.

```go
package main

import "fmt"

func main() {
    s := []int{1, 2, 3}

    // RUNTIME PANIC patterns. The compiler cannot know a slice's length or
    // capacity, so these only blow up when the line executes:
    // s[3]      // panic: index out of range [3] with length 3
    // s[1:5]    // panic: slice bounds out of range [1:5] with capacity 3
    //
    // COMPILE ERROR patterns. Constant indices are checked statically, so
    // these never reach the runtime at all:
    // s[-1]     // invalid argument: index -1 must not be negative
    // s[:10:5]  // invalid slice indices: 10 > 5
    //
    // The distinction matters: a constant bad index is caught for free, but
    // the moment the index comes from a variable the check is yours to write.
    // n := -1
    // s[n]      // panic: index out of range [-1]

    // SAFE pattern: always bounds-check
    idx := 5
    if idx >= 0 && idx < len(s) {
        fmt.Println(s[idx])
    } else {
        fmt.Println("index out of range")
    }

    // TRAP: off-by-one in loops. This panics on the final iteration,
    // where i == len(s):
    // for i := 0; i <= len(s); i++ { fmt.Println(s[i]) }
    //
    // The fix is `<`, not a defensive check inside the body. Better still,
    // use range and let the compiler own the bound:
    for _, v := range s {
        fmt.Println(v)
    }

    // COMMON PATTERN: Safe get with default
    get := func(slice []int, i int, def int) int {
        if i < 0 || i >= len(slice) {
            return def
        }
        return slice[i]
    }
    fmt.Println(get(s, 10, -1)) // -1, no panic
}
```

---
