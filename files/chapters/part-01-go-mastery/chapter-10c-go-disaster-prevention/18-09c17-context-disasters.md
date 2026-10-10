## 10C.17 Context Disasters

The `context` package is central to Go's approach to cancellation, timeouts, and request-scoped values. However, misusing it leads to subtle bugs: passing a `nil` context causes panics, using string keys for context values leads to collisions between packages, and ignoring `ctx.Done()` in goroutines causes them to leak when the parent request has already been canceled. Context should always be the first parameter of a function and should never be stored in a struct field.

```go
package main

import (
    "context"
    "fmt"
    "time"
)

// TRAP 1: passing a nil context.
// context.Context is an interface, so a nil one has no method set to dispatch
// to. Any call on it (Value, Deadline, Done, Err) panics with a nil pointer
// dereference. There is no zero value that behaves sensibly, which is why
// context.Background() exists.
func callService(ctx context.Context, id string) error {
    // Check cancellation before doing work. Every context-aware function
    // owes its caller this, otherwise the ctx parameter is decoration.
    if err := ctx.Err(); err != nil {
        return err
    }
    // ... real work, itself passing ctx down ...
    return nil
}

func callerBug() {
    // callService(nil, "123") // panic: nil pointer dereference inside ctx.Err()

    // CORRECT: Background() at the root of a request or a main
    callService(context.Background(), "123")
    // TODO() when a context should be threaded here but the plumbing is not
    // done yet. It behaves identically to Background(), and the distinction
    // is a signal to readers and to static analysis, not to the runtime.
    callService(context.TODO(), "123")
}

// TRAP 2: Context value key collisions using string keys
func trap2() {
    ctx := context.Background()

    // DISASTER: package A and package B both use string "userID" as key
    // They'll collide if the context is shared!
    ctx = context.WithValue(ctx, "userID", "alice")
    ctx = context.WithValue(ctx, "userID", "bob") // silently overwrites

    val := ctx.Value("userID")
    fmt.Println(val) // "bob", alice is unreachable

    // Note that WithValue did not overwrite anything. Each call wraps the
    // parent in a new node, so both values are still in the chain. Lookup
    // walks outward from the innermost node and returns the first match, so
    // "alice" is simply shadowed forever. `go vet` has no check for string
    // context keys. The `context.WithValue` docs advise against them
    // (`should not be of type string`), which is the real rule to follow.

    // CORRECT: an unexported key type, which no other package can construct
    ctx2 := context.WithValue(ctx, contextKeyUserID{}, "alice")
    fmt.Println(ctx2.Value(contextKeyUserID{})) // "alice", collision-safe
}

// contextKeyUserID is unexported, so no other package can name this type,
// let alone produce a value that compares equal to it.
type contextKeyUserID struct{}

// TRAP 3: ignoring context cancellation, which leaks the goroutine
func leakyFetch(ctx context.Context) {
    go func() {
        // This goroutine never looks at ctx.Done(). Canceling ctx does
        // nothing to it: it holds its stack and everything it references for
        // the full 10 minutes, long after the request that spawned it is
        // gone. Under load, that is an OOM with a slow fuse.
        time.Sleep(10 * time.Minute) // simulate a slow operation
        fmt.Println("done")
    }()
}

// CORRECT: respect cancellation on every blocking operation, including
// the send. Selecting on ctx.Done() for the work but then doing a bare
// `results <- "result"` just moves the leak: if the receiver is gone, the
// goroutine parks on that send forever and ctx cancellation cannot reach it.
func respectedFetch(ctx context.Context, results chan<- string) {
    go func() {
        select {
        case <-ctx.Done():
            return
        case <-time.After(100 * time.Millisecond):
        }
        select {
        case results <- "result":
        case <-ctx.Done(): // nobody is reading, and we were told to stop
        }
    }()
}

// TRAP 4: Storing context in a struct (anti-pattern)
type BadService struct {
    ctx context.Context // NEVER store context in a struct!
}

// CORRECT: Pass context as first argument to each method
type GoodService struct {
    // no ctx field
}

func (s *GoodService) DoWork(ctx context.Context) error {
    select {
    case <-ctx.Done():
        return ctx.Err()
    default:
        return nil
    }
}

// TRAP 5: Using context after it's been canceled
func canceledContextUsage() {
    ctx, cancel := context.WithTimeout(context.Background(), 1*time.Millisecond)
    defer cancel()

    time.Sleep(10 * time.Millisecond) // let it expire

    // ctx has expired, so callService's ctx.Err() check rejects immediately
    err := callService(ctx, "123")
    if err != nil {
        fmt.Println("expected:", err) // context deadline exceeded
    }
    // This only works because callService checks. A function that takes a
    // ctx and never reads it will happily run the full operation against a
    // context that expired ten minutes ago, and no caller can tell.
}
```

---
