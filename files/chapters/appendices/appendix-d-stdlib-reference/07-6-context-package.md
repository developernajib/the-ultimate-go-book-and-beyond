## 6. context Package

### Context Basics

A `context.Context` carries deadlines, cancellation signals, and request-scoped values across API boundaries. Start with `context.Background()` at the top of your call chain and derive child contexts with `WithCancel`, `WithTimeout`, or `WithValue`.

```go
package main

import (
    "context"
    "fmt"
    "time"
)

func contextBasics() {
    // Background context - top-level, never canceled
    ctx := context.Background()

    // TODO context - placeholder when unsure which context to use
    todoCtx := context.TODO()

    _, _ = ctx, todoCtx
}

// Context with cancellation
func cancellationExample() {
    ctx, cancel := context.WithCancel(context.Background())
    defer cancel() // Always call cancel to release resources

    go func() {
        time.Sleep(2 * time.Second)
        cancel() // Cancel the context
    }()

    select {
    case <-ctx.Done():
        fmt.Println("Context canceled:", ctx.Err())
    }
}

// Context with timeout
func timeoutExample() {
    ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
    defer cancel()

    select {
    case <-time.After(5 * time.Second):
        fmt.Println("Operation completed")
    case <-ctx.Done():
        fmt.Println("Operation timed out:", ctx.Err())
    }
}

// Context with deadline
func deadlineExample() {
    deadline := time.Now().Add(3 * time.Second)
    ctx, cancel := context.WithDeadline(context.Background(), deadline)
    defer cancel()

    // Check remaining time
    if d, ok := ctx.Deadline(); ok {
        remaining := time.Until(d)
        fmt.Printf("Context expires in %v\n", remaining)
    }

    <-ctx.Done()
    fmt.Println("Deadline reached:", ctx.Err())
}
```

### Context Values

```go
package main

import (
    "context"
    "fmt"
)

// Define custom type for context keys (best practice)
type contextKey string

const (
    userIDKey    contextKey = "userID"
    requestIDKey contextKey = "requestID"
)

func contextValuesExample() {
    // Store values in context
    ctx := context.Background()
    ctx = context.WithValue(ctx, userIDKey, "12345")
    ctx = context.WithValue(ctx, requestIDKey, "req-abc-123")

    // Retrieve values
    userID, ok := ctx.Value(userIDKey).(string)
    if ok {
        fmt.Println("User ID:", userID)
    }

    requestID := ctx.Value(requestIDKey).(string)
    fmt.Println("Request ID:", requestID)
}

// WARNING: Don't use context.Value for:
// - Optional function parameters
// - Passing data that functions need to do their job
//
// DO use context.Value for:
// - Request-scoped data (user ID, trace ID, etc.)
// - Data that crosses API boundaries
// - Data not essential for function operation

// Better approach: Explicit parameters
func ProcessUserOrder(ctx context.Context, userID string, orderID string) error {
    // Good: userID and orderID are explicit parameters
    // Context is only for cancellation/timeout
    return nil
}

// Avoid this pattern:
func ProcessUserOrderBad(ctx context.Context) error {
    // Bad: Required data hidden in context
    userID := ctx.Value(userIDKey).(string)
    orderID := ctx.Value("orderID").(string) // Even worse: string key
    _, _ = userID, orderID
    return nil
}
```

### Context Patterns

```go
package main

import (
    "context"
    "fmt"
    "time"
)

// Pattern 1: Propagate context through call chain
func handleRequest(ctx context.Context) error {
    return processRequest(ctx)
}

func processRequest(ctx context.Context) error {
    return queryDatabase(ctx)
}

func queryDatabase(ctx context.Context) error {
    // Check if context is canceled before expensive operation
    select {
    case <-ctx.Done():
        return ctx.Err()
    default:
    }

    // Do database query
    return nil
}

// Pattern 2: Create child context with different timeout
func handleHTTPRequest(ctx context.Context) error {
    // Overall request has 10s timeout
    // But database query should only take 2s
    dbCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
    defer cancel()

    if err := queryDatabase(dbCtx); err != nil {
        return err
    }

    // Other operations can use the parent context
    return nil
}

// Pattern 3: Graceful shutdown
func worker(ctx context.Context) {
    ticker := time.NewTicker(1 * time.Second)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            fmt.Println("Worker shutting down:", ctx.Err())
            return
        case <-ticker.C:
            fmt.Println("Worker doing work")
        }
    }
}

func gracefulShutdownExample() {
    ctx, cancel := context.WithCancel(context.Background())

    // Start workers
    go worker(ctx)
    go worker(ctx)

    // Simulate shutdown signal
    time.Sleep(5 * time.Second)
    fmt.Println("Initiating shutdown")
    cancel()

    // Wait for cleanup
    time.Sleep(1 * time.Second)
}

// Pattern 4: Multiple operations with shared deadline
func orchestrateOperations(ctx context.Context) error {
    // All operations share the same deadline
    ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
    defer cancel()

    // Start operations concurrently
    errCh := make(chan error, 3)

    go func() {
        errCh <- operation1(ctx)
    }()
    go func() {
        errCh <- operation2(ctx)
    }()
    go func() {
        errCh <- operation3(ctx)
    }()

    // Wait for all operations
    for i := 0; i < 3; i++ {
        if err := <-errCh; err != nil {
            return err
        }
    }

    return nil
}

func operation1(ctx context.Context) error { return nil }
func operation2(ctx context.Context) error { return nil }
func operation3(ctx context.Context) error { return nil }
```

### Context Best Practices

```go
package main

import (
    "context"
    "time"
)

// DO: Context as first parameter
func DoWork(ctx context.Context, arg1 string, arg2 int) error {
    return nil
}

// DON'T: Context stored in struct
type BadServer struct {
    ctx context.Context // Don't do this
}

// DO: Pass context explicitly
type GoodServer struct {
    // No context field
}

func (s *GoodServer) HandleRequest(ctx context.Context) error {
    return nil
}

// DO: Check context cancellation in loops
func processItems(ctx context.Context, items []string) error {
    for _, item := range items {
        // Check cancellation
        select {
        case <-ctx.Done():
            return ctx.Err()
        default:
        }

        // Process item
        _ = item
    }
    return nil
}

// DO: Set reasonable timeouts
func makeAPICall(ctx context.Context) error {
    // Don't let context be indefinite
    if _, ok := ctx.Deadline(); !ok {
        var cancel context.CancelFunc
        ctx, cancel = context.WithTimeout(ctx, 30*time.Second)
        defer cancel()
    }

    // Make call
    return nil
}

// DON'T: Pass nil context
func badFunction() {
    // DoWork(nil, "test", 1) // Don't do this

    // DO: Use context.Background() or context.TODO()
    DoWork(context.Background(), "test", 1)
}
```

---
