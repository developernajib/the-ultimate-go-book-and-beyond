## 10C.19 Shadowed Error Variable

Variable shadowing is when the short declaration operator `:=` creates a new variable in an inner scope that hides a variable with the same name in the outer scope. This is particularly dangerous with the `err` variable: if you use `:=` inside an `if` block, the new `err` disappears when the block ends, and the outer `err` remains unchanged. Your function then returns the wrong error (or nil) without any compiler warning, because from the compiler's point of view you did declare the variable and you did read it. Two different tools cover the two halves of this: the standalone `shadow` analyzer (`golang.org/x/tools/go/analysis/passes/shadow`, run via `go vet -vettool=$(which shadow)`) finds the shadowed declaration, and `errcheck` finds errors you never checked at all. Neither is in the default `go vet` suite, so both have to be wired into CI deliberately.

```go
package main

import (
    "errors"
    "fmt"
    "os"
)

// DISASTER: := inside the if block declares a new err AND a new result.
// Both die at the closing brace. The outer err is never assigned, so the
// function reports success, and the outer result is never assigned either,
// so the caller gets "" back as though that were the real answer.
//
// Note what makes this survive review: the inner error IS checked. The code
// looks conscientious. It just checks a variable that has no way to reach
// the return statement.
func openAndProcess(path string) (string, error) {
    var result string
    var err error

    f, err := os.Open(path) // fine: f is new, so err is REUSED, not shadowed
    if err != nil {
        return "", fmt.Errorf("open: %w", err)
    }
    defer f.Close()

    if someCondition() {
        // BUG: := with no new variable on the left of the outer scope's
        // names still declares fresh ones here, because this is a new scope.
        result, err := process(f)
        if err != nil {
            // Logged, not returned. The error stops here.
            fmt.Println("process failed:", err)
        }
        _ = result
    }

    // Both outer variables are exactly as they were declared.
    return result, err // "", nil: a silent, confident lie
}

// FIX: use = so the assignment lands on the outer variables.
// Declare result up front, and the block writes through to it.
func openAndProcessFixed(path string) (string, error) {
    f, err := os.Open(path)
    if err != nil {
        return "", fmt.Errorf("open: %w", err)
    }
    defer f.Close()

    var result string
    if someCondition() {
        result, err = process(f) // = not :=, so these are the outer variables
        if err != nil {
            return "", fmt.Errorf("process: %w", err)
        }
    }
    return result, nil
}

// DISASTER: the error thrown away with a blank identifier.
// The nil never surfaces here. It surfaces at the first f.Read() the caller
// makes, as a nil pointer dereference in a stack trace that points nowhere
// near this function.
func openFileBad(path string) *os.File {
    f, _ := os.Open(path) // error discarded on purpose, which is the problem
    return f              // nil whenever the open failed
}

func someCondition() bool                { return true }
func process(f *os.File) (string, error) { return "", nil }
var _ = errors.New
```

---
