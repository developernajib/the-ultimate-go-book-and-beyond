export default `## 10C.19 Shadowed Error Variable

Variable shadowing is when the short declaration operator \`:=\` creates a new variable in an inner scope that hides a variable with the same name in the outer scope. This is particularly dangerous with the \`err\` variable: if you use \`:=\` inside an \`if\` block, the new \`err\` disappears when the block ends, and the outer \`err\` remains unchanged. Your function then returns the wrong error (or nil) without any compiler warning. The \`go vet -shadow\` flag and the \`errcheck\` linter can detect these bugs automatically.

\`\`\`go
package main

import (
    "errors"
    "fmt"
    "os"
)

// DISASTER: := in an if block creates a new scope, shadowing the outer err
func openAndProcess(path string) error {
    var err error // outer err

    f, err := os.Open(path)
    if err != nil {
        return fmt.Errorf("open: %w", err)
    }
    defer f.Close()

    // BUG: := creates a NEW err in this scope, shadowing outer err
    if someCondition() {
        result, err := process(f) // err is NEW variable here
        if err != nil {
            return fmt.Errorf("process: %w", err)
        }
        fmt.Println(result)
    }
    // outer err is still nil here - the shadow err is gone!
    // If process() succeeded but you needed to check outer state, you'd miss it

    return err // returns the outer err (nil), not the inner process err
}

// FIX: Use = for err when it's already declared in the outer scope
func openAndProcessFixed(path string) error {
    f, err := os.Open(path)
    if err != nil {
        return fmt.Errorf("open: %w", err)
    }
    defer f.Close()

    var result string
    result, err = process(f) // = not :=, reuses outer err
    if err != nil {
        return fmt.Errorf("process: %w", err)
    }
    fmt.Println(result)
    return nil
}

// DISASTER: swallowed error with blank identifier
func openFileBad(path string) *os.File {
    f, _ := os.Open(path) // error silently discarded!
    return f               // may return nil if open failed
}

// use go vet and errcheck linter to catch swallowed errors
func someCondition() bool { return true }
func process(f *os.File) (string, error) { return "", nil }
var _ = errors.New
\`\`\`

---
`;
