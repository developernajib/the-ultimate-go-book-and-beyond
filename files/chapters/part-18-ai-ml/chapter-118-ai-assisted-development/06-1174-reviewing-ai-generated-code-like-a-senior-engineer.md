## 118.4 Reviewing AI-Generated Code Like a Senior Engineer

### The Review Checklist

Every piece of AI-generated code that goes into your codebase deserves a review at least as thorough as you would give a junior engineer's PR. This is not optional. It is the professional obligation, and it is the one that transfers with your name on the commit.

**Security**:

```go
// AI often generates this - INSECURE
query := "SELECT * FROM users WHERE email = '" + email + "'"

// What it should generate - SECURE
query := "SELECT * FROM users WHERE email = $1"
rows, err := db.QueryContext(ctx, query, email)
```
```go
// AI often generates JWT "validation" like this - INSECURE
// The error is discarded, so an unverified token sails straight through.
token, _ := jwt.Parse(tokenString, nil)
claims := token.Claims.(jwt.MapClaims)

// What it should generate - SECURE
token, err := jwt.Parse(tokenString, func(token *jwt.Token) (any, error) {
    if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
        return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
    }
    return []byte(secretKey), nil
})
if err != nil || !token.Valid {
    return nil, ErrInvalidToken
}
```
**Error handling**:

```go
// AI often generates this - errors swallowed
result, _ := someFunction()
anotherResult, _ := anotherFunction(result)

// What it should generate
result, err := someFunction()
if err != nil {
    return fmt.Errorf("doing X: %w", err)
}
anotherResult, err := anotherFunction(result)
if err != nil {
    return fmt.Errorf("doing Y with result: %w", err)
}
```
**Concurrency**:

```go
// AI often generates this - race condition
type Cache struct {
    data map[string]string
}

func (c *Cache) Get(key string) string {
    return c.data[key] // NOT SAFE for concurrent access
}

// What it should generate
type Cache struct {
    mu   sync.RWMutex
    data map[string]string
}

func (c *Cache) Get(key string) (string, bool) {
    c.mu.RLock()
    defer c.mu.RUnlock()
    val, ok := c.data[key]
    return val, ok
}
```
**Edge cases**:

```go
// AI often generates the happy path and drops the failure path entirely
func processItems(items []Item) []Result {
    results := make([]Result, len(items))
    for i, item := range items {
        results[i] = process(item) // what if process fails? there's nowhere to say so
    }
    return results
}

// What it should generate
func processItems(items []Item) ([]Result, error) {
    if len(items) == 0 {
        return nil, nil // or []Result{} depending on API contract
    }
    results := make([]Result, 0, len(items))
    for _, item := range items {
        result, err := process(item)
        if err != nil {
            return nil, fmt.Errorf("processing item %v: %w", item.ID, err)
        }
        results = append(results, result)
    }
    return results, nil
}
```
### Common AI Code Anti-Patterns in Go

**1. Goroutine leaks**

AI frequently generates goroutines without proper lifecycle management:

```go
// AI generates this - the goroutine outlives any way to stop it
func startWorker(jobs <-chan Job) {
    go func() {
        for job := range jobs {
            process(job)
        }
    }()
    // no way to stop this goroutine
}

// Correct: use context for cancellation
func startWorker(ctx context.Context, jobs <-chan Job) {
    go func() {
        for {
            select {
            case <-ctx.Done():
                return
            case job, ok := <-jobs:
                if !ok {
                    return
                }
                process(job)
            }
        }
    }()
}
```
**2. Defer in loops**

```go
// AI generates this - defer runs at function return, not loop iteration
// If you open 1000 files, all stay open until the function returns
func processFiles(paths []string) error {
    for _, path := range paths {
        f, err := os.Open(path)
        if err != nil {
            return err
        }
        defer f.Close() // BUG: all files stay open until processFiles returns
        process(f)
    }
    return nil
}

// Correct: use a closure
func processFiles(paths []string) error {
    for _, path := range paths {
        if err := processFile(path); err != nil {
            return fmt.Errorf("processing %s: %w", path, err)
        }
    }
    return nil
}

func processFile(path string) error {
    f, err := os.Open(path)
    if err != nil {
        return err
    }
    defer f.Close()
    return process(f)
}
```
**3. Locking on value receiver (mutex on copy)**

```go
// AI generates this - mutex copied, provides NO protection
type Counter struct {
    mu    sync.Mutex
    count int
}

// Value receiver copies the Counter, including the mutex
// Each call works on a different copy - DATA RACE
func (c Counter) Increment() {
    c.mu.Lock()
    defer c.mu.Unlock()
    c.count++ // operates on a copy
}

// Correct: pointer receiver
func (c *Counter) Increment() {
    c.mu.Lock()
    defer c.mu.Unlock()
    c.count++
}
```
**4. Missing context propagation**

```go
// AI often "forgets" context in internal calls
func (s *UserService) CreateUser(ctx context.Context, req CreateUserRequest) (*User, error) {
    // validate...
    user := &User{...}

    // BUG: context not propagated to database call
    if err := s.repo.Save(user); err != nil {
        return nil, err
    }

    // Correct:
    if err := s.repo.Save(ctx, user); err != nil {
        return nil, fmt.Errorf("saving user: %w", err)
    }
    return user, nil
}
```
**5. Any instead of proper types**

```go
// AI falls back to any when it doesn't know the type
func (s *Service) Process(data any) (any, error) {
    // ...
}

// Usually the right answer: a concrete type or a narrow interface
func (s *Service) Process(req ProcessRequest) (*ProcessResult, error) {
    // ...
}

// If the operation genuinely is generic, it must be a function, not a method.
// Methods cannot declare type parameters in Go.
func Process[T any](s *Service, data T) (T, error) {
    // ...
}
```

That last comment is worth dwelling on, because it is a good example of how AI fails in Go specifically. Ask a model to "make this method generic" and there is a fair chance it writes `func (s *Service) Process[T any](data T)`, which is not merely bad style. It does not compile. Go forbids type parameters on methods, and the compiler says exactly that: `method must have no type parameters`. The model produces it anyway because the shape is right in most other languages with generics. This is the class of error the compiler catches for you for free, which is why "does it build" is the cheapest review step you have, and why you run it before you read anything.

### Security Red Flags in AI Output

When reviewing AI-generated code, these patterns are immediate blockers. Do not merge until they are fixed:

**1. SQL concatenation** (any form):
```go
// BLOCK - SQL injection
db.Query("SELECT * FROM " + table + " WHERE id = " + id)
db.Query(fmt.Sprintf("SELECT * FROM users WHERE email = '%s'", email))
```
**2. JWT without signature verification**:
```go
// BLOCK - authentication bypass
p := jwt.NewParser()
token, _, _ := p.ParseUnverified(tokenStr, jwt.MapClaims{})
```
**3. Crypto anti-patterns**:
```go
// BLOCK - MD5/SHA1 for password hashing (both are fast, which is the problem)
md5.Sum([]byte(password))
sha1.Sum([]byte(password))

// Acceptable: a slow, salted password hash
hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
```
**4. Logging sensitive data**:
```go
// BLOCK - PII in logs
log.Printf("user logged in: %s password: %s", email, password)
slog.Info("request", "body", req) // if req contains PII
```
**5. Hardcoded secrets**:
```go
// BLOCK - any kind of hardcoded credential
const jwtSecret = "supersecret123"
apiKey := "sk-abc123def456"
```
**6. Missing rate limiting on auth**:
```go
// REVIEW - auth endpoint with no rate limiting
r.Post("/auth/login", s.handleLogin) // is there rate limiting middleware?
```
**7. Weak randomness**:
```go
// BLOCK - predictable "random" tokens
import "math/rand/v2"
token := rand.Int64() // NOT cryptographically secure

// Correct: crypto/rand
import "crypto/rand"

b := make([]byte, 32)
if _, err := rand.Read(b); err != nil {
    return "", fmt.Errorf("generating token: %w", err)
}
token := base64.RawURLEncoding.EncodeToString(b)

// Simpler for the common case (Go 1.24+): a random URL-safe string
token := rand.Text()
```

`math/rand/v2` is the trap worth naming, because it looks modern. The `/v2` reads like the newer, better package, and for simulations and load generation it is. For anything an attacker must not predict (session tokens, password reset links, CSRF tokens, API keys) it is a vulnerability, and the two packages are one import line apart with identical-looking call sites.
### The Trust but Verify Principle

Three rules for AI-generated code in production:

**Rule 1: Understand before you commit**. If you cannot explain what the code does and why each part is there, you are not ready to commit it. Ask AI to explain its own output. Read the Go standard library documentation for unfamiliar functions it uses.

**Rule 2: Security and auth code requires expert review**. If AI generates authentication, authorization, or cryptography code, it must be reviewed by someone with security expertise before merging. No exceptions. This is not because AI is always wrong. It is because the consequences of being wrong are catastrophic and the patterns are subtle.

**Rule 3: Test coverage is not optional for AI-generated code**. AI output that lacks tests is a draft, not code. Require AI to generate tests alongside implementation. Run the tests. If they don't adequately cover the behavior, add more tests before considering the code ready.

---

### Junior → FAANG: Code Review as the Primary Quality Gate for AI Output

The review checklist in this section is a formalized version of the review process that every FAANG engineer is expected to apply to code they author, whether that code is AI-generated or written by hand. The difference with AI-generated code is that the checklist must be applied more deliberately because AI-generated code has a distinct failure mode pattern: it is usually syntactically correct and architecturally plausible, but fails on edge cases (nil pointers, empty slices, zero values), error handling (swallowed errors, incorrect error types), and security (missing input validation, incorrect authorization checks). Knowing this failure pattern means you know where to focus your review energy.

Practice applying the checklist to real AI-generated Go code until it becomes automatic. Take any function generated by an AI tool (a repository method, a service function, an HTTP handler) and work through: are all errors handled and wrapped? Are all inputs validated before use? Are there nil dereferences in the happy path? What happens with an empty slice? What happens with a zero-value struct? Does the function implement the interface contract correctly, including behavior specified in comments? This practice, done regularly, develops the code reading skill that FAANG interviewers assess in code review interview rounds.

The three rules at the end of the section (understand before merging, security review for sensitive code, tests are not optional) are the behavioral commitments that distinguish engineers who use AI responsibly from engineers who use AI to generate code they do not understand. In a FAANG interview, if asked "how do you ensure quality for AI-generated code you use in production?", these three rules are the core of the correct answer. Be prepared to give concrete examples of each: a time you caught a bug by understanding AI-generated code before merging, a security issue you identified in AI-generated authentication code, and a test you added to cover a case the AI missed.

### Senior @ FAANG: Code Review Standards for AI-Assisted Engineering at Scale

At senior level, the review checklist becomes a code review automation target. Several items on the checklist can be automated: error handling check (errcheck linter), nil pointer dereference risk (staticcheck), missing context propagation (custom linter), SQL parameterization (custom query analysis). Automation moves the checklist from a mental model that engineers apply inconsistently to a CI gate that applies it consistently to every PR. The items that cannot be automated (architectural fit, business logic correctness, security for novel attack vectors) are the ones that require the experienced human reviewer's attention.

The staff engineer's contribution to AI-assisted code review is the review standard document: a concrete, testable specification of what "production quality" means for AI-generated code in this codebase. This document covers the checklist items, the automation that enforces them, the items that require human review and why, and the process for escalating code that a reviewer is not qualified to review (e.g., cryptographic code that should be reviewed by a security engineer). Without this document, code review quality for AI-generated code varies with the reviewer's experience level, which is inconsistent and does not scale.

The "tests are not optional" rule has an organizational enforcement mechanism: code coverage gates in CI. If coverage drops below the team's standard when a PR is merged, CI fails. This means AI-generated code without tests causes CI to fail, making the rule automatic rather than advisory. Setting up and maintaining the coverage gate, calibrating it to allow reasonable exceptions (generated code, thin adapters), and monitoring coverage trends over time is the kind of platform engineering work that keeps the quality standard stable as the team grows and as AI tool usage increases.
