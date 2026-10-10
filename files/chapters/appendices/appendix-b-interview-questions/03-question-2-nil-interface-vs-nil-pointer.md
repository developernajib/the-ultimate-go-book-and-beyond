## Question 2: nil Interface vs nil Pointer

**Level**: Mid-Senior

**Question**: What does this code print? Why is this a common source of bugs?

```go
func doSomething() error {
    var err *MyError
    // Some logic that might not assign to err
    return err  // Returns nil interface, right?
}

type MyError struct {
    Msg string
}

func (e *MyError) Error() string {
    return e.Msg
}

func main() {
    err := doSomething()
    if err != nil {
        fmt.Println("Error occurred:", err)
    } else {
        fmt.Println("No error")
    }
}
```

**Answer**:

```
Error occurred: <nil>
```

This prints "Error occurred: <nil>" - the `err != nil` check passes even though the pointer is nil!

**Explanation**:

In Go, an interface value consists of two parts:
1. **Type**: The concrete type of the value
2. **Value**: The actual value

```go
// Interface internals (simplified representation of runtime.iface):
type iface struct {
    tab  *itab
    data unsafe.Pointer
}
```

When we return `err` (which is `*MyError(nil)`):
- The interface's **type** field points to `*MyError`
- The interface's **value** field is `nil`

An interface is only `nil` when both type and value are nil:

```go
var err error              // Both type and value are nil
fmt.Println(err == nil)    // true

var myErr *MyError = nil   // Pointer is nil
err = myErr                // Type is *MyError, value is nil
fmt.Println(err == nil)    // false!
```

**Visualization**:

```
nil interface:
┌──────┬───────┐
│ type │ value │
│ nil  │  nil  │
└──────┴───────┘

Non-nil interface with nil value:
┌──────────┬───────┐
│   type   │ value │
│ *MyError │  nil  │
└──────────┴───────┘
```

**The Fix**:

```go
func doSomething() error {
    var err *MyError
    if someCondition {
        err = &MyError{Msg: "something went wrong"}
    }

    // Correct way: explicit nil check
    if err != nil {
        return err
    }
    return nil  // Return typed nil
}
```

Or better yet:

```go
func doSomething() error {
    // Declare as interface from the start
    var err error
    if someCondition {
        err = &MyError{Msg: "something went wrong"}
    }
    return err  // Works correctly
}
```

**Real Production Bug Example** (from a Google service):

```go
func validateUser(userID string) error {
    var validationErr *ValidationError

    user, err := getUser(userID)
    if err != nil {
        validationErr = &ValidationError{Msg: "user not found"}
    }

    return validationErr  // BUG: Returns non-nil interface even on success!
}

// This caused a production incident where all requests were failing
// even though users existed
func handleRequest(w http.ResponseWriter, r *http.Request) {
    if err := validateUser(r.FormValue("user_id")); err != nil {
        http.Error(w, err.Error(), http.StatusBadRequest)
        return
    }
    // This code never executed for valid users!
}
```

**Common Follow-up**: How can you detect this at compile time?

Use linters:
```bash
# errcheck: Checks for unchecked errors
go install github.com/kisielk/errcheck@latest

# nilaway: Detects nil pointer dereferences and interface issues
go install go.uber.org/nilaway/cmd/nilaway@latest
```

**Companies that asked this**: Google, Meta, Amazon, Datadog

---
