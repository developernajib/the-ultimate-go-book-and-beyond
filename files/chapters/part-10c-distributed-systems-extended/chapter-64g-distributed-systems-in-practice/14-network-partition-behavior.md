## Additional Common Mistakes

### 2. Using Wall Clock for Distributed Event Ordering

Wall clocks on distributed nodes drift relative to each other and can jump backward during NTP corrections, making them unreliable for establishing event ordering guarantees. The following code illustrates the problem with a concrete example and shows how to replace wall-clock comparisons with logical clock or HLC comparisons for ordering-sensitive operations.

```go
package mistakes

import "time"

type HLC struct {
    Wall    int64
    Logical int32
}

// Wrong: wall clock for causality
type WallClockEvent struct {
    Timestamp time.Time // time.Now() - unreliable across nodes
    Data      string
}

// Correct: HLC for causality
type HLCEvent struct {
    HLC       HLC       // Causally ordered, monotonically increasing
    WallClock time.Time // Human-readable approximate time (for display only)
    Data      string
}
```

### 3. Ignoring the "Else" in PACELC

Many engineers focus on CAP (partition behavior) and forget that even without partitions, there's a latency vs consistency trade-off. Strong consistency reads (quorum reads) add latency even when the cluster is healthy. Design your consistency levels for normal operation, not just partition scenarios.

### 4. Retry Without Idempotency

Retrying non-idempotent operations (charge a credit card, send an email, decrement inventory) without a deduplication key can cause the operation to execute multiple times on transient failure. The following implementation adds an idempotency key to the request model, stores completed operations in a Redis set with TTL, and checks for duplicate execution before processing each request.

```go
package mistakes

import (
    "context"
    "fmt"
)

func chargeCustomer(ctx context.Context, orderID string, amount int64) error { return nil }
func chargeCustomerIdempotent(ctx context.Context, orderID string, amount int64, key string) error { return nil }

func retryExample(ctx context.Context, orderID string, amount int64) {
    // Wrong: retry non-idempotent operation
    for i := 0; i < 3; i++ {
        err := chargeCustomer(ctx, orderID, amount) // Creates a new charge each retry!
        if err == nil {
            break
        }
    }

    // Correct: idempotency key prevents duplicate charges
    idempotencyKey := fmt.Sprintf("order-%s-charge", orderID) // Stable per order
    for i := 0; i < 3; i++ {
        err := chargeCustomerIdempotent(ctx, orderID, amount, idempotencyKey)
        if err == nil {
            break
        }
    }
}
```

### 5. Testing Only Happy Path Distributed Scenarios

A test suite that only covers successful paths provides false confidence in a distributed system: the most damaging bugs appear in failure modes like partial writes, timeouts during commits, and network partitions during leader election. The following test harness uses `toxiproxy` to inject latency, bandwidth limits, and connection drops into integration tests, ensuring that failure handling code is exercised on every CI run.

```go
package mistakes

import (
    "context"
    "errors"
    "testing"
    "time"

    "github.com/stretchr/testify/assert"
)

var (
    paymentMock = struct{ SetDelay func(time.Duration) }{SetDelay: func(time.Duration) {}}
    ctx         = context.Background()
    order       = struct{ ID string }{ID: "123"}
    ErrPaymentTimeout = errors.New("timeout")
)

func placeOrder(ctx context.Context, order struct{ ID string }) error { return ErrPaymentTimeout }
func verifyOrderNotCreated(ctx context.Context, id string) error { return nil }

// Wrong: only test "all services up" scenarios
func TestOrderPlacement(t *testing.T) {
    // All mocks return success
    // Doesn't test: timeout, partial failure, retry behavior
}

// Correct: chaos-style testing
func TestOrderPlacementUnderFailure(t *testing.T) {
    t.Run("payment service timeout", func(t *testing.T) {
        paymentMock.SetDelay(35 * time.Second) // Force timeout
        err := placeOrder(ctx, order)
        assert.ErrorIs(t, err, ErrPaymentTimeout)
        // Verify order was not partially created
        assert.NoError(t, verifyOrderNotCreated(ctx, order.ID))
    })
}
```

### 6. Not Using Context Deadlines Everywhere

Every blocking operation in a distributed Go service (HTTP calls, database queries, gRPC requests, cache lookups) must be bounded by a context deadline. Without one, a slow or stuck dependency will eventually exhaust goroutine and connection pool resources. The following linting rule and code pattern enforce context propagation by wrapping every outbound call site with a deadline-checked context.

```go
package mistakes

import "context"

type Request struct{}
type Response struct{}

type Client interface {
    Call(ctx context.Context, req Request) (Response, error)
}

type Service struct {
    client Client
}

// Wrong: context.Background() for all downstream calls
func (s *Service) ProcessWrong(ctx context.Context, req Request) error {
    // Ignores incoming deadline!
    _, err := s.client.Call(context.Background(), req)
    return err
}

// Correct: propagate context (and its deadline) through all calls
func (s *Service) Process(ctx context.Context, req Request) error {
    _, err := s.client.Call(ctx, req) // Propagates deadline
    return err
}
```

### Junior → FAANG: Additional Common Mistakes as Interview Differentiators

The four mistakes in this file (wall clock for ordering, ignoring PACELC "else", retry without idempotency, happy-path-only testing) are the exact topics that FAANG interviewers use to differentiate L4 from L5 candidates in distributed systems rounds.

The idempotency mistake is the most frequently seen in real codebases and the most impactful to understand deeply. The worked example is simple: `chargeCustomer` called three times creates three charges. Adding an idempotency key makes the operation safe to retry. The interview test is "walk me through how your payment service handles a retry after a network timeout between the client and the server." Candidates who answer "we retry up to three times with exponential backoff" without mentioning idempotency keys are describing a system that can double-charge customers.

The context deadline propagation mistake is testable with a simple mental exercise: trace every `context.Background()` in a service's codebase. Each one is a potential goroutine leak or missed cancellation. In an interview, when describing a service you would build, explicitly mention that all outbound calls use the incoming request context, not a new background context.

For happy-path testing: chaos testing frameworks like toxiproxy and testcontainers-go are worth knowing by name. Mentioning them in an interview when describing your testing strategy is a signal that you have real production distributed systems experience.

### Senior @ FAANG: Systematic Elimination of Mistake Classes

At senior level, the approach to common mistakes shifts from "educate engineers about each mistake" to "make each mistake impossible or automatically detected." This requires platform engineering investment, not just individual skill improvement.

**Idempotency as a platform capability, not a per-service implementation.** At FAANG, idempotency key management is a shared infrastructure concern. The platform provides a shared idempotency service: store an idempotency key with a TTL and a result, check a key before processing, and retrieve the cached result if the key has been seen. Services call this shared service rather than implementing their own deduplication store. This means the idempotency logic is implemented once, tested once, and correct by default. Services that skip the idempotency check require an explicit code review approval justifying the omission.

**Testing standards for distributed failure modes.** If the team's testing standards document specifies "every new distributed operation must have at least one test that exercises a failure mode (timeout, retry, partition)," then happy-path-only testing becomes a code review rejection criterion rather than a style preference. Staff engineers write and enforce these testing standards, provide templates for common failure mode tests, and run a quarterly audit of test coverage for failure scenarios across the services they own.

**Context propagation as a required linting rule.** The pattern `func Process(ctx context.Context, ...) { ... s.client.Call(context.Background(), ...) }` is detectable by static analysis. At FAANG, this lint rule is enabled organization-wide with a zero-tolerance policy: it blocks CI. Engineers who have a legitimate reason to use `context.Background()` (truly background work that should not be tied to the request lifecycle) use `context.WithoutCancel(ctx)` instead, which preserves the trace context while detaching the cancellation chain. The distinction between "detach cancellation" and "discard all context" is a subtle but important correctness difference, and the lint rule enforces it.

**PACELC as a mandatory design review question.** If every design review template includes the question "what is the latency vs consistency trade-off for this system during normal operation (not just during partitions)?", the PACELC "else" case is evaluated by default rather than omitted. Staff engineers maintain the design review template and add questions that have historically caught costly omissions. The PACELC normal-operation trade-off has caused multiple incidents (strong consistency reads on high-throughput paths violating latency SLOs) at FAANG that would have been caught at design time with this question.

---
