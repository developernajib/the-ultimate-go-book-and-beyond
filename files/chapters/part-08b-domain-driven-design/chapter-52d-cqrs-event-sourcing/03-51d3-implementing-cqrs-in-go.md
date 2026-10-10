## 52D.3 Implementing CQRS in Go

### Command Bus

The command bus routes commands to their registered handlers:

```go
// internal/cqrs/command_bus.go

package cqrs

import (
    "context"
    "fmt"
    "sync"
)

// Command is the marker interface for all commands.
// Commands are named in the imperative: PlaceOrder, CancelOrder, TransferFunds.
type Command interface {
    CommandName() string
}

// CommandHandler handles a specific command type.
type CommandHandler[C Command] interface {
    Handle(ctx context.Context, cmd C) error
}

// CommandBus routes commands to their registered handlers.
type CommandBus struct {
    mu       sync.RWMutex
    handlers map[string]commandHandlerFunc
}

// commandHandlerFunc is the internal handler signature.
type commandHandlerFunc func(ctx context.Context, cmd Command) error

// NewCommandBus creates a new command bus.
func NewCommandBus() *CommandBus {
    return &CommandBus{
        handlers: make(map[string]commandHandlerFunc),
    }
}

// Register registers a command handler for a specific command type.
// Uses generics to ensure type safety at registration time.
func Register[C Command](bus *CommandBus, handler CommandHandler[C]) {
    var zero C
    commandName := zero.CommandName()

    bus.mu.Lock()
    defer bus.mu.Unlock()

    bus.handlers[commandName] = func(ctx context.Context, cmd Command) error {
        typedCmd, ok := cmd.(C)
        if !ok {
            return fmt.Errorf("command bus: type mismatch for %s: expected %T, got %T",
                commandName, zero, cmd)
        }
        return handler.Handle(ctx, typedCmd)
    }
}

// Dispatch routes the command to its registered handler.
func (b *CommandBus) Dispatch(ctx context.Context, cmd Command) error {
    b.mu.RLock()
    handler, ok := b.handlers[cmd.CommandName()]
    b.mu.RUnlock()

    if !ok {
        return fmt.Errorf("no handler registered for command %q", cmd.CommandName())
    }
    return handler(ctx, cmd)
}

// Middleware is a function that wraps a commandHandlerFunc.
type Middleware func(commandHandlerFunc) commandHandlerFunc

// Use applies middleware to all registered handlers (must be called before Register).
// Useful for logging, tracing, and metrics.
func (b *CommandBus) Use(middleware Middleware) {
    b.mu.Lock()
    defer b.mu.Unlock()
    for name, handler := range b.handlers {
        b.handlers[name] = middleware(handler)
    }
}
```

### Query Bus

The interface definition below establishes the contract that both production implementations and test doubles must satisfy, enabling dependency inversion across the layer boundary.

```go
// internal/cqrs/query_bus.go

package cqrs

import (
    "context"
    "fmt"
    "sync"
)

// Query is the marker interface for all queries.
// Queries are named descriptively: GetOrder, ListCustomerOrders.
type Query interface {
    QueryName() string
}

// QueryResult is the result type for queries.
type QueryResult any

// QueryHandler handles a specific query type.
type QueryHandler[Q Query, R QueryResult] interface {
    Handle(ctx context.Context, q Q) (R, error)
}

// QueryBus routes queries to their registered handlers.
type QueryBus struct {
    mu       sync.RWMutex
    handlers map[string]queryHandlerFunc
}

// queryHandlerFunc is the internal handler signature.
type queryHandlerFunc func(ctx context.Context, q Query) (QueryResult, error)

// NewQueryBus creates a new query bus.
func NewQueryBus() *QueryBus {
    return &QueryBus{
        handlers: make(map[string]queryHandlerFunc),
    }
}

// RegisterQuery registers a query handler for a specific query type.
func RegisterQuery[Q Query, R QueryResult](bus *QueryBus, handler QueryHandler[Q, R]) {
    var zero Q
    queryName := zero.QueryName()

    bus.mu.Lock()
    defer bus.mu.Unlock()

    bus.handlers[queryName] = func(ctx context.Context, q Query) (QueryResult, error) {
        typedQ, ok := q.(Q)
        if !ok {
            return nil, fmt.Errorf("query bus: type mismatch for %s", queryName)
        }
        return handler.Handle(ctx, typedQ)
    }
}

// Ask routes the query to its registered handler and returns the result.
func Ask[R QueryResult](ctx context.Context, bus *QueryBus, q Query) (R, error) {
    bus.mu.RLock()
    handler, ok := bus.handlers[q.QueryName()]
    bus.mu.RUnlock()

    var zero R
    if !ok {
        return zero, fmt.Errorf("no handler registered for query %q", q.QueryName())
    }

    result, err := handler(ctx, q)
    if err != nil {
        return zero, err
    }

    typedResult, ok := result.(R)
    if !ok {
        return zero, fmt.Errorf("query bus: result type mismatch for %s", q.QueryName())
    }
    return typedResult, nil
}
```

### Middleware: Logging and Tracing

The logging and tracing middleware wraps command and query handlers in the decorator pattern: each middleware receives the next handler as a function argument and returns a new handler, so the bus can compose an arbitrary chain of cross-cutting concerns (logging, metrics, idempotency) without modifying the core handler logic.

```go
// internal/cqrs/middleware.go

package cqrs

import (
    "context"
    "log/slog"
    "time"
)

// LoggingMiddleware logs command dispatch and timing.
func LoggingMiddleware(logger *slog.Logger) Middleware {
    return func(next commandHandlerFunc) commandHandlerFunc {
        return func(ctx context.Context, cmd Command) error {
            start := time.Now()
            err := next(ctx, cmd)
            duration := time.Since(start)

            if err != nil {
                logger.Error("command failed",
                    "command", cmd.CommandName(),
                    "duration_ms", duration.Milliseconds(),
                    "error", err.Error(),
                )
            } else {
                logger.Info("command succeeded",
                    "command", cmd.CommandName(),
                    "duration_ms", duration.Milliseconds(),
                )
            }
            return err
        }
    }
}

// RecoveryMiddleware recovers from panics in command handlers.
func RecoveryMiddleware(logger *slog.Logger) Middleware {
    return func(next commandHandlerFunc) commandHandlerFunc {
        return func(ctx context.Context, cmd Command) (err error) {
            defer func() {
                if r := recover(); r != nil {
                    logger.Error("panic in command handler",
                        "command", cmd.CommandName(),
                        "panic", r,
                    )
                    err = fmt.Errorf("internal error handling command %s", cmd.CommandName())
                }
            }()
            return next(ctx, cmd)
        }
    }
}
```

### Complete Wiring Example

The wiring example shows how `cqrs.Register` binds concrete handler types to the generic buses using Go's type inference, and how the middleware chain is applied once at startup so that every command and query automatically receives logging and idempotency checks without each handler opting in individually.

```go
// Wire command bus in main.go

cmdBus := cqrs.NewCommandBus()
queryBus := cqrs.NewQueryBus()

// Register command handlers
cqrs.Register(cmdBus, orderapp.NewPlaceOrderHandler(orderRepo))
cqrs.Register(cmdBus, orderapp.NewCancelOrderHandler(orderRepo, idempotencyStore))
cqrs.Register(cmdBus, orderapp.NewConfirmOrderHandler(orderRepo))
cqrs.Register(cmdBus, orderapp.NewFulfillOrderHandler(orderRepo))

// Apply middleware to all handlers
cmdBus.Use(cqrs.LoggingMiddleware(logger))
cmdBus.Use(cqrs.RecoveryMiddleware(logger))

// Register query handlers
cqrs.RegisterQuery(queryBus, orderapp.NewGetOrderHandler(queryRepo))
cqrs.RegisterQuery(queryBus, orderapp.NewListCustomerOrdersHandler(queryRepo))
```

### Junior → FAANG: Tracing the Generic Wiring by Hand

The generic command and query buses are the most technically dense code in this chapter. If you are newer to Go generics, the `Register[C Command]` function signature may look opaque. Work through it step by step.

`Register[C Command]` declares a type parameter `C` constrained to the `Command` interface. When you call `Register(cmdBus, orderapp.NewPlaceOrderHandler(orderRepo))`, Go infers `C` as `PlaceOrderCommand` from the handler's type. The `var zero C` trick instantiates a zero value of that type to call `CommandName()` for the registry key. The returned `commandHandlerFunc` closure captures the type assertion `cmd.(C)` so that every call to the handler is type-checked without reflection on the hot path.

Read through that closure three times until you can explain it to someone else. The pattern (type-safe registry with a closure over a concrete type) appears repeatedly in Go infrastructure code. Understanding it here means you will recognize it in real codebases.

The middleware pattern is the decorator pattern in functional style. Each `Middleware` wraps the next handler and returns a new handler. The order of `cmdBus.Use()` calls matters: the first middleware applied is the outermost wrapper. Draw the call stack for a command that goes through logging then recovery, and verify you understand which middleware executes first.

For your first-job habits: do not add middleware to a bus until you have a failing test that demonstrates you need it. Logging middleware should produce structured logs with the command name and duration. Write a test that captures the log output and asserts the fields are present. This makes middleware correctness visible rather than assumed.

### Senior @ FAANG: Bus Design Trade-offs at Platform Scale

The bus implementations in this section are correct and idiomatic for a single service. At platform scale, the design decisions exposed here have broader implications.

The `commandHandlerFunc` internal type (a plain function) rather than an interface is a deliberate choice for composition: functions compose with closures while interfaces require wrapper types. The trade-off is that `commandHandlerFunc` is opaque to reflection and tooling. If you build a platform that needs to enumerate registered handlers for documentation or routing rules, you lose that visibility. One extension: store a `HandlerMetadata` alongside each handler registration (name, description, expected latency, idempotency contract) and expose it as a registry endpoint. This turns the bus from an internal wiring detail into a service's self-describing API contract.

The `Use` method applies middleware retroactively to all registered handlers. This is convenient but has a subtle ordering guarantee: middleware applied before registrations is missed. The implementation processes only already-registered handlers. For a platform shared library, the safer design is to apply a fixed middleware chain at dispatch time rather than mutating handler registrations. This makes the execution model deterministic regardless of registration order.

Idempotency is conspicuously absent from the middleware examples. A production command bus at L6/L7 scope needs an idempotency middleware: extract an idempotency key from the command (often a UUID the client generates), check a `processed_commands` store, skip re-execution if already processed, return the stored result. The store must be transactional with the command effect. Without this, any retry (HTTP client timeout, network partition, at-least-once delivery from a queue) can duplicate side effects. Writing this middleware correctly is the interview question that distinguishes candidates who have operated distributed systems from those who have only designed them on paper.

The query bus's `Ask` function uses a generic return type that requires a type assertion at the call site. This is a known limitation of Go's type system: the bus registry stores `any` internally, so the type is lost and must be reasserted. An alternative design uses a `Result[R]` wrapper and returns it from the handler, pushing the assertion into the handler registration rather than the call site. Neither approach is perfect. The one in this section optimizes for ergonomic call sites at the cost of a runtime assertion. Document the trade-off in your team's ADR.

---
