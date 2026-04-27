export default `## 10C.25 Unnecessary Nested Code

Deep nesting is one of the most common readability killers in Go. The Go community has a strong convention: the "happy path", the normal, successful execution flow, should be the least indented code. Errors and edge cases should be handled early and exited immediately.

### The Disaster

Five levels of nested \`if/else\` blocks force the reader to hold the full condition tree in their head to understand any single branch. A bug introduced in the wrong \`else\` branch can execute silently, adding new error conditions requires careful placement deep inside the structure, making it easy to skip cleanup or skip the correct return path entirely.

\`\`\`go
package main

import (
    "errors"
    "fmt"
    "os"
)

// WRONG: deeply nested "pyramid of doom" - hard to read, hard to maintain
func processFile(path string) error {
    file, err := os.Open(path)
    if err == nil {
        defer file.Close()
        data := make([]byte, 1024)
        n, err := file.Read(data)
        if err == nil {
            if n > 0 {
                result, err := validate(data[:n])
                if err == nil {
                    if result.IsValid {
                        err = save(result)
                        if err == nil {
                            fmt.Println("success!")
                            return nil
                        } else {
                            return fmt.Errorf("save failed: %w", err)
                        }
                    } else {
                        return errors.New("validation: result invalid")
                    }
                } else {
                    return fmt.Errorf("validate failed: %w", err)
                }
            } else {
                return errors.New("file is empty")
            }
        } else {
            return fmt.Errorf("read failed: %w", err)
        }
    } else {
        return fmt.Errorf("open failed: %w", err)
    }
}
\`\`\`

### Why It's Dangerous

- Every additional nesting level increases cognitive load exponentially
- Bug-prone: easy to put code in the wrong \`else\` branch when you have 4-5 levels
- Code reviewers lose track of which \`if\` a given \`else\` belongs to
- Adding new logic requires tracing the full tree of conditions
- Go proverb: *"The greater the distance between a name's declaration and its uses, the longer the name should be."* Deep nesting naturally increases this distance

### The Fix: Guard Clauses and Early Returns

Guard clauses invert each condition and return the error immediately, keeping the happy path at the left margin with zero nesting.

\`\`\`go
package main

import (
    "errors"
    "fmt"
    "os"
)

// CORRECT: flat structure using guard clauses (early returns)
// The happy path flows straight down - zero unnecessary nesting
func processFile(path string) error {
    file, err := os.Open(path)
    if err != nil {
        return fmt.Errorf("open failed: %w", err)
    }
    defer file.Close()

    data := make([]byte, 1024)
    n, err := file.Read(data)
    if err != nil {
        return fmt.Errorf("read failed: %w", err)
    }

    if n == 0 {
        return errors.New("file is empty")
    }

    result, err := validate(data[:n])
    if err != nil {
        return fmt.Errorf("validate failed: %w", err)
    }

    if !result.IsValid {
        return errors.New("validation: result invalid")
    }

    if err := save(result); err != nil {
        return fmt.Errorf("save failed: %w", err)
    }

    fmt.Println("success!")
    return nil
}
\`\`\`

**The Rule:** If a condition leads to an error or early exit, handle it immediately and \`return\`. Never wrap the "success" case inside the \`if\` body, keep the happy path at the top level.

\`\`\`
┌─────────────────────────────────────────────────────────────────┐
│              Guard Clause Pattern                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  WRONG (nested):                CORRECT (guard clause):         │
│                                                                  │
│  func f() error {               func f() error {                │
│      if condA {                     if !condA {                  │
│          if condB {                     return errA              │
│              if condC {                 }                        │
│                  // success             if !condB {              │
│              } else {                       return errB          │
│                  return errC            }                        │
│              }                          if !condC {              │
│          } else {                           return errC          │
│              return errB                }                        │
│          }                              // success               │
│      } else {                           return nil              │
│          return errA                }                            │
│      }                                                          │
│  }                                                              │
└─────────────────────────────────────────────────────────────────┘
\`\`\`

---
`;
