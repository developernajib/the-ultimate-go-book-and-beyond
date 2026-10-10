## 18.13 Company Case Studies

### Google: Testing at Scale

Google runs an enormous number of tests daily across its monorepo. Three practices stand out and transfer well: hermetic tests that construct all dependencies locally so results never depend on external state, a size classification that gates execution by expected resource cost, and property-based fuzzing for serialization round-trips.

```go
// 1. Hermetic Tests - Tests don't depend on external state
func TestPaymentProcessing_Hermetic(t *testing.T) {
    // Create isolated test environment
    env := newTestEnvironment(t)

    // All dependencies are local and controlled
    paymentGateway := env.MockPaymentGateway()
    db := env.InMemoryDB()
    clock := env.FakeClock()

    service := NewPaymentService(paymentGateway, db, clock)

    // Test runs identically every time
    result, err := service.ProcessPayment(ctx, payment)
    // ...
}

// 3. Property-Based Testing for Serialization
func FuzzProtoRoundTrip(f *testing.F) {
    f.Add([]byte{0x08, 0x96, 0x01}) // Sample protobuf

    f.Fuzz(func(t *testing.T, data []byte) {
        var msg MyProto
        if err := proto.Unmarshal(data, &msg); err != nil {
            return // Invalid proto is fine
        }

        // Re-encode and decode should match
        encoded, err := proto.Marshal(&msg)
        if err != nil {
            t.Fatal(err)
        }

        var msg2 MyProto
        if err := proto.Unmarshal(encoded, &msg2); err != nil {
            t.Fatal(err)
        }

        if !proto.Equal(&msg, &msg2) {
            t.Error("Round trip failed")
        }
    })
}
```

**On test size classification.** The idea is sound and worth stealing. Classify each test by resource cost, roughly: small means a single process with no I/O and no sleeping, medium means one machine with local I/O allowed, and large means multiple machines and real dependencies. Then run the cheap tier on every edit and the expensive tiers less often. Google's tooling enforces this at the build-system level, which is where the concept comes from.

Do not try to express it as a per-function build tag. **Go build constraints are per-file, and only ever at the very top of a file, before the package clause.** Tagging individual functions does not compile:

```
$ go vet ./...
size_test.go:5:1: misplaced //go:build comment
$ go test ./...
./size_test.go:5:3: misplaced compiler directive
FAIL    ts [build failed]
```

In Go, the size tiers become **files**, not functions:

```go
//go:build medium

// db_medium_test.go
package payment
```

Then `go test ./...` runs the small tier, and `go test -tags=medium ./...` adds the medium tier. If you want per-test granularity without splitting files, use `testing.Short()` and `-short` instead, since that is a runtime decision rather than a compile-time one.

**Google's testing principles:**

| Principle | Implementation |
|-----------|----------------|
| Test behavior, not implementation | Use interfaces, test public APIs |
| Prefer fakes over mocks | Implement lightweight versions |
| Tests must be deterministic | No random seeds, fake time |
| Tests own their data | No shared test databases |
| Mostly unit, fewer integration, fewest E2E | Follow the testing pyramid (see 18.0 for indicative ratios) |

### Uber: Testing Microservices

Uber runs a large Go microservice estate, and one artifact of that experience is public and widely used: `go.uber.org/goleak`, the goroutine-leak detector from 18.10. A service mesh of that size makes three concerns unavoidable, and the patterns below are how organizations at that scale address them, whatever the logo.

Contract verification means that when one service changes its API, consuming services' expectations are checked automatically rather than discovered in production. Chaos injection puts random failures and latency into handlers so integration tests prove that retry and circuit-breaker logic actually fires. Leak detection is table stakes once you have thousands of long-lived processes, because a goroutine leaked per request is an outage on a schedule.

```go
// 1. Contract Testing with Pact
// consumer_test.go
package consumer

import (
    "errors"
    "fmt"
    "testing"

    "github.com/pact-foundation/pact-go/dsl"
)

func TestUserServiceConsumer(t *testing.T) {
    // Create Pact mock server
    pact := dsl.Pact{
        Consumer: "OrderService",
        Provider: "UserService",
    }
    defer pact.Teardown()

    // Define expected interaction
    pact.
        AddInteraction().
        Given("User 123 exists").
        UponReceiving("A request for user 123").
        WithRequest(dsl.Request{
            Method: "GET",
            Path:   dsl.String("/users/123"),
        }).
        WillRespondWith(dsl.Response{
            Status: 200,
            Body: dsl.Match(User{
                ID:   dsl.Like(123),
                Name: dsl.Like("John"),
            }),
        })

    // Test against mock server
    err := pact.Verify(func() error {
        // The v1 mock server exposes its port, not a URL: build the
        // address the same way the official consumer example does.
        client := NewUserClient(fmt.Sprintf("http://localhost:%d", pact.Server.Port))
        user, err := client.GetUser(123)
        if err != nil {
            return err
        }
        if user.ID != 123 {
            return errors.New("unexpected user ID")
        }
        return nil
    })

    if err != nil {
        t.Fatal(err)
    }
}

// 2. Chaos Testing Integration
type ChaosMiddleware struct {
    failureRate float64
    latency     time.Duration
    enabled     bool
}

func (c *ChaosMiddleware) Wrap(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        if !c.enabled {
            next.ServeHTTP(w, r)
            return
        }

        // Random failure
        if rand.Float64() < c.failureRate {
            http.Error(w, "chaos failure", http.StatusServiceUnavailable)
            return
        }

        // Random latency
        time.Sleep(c.latency)
        next.ServeHTTP(w, r)
    })
}

func TestWithChaos(t *testing.T) {
    if testing.Short() {
        t.Skip("skipping chaos test in short mode")
    }

    chaos := &ChaosMiddleware{
        failureRate: 0.1, // 10% failures
        latency:     100 * time.Millisecond,
        enabled:     true,
    }

    handler := chaos.Wrap(myHandler)
    server := httptest.NewServer(handler)
    defer server.Close()

    // Service should handle failures gracefully
    client := NewResilientClient(server.URL)

    successes := 0
    for i := 0; i < 100; i++ {
        if _, err := client.DoRequest(); err == nil {
            successes++
        }
    }

    // Should succeed at least 85% despite 10% failure rate
    if successes < 85 {
        t.Errorf("Too many failures: %d/100 succeeded", successes)
    }
}

// 3. goleak for Goroutine Leak Detection
func TestMain(m *testing.M) {
    goleak.VerifyTestMain(m,
        // Ignore known background goroutines
        goleak.IgnoreTopFunction("go.uber.org/zap/zapcore.(*BufferedWriteSyncer).flushLoop"),
        goleak.IgnoreTopFunction("github.com/uber/jaeger-client-go.(*RemoteReporter).processQueue"),
    )
}
```

### Resilience Testing at Streaming Scale

A streaming platform must keep serving even when individual dependencies fail, the discipline Netflix's chaos engineering practice made famous. Test suites at that tier model failure scenarios explicitly: a `FailureInjector` configurable with error rates and latency distributions, circuit-breaker tests that verify fast-fail behavior when a backend is down, and bulkhead tests that confirm resource isolation under concurrent load.

```go
// 1. Failure Injection
type FailureInjector struct {
    scenarios map[string]FailureScenario
    active    string
    mu        sync.RWMutex
}

type FailureScenario struct {
    Name        string
    ErrorRate   float64
    LatencyP50  time.Duration
    LatencyP99  time.Duration
    ErrorType   error
}

func (fi *FailureInjector) MaybeInject() error {
    fi.mu.RLock()
    defer fi.mu.RUnlock()

    scenario, ok := fi.scenarios[fi.active]
    if !ok {
        return nil
    }

    if rand.Float64() < scenario.ErrorRate {
        return scenario.ErrorType
    }

    // Simulate latency distribution
    latency := scenario.LatencyP50
    if rand.Float64() > 0.99 {
        latency = scenario.LatencyP99
    }
    time.Sleep(latency)

    return nil
}

// 2. Testing Circuit Breakers
func TestCircuitBreaker(t *testing.T) {
    failCount := 0
    backend := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        failCount++
        if failCount <= 5 {
            http.Error(w, "failure", 500)
            return
        }
        w.WriteHeader(200)
    })

    server := httptest.NewServer(backend)
    defer server.Close()

    cb := NewCircuitBreaker(CircuitBreakerConfig{
        Threshold:        3,
        Timeout:          time.Second,
        HalfOpenRequests: 1,
    })

    client := &http.Client{
        Transport: cb.Transport(http.DefaultTransport),
    }

    // First 3 requests fail, opening circuit
    for i := 0; i < 3; i++ {
        resp, _ := client.Get(server.URL)
        if resp != nil {
            resp.Body.Close()
        }
    }

    // Circuit should be open now
    if cb.State() != CircuitOpen {
        t.Error("Expected circuit to be open")
    }

    // Requests should fail fast
    start := time.Now()
    _, err := client.Get(server.URL)
    elapsed := time.Since(start)

    if elapsed > 100*time.Millisecond {
        t.Error("Request should fail fast when circuit is open")
    }
    if err == nil {
        t.Error("Expected error from open circuit")
    }
}

// 3. Testing Bulkheads
func TestBulkhead_IsolatesFailures(t *testing.T) {
    bulkhead := NewBulkhead(BulkheadConfig{
        MaxConcurrent:   10,
        MaxWaiting:      100,
        WaitTimeout:     time.Second,
    })

    var wg sync.WaitGroup
    errCh := make(chan error, 1000)

    // Start 100 concurrent requests
    for i := 0; i < 100; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()

            if err := bulkhead.Execute(func() error {
                time.Sleep(100 * time.Millisecond)
                return nil
            }); err != nil {
                errCh <- err
            }
        }()
    }

    wg.Wait()
    close(errCh)

    // With max 10 concurrent, some should be rejected
    rejected := 0
    for err := range errCh {
        if errors.Is(err, ErrBulkheadFull) {
            rejected++
        }
    }

    t.Logf("Rejected %d requests (expected some)", rejected)
}
```

### Testing Payment Systems

Financial systems demand a higher testing bar than most applications: an idempotency bug can charge a customer twice, a floating-point rounding error can lose cents at scale, and a missing audit entry can violate compliance requirements. Stripe is the reference point people reach for here, though its payments core is famously multi-language with a large Ruby footprint and it does not publish its Go test suites, so treat what follows as what a payments-grade Go suite must cover rather than as anyone's internal code.

The categories below are not optional extras in this domain. Each maps to a specific way money goes missing.

```go
// 1. Idempotency Testing
func TestPayment_Idempotency(t *testing.T) {
    db := setupTestDB(t)
    service := NewPaymentService(db)

    idempotencyKey := uuid.New().String()
    payment := &Payment{
        Amount:   1000,
        Currency: "usd",
    }

    // First request
    result1, err := service.CreatePayment(ctx, idempotencyKey, payment)
    if err != nil {
        t.Fatal(err)
    }

    // Retry with same key should return same result
    result2, err := service.CreatePayment(ctx, idempotencyKey, payment)
    if err != nil {
        t.Fatal(err)
    }

    if result1.ID != result2.ID {
        t.Error("Idempotent requests should return same payment")
    }

    // Verify only one payment was created
    var count int
    db.QueryRow("SELECT COUNT(*) FROM payments").Scan(&count)
    if count != 1 {
        t.Errorf("Expected 1 payment, got %d", count)
    }
}

// 2. Decimal Precision Testing
func TestMoney_Precision(t *testing.T) {
    tests := []struct {
        a, b     string
        op       string
        expected string
    }{
        {"0.10", "0.20", "add", "0.30"},
        {"0.30", "0.10", "sub", "0.20"},
        {"0.10", "3", "mul", "0.30"},
        {"0.30", "3", "div", "0.10"},
        // Famous floating-point failure case
        {"0.1", "0.2", "add", "0.3"},
    }

    for _, tt := range tests {
        t.Run(fmt.Sprintf("%s_%s_%s", tt.a, tt.op, tt.b), func(t *testing.T) {
            a := NewMoney(tt.a)
            b := NewMoney(tt.b)

            var result Money
            switch tt.op {
            case "add":
                result = a.Add(b)
            case "sub":
                result = a.Sub(b)
            case "mul":
                result = a.Mul(b)
            case "div":
                result = a.Div(b)
            }

            expected := NewMoney(tt.expected)
            if !result.Equal(expected) {
                t.Errorf("%s %s %s = %s; want %s",
                    tt.a, tt.op, tt.b, result.String(), tt.expected)
            }
        })
    }
}

// 3. Testing Audit Trails
func TestPayment_AuditTrail(t *testing.T) {
    db := setupTestDB(t)
    auditLog := NewAuditLog(db)
    service := NewPaymentService(db, auditLog)

    payment, _ := service.CreatePayment(ctx, key, &Payment{Amount: 1000})

    // Verify audit entries
    entries, _ := auditLog.GetEntries(payment.ID)

    expected := []string{
        "payment.created",
        "payment.risk_check",
        "payment.authorized",
        "payment.captured",
    }

    for i, exp := range expected {
        if entries[i].Event != exp {
            t.Errorf("Entry %d: expected %s, got %s", i, exp, entries[i].Event)
        }
    }
}

// 4. Concurrent Transaction Testing
func TestConcurrentTransfers(t *testing.T) {
    db := setupTestDB(t)
    service := NewTransferService(db)

    // Create accounts with $100 each
    acc1, _ := service.CreateAccount(10000)
    acc2, _ := service.CreateAccount(10000)

    // Concurrent transfers between accounts
    var wg sync.WaitGroup
    for i := 0; i < 100; i++ {
        wg.Add(2)

        // Transfer from acc1 to acc2
        go func() {
            defer wg.Done()
            service.Transfer(acc1.ID, acc2.ID, 100)
        }()

        // Transfer from acc2 to acc1
        go func() {
            defer wg.Done()
            service.Transfer(acc2.ID, acc1.ID, 100)
        }()
    }

    wg.Wait()

    // Total balance should be unchanged
    balance1, _ := service.GetBalance(acc1.ID)
    balance2, _ := service.GetBalance(acc2.ID)

    totalBalance := balance1 + balance2
    if totalBalance != 20000 {
        t.Errorf("Total balance should be 20000, got %d", totalBalance)
    }
}
```

### Staff Lens: Testing Strategies Reflect Risk Tolerance

Each case study's testing strategy reflects its business context. Payment processors test idempotency obsessively because duplicate charges are catastrophic. Media services test pipeline resilience because single-point failures affect millions. Ride-sharing services test concurrent state because race conditions corrupt rider-driver matches.

Your testing strategy should reflect your risk tolerance. Low-risk internal tools need less. High-risk external APIs need more. The uniform-testing-everywhere approach is a common mistake that wastes effort on low-risk code while under-testing high-risk code.

### Principal Lens: Mature Test Culture Compounds

Teams with mature testing cultures have lower incident rates, faster feature velocity, and higher engineer satisfaction. Each of these compounds over years. A team that invests in testing discipline early reaps benefits for the life of the codebase. A team that defers the investment pays it back with incidents and manual verification forever.

---
