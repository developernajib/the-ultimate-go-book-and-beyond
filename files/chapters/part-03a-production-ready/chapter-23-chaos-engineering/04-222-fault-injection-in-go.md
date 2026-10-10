## 23.2 Fault Injection in Go

Fault injection is the core mechanism of chaos engineering. It means deliberately introducing errors, delays, or failures into specific parts of your system so you can observe how the rest of the system reacts. In Go, the standard library's interface-based design makes fault injection particularly clean: you can wrap an `http.Handler`, a `grpc.UnaryServerInterceptor`, or a `*sql.DB` with a thin layer that introduces faults at a configured rate. The implementations below show how to inject faults at the HTTP, gRPC, and database layers without modifying any of your application's business logic.

One rule governs all three. A fault injector is armed and disarmed by an operator while production traffic is flowing through it, which means the configuration is read by every request goroutine and written by whoever is running the experiment. Storing that configuration in a plain mutable struct is a data race, and `go test -race` will say so. Every injector below publishes its configuration through an `atomic.Pointer`, and treats the config value it loads as immutable for the life of the request. The swap is a single pointer store, so an abort switch takes effect on the next request rather than on the next deploy.

### HTTP Fault Injection Middleware

HTTP middleware is the least invasive injection point because it sits in front of every handler without touching business logic. `Injector` acts as a control plane: the zero configuration has `Enabled` false, which makes the middleware a pointer load and a branch, so it can be compiled into production builds and armed through a feature flag during a scheduled experiment. Latency injection with configurable jitter simulates realistic network variance rather than a perfectly uniform delay, which produces more faithful results when testing timeout and retry behavior.

Note the `sleepCtx` helper. A naive injector calls `time.Sleep`, which keeps sleeping long after the client has hung up or its deadline has passed. That turns a latency experiment into a goroutine leak under load, precisely when you least want one. Waiting on the request context instead means the injected delay respects the same cancellation every other part of the request path respects.

```go
package chaos

import (
    "context"
    "math/rand/v2"
    "net/http"
    "sync/atomic"
    "time"
)

// FaultConfig is immutable once published. To change the configuration,
// build a new value and hand it to Injector.Store.
type FaultConfig struct {
    Enabled       bool
    Latency       time.Duration
    LatencyJitter time.Duration
    ErrorRate     float64 // Fraction of requests to fail, 0 to 1
    ErrorCode     int     // HTTP status returned for injected failures
}

// Injector publishes a FaultConfig to the request path. The pointer swap is
// atomic, so an operator can arm or disarm an experiment while requests are
// in flight without racing the handlers reading it.
type Injector struct {
    cfg atomic.Pointer[FaultConfig]
}

func NewInjector() *Injector {
    inj := &Injector{}
    inj.Store(FaultConfig{})
    return inj
}

func (i *Injector) Store(c FaultConfig) { i.cfg.Store(&c) }
func (i *Injector) Load() FaultConfig   { return *i.cfg.Load() }

// Disable is the abort switch. It is one atomic store, it cannot fail, and it
// is safe to call from a signal handler or an HTTP endpoint.
func (i *Injector) Disable() { i.Store(FaultConfig{}) }

// sleepCtx waits for d and reports whether it slept the full duration.
// It returns false as soon as ctx is done.
func sleepCtx(ctx context.Context, d time.Duration) bool {
    t := time.NewTimer(d)
    defer t.Stop()
    select {
    case <-t.C:
        return true
    case <-ctx.Done():
        return false
    }
}

func (i *Injector) Middleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        cfg := i.Load()
        if !cfg.Enabled {
            next.ServeHTTP(w, r)
            return
        }

        if cfg.Latency > 0 {
            d := cfg.Latency
            if cfg.LatencyJitter > 0 {
                d += rand.N(cfg.LatencyJitter)
            }
            if !sleepCtx(r.Context(), d) {
                // The caller gave up while we were holding the request.
                // Stop burning a goroutine on a response nobody will read.
                return
            }
        }

        if cfg.ErrorRate > 0 && rand.Float64() < cfg.ErrorRate {
            code := cfg.ErrorCode
            if code == 0 {
                code = http.StatusInternalServerError
            }
            http.Error(w, "chaos: injected error", code)
            return
        }

        next.ServeHTTP(w, r)
    })
}
```

`ErrorRate` is the blast radius dial for this injector, and it is the only one it has. Ship it behind a config that also carries a deadline, and have whatever arms the experiment call `Disable` on a timer, so a forgotten experiment expires on its own instead of running until someone notices.

### gRPC Fault Injection

gRPC services use interceptors, the equivalent of middleware, to intercept unary calls before they reach handler functions. The injector below follows the same atomic publication pattern as the HTTP version and returns a real gRPC `status.Error` with a configurable `codes.Code`, which matters because gRPC clients read status codes semantically. A client whose service config declares a `retryPolicy` listing `UNAVAILABLE` in `retryableStatusCodes` will transparently retry the call, while `INTERNAL` is not in a conventional retryable set and surfaces straight to the caller. `WaitForReady` is a different knob and is often confused with this one: it controls whether an RPC waits for the channel to reach a ready state instead of failing fast, and it has no bearing on how a client reacts to a status the server actually returned.

The `codes.OK` guard is not defensive padding. `codes.Code` is an integer whose zero value is `codes.OK`, and `status.Error(codes.OK, msg)` returns a **nil error** by design. An injector that forwards an unset `ErrorCode` straight into `status.Error` therefore returns `(nil, nil)` on every request it believes it is failing: the handler is skipped, no error reaches the client, and gRPC is handed a nil response to marshal. The experiment reports a clean run while the service quietly returns nothing. Fail-closed on the zero value instead.

```go
package chaos

import (
    "context"
    "math/rand/v2"
    "sync/atomic"
    "time"

    "google.golang.org/grpc"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"
)

type GRPCFaultConfig struct {
    Enabled   bool
    Latency   time.Duration
    ErrorRate float64
    ErrorCode codes.Code
}

type GRPCInjector struct {
    cfg atomic.Pointer[GRPCFaultConfig]
}

func NewGRPCInjector() *GRPCInjector {
    inj := &GRPCInjector{}
    inj.Store(GRPCFaultConfig{})
    return inj
}

func (i *GRPCInjector) Store(c GRPCFaultConfig) { i.cfg.Store(&c) }
func (i *GRPCInjector) Load() GRPCFaultConfig   { return *i.cfg.Load() }
func (i *GRPCInjector) Disable()                { i.Store(GRPCFaultConfig{}) }

func (i *GRPCInjector) Unary() grpc.UnaryServerInterceptor {
    return func(
        ctx context.Context,
        req any,
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (any, error) {
        cfg := i.Load()
        if !cfg.Enabled {
            return handler(ctx, req)
        }

        if cfg.Latency > 0 {
            if !sleepCtx(ctx, cfg.Latency) {
                // The deadline the injected latency blew through. Report it
                // honestly rather than running the handler anyway.
                return nil, status.FromContextError(ctx.Err()).Err()
            }
        }

        if cfg.ErrorRate > 0 && rand.Float64() < cfg.ErrorRate {
            code := cfg.ErrorCode
            if code == codes.OK {
                // status.Error(codes.OK, ...) returns nil. Returning that
                // would hand gRPC a nil response and a nil error, so an
                // unset code becomes the one clients are meant to retry.
                code = codes.Unavailable
            }
            return nil, status.Error(code, "chaos: injected error")
        }

        return handler(ctx, req)
    }
}
```

### Database Fault Injection

Database slowness is one of the most common real-world failure modes and one of the hardest to reproduce in a test environment, making it a valuable chaos engineering target. `ChaosDB` wraps a `*sql.DB` and intercepts `QueryContext` and `ExecContext` calls, injecting latency or a synthetic error according to the published configuration. Because it exposes the same method signatures as the standard library's database methods, existing code that uses those methods can be pointed at a `ChaosDB` instance during experiments without any changes.

The injected error is a package-level sentinel rather than a fresh `errors.New` per call, so a test can assert `errors.Is(err, chaos.ErrChaosDB)` and a retry classifier upstream can tell an injected fault apart from a real one.

```go
package chaos

import (
    "context"
    "database/sql"
    "errors"
    "math/rand/v2"
    "sync/atomic"
    "time"
)

type DBFaultConfig struct {
    Enabled   bool
    Latency   time.Duration
    ErrorRate float64
}

// ErrChaosDB marks a fault this package injected, never one the database
// produced. Callers can match it with errors.Is.
var ErrChaosDB = errors.New("chaos: database fault injected")

type ChaosDB struct {
    db  *sql.DB
    cfg atomic.Pointer[DBFaultConfig]
}

func NewChaosDB(db *sql.DB) *ChaosDB {
    c := &ChaosDB{db: db}
    c.Store(DBFaultConfig{})
    return c
}

func (c *ChaosDB) Store(cfg DBFaultConfig) { c.cfg.Store(&cfg) }
func (c *ChaosDB) Disable()                { c.Store(DBFaultConfig{}) }

func (c *ChaosDB) injectFault(ctx context.Context) error {
    cfg := *c.cfg.Load()
    if !cfg.Enabled {
        return nil
    }

    if cfg.Latency > 0 && !sleepCtx(ctx, cfg.Latency) {
        return ctx.Err()
    }

    if cfg.ErrorRate > 0 && rand.Float64() < cfg.ErrorRate {
        return ErrChaosDB
    }

    return nil
}

func (c *ChaosDB) QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
    if err := c.injectFault(ctx); err != nil {
        return nil, err
    }
    return c.db.QueryContext(ctx, query, args...)
}

func (c *ChaosDB) ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error) {
    if err := c.injectFault(ctx); err != nil {
        return nil, err
    }
    return c.db.ExecContext(ctx, query, args...)
}
```

### Staff Lens: Fault Injection at Interface Boundaries

Go's interfaces make fault injection clean: wrap any interface implementation with a fault-injecting version. This is the right place to inject, at the boundary where your code meets external dependencies. Do not inject faults deep inside business logic. That is unrealistic.

The subtler point is that a fault injector is production code and deserves production scrutiny. Two of the bugs corrected above, an unsynchronised config struct and a zero value that silently means "no error", are the kind that make an experiment report success while doing something else entirely. A chaos tool that lies to you is worse than no chaos tool, because it converts an unknown into a false certainty. Run your injectors under `-race`, and write a test that asserts the injector actually fails the request when you tell it to.

---
