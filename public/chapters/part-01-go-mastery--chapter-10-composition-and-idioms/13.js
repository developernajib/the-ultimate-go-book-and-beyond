export default `## 10.12 Exercises with Solutions

Each exercise applies a pattern from this chapter to a realistic scenario. Try implementing the solution yourself before reading the answer.

### Exercise 1: Implement Functional Options for HTTP Client

**Problem:** Create an HTTP client with functional options for timeout, retry, and custom headers.

**Solution:**

\`\`\`go
package httpclient

import (
    "net/http"
    "net/url"
    "strings"
    "time"
)

type Client struct {
    httpClient *http.Client
    baseURL    string
    timeout    time.Duration
    retries    int
    headers    map[string]string
}

type Option func(*Client)

func WithTimeout(d time.Duration) Option {
    return func(c *Client) {
        c.timeout = d
        c.httpClient.Timeout = d
    }
}

func WithRetries(n int) Option {
    return func(c *Client) {
        c.retries = n
    }
}

func WithHeader(key, value string) Option {
    return func(c *Client) {
        if c.headers == nil {
            c.headers = make(map[string]string)
        }
        c.headers[key] = value
    }
}

func WithBaseURL(url string) Option {
    return func(c *Client) {
        c.baseURL = url
    }
}

func NewClient(opts ...Option) *Client {
    c := &Client{
        httpClient: &http.Client{
            Timeout: 30 * time.Second,
        },
        timeout: 30 * time.Second,
        retries: 0,
        headers: make(map[string]string),
    }

    for _, opt := range opts {
        opt(c)
    }

    return c
}

func (c *Client) Do(req *http.Request) (*http.Response, error) {
    // Apply default headers
    for k, v := range c.headers {
        if req.Header.Get(k) == "" {
            req.Header.Set(k, v)
        }
    }

    // Prepend base URL
    if c.baseURL != "" && !strings.HasPrefix(req.URL.String(), "http") {
        req.URL, _ = url.Parse(c.baseURL + req.URL.String())
    }

    // Retry logic
    var resp *http.Response
    var err error

    for attempt := 0; attempt <= c.retries; attempt++ {
        resp, err = c.httpClient.Do(req)
        if err == nil && resp.StatusCode < 500 {
            return resp, nil
        }

        if attempt < c.retries {
            time.Sleep(time.Duration(attempt+1) * time.Second)
        }
    }

    return resp, err
}

// Usage
func main() {
    client := NewClient(
        WithBaseURL("https://api.example.com"),
        WithTimeout(10*time.Second),
        WithRetries(3),
        WithHeader("Authorization", "Bearer token123"),
        WithHeader("User-Agent", "MyApp/1.0"),
    )

    req, _ := http.NewRequest("GET", "/users", nil)
    _, _ = client.Do(req)
}
\`\`\`

### Exercise 2: Middleware Chain

**Problem:** Build a middleware system that allows chaining multiple middleware functions.

**Solution:**

\`\`\`go
package middleware

import (
    "context"
    "log/slog"
    "net/http"
    "time"
)

type Middleware func(http.Handler) http.Handler

// Chain composes multiple middleware into one
func Chain(middlewares ...Middleware) Middleware {
    return func(final http.Handler) http.Handler {
        for i := len(middlewares) - 1; i >= 0; i-- {
            final = middlewares[i](final)
        }
        return final
    }
}

// Logging logs request details
func Logging(logger *slog.Logger) Middleware {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            start := time.Now()
            wrapped := &statusRecorder{ResponseWriter: w, status: 200}

            next.ServeHTTP(wrapped, r)

            logger.Info("request",
                "method", r.Method,
                "path", r.URL.Path,
                "status", wrapped.status,
                "duration", time.Since(start),
            )
        })
    }
}

type statusRecorder struct {
    http.ResponseWriter
    status int
}

func (r *statusRecorder) WriteHeader(status int) {
    r.status = status
    r.ResponseWriter.WriteHeader(status)
}

// Timeout adds a timeout to requests
func Timeout(d time.Duration) Middleware {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            ctx, cancel := context.WithTimeout(r.Context(), d)
            defer cancel()

            next.ServeHTTP(w, r.WithContext(ctx))
        })
    }
}

// Auth checks for authorization header
func Auth(validator func(token string) bool) Middleware {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            token := r.Header.Get("Authorization")
            if token == "" || !validator(token) {
                http.Error(w, "Unauthorized", http.StatusUnauthorized)
                return
            }
            next.ServeHTTP(w, r)
        })
    }
}

// CORS adds CORS headers
func CORS(origins []string) Middleware {
    allowed := make(map[string]bool)
    for _, o := range origins {
        allowed[o] = true
    }

    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            origin := r.Header.Get("Origin")
            if allowed["*"] || allowed[origin] {
                w.Header().Set("Access-Control-Allow-Origin", origin)
                w.Header().Set("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS")
                w.Header().Set("Access-Control-Allow-Headers", "Content-Type,Authorization")
            }

            if r.Method == "OPTIONS" {
                w.WriteHeader(http.StatusOK)
                return
            }

            next.ServeHTTP(w, r)
        })
    }
}

// Usage
func main() {
    logger := slog.Default()

    handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        w.Write([]byte("Hello, World!"))
    })

    chain := Chain(
        Logging(logger),
        Timeout(5*time.Second),
        Auth(func(token string) bool { return token == "secret" }),
        CORS([]string{"https://example.com"}),
    )

    http.Handle("/api/", chain(handler))
    http.ListenAndServe(":8080", nil)
}
\`\`\`

### Exercise 3: Generic Repository

**Problem:** Implement a generic repository interface with in-memory implementation.

**Solution:**

\`\`\`go
package repository

import (
    "context"
    "errors"
    "sync"
)

var (
    ErrNotFound = errors.New("not found")
    ErrConflict = errors.New("already exists")
)

// Entity must have a string ID
type Entity interface {
    GetID() string
}

// Repository defines CRUD operations for any entity
type Repository[T Entity] interface {
    Get(ctx context.Context, id string) (T, error)
    List(ctx context.Context, offset, limit int) ([]T, error)
    Create(ctx context.Context, entity T) error
    Update(ctx context.Context, entity T) error
    Delete(ctx context.Context, id string) error
}

// InMemoryRepository is a generic in-memory implementation
type InMemoryRepository[T Entity] struct {
    mu    sync.RWMutex
    items map[string]T
}

func NewInMemoryRepository[T Entity]() *InMemoryRepository[T] {
    return &InMemoryRepository[T]{
        items: make(map[string]T),
    }
}

func (r *InMemoryRepository[T]) Get(ctx context.Context, id string) (T, error) {
    r.mu.RLock()
    defer r.mu.RUnlock()

    item, ok := r.items[id]
    if !ok {
        var zero T
        return zero, ErrNotFound
    }
    return item, nil
}

func (r *InMemoryRepository[T]) List(ctx context.Context, offset, limit int) ([]T, error) {
    r.mu.RLock()
    defer r.mu.RUnlock()

    result := make([]T, 0, len(r.items))
    for _, item := range r.items {
        result = append(result, item)
    }

    // Apply pagination
    if offset >= len(result) {
        return []T{}, nil
    }

    end := offset + limit
    if end > len(result) {
        end = len(result)
    }

    return result[offset:end], nil
}

func (r *InMemoryRepository[T]) Create(ctx context.Context, entity T) error {
    r.mu.Lock()
    defer r.mu.Unlock()

    if _, exists := r.items[entity.GetID()]; exists {
        return ErrConflict
    }

    r.items[entity.GetID()] = entity
    return nil
}

func (r *InMemoryRepository[T]) Update(ctx context.Context, entity T) error {
    r.mu.Lock()
    defer r.mu.Unlock()

    if _, exists := r.items[entity.GetID()]; !exists {
        return ErrNotFound
    }

    r.items[entity.GetID()] = entity
    return nil
}

func (r *InMemoryRepository[T]) Delete(ctx context.Context, id string) error {
    r.mu.Lock()
    defer r.mu.Unlock()

    if _, exists := r.items[id]; !exists {
        return ErrNotFound
    }

    delete(r.items, id)
    return nil
}

// Example entity
type User struct {
    ID    string
    Name  string
    Email string
}

func (u User) GetID() string {
    return u.ID
}

// Usage
func main() {
    userRepo := NewInMemoryRepository[User]()

    ctx := context.Background()

    // Create
    _ = userRepo.Create(ctx, User{
        ID:    "1",
        Name:  "John",
        Email: "john@example.com",
    })

    // Get
    user, _ := userRepo.Get(ctx, "1")

    // List
    _, _ = userRepo.List(ctx, 0, 10)

    // Update
    user.Name = "Jane"
    _ = userRepo.Update(ctx, user)

    // Delete
    _ = userRepo.Delete(ctx, "1")
}
\`\`\`

### Senior at FAANG Track

7. **Team idiomatic Go guide.** Write the team's guide. Cover composition vs inheritance, functional options vs config structs, naming conventions, package layout, testing. Publish.

8. **Idiomatic refactor.** Pick one service. Identify non-idiomatic patterns (config structs, getter/setter chains, inheritance-shaped embedding). Land the refactor incrementally.

9. **Linter authorship.** Author a team-specific linter that catches one recurring non-idiomatic pattern. Wire into CI.

10. **Review-discipline retro.** After a quarter of applying idiomatic-Go discipline, run a team retro. What worked, what didn't, which conventions stuck. Document.

### Staff / Principal Track

11. **Cross-service convergence plan.** Pick an org with ten to fifty Go services that have diverged on middleware, config loading, and error handling. Write the convergence plan: which shapes win, which lose, the migration strategy, the grace period, the rollback plan if the convergence is wrong. Socialise with the senior pool. Revise. The deliverable is the plan, not the code.

12. **Idiom RFC with pilot.** Author a one-page RFC proposing a new idiom (example: "all services adopt \`slog\` with a shared handler factory"). Run a four-week pilot on one team. Collect before-and-after metrics. Decide whether to roll out or kill.

13. **Framework vs library decision.** Your org is debating whether to build an internal HTTP framework. Write the decision doc: the case for framework, the case for shared library, the recommendation. Include cost estimates for each path over three years. Principal-level deliverable.

14. **Linter for organisational idiom.** Author a \`golangci-lint\` custom linter that catches an org-specific pattern violation (example: "no constructor may take more than three positional parameters"). Wire into CI. Measure the false-positive rate and tune over four weeks.

15. **Idiom deprecation.** Identify an idiom that was correct five years ago and is now wrong (example: \`interface{}\` where \`any\` or generics should be used, hand-rolled clock interfaces where \`testing/synctest\` now exists). Write the deprecation doc, including the migration path. Drive the rollout over two quarters.

16. **The library graveyard audit.** For a mature Go org, audit the internal shared libraries that were built with enthusiasm and are now abandoned. Categorise each: still-used, dormant-but-harmless, active-liability. For the liabilities, write a retirement plan. This is unglamorous principal work that saves the org real maintenance cost.

---
`;
