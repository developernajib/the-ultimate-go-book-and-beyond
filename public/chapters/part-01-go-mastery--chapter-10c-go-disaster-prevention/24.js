export default `## 10C.23 Initializing Slice vs Map Gotcha

In Go, there is a subtle but important difference between a nil slice/map and an empty one. A nil slice (\`var s []int\`) and an empty slice (\`s := []int{}\`) both have length zero and work identically with \`append\`, \`len\`, and \`range\`. However, they behave differently with JSON marshaling: a nil slice encodes to \`null\` while an empty slice encodes to \`[]\`. For maps, the difference is more dangerous: reading from a nil map is safe and returns the zero value, but writing to a nil map causes an immediate panic.

\`\`\`go
package main

import "fmt"

func main() {
    // TRAP: var s []int is nil, but make([]int, 0) is empty - both have len=0
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
    // This matters in APIs where [] and null mean different things!

    // TRAP: var m map[string]int is nil
    var nilMap map[string]int
    fmt.Println(nilMap["key"]) // 0 - reading is safe
    // nilMap["key"] = 1       // PANIC: assignment to entry in nil map

    // CORRECT: initialize before writing
    nilMap = make(map[string]int)
    nilMap["key"] = 1 // safe
}
\`\`\`

---
`;
