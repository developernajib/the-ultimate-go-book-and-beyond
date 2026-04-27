export default `## 6.12 Exercises with Solutions

### Exercise 1: Implement io.Reader

Write a type that implements \`io.Reader\` to generate a repeating pattern of bytes. The reader should cycle through the pattern until it has produced \`limit\` total bytes, then return \`io.EOF\`.

**Solution:**

\`\`\`go
type PatternReader struct {
    pattern []byte
    pos     int
    limit   int64
    read    int64
}

func NewPatternReader(pattern []byte, limit int64) *PatternReader {
    return &PatternReader{
        pattern: pattern,
        limit:   limit,
    }
}

func (r *PatternReader) Read(p []byte) (n int, err error) {
    if r.read >= r.limit {
        return 0, io.EOF
    }

    remaining := r.limit - r.read
    toRead := int64(len(p))
    if toRead > remaining {
        toRead = remaining
    }

    for i := int64(0); i < toRead; i++ {
        p[i] = r.pattern[r.pos]
        r.pos = (r.pos + 1) % len(r.pattern)
    }

    r.read += toRead
    return int(toRead), nil
}

// Usage
reader := NewPatternReader([]byte("abc"), 10)
data, _ := io.ReadAll(reader)
fmt.Println(string(data)) // "abcabcabca"
\`\`\`

### Exercise 2: Decorator Pattern, CountingWriter

Create a \`CountingWriter\` that wraps an \`io.Writer\` and counts total bytes written.

**Solution:**

\`\`\`go
type CountingWriter struct {
    w     io.Writer
    count int64
    mu    sync.Mutex
}

func NewCountingWriter(w io.Writer) *CountingWriter {
    return &CountingWriter{w: w}
}

func (cw *CountingWriter) Write(p []byte) (n int, err error) {
    n, err = cw.w.Write(p)
    cw.mu.Lock()
    cw.count += int64(n)
    cw.mu.Unlock()
    return
}

func (cw *CountingWriter) Count() int64 {
    cw.mu.Lock()
    defer cw.mu.Unlock()
    return cw.count
}

func (cw *CountingWriter) Reset() {
    cw.mu.Lock()
    cw.count = 0
    cw.mu.Unlock()
}

// Usage
var buf bytes.Buffer
cw := NewCountingWriter(&buf)
cw.Write([]byte("hello"))
cw.Write([]byte(" world"))
fmt.Println(cw.Count()) // 11
\`\`\`

### Exercise 3: Interface Segregation

The following \`UserService\` interface has nine methods spanning CRUD, search, export, notification, and reporting. Refactor it into small, single-responsibility interfaces that can be composed when a consumer needs multiple capabilities.

\`\`\`go
type UserService interface {
    Create(user User) error
    Get(id int) (User, error)
    Update(user User) error
    Delete(id int) error
    List() ([]User, error)
    Search(query string) ([]User, error)
    Export(format string) ([]byte, error)
    SendNotification(id int, message string) error
    GenerateReport() (Report, error)
}
\`\`\`

**Solution:**

\`\`\`go
// Core CRUD operations
type UserCreator interface {
    Create(user User) error
}

type UserGetter interface {
    Get(id int) (User, error)
}

type UserUpdater interface {
    Update(user User) error
}

type UserDeleter interface {
    Delete(id int) error
}

// Query operations
type UserLister interface {
    List() ([]User, error)
}

type UserSearcher interface {
    Search(query string) ([]User, error)
}

// Export/Report operations
type UserExporter interface {
    Export(format string) ([]byte, error)
}

type ReportGenerator interface {
    GenerateReport() (Report, error)
}

// Notification (separate concern)
type NotificationSender interface {
    SendNotification(userID int, message string) error
}

// Composed interfaces for common use cases
type UserReader interface {
    UserGetter
    UserLister
}

type UserWriter interface {
    UserCreator
    UserUpdater
    UserDeleter
}

type UserCRUD interface {
    UserReader
    UserWriter
}

// Implementation can satisfy any combination
type UserStore struct { ... }

func (s *UserStore) Create(user User) error { ... }
func (s *UserStore) Get(id int) (User, error) { ... }
func (s *UserStore) Update(user User) error { ... }
func (s *UserStore) Delete(id int) error { ... }
func (s *UserStore) List() ([]User, error) { ... }
func (s *UserStore) Search(query string) ([]User, error) { ... }

// Separate service for notifications
type NotificationService struct { ... }

func (n *NotificationService) SendNotification(userID int, message string) error { ... }

// Compile-time checks
var (
    _ UserCRUD       = (*UserStore)(nil)
    _ UserSearcher   = (*UserStore)(nil)
)
\`\`\`

### Exercise 4: Functional Options

Design a configuration system for a database connection pool using the functional options pattern. Support options for max connections, min connections, timeout, retry policy, TLS, and logger. Each option should validate its input and return an error for invalid values.

**Solution:**

\`\`\`go
type RetryPolicy struct {
    MaxRetries  int
    InitialWait time.Duration
    MaxWait     time.Duration
}

type Pool struct {
    dsn         string
    maxConns    int
    minConns    int
    maxIdleTime time.Duration
    timeout     time.Duration
    retryPolicy *RetryPolicy
    tlsConfig   *tls.Config
    logger      Logger
}

type Option func(*Pool) error

func WithMaxConnections(max int) Option {
    return func(p *Pool) error {
        if max < 1 {
            return errors.New("max connections must be >= 1")
        }
        p.maxConns = max
        return nil
    }
}

func WithMinConnections(min int) Option {
    return func(p *Pool) error {
        if min < 0 {
            return errors.New("min connections must be >= 0")
        }
        p.minConns = min
        return nil
    }
}

func WithTimeout(d time.Duration) Option {
    return func(p *Pool) error {
        if d <= 0 {
            return errors.New("timeout must be positive")
        }
        p.timeout = d
        return nil
    }
}

func WithRetryPolicy(policy RetryPolicy) Option {
    return func(p *Pool) error {
        if policy.MaxRetries < 0 {
            return errors.New("max retries must be >= 0")
        }
        p.retryPolicy = &policy
        return nil
    }
}

func WithTLS(cfg *tls.Config) Option {
    return func(p *Pool) error {
        p.tlsConfig = cfg
        return nil
    }
}

func WithLogger(l Logger) Option {
    return func(p *Pool) error {
        p.logger = l
        return nil
    }
}

func NewPool(dsn string, opts ...Option) (*Pool, error) {
    p := &Pool{
        dsn:         dsn,
        maxConns:    10,
        minConns:    1,
        maxIdleTime: 5 * time.Minute,
        timeout:     30 * time.Second,
        logger:      defaultLogger,
    }

    for _, opt := range opts {
        if err := opt(p); err != nil {
            return nil, fmt.Errorf("invalid option: %w", err)
        }
    }

    // Validate final state
    if p.minConns > p.maxConns {
        return nil, errors.New("min connections cannot exceed max")
    }

    return p, nil
}

// Usage
pool, err := NewPool("postgres://localhost/db",
    WithMaxConnections(50),
    WithMinConnections(5),
    WithTimeout(10*time.Second),
    WithRetryPolicy(RetryPolicy{
        MaxRetries:  3,
        InitialWait: 100 * time.Millisecond,
        MaxWait:     5 * time.Second,
    }),
    WithTLS(tlsConfig),
)
\`\`\`

### Mid-Level FAANG-Entry Track

6. **Refactor a big interface.** Find (or write) a service with a 15-method repository interface. Split into focused interfaces per consumer. Measure lines of code for test doubles before and after.

7. **Typed-nil hunt.** Write three functions that return \`error\` interface wrapping a nil typed pointer via different paths. Then fix each one. Document the pattern that each required.

8. **Interface-based decorator.** Take an \`http.Handler\` and write a decorator that adds structured logging. Then compose three decorators (logging, metrics, recovery). The exercise is composing without dependency cycles.

### Senior at FAANG Track

9. **Interface-size audit.** For one of your team's services, list every interface. Count methods. For each interface with more than five methods, write a one-paragraph justification or refactor plan.

10. **Dependency-direction audit.** Find three interfaces in your codebase that are declared in the producer package. Move them to the consumer package. Measure the import graph before and after.

11. **Mocking discipline.** Audit your team's test suite for over-mocked tests. Define the team's rule (hand-rolled fakes vs generated mocks, when to mock vs when to run for real). Write it down. Refactor three representative test files to the new discipline.

12. **Architecture review material.** Take the interface-driven application from Section 5.9 and adapt it to your team's domain. Present it at the team's architecture review. Collect feedback. Publish the adapted reference implementation.

### Staff / Principal Track

13. **Interface RFC.** Pick one interface in a shared platform package used by at least five callers in your org. Write an RFC proposing a three-year evolution plan for it. Cover: the problem, the proposed changes, the migration sequence, the deprecation window, the rollback plan, and the estimated engineering cost per affected team. Circulate to the stakeholders. Collect objections. Revise.

14. **Org-wide interface style guide.** Write a one-page internal doc that codifies your team's interface design rules. Include canonical examples of the five patterns the team uses most (functional options, middleware, strategy, adapter, optional-interface). Link it from CONTRIBUTING.md. Measure adoption six months later by sampling interface-related review comments before and after.

15. **Contract test suite.** For an interface with more than one production implementation in your codebase, build a shared contract test suite that every implementation must pass. Wire it into CI. Document the invariants the interface enforces that are not visible from the method signatures alone (thread-safety, retry semantics, ordering guarantees, idempotency).

16. **Performance audit.** Take a latency-critical Go service in your org. Profile it. Identify the interface boundaries. For each interface call in the hot path, decide whether to keep the interface, replace it with a concrete type, use generics, or enable PGO. Quantify the latency and allocation impact of each choice. Write up the tradeoffs for the team.

17. **Cross-team interface deprecation.** Take a deprecated interface that still has callers across multiple teams. Design and execute the deprecation campaign. Cover: communication plan, migration tooling, deadline, escalation path for stragglers. The exercise is not the code. It is the coordination.

18. **Interface boundary as a process boundary.** Identify an interface in your system where the coupling has grown past what in-process polymorphism can carry cleanly. Design the move to a process boundary (gRPC, HTTP, message queue). Cover: the new contract, the failure semantics that the interface did not have to express but the RPC does, and the migration that preserves the interface for the transition period.

---
`;
