export default `## 6.8 Testing with Interfaces

When your code depends on interfaces rather than concrete types, you can substitute lightweight mock implementations in tests. This eliminates the need for real databases, network connections, or external services during unit testing, making tests fast, deterministic, and isolated.

### Mock Generation with Interfaces

Interfaces defined at the consumer side make unit testing straightforward: mock implementations replace real dependencies without requiring changes to the code under test.

\`\`\`go
// Define interface for what you need
type UserRepository interface {
    Get(ctx context.Context, id string) (*User, error)
    Create(ctx context.Context, user *User) error
    Update(ctx context.Context, user *User) error
}

// Production implementation
type PostgresUserRepo struct {
    db *sql.DB
}

func (r *PostgresUserRepo) Get(ctx context.Context, id string) (*User, error) {
    // Real database query
}

// Mock implementation for tests
type MockUserRepo struct {
    users    map[string]*User
    getError error
}

func NewMockUserRepo() *MockUserRepo {
    return &MockUserRepo{users: make(map[string]*User)}
}

func (m *MockUserRepo) Get(ctx context.Context, id string) (*User, error) {
    if m.getError != nil {
        return nil, m.getError
    }
    user, ok := m.users[id]
    if !ok {
        return nil, ErrNotFound
    }
    return user, nil
}

func (m *MockUserRepo) Create(ctx context.Context, user *User) error {
    m.users[user.ID] = user
    return nil
}

func (m *MockUserRepo) Update(ctx context.Context, user *User) error {
    if _, ok := m.users[user.ID]; !ok {
        return ErrNotFound
    }
    m.users[user.ID] = user
    return nil
}

// Test helpers
func (m *MockUserRepo) SetGetError(err error) {
    m.getError = err
}

func (m *MockUserRepo) AddUser(user *User) {
    m.users[user.ID] = user
}
\`\`\`

### Stripe's Testing Pattern

Stripe uses interface-based testing extensively:

\`\`\`go
// Service under test
type PaymentService struct {
    payments PaymentProcessor
    users    UserStore
    logger   Logger
}

func (s *PaymentService) ProcessPayment(ctx context.Context, userID string, amount int64) error {
    user, err := s.users.Get(ctx, userID)
    if err != nil {
        return fmt.Errorf("get user: %w", err)
    }

    if err := s.payments.Charge(ctx, user.PaymentMethod, amount); err != nil {
        s.logger.Error("charge failed", "user_id", userID, "error", err)
        return fmt.Errorf("charge: %w", err)
    }

    s.logger.Info("payment processed", "user_id", userID, "amount", amount)
    return nil
}

// Test with mocks
func TestPaymentService_ProcessPayment(t *testing.T) {
    tests := []struct {
        name        string
        userID      string
        amount      int64
        setupMocks  func(*MockUserStore, *MockPaymentProcessor)
        wantErr     bool
        errContains string
    }{
        {
            name:   "successful payment",
            userID: "user-123",
            amount: 1000,
            setupMocks: func(users *MockUserStore, payments *MockPaymentProcessor) {
                users.AddUser(&User{
                    ID:            "user-123",
                    PaymentMethod: "pm_123",
                })
            },
            wantErr: false,
        },
        {
            name:   "user not found",
            userID: "unknown",
            amount: 1000,
            setupMocks: func(users *MockUserStore, payments *MockPaymentProcessor) {
                // Don't add user
            },
            wantErr:     true,
            errContains: "get user",
        },
        {
            name:   "payment fails",
            userID: "user-123",
            amount: 1000,
            setupMocks: func(users *MockUserStore, payments *MockPaymentProcessor) {
                users.AddUser(&User{
                    ID:            "user-123",
                    PaymentMethod: "pm_123",
                })
                payments.SetChargeError(errors.New("card declined"))
            },
            wantErr:     true,
            errContains: "charge",
        },
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            users := NewMockUserStore()
            payments := NewMockPaymentProcessor()
            logger := NewMockLogger()

            tt.setupMocks(users, payments)

            svc := &PaymentService{
                users:    users,
                payments: payments,
                logger:   logger,
            }

            err := svc.ProcessPayment(context.Background(), tt.userID, tt.amount)

            if tt.wantErr {
                if err == nil {
                    t.Fatal("expected error, got nil")
                }
                if !strings.Contains(err.Error(), tt.errContains) {
                    t.Errorf("error should contain %q, got %q", tt.errContains, err.Error())
                }
                return
            }

            if err != nil {
                t.Fatalf("unexpected error: %v", err)
            }
        })
    }
}
\`\`\`

### Table-Driven Tests with Interface Mocks

Table-driven tests combined with interface mocks allow exhaustive coverage of all branches through a function. Each test case specifies its mock behavior and expected outcome.

\`\`\`go
func TestCacheGet(t *testing.T) {
    tests := []struct {
        name      string
        key       string
        cacheData map[string][]byte
        want      []byte
        wantErr   error
    }{
        {
            name:      "key exists",
            key:       "existing",
            cacheData: map[string][]byte{"existing": []byte("value")},
            want:      []byte("value"),
            wantErr:   nil,
        },
        {
            name:      "key missing",
            key:       "missing",
            cacheData: map[string][]byte{},
            want:      nil,
            wantErr:   ErrCacheMiss,
        },
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            cache := &MockCache{data: tt.cacheData}

            got, err := cache.Get(context.Background(), tt.key)

            if !errors.Is(err, tt.wantErr) {
                t.Errorf("Get() error = %v, want %v", err, tt.wantErr)
            }

            if !bytes.Equal(got, tt.want) {
                t.Errorf("Get() = %v, want %v", got, tt.want)
            }
        })
    }
}
\`\`\`

### Hand-Rolled Fakes vs Generated Mocks

For a senior engineer, the choice between hand-rolled fakes and generated mocks is a discipline question. Hand-rolled fakes are:

- Smaller and more readable for narrow interfaces.
- Flexible for testing specific behaviour without stubbing every method.
- Free of the "expect this call exactly N times" ritual that mock frameworks encourage.

Generated mocks (via \`mockgen\`, \`mockery\`) are:

- Faster to produce for large interfaces (but see the "interfaces should be small" rule).
- Consistent across the codebase when wired into \`go generate\`.
- Prone to encouraging over-specification (tests that break when implementation details change).

The senior-track default is "hand-rolled fakes for small interfaces, generated mocks only when the interface is unavoidably large and the boilerplate is painful". The discipline is to keep interfaces small enough that hand-rolling is natural.

### Code-Review Lens (Senior Track)

Three patterns to flag in test PRs:

1. **Tests that mock every dependency.** The test is verifying the mock, not the code. Consider which dependencies need mocking (I/O, external services) and which should run for real (pure logic, small helpers).
2. **Over-specified mock expectations.** \`mockCache.EXPECT().Get().Times(1)\` rigidly specifies the implementation. A change to the implementation breaks the test even when the behaviour is correct. Loosen the expectation or reconsider.
3. **A production interface defined only for testing.** If the interface has one implementation plus a mock, and the mock is the only reason for the interface, the interface is dead weight. Consider testing through the concrete type.

### Contract Tests: Keeping the Fake Honest

A hand-rolled fake drifts from the real implementation over time. The real \`PostgresUserRepo\` grows a constraint (case-insensitive email matching, for example) that the fake does not enforce. Tests pass against the fake, production fails against the real one. The prevention is a contract test: one shared test suite that runs against every implementation of the interface.

\`\`\`go
func TestUserRepositoryContract(t *testing.T, newRepo func() UserRepository) {
    t.Run("Get returns ErrNotFound for unknown id", func(t *testing.T) {
        r := newRepo()
        _, err := r.Get(ctx, "does-not-exist")
        if !errors.Is(err, ErrNotFound) {
            t.Fatalf("expected ErrNotFound, got %v", err)
        }
    })
    // ... more shared cases
}

func TestPostgresUserRepo(t *testing.T) {
    TestUserRepositoryContract(t, func() UserRepository {
        return NewPostgresUserRepo(testDB)
    })
}

func TestMockUserRepo(t *testing.T) {
    TestUserRepositoryContract(t, func() UserRepository {
        return NewMockUserRepo()
    })
}
\`\`\`

Both implementations must pass the same suite. This is the technique that makes "mock is honest" a compile-plus-test-time guarantee, not tribal knowledge. At staff level, contract tests become mandatory for any interface with more than one production implementation (for example, multi-region storage adapters, multi-provider payment processors).

### Staff Lens: The Testing Boundary Is a Design Decision

The interfaces a team defines for testing are, in aggregate, the team's architecture. If the test suite mocks \`Database\` and \`HTTPClient\`, the architecture has those two seams. If it mocks fifteen different small helpers, the architecture is fragmented. The staff-level observation: the test dependency graph is a leading indicator of production coupling. A team whose tests require injecting ten mocks to construct one service is a team whose production code is too tightly coupled, regardless of how clean the individual interfaces look. Reduce the number of seams. Prefer a handful of well-defined seams at meaningful boundaries (process, network, disk, time) over a seam at every function. This is the difference between tests that survive a refactor and tests that have to be rewritten every time.

### The Time Interface (Testable Time)

A recurring staff-level finding: code that calls \`time.Now()\` directly is not testable. The fix is a one-method interface.

\`\`\`go
type Clock interface { Now() time.Time }

type realClock struct{}
func (realClock) Now() time.Time { return time.Now() }

type fakeClock struct{ t time.Time }
func (f *fakeClock) Now() time.Time { return f.t }
\`\`\`

Inject \`Clock\` wherever code reads the current time. The fake clock in tests gives you deterministic timestamps, time-based cache expiration testable in microseconds instead of seconds, and zero flakiness. For Go 1.25+, the stdlib's \`testing/synctest\` package provides a similar capability with more features (fake tickers, fake \`time.Sleep\`). Prefer it over a hand-rolled clock interface when the stdlib version fits. This is the kind of seam that is cheap to add at design time and expensive to retrofit later.

---
`;
