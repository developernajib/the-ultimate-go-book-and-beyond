## 10C.25 Unnecessary Nested Code

Deep nesting is one of the most common readability killers in Go. The Go community has a strong convention: the "happy path", the normal, successful execution flow, should be the least indented code. Errors and edge cases should be handled early and exited immediately.

### The Disaster

Five levels of nested `if/else` force the reader to hold the whole condition tree in their head to understand any single branch. Put a statement in the wrong `else` and nothing complains, because every branch is syntactically fine. Adding a sixth condition later means finding the right depth to wedge it into, which is how return paths get missed and cleanup gets skipped.

```go
package main

import (
    "errors"
    "fmt"
    "os"
)

// WRONG: the "pyramid of doom". Note that the success case is buried
// deepest, and the error cases read bottom-up in reverse of the order they
// can occur. Every `else` is a return you have to go find.
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
```

### Why It's Dangerous

- Each nesting level adds another condition the reader must keep live to understand the code at the bottom
- Easy to put a statement in the wrong `else` branch, and nothing catches it
- Reviewers lose track of which `if` a given `else` belongs to
- Adding a condition means tracing the whole tree to find where it goes
- The error handling is scattered to the leaves, so there is no single place to see what can go wrong

### The Fix: Guard Clauses and Early Returns

Guard clauses invert each condition and return the error immediately, keeping the happy path at the left margin with zero nesting.

```go
package main

import (
    "errors"
    "fmt"
    "os"
)

// CORRECT: guard clauses. Same logic, same errors, same order.
// The happy path runs straight down the left margin, and each failure is
// handled next to the call that can produce it.
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
```

**The Rule:** If a condition leads to an error or early exit, handle it immediately and `return`. Never wrap the "success" case inside the `if` body, keep the happy path at the top level.

```
┌──────────────────────────────────────────────────────────────────┐
│              Guard Clause Pattern                                │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  WRONG (nested):                CORRECT (guard clause):          │
│                                                                  │
│  func f() error {               func f() error {                 │
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
│      } else {                           return nil               │
│          return errA                }                            │
│      }                                                           │
│  }                                                               │
└──────────────────────────────────────────────────────────────────┘
```

---
