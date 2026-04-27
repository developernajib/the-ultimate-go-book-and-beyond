export default `## 10C.17 Context Disasters

The \`context\` package is central to Go's approach to cancellation, timeouts, and request-scoped values. However, misusing it leads to subtle bugs: passing a \`nil\` context causes panics, using string keys for context values leads to collisions between packages, and ignoring \`ctx.Done()\` in goroutines causes them to leak when the parent request has already been cancelled. Context should always be the first parameter of a function and should never be stored in a struct field.

\`\`\`go
package main

import (
    "context"
    "fmt"
    "time"
)

// TRAP 1: Passing nil context
func callService(ctx context.Context, id string) error {
    // ctx.Value() on nil panics!
    // ctx.Deadline() on nil panics!
    if ctx == nil {
        panic("nil context") // will panic if caller passes nil
    }
    return nil
}

func callerBug() {
    // callService(nil, "123") // panic: nil pointer dereference
    // CORRECT:
    callService(context.Background(), "123")
    callService(context.TODO(), "123") // use TODO() when you'll fill it in later
}

// TRAP 2: Context value key collisions using string keys
func trap2() {
    ctx := context.Background()

    // DISASTER: package A and package B both use string "userID" as key
    // They'll collide if the context is shared!
    ctx = context.WithValue(ctx, "userID", "alice")
    ctx = context.WithValue(ctx, "userID", "bob") // silently overwrites

    val := ctx.Value("userID")
    fmt.Println(val) // "bob" - alice is gone

    // CORRECT: Use package-private unexported type as key
    ctx2 := context.WithValue(ctx, contextKeyUserID{}, "alice")
    fmt.Println(ctx2.Value(contextKeyUserID{})) // "alice" - collision-safe
}

// contextKeyUserID is an unexported type - cannot collide with other packages
type contextKeyUserID struct{}

// TRAP 3: Ignoring context cancellation - goroutine leak
func leakyFetch(ctx context.Context) {
    go func() {
        // This goroutine never checks ctx.Done() - if ctx is cancelled,
        // this goroutine leaks until the long operation completes
        time.Sleep(10 * time.Minute) // simulate slow operation
        fmt.Println("done") // may never run if service shuts down
    }()
}

// CORRECT: Always respect context cancellation
func respectedFetch(ctx context.Context, results chan<- string) {
    go func() {
        select {
        case <-ctx.Done():
            return // exit when context is cancelled
        case <-time.After(100 * time.Millisecond):
            results <- "result"
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

// TRAP 5: Using context after it's been cancelled
func cancelledContextUsage() {
    ctx, cancel := context.WithTimeout(context.Background(), 1*time.Millisecond)
    defer cancel()

    time.Sleep(10 * time.Millisecond) // let it expire

    // ctx is now cancelled - operations using it will fail
    err := callService(ctx, "123")
    if err != nil {
        fmt.Println("expected:", err) // context deadline exceeded
    }
}
\`\`\`

---
`;
