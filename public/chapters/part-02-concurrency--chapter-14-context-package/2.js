export default `## 14.1 Understanding Context

The \`context\` package, introduced in Go 1.7, provides a standardized way to manage request lifecycles across API boundaries. It solves three critical problems in distributed systems:

1. **Cancellation propagation**: When a request is cancelled, all downstream operations should stop
2. **Deadline management**: Operations should respect time limits from callers
3. **Request-scoped data**: Certain data (trace IDs, authentication) must flow through the call chain

### The Context Interface

The \`context.Context\` interface is intentionally minimal, four methods that together express everything a downstream function needs to know about its execution environment. \`Done()\` returns a channel that is closed on cancellation or timeout, enabling goroutines to react by selecting on it alongside their own work. \`Err()\` distinguishes between the two cancellation causes, while \`Value()\` provides a read-only lookup into the key-value pairs attached to the context tree.

\`\`\`go
type Context interface {
    // Deadline returns the time when this context will be cancelled.
    // ok is false when no deadline is set.
    Deadline() (deadline time.Time, ok bool)

    // Done returns a channel that is closed when the context is cancelled
    // or times out. Done is nil for contexts that can never be cancelled.
    Done() <-chan struct{}

    // Err returns nil if Done is not yet closed.
    // Otherwise, it returns Canceled if the context was cancelled
    // or DeadlineExceeded if the deadline passed.
    Err() error

    // Value returns the value associated with key, or nil if not set.
    // Use only for request-scoped data that transits API boundaries.
    Value(key any) any
}
\`\`\`

### Context Hierarchy Visualization

Contexts form an immutable tree: each \`WithCancel\`, \`WithTimeout\`, or \`WithValue\` call creates a new child node that wraps its parent without modifying it. When a node is cancelled, the cancellation signal propagates downward to every descendant, but never upward to the parent or sideways to siblings. The diagram below shows how a root \`Background\` context can spawn a chain of decorated children, each inheriting the strictest deadline and all accumulated values from its ancestors.

\`\`\`
┌─────────────────────────────────────────────────────────────────┐
│                    Context Hierarchy                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│    context.Background()                                          │
│           │                                                      │
│           ▼                                                      │
│    WithCancel(parent)  ─────────────► cancel()                  │
│           │                              │                       │
│           ▼                              ▼                       │
│    WithTimeout(parent, 30s)        All children                  │
│           │                        are cancelled                 │
│           ▼                                                      │
│    WithValue(parent, key, val)                                  │
│           │                                                      │
│           ▼                                                      │
│    WithDeadline(parent, time)                                   │
│           │                                                      │
│           ▼                                                      │
│      Child contexts inherit:                                     │
│      • Cancellation (always)                                    │
│      • Deadline (minimum of parent and self)                    │
│      • Values (from chain lookup)                               │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
\`\`\`

### Creating Contexts

\`context.Background()\` is the conventional root for production code such as \`main\` and server request handlers, while \`context.TODO()\` is a placeholder that signals the code has not yet been wired up properly. The Go 1.20 addition \`WithCancelCause\` improves observability by letting the caller attach a descriptive error to the cancellation rather than communicating only via the generic \`context.Canceled\` sentinel. Go 1.21 further extended the package with \`WithoutCancel\` for detaching long-running cleanup work and \`AfterFunc\` for registering cancellation callbacks without blocking a goroutine.

\`\`\`go
package main

import (
    "context"
    "fmt"
    "time"
)

func main() {
    // Background: Root context for main, init, tests
    // Never cancelled, no deadline, no values
    ctx := context.Background()

    // TODO: Placeholder when unsure what context to use
    // Use during development, replace before production
    ctx = context.TODO()

    // WithCancel: Manual cancellation
    ctx, cancel := context.WithCancel(context.Background())
    defer cancel() // Always call cancel!

    // WithDeadline: Absolute time deadline
    deadline := time.Now().Add(5 * time.Second)
    ctx, cancel = context.WithDeadline(context.Background(), deadline)
    defer cancel()

    // WithTimeout: Relative duration timeout
    ctx, cancel = context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()

    // WithValue: Request-scoped data
    type ctxKey string
    ctx = context.WithValue(context.Background(), ctxKey("requestID"), "abc-123")

    // WithCancelCause (Go 1.20+): Cancellation with reason
    ctx, cancelCause := context.WithCancelCause(context.Background())
    cancelCause(fmt.Errorf("user requested cancellation"))
    // context.Cause(ctx) returns the error

    // WithoutCancel (Go 1.21+): Detach from parent cancellation
    // Child will NOT be cancelled when parent is cancelled
    detached := context.WithoutCancel(ctx)
    _ = detached

    // AfterFunc (Go 1.21+): Register callback on cancellation
    stop := context.AfterFunc(ctx, func() {
        fmt.Println("Context cancelled!")
    })
    defer stop()
}
\`\`\`

### The Cancel Function Contract

The cancel function returned by \`WithCancel\`, \`WithDeadline\`, and \`WithTimeout\` **must** be called:

\`\`\`go
// WRONG: Cancel never called, resources leak
func badExample(ctx context.Context) error {
    ctx, _ = context.WithTimeout(ctx, 5*time.Second)  // Cancel discarded!
    return doWork(ctx)
}

// WRONG: Cancel only called on success path
func badExample2(ctx context.Context) error {
    ctx, cancel := context.WithTimeout(ctx, 5*time.Second)

    result, err := doWork(ctx)
    if err != nil {
        return err  // Cancel never called!
    }

    cancel()
    return result
}

// CORRECT: Always defer cancel
func goodExample(ctx context.Context) error {
    ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
    defer cancel()  // Always called, on all paths

    return doWork(ctx)
}
\`\`\`

Why call cancel even if the context times out naturally?
- Releases resources (goroutines, timers) associated with the context
- Allows garbage collection of the context tree
- The contract: caller of \`WithX\` is responsible for calling cancel

### Context as a First-Class Function Parameter

Every function in a modern Go codebase that might do I/O, block, or spawn a goroutine takes \`context.Context\` as the first parameter. The signature is fixed:

\`\`\`go
func DoSomething(ctx context.Context, args ...) (Result, error)
\`\`\`

The rules:

1. **First parameter, always.** Not second, not last, not in a struct. The convention is universal; violating it makes the function look wrong.
2. **Named \`ctx\`.** Not \`context\`, not \`c\`. One name, recognised by every Go engineer.
3. **Never nil.** If you have no context, use \`context.Background()\` at the entry point or \`context.TODO()\` during migration. Passing nil panics at runtime.
4. **Never stored in a struct.** Context lifetime is bound to a single operation (usually a request). Storing it in a struct means the struct now has a lifetime dependency on some request, which is almost always a bug.

### Staff Lens: Context Discipline Is a Review Invariant

The single fastest way to evaluate a Go codebase's maturity is to grep for context usage. Healthy codebases: every I/O function takes context, every RPC passes context through, every goroutine spawned from a request respects the request's context. Unhealthy codebases: context added sporadically, functions that should take context but do not, goroutines that run forever because they ignore their parent context. The staff-level investment is making the first pattern the default via team norms and review discipline.

---
`;
