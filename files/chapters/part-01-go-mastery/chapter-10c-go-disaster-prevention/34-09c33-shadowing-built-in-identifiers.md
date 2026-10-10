## 10C.33 Shadowing Built-in Identifiers

Go allows you to declare variables and functions that shadow built-in identifiers like `len`, `cap`, `append`, `make`, `new`, `error`, `true`, `false`, `nil`, `copy`, `delete`, `print`, and `println`. The compiler does not produce an error, the built-in is simply hidden in that scope, leading to extremely confusing compile errors or silent behavior changes.

### The Disaster

Go's built-in identifiers are not keywords. They are ordinary names declared in the universe block, the outermost scope of every program. Nothing protects them, so any declaration in any inner scope shadows them the same way a local shadows a package-level variable. The compiler has no opinion about this, because from its point of view nothing unusual happened.

```go
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
    fmt.Println(m) // [5], from the local func, not the built-in

    // DISASTER 7: the one that actually happens, because the language moved.
    // `max` and `min` became built-ins in Go 1.21. Every codebase that had
    // been writing `max := 100` for a decade still compiles: the local just
    // shadows the new built-in, harmlessly. It stops being harmless the day
    // someone in that same scope reaches for the built-in:
    max := 100
    // best := max(a, b) // cannot call non-function max (variable of type int)
    _ = max
    // Nothing warns you at the point of shadowing. The error lands on the
    // innocent line, months later, on somebody else's PR.
}
```

### Why It's Dangerous

- The compiler accepts the shadowing silently. Predeclared identifiers live in the universe block, which every other scope can shadow, exactly like any outer scope.
- The error never lands on the shadowing line. It lands wherever someone later used the built-in, which may be a hundred lines away or added a year later.
- Severity is uneven. A local `len := 5` is contained. A package-level `type error string` breaks every function signature in the package.
- The set of built-ins grows. `clear`, `max`, and `min` arrived in Go 1.21, retroactively turning ordinary variable names into shadows.
- Reviewers read `max := 100` as a variable named max, because that is what it was for the previous ten years

### The Fix: Never Shadow Built-ins, Use Linters

Use descriptive variable names that do not collide with built-in identifiers, and enable the `predeclared` linter in `golangci-lint` to catch accidental shadowing automatically.

```go
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
// TOOLING: `go vet` does NOT check for this, and neither does the compiler.
// The linter that does is `predeclared`:
//   golangci-lint run --enable predeclared
// Enable it once and the whole class is gone. Note it is off by default,
// which is why most codebases have never seen a warning for any of the
// above.
```

**The Rule:** Never use a built-in identifier as a variable, function, or type name. Configure `golangci-lint` with the `predeclared` linter enabled to catch this automatically.

---
