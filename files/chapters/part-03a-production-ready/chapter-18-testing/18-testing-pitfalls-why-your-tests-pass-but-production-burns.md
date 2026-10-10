## Testing Pitfalls: Why Your Tests Pass but Production Burns

This section covers the most dangerous testing mistakes that give false confidence while letting bugs slip through to production.

### The Flaky Test Epidemic

**The Scenario**: Your CI passes 90% of the time. Failed builds are re-run until they pass. Nobody investigates flaky tests because "they always pass eventually."

**Why Flaky Tests Are Dangerous**:
- Developers lose trust in the test suite
- Real failures get ignored ("probably just flaky")
- CI becomes a slot machine: keep pulling until you win
- Tests stop being a safety net

```go
// FLAKY: Race condition in test

func TestConcurrentCounter(t *testing.T) {
    counter := &Counter{}

    var wg sync.WaitGroup
    for i := 0; i < 100; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            counter.Increment()
        }()
    }
    wg.Wait()

    // 🚨 Flaky: Race condition in Counter.Increment()
    // Sometimes passes, sometimes fails depending on timing
    if counter.Value() != 100 {
        t.Errorf("expected 100, got %d", counter.Value())
    }
}

// PROPER: Test should detect the race condition, not be victim of it

func TestConcurrentCounter(t *testing.T) {
    counter := &Counter{}

    var wg sync.WaitGroup
    for i := 0; i < 100; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            counter.Increment()
        }()
    }
    wg.Wait()

    // With -race flag, this test WILL fail if Counter has a race
    // Without -race, we should use atomic operations in Counter
    if counter.Value() != 100 {
        t.Errorf("expected 100, got %d", counter.Value())
    }
}

// BEST: Counter should be thread-safe by design

type Counter struct {
    value atomic.Int64
}

func (c *Counter) Increment() {
    c.value.Add(1)
}

func (c *Counter) Value() int64 {
    return c.value.Load()
}
```

### Time-Based Test Flakiness

**The Classic Mistake**: Tests that depend on wall clock time.

```go
// WRONG: Time-dependent test

func TestTokenExpiration(t *testing.T) {
    token := GenerateToken(time.Now().Add(1 * time.Second))

    // Works in isolation, flaky in CI
    time.Sleep(2 * time.Second)

    if !token.IsExpired() {
        t.Error("token should be expired")
    }
}

// 🚨 Problems:
// - Slow: 2 second sleep
// - Flaky: Timing can vary on loaded CI machines
// - Non-deterministic: Results depend on execution speed
```

```go
// CORRECT: Inject time dependency

type Token struct {
    ExpiresAt time.Time
    clock     func() time.Time  // Injected time source
}

func NewToken(expiresAt time.Time, clock func() time.Time) *Token {
    if clock == nil {
        clock = time.Now
    }
    return &Token{ExpiresAt: expiresAt, clock: clock}
}

func (t *Token) IsExpired() bool {
    return t.clock().After(t.ExpiresAt)
}

func TestTokenExpiration(t *testing.T) {
    // Fixed "now" for deterministic testing
    fixedNow := time.Date(2024, 1, 1, 12, 0, 0, 0, time.UTC)
    clock := func() time.Time { return fixedNow }

    token := NewToken(
        fixedNow.Add(-1*time.Hour),  // Already expired
        clock,
    )

    if !token.IsExpired() {
        t.Error("token should be expired")
    }
}
```

On Go 1.25 and later, `testing/synctest` offers a complementary approach: inside `synctest.Test`, time is virtualized, `time.Sleep` advances the fake clock instantly, and timing-dependent concurrent code becomes deterministic without threading a clock through every constructor. The division of labor: inject a clock for domain time (token expiry, billing periods) where the time is part of the contract, and reach for `synctest` when the flakiness comes from goroutine timing itself.

### The Mocking Trap: Testing the Mock, Not the Code

**The Anti-Pattern**: Tests that pass because mocks return exactly what the code expects, not because the code is correct.

```go
// WRONG: Mock perfectly matches what code expects

func TestUserService_GetUser(t *testing.T) {
    mockRepo := &MockUserRepo{}
    mockRepo.On("GetByID", 123).Return(&User{
        ID:    123,
        Name:  "Alice",
        Email: "alice@example.com",
    }, nil)

    service := NewUserService(mockRepo)
    user, err := service.GetUser(123)

    // This test passes, but what are we actually testing?
    // We're testing that the mock returns what we told it to return!
    if err != nil {
        t.Fatal(err)
    }
    if user.Name != "Alice" {
        t.Error("wrong name")
    }
}

// What if GetByID returns nil user with nil error?
// What if the service doesn't handle email validation?
// What if there's a mapping bug in the service layer?
// This test wouldn't catch any of those!
```

```go
// BETTER: Test behavior, not data passthrough

func TestUserService_GetUser_NotFound(t *testing.T) {
    mockRepo := &MockUserRepo{}
    mockRepo.On("GetByID", mock.Anything).Return(nil, ErrNotFound)

    service := NewUserService(mockRepo)
    _, err := service.GetUser(999)

    // Test the SERVICE behavior when repo returns not found
    if !errors.Is(err, ErrUserNotFound) {
        t.Errorf("expected ErrUserNotFound, got %v", err)
    }
}

func TestUserService_GetUser_ValidatesResult(t *testing.T) {
    mockRepo := &MockUserRepo{}
    // Return user with invalid email - does service catch this?
    mockRepo.On("GetByID", mock.Anything).Return(&User{
        ID:    123,
        Email: "not-an-email",  // Invalid!
    }, nil)

    service := NewUserService(mockRepo)
    _, err := service.GetUser(123)

    // If service should validate, this should fail
    if err == nil {
        t.Error("expected validation error for invalid email")
    }
}

// BEST: Use real implementation when possible

func TestUserService_Integration(t *testing.T) {
    // In-memory repository - fast, but tests real interaction
    repo := NewInMemoryUserRepo()
    repo.Save(&User{ID: 123, Name: "Alice", Email: "alice@test.com"})

    service := NewUserService(repo)

    user, err := service.GetUser(123)
    if err != nil {
        t.Fatal(err)
    }

    // Now we're testing the ACTUAL service + repository interaction
    if user.Name != "Alice" {
        t.Errorf("expected Alice, got %s", user.Name)
    }
}
```

### The Database State Leak

**The Problem**: Tests that share database state, causing order-dependent failures.

```go
// WRONG: Tests share database state

var testDB *sql.DB  // 🚨 Shared database connection

func TestMain(m *testing.M) {
    testDB = setupTestDB()
    os.Exit(m.Run())
}

func TestCreateUser(t *testing.T) {
    // Creates user with email "alice@test.com"
    _, err := CreateUser(testDB, "Alice", "alice@test.com")
    if err != nil {
        t.Fatal(err)
    }
}

func TestCreateUserDuplicate(t *testing.T) {
    // 🚨 FLAKY: Depends on TestCreateUser running first
    // If tests run in parallel or different order, this fails
    _, err := CreateUser(testDB, "Alice2", "alice@test.com")
    if err == nil {
        t.Error("expected duplicate email error")
    }
}

func TestListUsers(t *testing.T) {
    // 🚨 FLAKY: Result depends on which tests ran before
    users, _ := ListUsers(testDB)
    // Is it 0? 1? 2? Depends on test order!
}
```

```go
// CORRECT: Each test gets fresh state

func TestCreateUser(t *testing.T) {
    // Transaction rollback pattern - FAST
    tx, _ := testDB.Begin()
    defer tx.Rollback()  // Always rollback, even on success

    _, err := CreateUserTx(tx, "Alice", "alice@test.com")
    if err != nil {
        t.Fatal(err)
    }

    // Verify within transaction
    user, err := GetUserByEmailTx(tx, "alice@test.com")
    if err != nil {
        t.Fatal(err)
    }
    if user.Name != "Alice" {
        t.Error("wrong name")
    }
    // tx.Rollback() called by defer - database unchanged
}

// Alternative: Test containers with fresh database per test
func TestWithFreshDB(t *testing.T) {
    ctx := context.Background()
    postgres, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
        ContainerRequest: testcontainers.ContainerRequest{
            Image:        "postgres:15",
            ExposedPorts: []string{"5432/tcp"},
            Env: map[string]string{
                "POSTGRES_PASSWORD": "test",
                "POSTGRES_DB":       "test",
            },
            // The ready line appears twice in Postgres logs (the server
            // restarts after init), so require both occurrences. See 18.7.
            WaitingFor: wait.ForLog("database system is ready").WithOccurrence(2),
        },
        Started: true,
    })
    if err != nil {
        t.Fatal(err)
    }
    defer postgres.Terminate(ctx)

    // Fresh database for this test
    host, _ := postgres.Host(ctx)
    port, _ := postgres.MappedPort(ctx, "5432")
    connStr := "postgres://test:test@" + host + ":" + port.Port() + "/test?sslmode=disable"
    db, _ := sql.Open("postgres", connStr)
    defer db.Close()

    // Run test with completely isolated database
}
```

### Testing Error Paths: The 80% That Gets Ignored

**The Reality**: Most code is error handling, but most tests only cover the happy path.

```go
// Service with multiple error paths
func (s *PaymentService) ProcessPayment(ctx context.Context, req PaymentRequest) (*Payment, error) {
    // Error path 1: Validation
    if err := req.Validate(); err != nil {
        return nil, fmt.Errorf("validation failed: %w", err)
    }

    // Error path 2: User lookup
    user, err := s.users.GetByID(ctx, req.UserID)
    if err != nil {
        return nil, fmt.Errorf("user lookup failed: %w", err)
    }

    // Error path 3: Idempotency check
    existing, err := s.payments.GetByIdempotencyKey(ctx, req.IdempotencyKey)
    if err != nil && !errors.Is(err, ErrNotFound) {
        return nil, fmt.Errorf("idempotency check failed: %w", err)
    }
    if existing != nil {
        return existing, nil  // Return existing payment
    }

    // Error path 4: External payment provider
    providerResult, err := s.provider.Charge(ctx, ChargeRequest{
        Amount:   req.Amount,
        Currency: req.Currency,
        Source:   user.PaymentSource,
    })
    if err != nil {
        return nil, fmt.Errorf("charge failed: %w", err)
    }

    // Error path 5: Save to database
    payment := &Payment{
        ID:        providerResult.ID,
        UserID:    req.UserID,
        Amount:    req.Amount,
        Status:    PaymentStatusComplete,
    }
    if err := s.payments.Save(ctx, payment); err != nil {
        // Error path 6: Rollback provider charge?
        // This is where it gets complex...
        return nil, fmt.Errorf("save failed: %w", err)
    }

    return payment, nil
}

// WRONG: Only testing happy path
func TestProcessPayment(t *testing.T) {
    // Setup all mocks to return success
    service := setupHappyPathMocks()

    payment, err := service.ProcessPayment(ctx, validRequest)
    if err != nil {
        t.Fatal(err)
    }
    if payment.Status != PaymentStatusComplete {
        t.Error("wrong status")
    }
}

// CORRECT: Test each error path explicitly
func TestProcessPayment_ErrorPaths(t *testing.T) {
    tests := []struct {
        name          string
        setupMocks    func(*MockUserRepo, *MockPaymentRepo, *MockProvider)
        request       PaymentRequest
        wantErr       error
        wantErrSubstr string
    }{
        {
            name: "validation error - negative amount",
            request: PaymentRequest{Amount: -100},
            wantErrSubstr: "validation failed",
        },
        {
            name: "user not found",
            setupMocks: func(users *MockUserRepo, _ *MockPaymentRepo, _ *MockProvider) {
                users.On("GetByID", mock.Anything, mock.Anything).Return(nil, ErrNotFound)
            },
            request: PaymentRequest{Amount: 100, UserID: 999},
            wantErrSubstr: "user lookup failed",
        },
        {
            name: "provider charge fails",
            setupMocks: func(users *MockUserRepo, _ *MockPaymentRepo, provider *MockProvider) {
                users.On("GetByID", mock.Anything, mock.Anything).Return(&User{}, nil)
                provider.On("Charge", mock.Anything, mock.Anything).Return(nil, errors.New("card declined"))
            },
            request: PaymentRequest{Amount: 100, UserID: 1},
            wantErrSubstr: "charge failed",
        },
        {
            name: "idempotent request returns existing",
            setupMocks: func(users *MockUserRepo, payments *MockPaymentRepo, _ *MockProvider) {
                users.On("GetByID", mock.Anything, mock.Anything).Return(&User{}, nil)
                payments.On("GetByIdempotencyKey", mock.Anything, "key123").Return(&Payment{ID: "existing"}, nil)
            },
            request: PaymentRequest{Amount: 100, UserID: 1, IdempotencyKey: "key123"},
            wantErr: nil,  // Should succeed with existing payment
        },
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            users := &MockUserRepo{}
            payments := &MockPaymentRepo{}
            provider := &MockProvider{}

            if tt.setupMocks != nil {
                tt.setupMocks(users, payments, provider)
            }

            service := NewPaymentService(users, payments, provider)
            _, err := service.ProcessPayment(ctx, tt.request)

            if tt.wantErrSubstr != "" && (err == nil || !strings.Contains(err.Error(), tt.wantErrSubstr)) {
                t.Errorf("expected error containing %q, got %v", tt.wantErrSubstr, err)
            }
        })
    }
}
```

### The Coverage Trap: 100% Coverage, 0% Confidence

**The Anti-Pattern**: Chasing coverage percentage instead of testing behavior.

```go
// Code with 100% coverage but no actual testing

func CalculateDiscount(price float64, code string) float64 {
    if code == "SAVE10" {
        return price * 0.9
    }
    if code == "SAVE20" {
        return price * 0.8
    }
    return price
}

// "Tests" that achieve 100% coverage
func TestCalculateDiscount(t *testing.T) {
    CalculateDiscount(100, "SAVE10")  // Covers first branch
    CalculateDiscount(100, "SAVE20")  // Covers second branch
    CalculateDiscount(100, "")        // Covers default
    // No assertions! Just executing code for coverage
}
```

```go
// CORRECT: Test behavior, not just coverage

func TestCalculateDiscount(t *testing.T) {
    tests := []struct {
        name     string
        price    float64
        code     string
        expected float64
    }{
        {"no discount", 100.0, "", 100.0},
        {"10% discount", 100.0, "SAVE10", 90.0},
        {"20% discount", 100.0, "SAVE20", 80.0},
        {"case insensitive? (probably a bug)", 100.0, "save10", 100.0},  // Document behavior
        {"zero price", 0.0, "SAVE10", 0.0},
        {"negative price (edge case)", -100.0, "SAVE10", -90.0},  // Is this expected?
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            result := CalculateDiscount(tt.price, tt.code)
            if result != tt.expected {
                t.Errorf("CalculateDiscount(%v, %q) = %v, want %v",
                    tt.price, tt.code, result, tt.expected)
            }
        })
    }
}
```

That table passes. Every row, including the exact `result != tt.expected` comparison on `float64`. And it passes for a reason that should make you uneasy: `100.0` is a friendly number.

```
100.0*0.9  = 90.00000000000000000000   equals 90.0?    true
19.99*0.8  = 15.99199999999999910472   equals 15.992?  false
```

Change one test input from `100.0` to a price a real store would charge, and the same assertion fails on arithmetic rather than on a bug. The test suite is green because someone picked round numbers, which is a second, sneakier version of the same trap this section is about: the inputs were chosen to make the test pass rather than to model reality.

There are two lessons stacked here. If you must compare floats, compare with a tolerance (`math.Abs(got-want) < 1e-9`, or `cmpopts.EquateApprox`), because exact equality on computed floats is a coin flip that depends on your inputs. And better: **do not represent money as `float64` at all.** Use integer minor units (cents) and the problem disappears at the source, along with the accumulated rounding drift that costs real money at volume. `CalculateDiscount(priceCents int64, code string) int64` has no such failure mode. This chapter's payments material makes the same point, and this innocuous-looking discount function is exactly how float money gets into a codebase.

### Benchmark Lies: Measuring the Wrong Thing

**The Problem**: benchmarks that do not reflect real-world usage. Note carefully what the problem is *not*, on a modern toolchain: since Go 1.24, `b.Loop()` keeps the loop body's calls and results alive, so the old "the compiler deleted my benchmark" hazard is handled by the language. The remaining lie is about the **input**.

```go
// MISLEADING: the payload is nothing like production.

func BenchmarkJSONMarshal(b *testing.B) {
    data := map[string]string{"key": "value"} // 1 key, ~15 bytes

    for b.Loop() {
        json.Marshal(data)
    }
}

// BETTER: benchmark the payload you actually serialize.

func BenchmarkJSONMarshal_Realistic(b *testing.B) {
    data := generateRealisticPayload() // 1KB+, nested, real field types

    b.ReportAllocs()

    for b.Loop() {
        if _, err := json.Marshal(data); err != nil {
            b.Fatal(err)
        }
    }
}

// Run with: go test -bench=. -benchmem -count=10 > new.txt && benchstat old.txt new.txt
```

Three pieces of ceremony that older benchmark advice insists on are now redundant, and carrying them forward suggests you do not know why they were there:

**No `b.ResetTimer()` after setup.** `b.Loop()` resets the timer on its first call. Benchmarking a 300ms setup followed by the loop, with and without an explicit reset:

```
BenchmarkNoResetTimer-8     3494823   356.3 ns/op   96 B/op   4 allocs/op
BenchmarkWithResetTimer-8   3270458   365.2 ns/op   96 B/op   4 allocs/op
```

Identical. The 300ms never entered either measurement.

**No sink variable, no `_ = result`.** Discarding the result of `json.Marshal` inside a `b.Loop()` body does not let the compiler skip the work:

```
BenchmarkDiscarded-8   3448376   421.8 ns/op   96 B/op   4 allocs/op
BenchmarkKept-8        1733947   684.2 ns/op   96 B/op   4 allocs/op
```

Both perform 4 allocations per operation, which is the proof the marshalling actually ran. (The `Kept` version is *slower*, because storing to a captured variable is extra work you have now included in your measurement. The workaround costs you accuracy.)

**No artificial `if len(result) == 0` check.** Same reason, and it adds a branch to the timed region.

What remains genuinely important is `b.ReportAllocs()` (or `-benchmem`) and, above all, a realistic input. A 15-byte map tells you about `json`'s fixed overhead and nothing about your service.

### Quick Reference: Testing Anti-Patterns

| Anti-Pattern | Why It's Dangerous | Fix |
|--------------|-------------------|-----|
| Flaky tests | False confidence, ignored failures | Fix race conditions, inject time |
| Shared state | Order-dependent failures | Transaction rollback, containers |
| Over-mocking | Testing mocks, not code | Use real implementations when possible |
| Happy path only | 80% of code untested | Explicitly test every error path |
| Coverage chasing | 100% coverage ≠ working code | Test behavior with assertions |
| Slow tests | Developers skip them | Parallelize, use in-memory stores |
| No benchmarks | Performance regressions undetected | Benchmark critical paths |

### Staff Lens: The Tests-Passing-Production-Burning Pattern

When tests pass but production breaks, the pattern is almost always: tests did not exercise the real scenario that failed. Common causes:

- Test used mocks that did not match real behavior.
- Test did not include the failing input (fuzz would have caught it).
- Test ran sequentially. Production runs concurrent.
- Test used fake time. Production hit a real-time edge case.
- Test covered unit behavior but not integration behavior.

Every production incident is a signal that the test suite has a gap. The staff-level discipline is closing that gap as part of the incident response, not just patching the bug.

---
