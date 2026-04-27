export default `## 10C.24 The for range Copy Trap

When you iterate over a slice with \`for _, v := range s\`, the variable \`v\` is a **copy** of each element, not a reference to it. Modifying \`v\` inside the loop has no effect on the original slice. This is especially surprising with slices of structs: changing \`v.Field\` does nothing to the struct in the slice. For large structs, this copying also has a performance cost on every iteration. To modify elements in place, use the index form \`for i := range s\` and access \`s[i]\` directly. Additionally, map iteration order in Go is intentionally randomized, so you must never write code that depends on a specific key order.

\`\`\`go
package main

import "fmt"

type BigStruct struct {
    Data [1024]byte
    ID   int
}

func main() {
    structs := []BigStruct{{ID: 1}, {ID: 2}, {ID: 3}}

    // TRAP 1: Range copies the value - modifying it doesn't modify the slice
    for _, s := range structs {
        s.ID = 999 // modifies a COPY, not the original
    }
    fmt.Println(structs[0].ID) // 1 - NOT 999, unchanged!

    // FIX: Use index to modify in place
    for i := range structs {
        structs[i].ID = 999 // modifies original
    }
    fmt.Println(structs[0].ID) // 999 - correct

    // TRAP 2: Range copies the whole struct on each iteration - expensive!
    // For large structs, use index-based access or slices of pointers
    ptrStructs := []*BigStruct{{ID: 1}, {ID: 2}, {ID: 3}}
    for _, s := range ptrStructs {
        s.ID = 888 // modifies through pointer - works correctly
    }
    fmt.Println(ptrStructs[0].ID) // 888

    // TRAP 3: Map range order is RANDOM - never rely on it
    m := map[string]int{"a": 1, "b": 2, "c": 3}
    for k, v := range m {
        fmt.Println(k, v) // different order each run
    }
}
\`\`\`

---
`;
