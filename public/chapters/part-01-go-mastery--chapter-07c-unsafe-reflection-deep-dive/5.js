export default `## 7C.4 reflect.DeepEqual and Comparison

\`reflect.DeepEqual\` solves a fundamental problem: Go's \`==\` operator cannot compare slices, maps, or structs containing those types, yet tests and assertion logic frequently need structural equality checks. Unlike \`==\`, \`DeepEqual\` recurses into composite types, comparing element by element, making it the standard tool for test assertions and config diffing. The critical subtlety is that it distinguishes a nil slice from an empty slice (\`[]int(nil)\` vs \`[]int{}\`), and for function values, it only considers two functions equal if both are nil, non-nil functions are always unequal, regardless of whether they point to the same code.

\`\`\`go
package main

import (
    "fmt"
    "reflect"
)

func main() {
    // reflect.DeepEqual: recursive comparison of any two values
    a := []int{1, 2, 3}
    b := []int{1, 2, 3}
    c := []int{1, 2, 4}

    fmt.Println(reflect.DeepEqual(a, b)) // true  (slices: same elements)
    fmt.Println(reflect.DeepEqual(a, c)) // false (different last element)
    fmt.Println(a == nil)                // false

    // Structs
    type Point struct{ X, Y int }
    p1 := Point{1, 2}
    p2 := Point{1, 2}
    p3 := Point{1, 3}
    fmt.Println(reflect.DeepEqual(p1, p2)) // true
    fmt.Println(reflect.DeepEqual(p1, p3)) // false

    // Maps
    m1 := map[string]int{"a": 1, "b": 2}
    m2 := map[string]int{"b": 2, "a": 1}
    fmt.Println(reflect.DeepEqual(m1, m2)) // true (map equality is key-value based)

    // Nil comparisons
    var s1 []int
    s2 := []int{}
    fmt.Println(reflect.DeepEqual(s1, s2)) // false! nil slice != empty slice
    fmt.Println(reflect.DeepEqual(s1, nil)) // true

    // TRAP: DeepEqual treats non-nil functions as always unequal
    fmt.Println(reflect.DeepEqual(func(){}, func(){})) // false (non-nil funcs are never equal)
    fmt.Println(reflect.DeepEqual((func())(nil), (func())(nil))) // true (both nil)
}
\`\`\`

### Test Discipline with DeepEqual

Three patterns to flag in test PRs:

1. **\`reflect.DeepEqual\` in production code.** It is slow and the trap above (nil vs empty slice) surfaces as flaky behaviour. Keep it in tests.
2. **\`reflect.DeepEqual\` when \`slices.Equal\` would work.** Go 1.21's \`slices.Equal\` and \`maps.Equal\` are faster and type-safe. Use them for their specific cases.
3. **\`reflect.DeepEqual\` on structs with unexported fields.** It works but the failure messages are opaque. Consider writing a custom \`Equal\` method for the type.

---
`;
