export default `## 10C.7 Slice Out-of-Bounds Panics

Accessing a slice element at an index that is negative or greater than or equal to the slice's length causes an immediate panic. Unlike some languages that return a default value or raise a catchable exception, Go panics on out-of-bounds access, which crashes the goroutine (and the entire program if not recovered). This is especially common with off-by-one errors in loops, user-supplied indices, and slicing operations where the high bound exceeds the capacity.

\`\`\`go
package main

import "fmt"

func main() {
    s := []int{1, 2, 3}

    // PANIC patterns:
    // s[3]      // panic: index out of range [3] with length 3
    // s[-1]     // panic: index out of range [-1]
    // s[1:5]    // panic: slice bounds out of range [1:5] with capacity 3
    // s[:10:5]  // panic: slice bounds out of range [:10] with capacity 3

    // SAFE pattern: always bounds-check
    idx := 5
    if idx >= 0 && idx < len(s) {
        fmt.Println(s[idx])
    } else {
        fmt.Println("index out of range")
    }

    // TRAP: Off-by-one in loops
    for i := 0; i <= len(s); i++ { // BUG: should be i < len(s)
        if i < len(s) { // defensive check saves us
            fmt.Println(s[i])
        }
    }

    // COMMON PATTERN: Safe get with default
    get := func(slice []int, i int, def int) int {
        if i < 0 || i >= len(slice) {
            return def
        }
        return slice[i]
    }
    fmt.Println(get(s, 10, -1)) // -1 - safe
}
\`\`\`

---
`;
