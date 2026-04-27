export default `## 10C.33 Shadowing Built-in Identifiers

Go allows you to declare variables and functions that shadow built-in identifiers like \`len\`, \`cap\`, \`append\`, \`make\`, \`new\`, \`error\`, \`true\`, \`false\`, \`nil\`, \`copy\`, \`delete\`, \`print\`, and \`println\`. The compiler does not produce an error, the built-in is simply hidden in that scope, leading to extremely confusing compile errors or silent behavior changes.

### The Disaster

Go's built-in identifiers (\`len\`, \`cap\`, \`append\`, \`make\`, \`new\`, \`error\`, \`true\`, \`false\`, \`nil\`) are predeclared in the universe scope and can be silently overridden by any local declaration. The compiler emits no warning, so a variable named \`len\` hiding the built-in produces confusing type errors or silent behavior changes wherever the built-in was expected.

\`\`\`go
package main

import "fmt"

func main() {
    // DISASTER 1: Shadowing len
    data := []int{1, 2, 3, 4, 5}
    len := 5 // shadows the built-in len function with an int variable

    // Later in the same function, someone tries to use len():
    // n := len(data) // COMPILE ERROR: cannot call non-function len (variable of type int)
    _ = len
    _ = data

    // DISASTER 2: Shadowing true/false
    true := 0 // shadows the built-in true constant
    if true == 0 {
        fmt.Println("true is false!") // this prints!
    }

    // DISASTER 3: Shadowing error - breaks error interface usage
    // type error string // shadows the built-in error interface!
    // func doWork() error { ... } // now returns your string type, not the error interface

    // DISASTER 4: Shadowing append
    append := func(s string, vals ...string) string {
        return s // broken custom append that does nothing
    }
    // result := append([]int{1}, 2) // COMPILE ERROR: type mismatch
    _ = append

    // DISASTER 5: Shadowing nil
    nil := "not nil" // yes, this compiles
    fmt.Println(nil) // prints: "not nil"
    // var p *int = nil // COMPILE ERROR: cannot use nil (variable of type string) as *int

    // DISASTER 6: Shadowing make
    make := func(n int) []int { return []int{n} }
    m := make(5)
    fmt.Println(m) // [5] - NOT a proper slice created by the built-in make
}
\`\`\`

### Why It's Dangerous

- The compiler accepts shadowed built-in identifiers without any warning
- The error messages when you try to use the shadowed built-in are confusing and misleading
- In large functions, the shadowing declaration may be far from where the built-in is used
- Shadowing \`error\` or \`nil\` can break fundamental Go patterns across an entire package
- Code reviewers may not notice single-letter variable names like \`len\` or \`cap\`

### The Fix: Never Shadow Built-ins, Use Linters

Use descriptive variable names that do not collide with built-in identifiers, and enable the \`predeclared\` linter in \`golangci-lint\` to catch accidental shadowing automatically.

\`\`\`go
package main

import "fmt"

func main() {
    // CORRECT: use descriptive names instead of built-in names
    data := []int{1, 2, 3, 4, 5}
    dataLen := len(data)      // use dataLen, not len
    dataCap := cap(data)      // use dataCap, not cap
    fmt.Println(dataLen, dataCap)

    // CORRECT: descriptive names that don't shadow
    isReady := true          // not: true := ...
    maxItems := 100          // not: new := 100
    errMsg := "failed"       // not: error := "failed"

    _ = isReady
    _ = maxItems
    _ = errMsg
}

// Complete list of built-in identifiers you must NEVER shadow:
//
// Types:    bool, byte, comparable, complex64, complex128, error, float32, float64,
//           int, int8, int16, int32, int64, rune, string,
//           uint, uint8, uint16, uint32, uint64, uintptr, any
//
// Constants: true, false, iota
//
// Zero:     nil
//
// Functions: append, cap, clear, close, complex, copy, delete, imag, len,
//            make, max, min, new, panic, print, println, real, recover
//
// TOOLING: Run these to detect shadowing:
//   go vet -shadow ./...
//   golangci-lint run --enable govet --enable predeclared
//   staticcheck ./...
\`\`\`

**The Rule:** Never use a built-in identifier as a variable, function, or type name. Configure \`golangci-lint\` with the \`predeclared\` linter enabled to catch this automatically.

---
`;
