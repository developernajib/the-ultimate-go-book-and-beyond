## 22B.5 Partial Failure Handling

### The Fan-Out Problem

Modern service architectures commonly fan out a single user request to multiple parallel upstream services. A product detail page might fan out to inventory, pricing, reviews, recommendations, and shipping, which is five concurrent calls. In a perfect world, all five succeed. In production, some will fail some of the time.

The question is: what do you return when three succeed and two fail?

The answer depends on which two failed. If pricing and inventory fail, you cannot show a valid product page, because you have no price to display and no stock information. Returning a partial result with "price unknown" is misleading and potentially harmful. Fail hard.

If reviews and recommendations fail, the core product information is intact. Return what you have. Tell the client what was missing. This is a partial result: useful, honest, and far better than returning nothing.

```
FAN-OUT PARTIAL FAILURE DECISION TREE

              ┌─────────────────────────────┐
              │       Fan-out N calls       │
              └───────────────┬─────────────┘
                              │
              ┌───────────────▼─────────────┐
              │    Collect all results      │
              │   (success AND failure)     │
              └───────────────┬─────────────┘
                              │
              ┌───────────────▼─────────────┐
              │   Are required calls OK?    │
              └──────┬──────────────┬───────┘
                     │ No           │ Yes
                     ▼              ▼
               Return 500     Return partial result
               or 503         with error metadata
                              (200 or 207)
```

### The PartialResult Type

To make partial failure a first-class concept in your code, you need a type that carries both successful data and structured error information in a single return value. The `PartialResult[T]` generic type below separates data from errors while also tracking whether any *required* source failed, giving callers the information they need to decide between serving a degraded response or returning an error to the client.

```go
package partial

import (
    "fmt"
    "strings"
)

// PartialResult holds the outcome of a fan-out operation where
// some sources may have failed.
type PartialResult[T any] struct {
    // Data contains the successfully fetched results.
    Data []T

    // Errors contains one entry per failed source.
    Errors []SourceError

    // RequiredFailed is true if any required source failed.
    RequiredFailed bool
}

// SourceError describes a failure from a specific named source.
type SourceError struct {
    Source    string
    Err       error
    Required  bool
    Transient bool // true if retry may succeed
}

func (e SourceError) Error() string {
    reqLabel := "optional"
    if e.Required {
        reqLabel = "required"
    }
    return fmt.Sprintf("source %q (%s) failed: %v", e.Source, reqLabel, e.Err)
}

// HasErrors returns true if any source failed.
func (r *PartialResult[T]) HasErrors() bool {
    return len(r.Errors) > 0
}

// FailedSources returns the names of all failed sources.
func (r *PartialResult[T]) FailedSources() []string {
    names := make([]string, 0, len(r.Errors))
    for _, e := range r.Errors {
        names = append(names, e.Source)
    }
    return names
}

// IsUsable returns true if the result can be served to a client
// (all required sources succeeded).
func (r *PartialResult[T]) IsUsable() bool {
    return !r.RequiredFailed
}

// Summary returns a human-readable description of the partial result.
func (r *PartialResult[T]) Summary() string {
    if !r.HasErrors() {
        return fmt.Sprintf("complete: %d items", len(r.Data))
    }
    return fmt.Sprintf("partial: %d items, failed: [%s]",
        len(r.Data), strings.Join(r.FailedSources(), ", "))
}
```

### Fan-Out Executor

With the result type defined, you need a concurrent executor that launches all sources in parallel, collects every outcome, success or failure, and assembles the final `PartialResult`. The `FanOut` function below uses a buffered channel sized to the number of sources so no goroutine ever blocks on send, and a `sync.WaitGroup` to know when all fetches have finished before closing the channel.

```go
package partial

import (
    "context"
    "errors"
    "sync"
)

// Source represents a named data source in a fan-out operation.
type Source[T any] struct {
    Name     string
    Required bool
    Fetch    func(ctx context.Context) (T, error)
}

// FanOut executes all sources concurrently and collects results.
// It returns a PartialResult with all successful results and all errors.
//
// FanOut returns when every source has returned, and NOT when ctx is
// canceled. Canceling ctx asks each Fetch to give up early, but a Fetch that
// does not select on ctx.Done() will keep running and FanOut will wait for
// it. The deadline you set is therefore only as real as the least
// well-behaved source: pass ctx to every network call you make inside Fetch.
// See FanOutWithDeadline below when you need a hard bound regardless.
func FanOut[T any](ctx context.Context, sources []Source[T]) *PartialResult[T] {
    type indexedResult struct {
        index int
        data  T
        err   error
    }

    results := make(chan indexedResult, len(sources))
    var wg sync.WaitGroup

    for i, src := range sources {
        wg.Add(1)
        go func(idx int, s Source[T]) {
            defer wg.Done()
            data, err := s.Fetch(ctx)
            results <- indexedResult{index: idx, data: data, err: err}
        }(i, src)
    }

    // Close results channel when all goroutines finish.
    go func() {
        wg.Wait()
        close(results)
    }()

    pr := &PartialResult[T]{}
    for res := range results {
        src := sources[res.index]
        if res.err != nil {
            se := SourceError{
                Source:    src.Name,
                Err:       res.err,
                Required:  src.Required,
                Transient: isTransient(res.err),
            }
            pr.Errors = append(pr.Errors, se)
            if src.Required {
                pr.RequiredFailed = true
            }
        } else {
            pr.Data = append(pr.Data, res.data)
        }
    }

    return pr
}

// FanOutWithDeadline behaves like FanOut but returns as soon as ctx is done,
// whether or not every source has finished. Sources still outstanding are
// recorded as failed with ctx.Err().
//
// This bounds the caller's latency. It does NOT stop a runaway Fetch: that
// goroutine keeps running until it returns on its own. The results channel is
// buffered with one slot per source precisely so a late send never blocks and
// never leaks the goroutine. Use this when a hard latency bound matters more
// than completeness, and fix the misbehaving source rather than relying on it.
func FanOutWithDeadline[T any](ctx context.Context, sources []Source[T]) *PartialResult[T] {
    type indexedResult struct {
        index int
        data  T
        err   error
    }

    results := make(chan indexedResult, len(sources))
    for i, src := range sources {
        go func(idx int, s Source[T]) {
            data, err := s.Fetch(ctx)
            results <- indexedResult{index: idx, data: data, err: err}
        }(i, src)
    }

    pr := &PartialResult[T]{}
    reported := make([]bool, len(sources))

    for n := 0; n < len(sources); n++ {
        select {
        case res := <-results:
            reported[res.index] = true
            src := sources[res.index]
            if res.err != nil {
                pr.Errors = append(pr.Errors, SourceError{
                    Source:    src.Name,
                    Err:       res.err,
                    Required:  src.Required,
                    Transient: isTransient(res.err),
                })
                if src.Required {
                    pr.RequiredFailed = true
                }
            } else {
                pr.Data = append(pr.Data, res.data)
            }

        case <-ctx.Done():
            // Attribute the deadline to every source that never reported.
            for i, done := range reported {
                if done {
                    continue
                }
                src := sources[i]
                pr.Errors = append(pr.Errors, SourceError{
                    Source:    src.Name,
                    Err:       ctx.Err(),
                    Required:  src.Required,
                    Transient: true,
                })
                if src.Required {
                    pr.RequiredFailed = true
                }
            }
            return pr
        }
    }

    return pr
}

// isTransient classifies an error as potentially retriable.
func isTransient(err error) bool {
    if err == nil {
        return false
    }
    // Network errors are transient.
    var netErr interface{ Timeout() bool }
    if errors.As(err, &netErr) && netErr.Timeout() {
        return true
    }
    // Context cancellation is not transient. The caller gave up.
    if errors.Is(err, context.Canceled) {
        return false
    }
    // Deadline exceeded on the root context is not transient for this request,
    // but may be transient for a retry with a new budget.
    if errors.Is(err, context.DeadlineExceeded) {
        return true
    }
    return false
}
```

### MultiError Aggregation

When a single operation involves several independent steps that can each fail, returning only the first error discards information the caller may need. `MultiError` collects all errors from a batch operation into a single value while implementing the standard `error` interface, and its `Unwrap() []error` method enables `errors.Is` and `errors.As` to inspect individual wrapped errors.

```go
// MultiError aggregates multiple errors into a single error value.
// It classifies them by severity for structured handling.
type MultiError struct {
    Errors []error
}

func (m *MultiError) Error() string {
    if len(m.Errors) == 0 {
        return "no errors"
    }
    msgs := make([]string, 0, len(m.Errors))
    for _, e := range m.Errors {
        msgs = append(msgs, e.Error())
    }
    return fmt.Sprintf("%d errors: [%s]", len(m.Errors), strings.Join(msgs, "; "))
}

func (m *MultiError) Unwrap() []error {
    return m.Errors
}

func (m *MultiError) Add(err error) {
    if err != nil {
        m.Errors = append(m.Errors, err)
    }
}

func (m *MultiError) AsError() error {
    if len(m.Errors) == 0 {
        return nil
    }
    return m
}
```

### HTTP 207 Multi-Status for Partial Responses

When a fan-out returns partial results, the HTTP status code matters. Using 200 implies complete success. Using 500 implies total failure. HTTP 207 Multi-Status is the usual choice for partial success, since it signals "some things worked, some did not."

One caveat worth knowing before you reach for it. 207 comes from WebDAV (RFC 4918), where it describes an XML `multistatus` body with a status per resource. Reusing it for JSON fan-out responses is established practice rather than anything the spec blesses, and intermediaries and client libraries treat it inconsistently, with some lumping it into a generic "2xx means fine" branch. That is survivable when the body is explicit about what failed, which is why the response below always carries `failed_sources`. If your clients are third parties you do not control, a plain 200 with an unambiguous `partial_success` field is the safer contract. What matters is not which of the two you pick but that you pick one and apply it consistently, so no caller mistakes partial data for complete data.

```go
// writePartialResponse writes a fan-out result as HTTP 207 Multi-Status
// or 200 (all OK) or 503 (required source failed).
func writePartialResponse[T any](w http.ResponseWriter, result *PartialResult[T]) {
    // Every header must be set BEFORE WriteHeader. WriteHeader serializes the
    // header map and sends it, so a Header().Set() after it is silently
    // discarded: no error, no panic, just a response with no Content-Type
    // that clients are left to sniff.
    w.Header().Set("Content-Type", "application/json")

    switch {
    case result.RequiredFailed:
        w.WriteHeader(http.StatusServiceUnavailable)
    case result.HasErrors():
        w.WriteHeader(http.StatusMultiStatus) // 207
    default:
        w.WriteHeader(http.StatusOK)
    }

    type responseBody[T any] struct {
        Data            []T           `json:"data"`
        FailedSources   []string      `json:"failed_sources,omitempty"`
        PartialSuccess  bool          `json:"partial_success,omitempty"`
        RequiredFailed  bool          `json:"required_failed,omitempty"`
    }

    body := responseBody[T]{
        Data:           result.Data,
        PartialSuccess: result.HasErrors() && !result.RequiredFailed,
        RequiredFailed: result.RequiredFailed,
    }
    if result.HasErrors() {
        body.FailedSources = result.FailedSources()
    }

    json.NewEncoder(w).Encode(body)
}
```

### Full Example: Parallel Data Fetcher with 5 Sources

This end-to-end example simulates a user dashboard that fans out to five upstream services, profile, orders, recommendations, notifications, and analytics, each with realistic latency and a configurable error rate. Two sources are marked required and three are optional, so the caller receives a usable partial result even when the optional services are degraded or slow beyond the 500 ms budget.

```go
package main

import (
    "context"
    "fmt"
    "math/rand/v2"
    "time"

    "your/module/partial"
)

type UserDashboardData struct {
    Source string
    Data   map[string]any
}

func fetchDashboard(ctx context.Context, userID string) *partial.PartialResult[UserDashboardData] {
    sources := []partial.Source[UserDashboardData]{
        {
            Name:     "profile",
            Required: true, // No dashboard can render without a profile.
            Fetch: func(ctx context.Context) (UserDashboardData, error) {
                return simulateFetch(ctx, "profile", 50*time.Millisecond, 0.01)
            },
        },
        {
            Name:     "orders",
            Required: true, // Orders history is required.
            Fetch: func(ctx context.Context) (UserDashboardData, error) {
                return simulateFetch(ctx, "orders", 120*time.Millisecond, 0.05)
            },
        },
        {
            Name:     "recommendations",
            Required: false, // Optional.
            Fetch: func(ctx context.Context) (UserDashboardData, error) {
                return simulateFetch(ctx, "recommendations", 200*time.Millisecond, 0.15)
            },
        },
        {
            Name:     "notifications",
            Required: false, // Optional.
            Fetch: func(ctx context.Context) (UserDashboardData, error) {
                return simulateFetch(ctx, "notifications", 80*time.Millisecond, 0.08)
            },
        },
        {
            Name:     "analytics_summary",
            Required: false, // Optional, and merely nice to have.
            Fetch: func(ctx context.Context) (UserDashboardData, error) {
                return simulateFetch(ctx, "analytics_summary", 300*time.Millisecond, 0.20)
            },
        },
    }

    // Apply a 500ms budget for the entire fan-out.
    ctx, cancel := context.WithTimeout(ctx, 500*time.Millisecond)
    defer cancel()

    result := partial.FanOut(ctx, sources)
    fmt.Printf("Dashboard result: %s\n", result.Summary())
    return result
}

func simulateFetch(ctx context.Context, name string, latency time.Duration, errorRate float64) (UserDashboardData, error) {
    // Simulate latency.
    select {
    case <-time.After(latency):
    case <-ctx.Done():
        return UserDashboardData{}, ctx.Err()
    }

    // Simulate random failures.
    if rand.Float64() < errorRate {
        return UserDashboardData{}, fmt.Errorf("source %q: simulated transient error", name)
    }

    return UserDashboardData{
        Source: name,
        Data:   map[string]any{"fetched": true, "source": name},
    }, nil
}
```

### Staff Lens: Mark Partial Responses Clearly

When returning partial results, the response must indicate which parts failed. Otherwise callers treat partial as complete and propagate incorrect data. HTTP 207 (Multi-Status), explicit `partial: true` field, or per-field null are all valid. Pick one and apply consistently.

---
