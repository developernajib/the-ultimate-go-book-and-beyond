export default `## 10C.4 The Interface Nil Trap, Go's Most Famous Bug

This is the single most common source of "impossible" nil panics in Go. It has caught nearly every experienced Go engineer at least once.

### The Disaster

Go interfaces are two-word structs: a type pointer and a data pointer. When a typed nil pointer (\`*MyError\`(nil)) is returned as \`error\`, the type word is set to \`*MyError\` while only the data word is nil, making the interface non-nil. The \`err != nil\` check passes, yet calling \`err.Error()\` panics because the receiver pointer is nil.

\`\`\`go
package main

import "fmt"

type MyError struct {
    Message string
}

func (e *MyError) Error() string {
    return e.Message
}

// LOOKS CORRECT but has a subtle bug
func DoSomething(fail bool) error {
    var err *MyError // typed nil pointer
    if fail {
        err = &MyError{Message: "something failed"}
    }
    return err // BUG: returns (*MyError)(nil), not nil!
}

func main() {
    err := DoSomething(false)

    // You expect this to be nil, so no error handling
    if err != nil { // THIS IS TRUE! err is NOT nil even though *MyError is nil
        fmt.Println("ERROR:", err) // prints: ERROR: <nil>
        // Calling err.Error() here would PANIC with nil pointer dereference
    }
    fmt.Println("err == nil:", err == nil) // false - the trap!
}
\`\`\`

### Why It Happens: Interface Internals

An interface value in Go is a **two-word struct** internally:

\`\`\`
┌─────────────────────────────────────────────────────────────────┐
│              Interface Internal Layout                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  interface{}  =  [ type pointer | data pointer ]               │
│                       (itype)       (idata)                    │
│                                                                 │
│  nil interface: type=nil, data=nil  →  == nil is true          │
│                                                                 │
│  (*MyError)(nil) as error:                                     │
│    type=*MyError (NOT nil!), data=nil  →  == nil is FALSE!     │
│                                                                 │
│  So: error interface is NOT nil even though the pointer IS nil │
│                                                                 │
│  var e *MyError = nil                                          │
│  var i error = e   →  i != nil  (type field is *MyError)      │
│                                                                 │
│  var i error = nil →  i == nil  (both fields are nil)         │
└─────────────────────────────────────────────────────────────────┘
\`\`\`

### The Fix: Never Return a Typed Nil

The fix is straightforward: never return a typed nil pointer through an interface return type. Instead, return an untyped \`nil\` literal when there is no error, or use an explicit nil check before returning.

\`\`\`go
package main

import (
    "errors"
    "fmt"
)

// CORRECT VERSION 1: Return nil directly, not typed nil
func DoSomethingFixed(fail bool) error {
    if fail {
        return &MyError{Message: "something failed"}
    }
    return nil // return untyped nil, not a typed nil pointer
}

// CORRECT VERSION 2: Use a sentinel pattern with explicit nil check
func DoSomethingV2(fail bool) error {
    var myErr *MyError
    if fail {
        myErr = &MyError{Message: "failed"}
    }
    if myErr == nil {
        return nil // explicitly return untyped nil
    }
    return myErr
}

// CORRECT VERSION 3: Use errors.New or fmt.Errorf instead of custom error pointers
func DoSomethingV3(fail bool) error {
    if fail {
        return errors.New("something failed")
    }
    return nil
}

// HOW TO DETECT typed nil in existing code (defensive check)
func IsNilError(err error) bool {
    if err == nil {
        return true
    }
    // Use reflection to check if the underlying value is nil
    // import "reflect"
    // return reflect.ValueOf(err).IsNil()
    return false
}

type MyError struct{ Message string }
func (e *MyError) Error() string { return e.Message }

func main() {
    err := DoSomethingFixed(false)
    fmt.Println(err == nil) // true - correct!

    err2 := DoSomethingFixed(true)
    fmt.Println(err2 == nil) // false - correct, there IS an error
    fmt.Println(err2)        // something failed
}
\`\`\`

**Golden Rule:** Functions returning \`error\` should return \`nil\` (untyped), never a typed nil pointer.

---
`;
