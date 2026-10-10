## Testing Strategy

Testing a social network backend requires both unit tests and integration tests working together. Unit tests verify individual service methods by mocking out the repository layer, which lets you test business logic in isolation without needing a running database. Integration tests use Testcontainers to spin up real PostgreSQL instances in Docker, ensuring that your SQL queries and schema constraints work correctly against an actual database. This two-level approach catches logic bugs early with fast unit tests and catches database-related bugs with slower but more realistic integration tests.

### Unit Test Example

Unit tests verify that service methods behave correctly by replacing the real repository with a mock. The mock records which methods were called and with what arguments, and returns pre-configured responses. This lets you test edge cases like duplicate usernames or invalid credentials without needing a database. The testify library provides assertion helpers and a mock framework that makes writing these tests concise and readable.

```go
// internal/service/user_test.go
package service_test

import (
    "context"
    "testing"

    "github.com/google/uuid"
    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/mock"
    "github.com/yourname/socialnet/internal/domain"
    "github.com/yourname/socialnet/internal/service"
    "go.uber.org/zap/zaptest"
)

type MockUserRepository struct {
    mock.Mock
}

func (m *MockUserRepository) Create(ctx context.Context, user *domain.User) error {
    args := m.Called(ctx, user)
    return args.Error(0)
}

func (m *MockUserRepository) GetByID(ctx context.Context, id uuid.UUID) (*domain.User, error) {
    args := m.Called(ctx, id)
    if args.Get(0) == nil {
        return nil, args.Error(1)
    }
    return args.Get(0).(*domain.User), args.Error(1)
}

// ... implement other methods

func TestUserService_CreateUser(t *testing.T) {
    mockRepo := new(MockUserRepository)
    logger := zaptest.NewLogger(t)
    userService := service.NewUserService(mockRepo, logger)

    req := &domain.CreateUserRequest{
        Username:    "testuser",
        Email:       "test@example.com",
        Password:    "password123",
        DisplayName: "Test User",
    }

    mockRepo.On("UsernameExists", mock.Anything, req.Username).Return(false, nil)
    mockRepo.On("EmailExists", mock.Anything, req.Email).Return(false, nil)
    mockRepo.On("Create", mock.Anything, mock.AnythingOfType("*domain.User")).Return(nil)
    mockRepo.On("CreateSettings", mock.Anything, mock.AnythingOfType("*domain.UserSettings")).Return(nil)

    user, err := userService.CreateUser(context.Background(), req)

    assert.NoError(t, err)
    assert.NotNil(t, user)
    assert.Equal(t, req.Username, user.Username)
    assert.Equal(t, req.Email, user.Email)
    mockRepo.AssertExpectations(t)
}
```

### Integration Test with Testcontainers

Integration tests use Testcontainers to spin up a real PostgreSQL database inside a Docker container for each test run. This ensures your SQL queries, constraints, and indexes work correctly against an actual database engine rather than a mock. The setup function creates the container, connects to it, runs migrations, and returns a cleanup function that tears everything down when the test finishes. These tests are slower than unit tests but catch real database issues that mocks cannot.

```go
// internal/repository/postgres/user_integration_test.go
//go:build integration
// +build integration

package postgres_test

import (
    "context"
    "testing"

    "github.com/jmoiron/sqlx"
    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
    "github.com/testcontainers/testcontainers-go"
    "github.com/testcontainers/testcontainers-go/wait"
    "github.com/yourname/socialnet/internal/domain"
    "github.com/yourname/socialnet/internal/repository/postgres"
)

func setupTestDB(t *testing.T) (*sqlx.DB, func()) {
    ctx := context.Background()

    req := testcontainers.ContainerRequest{
        Image:        "postgres:18-alpine",
        ExposedPorts: []string{"5432/tcp"},
        Env: map[string]string{
            "POSTGRES_USER":     "test",
            "POSTGRES_PASSWORD": "test",
            "POSTGRES_DB":       "testdb",
        },
        WaitingFor: wait.ForLog("database system is ready to accept connections"),
    }

    container, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
        ContainerRequest: req,
        Started:          true,
    })
    require.NoError(t, err)

    host, _ := container.Host(ctx)
    port, _ := container.MappedPort(ctx, "5432")

    dsn := fmt.Sprintf("host=%s port=%s user=test password=test dbname=testdb sslmode=disable",
        host, port.Port())

    db, err := sqlx.Connect("postgres", dsn)
    require.NoError(t, err)

    // Run migrations
    // ... (migration code)

    cleanup := func() {
        db.Close()
        container.Terminate(ctx)
    }

    return db, cleanup
}

func TestUserRepository_Create(t *testing.T) {
    db, cleanup := setupTestDB(t)
    defer cleanup()

    repo := postgres.NewUserRepository(db)

    user := &domain.User{
        ID:          uuid.New(),
        Username:    "testuser",
        Email:       "test@example.com",
        DisplayName: "Test User",
    }

    err := repo.Create(context.Background(), user)
    assert.NoError(t, err)

    // Verify user was created
    retrieved, err := repo.GetByID(context.Background(), user.ID)
    assert.NoError(t, err)
    assert.Equal(t, user.Username, retrieved.Username)
    assert.Equal(t, user.Email, retrieved.Email)
}
```

---

### Junior → FAANG: Building a Credible Testing Foundation

The prerequisite gap most junior candidates have: they write tests after implementation and test the happy path only. FAANG interviews probe whether you think about failure modes and edge cases before writing code. Practice the habit of writing the test first, even if just as a skeleton, to force yourself to think about inputs and expected outputs before touching the implementation.

Know the testing pyramid. Unit tests: fast, no I/O, test one function or method. Integration tests: involve real I/O (database, Redis), slower, test component interactions. End-to-end tests: test the full stack, slowest, fewest in number. When asked in an interview how you would test a new feature, walk through all three layers.

First-job mistake: creating test databases that share state between tests. Tests that depend on execution order are not tests, they are scripts. Use table-driven tests in Go, isolate each test with transaction rollbacks or container reset, and make every test hermetic.

Entry-level interview question you must nail: "How do you test code that calls an external service?" The answer is: define an interface for the external service, implement a mock in tests, and inject the mock via dependency injection. This is foundational Go testing idiom. If you cannot answer this fluently, it signals you have not practiced interface-driven design.

### Senior @ FAANG: Test Strategy as a Platform Reliability Investment

At FAANG, testing strategy is an engineering system decision, not a per-developer choice. The L6 responsibility is to define standards that ensure release safety across teams who are shipping independently multiple times per day.

**Test classification and SLA.** Define test classifications with latency SLAs that fit in the CI pipeline: unit tests must complete in under 30 seconds, integration tests under 5 minutes, full regression in under 15 minutes. Tests that violate their SLA are flagged for refactoring. Slow tests that block CI trains kill developer productivity and create pressure to skip test runs, which degrades reliability. At staff level, you treat test performance as a first-class metric, tracked per suite over time.

**Contract testing for service boundaries.** In a microservices architecture, integration tests between services are expensive and fragile. The mature alternative is consumer-driven contract testing using Pact. Each consumer service defines a contract (expected request format and response schema), the contract is published to a broker, and the producer service verifies it can fulfill all registered contracts. This allows services to evolve independently without full integration test suites, while catching breaking API changes before they reach production. Adopting Pact requires a shared broker and CI integration, which is a platform-level investment.

**Mutation testing for test quality.** High code coverage does not guarantee useful tests. A test that calls a function but asserts nothing will pass even when you delete the function body. Mutation testing (using `go-mutesting`) introduces small code changes (mutations) and verifies that at least one test fails. If a mutation survives (no test catches it), your test suite has a coverage gap in behavior, not just in lines. Running mutation testing on critical business logic (payment processing, authorization) reveals the weakest parts of your test suite before they reveal themselves in production.

**Chaos and resilience testing.** At FAANG scale, services must tolerate partial failures in dependencies. Chaos engineering validates this: deliberately inject latency, packet loss, and dependency failures into staging to verify your circuit breakers, timeouts, and fallbacks behave as designed. For a social network, key chaos scenarios are: Redis unavailable (does the service fall back to database or fail open), Elasticsearch unavailable (does search degrade gracefully or crash the feed), and primary database slow (does read traffic shift to replicas). Document these scenarios as runnable chaos experiments and include them in your production readiness review checklist.

**Production readiness review as a release gate.** Before a new service or major feature ships, senior engineers run a production readiness review against a checklist: SLOs defined and implemented, runbooks written for all alerts, load testing completed at 2x expected peak, chaos scenarios executed and validated, rollback procedure documented and tested, feature flags wired for emergency disable, and on-call rotation updated. This checklist is not optional. It is a gate owned by the on-call rotation, not by the feature team, ensuring independent sign-off on production safety.
