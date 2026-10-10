## 87.2 How to Review Code Effectively

### The Review Process

A good code review follows a structured workflow rather than jumping straight into line-by-line nitpicking. Start by understanding the context and the problem being solved, then assess the high-level approach before diving into details. This top-down approach ensures you catch design-level issues early, rather than spending all your time on small details while missing fundamental problems.

```
┌──────────────────────────────────────────────────────────────────┐
│                   CODE REVIEW WORKFLOW                           │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. UNDERSTAND CONTEXT (Before looking at code)                  │
│     ├── Read the PR description                                  │
│     ├── Understand the problem being solved                      │
│     ├── Check linked issues or tickets                           │
│     └── Note: If description is unclear, ask first               │
│                                                                  │
│  2. HIGH-LEVEL PASS                                              │
│     ├── Does the approach make sense?                            │
│     ├── Is it the right abstraction level?                       │
│     ├── Are there architectural concerns?                        │
│     └── Review tests first (understand expected behavior)        │
│                                                                  │
│  3. DETAILED PASS                                                │
│     ├── Line-by-line review                                      │
│     ├── Check edge cases                                         │
│     ├── Verify error handling                                    │
│     ├── Look for security issues                                 │
│     └── Assess readability and naming                            │
│                                                                  │
│  4. PROVIDE FEEDBACK                                             │
│     ├── Group comments by importance                             │
│     ├── Ask questions vs make statements                         │
│     ├── Suggest alternatives when blocking                       │
│     └── Acknowledge good code                                    │
│                                                                  │
│  5. APPROVE OR REQUEST CHANGES                                   │
│     ├── Approve: Ready to merge                                  │
│     ├── Request changes: Must address before merge               │
│     └── Comment: Suggestions, not blocking                       │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### What to Look For

When reviewing Go code, there are several categories of issues that come up repeatedly. Error handling, edge cases, concurrency safety, resource cleanup, and input validation are the most common sources of production bugs. The following examples illustrate what each category looks like in practice, so you know exactly what patterns to watch for during your reviews.

```go
// CORRECTNESS CHECKLIST:

// 1. Error handling
func fetchUser(id string) (*User, error) {
    user, err := db.Get(id)
    if err != nil {
        // ✓ Is error checked?
        // ✓ Is error wrapped with context?
        // ✓ Is it handled appropriately?
        return nil, fmt.Errorf("fetch user %s: %w", id, err)
    }
    return user, nil
}

// 2. Edge cases
func divide(a, b int) int {
    // ✗ What if b is 0?
    return a / b
}

// 3. Concurrency safety
type Counter struct {
    count int  // ✗ Not thread-safe
}

func (c *Counter) Increment() {
    c.count++  // Race condition
}

// 4. Resource cleanup
func processFile(path string) error {
    f, err := os.Open(path)
    if err != nil {
        return err
    }
    // ✗ Missing: defer f.Close()

    // Process file...
    return nil
}

// 5. Input validation
func createUser(name string, email string) (*User, error) {
    // ✗ No validation
    // What if name is empty?
    // What if email is invalid?
    return &User{Name: name, Email: email}, nil
}
```

### Security Review Checklist

Security issues are the highest-priority items in any code review because they can lead to data breaches, unauthorized access, and system compromise. Every reviewer should run through these categories mentally for each PR, even if the change seems minor. A small utility function that handles user input without validation can become an attack vector in production.

```
INJECTION:
□ SQL injection (use parameterized queries)
□ Command injection (avoid shell execution)
□ XSS (sanitize user input for HTML)
□ Path traversal (validate file paths)

AUTHENTICATION/AUTHORIZATION:
□ Are auth checks in place?
□ Is authorization checked, not just authentication?
□ Are tokens handled securely?
□ Are passwords hashed (bcrypt, argon2)?

SENSITIVE DATA:
□ Are secrets in environment variables, not code?
□ Is PII handled appropriately?
□ Are logs free of sensitive data?
□ Is data encrypted at rest/in transit?

DEPENDENCIES:
□ Are dependencies from trusted sources?
□ Are there known vulnerabilities?
□ Are minimum versions specified?
```

### Junior → FAANG: Demonstrating Structured Review Thinking in Interviews

The three-pass review workflow in this section is exactly what a FAANG interviewer is probing when they ask "walk me through how you would review this PR." Candidates who jump immediately to line-level feedback reveal that they skip the high-level pass, which is where design-level issues live.

Practice narrating the workflow aloud. "First I read the PR description and linked issue to understand the problem. Then I look at the tests to understand what the author believes the correct behavior is. Then I review the architecture and approach before going line by line." That narration demonstrates the same kind of structured thinking that good system design answers demonstrate: you have a process, not just instincts.

The security checklist is particularly important for FAANG interviews because security awareness is an explicit bar at all levels. Candidates who never mention SQL injection, auth checks, or secrets handling in a code review scenario are raising a flag. Weave at least one security consideration into every code review interview answer.

### Senior @ FAANG: The High-Level Pass as an Architectural Governance Tool

At L6 and above, the high-level review pass is where a staff engineer's value in the review process is concentrated. The line-by-line pass is where any competent engineer contributes. The architectural and design pass is where staff-level judgment is irreplaceable.

The highest-value thing a staff engineer does in a review is to identify that the approach itself is wrong before the author has invested deeply in implementation. "This approach cannot be made safe under concurrent access with reasonable changes. The design needs to be reconsidered" is a comment that saves days of debugging rather than hours. Writing that comment well, explaining the invariant that is violated and describing the design space for alternatives, is a distinct skill from writing good line-level feedback.

At the governance level, the security review checklist should not be a personal habit. It should be an automated and human-review combination: automated static analysis catches the mechanical issues, freeing human reviewers to focus on the architectural security concerns that tools cannot detect. Staff engineers who advocate for security scanning in the CI pipeline, and then use the freed attention to do richer architectural security review, are optimizing the entire review pipeline rather than just their individual contribution to it.

---

### Production Case Study: The 20-Minute Go Codebase Audit Framework

When onboarding to a new team or reviewing an extensive architecture pull request, line-by-line review without an organizing diagnostic framework causes reviewers to miss structural flaws while bikeshedding minor syntax. In [The first 10 things I check in every Go codebase](https://medium.com/@yaninyzwitty/the-first-10-things-i-check-in-every-go-codebase), Yaninyz witty outlines a battle-tested 20-minute audit framework for evaluating whether a Go project has sound production foundations.

```
┌────────────────────────────────────────────────────────────────────────┐
│             THE 20-MINUTE GO CODEBASE AUDIT CHECKLIST                  │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│  1. Error Wrapping Chains       ──► Use %w, errors.Is/As; no %v        │
│  2. Package Encapsulation       ──► Enforce compiler boundaries with   │
│                                     internal/; reject flat root leaks  │
│  3. Context Threading           ──► ctx first arg on I/O; no rogue     │
│                                     context.Background() in services   │
│  4. Goroutine Lifecycle         ──► Explicit ownership, stop channels, │
│                                     zero unbuffered leak vectors       │
│  5. Connection Pool Tuning      ──► MaxOpenConns, MaxIdleConns, and    │
│                                     ConnMaxLifetime explicitly set     │
│  6. Config & Secret Hygiene     ──► Typed struct parsed once at boot;  │
│                                     zero naked os.Getenv in domain code│
│  7. Interface Directionality    ──► Consumer-defined small interfaces; │
│                                     no Java-style producer interfaces  │
│  8. Test Signal Quality         ──► Table-driven with failure cases;   │
│                                     go test -race mandatory in CI      │
│  9. Linter Enforcement          ──► Strict golangci-lint in CI pipeline│
│ 10. Graceful Shutdown Flow      ──► Multi-stage drain: listener stop   │
│                                     ──► worker wait ──► DB pool close  │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

#### The 10 Audit Checkpoints in Detail

1. **Error Wrapping Discipline**: Grep for `err != nil`. Look for `fmt.Errorf("...: %w", err)` to preserve causal unwrapping. Flag naked `return err` where stack context vanishes, or string inspection like `strings.Contains(err.Error(), "not found")` instead of `errors.Is(err, sql.ErrNoRows)`.
2. **Package Layout & `internal/` Boundaries**: Inspect repository directory structure. Code inside `internal/` cannot be imported by external modules, preventing unintended API coupling. A project with every package exposed at root level leaks internal types into client code.
3. **Context Threading**: Ensure `context.Context` is the initial parameter of every network, database, and background function. Verify that deep business logic does not instantiate `context.Background()` or leave forgotten `context.TODO()` markers.
4. **Goroutine Ownership**: Every spawned goroutine must have an explicit parent, a deterministic termination condition, and a cleanup mechanism. Verify that channel sends do not block forever on unbuffered channels when receivers abandon work.
5. **Database Connection Pool Parameters**: Check database initialization. Verify that `SetMaxOpenConns`, `SetMaxIdleConns`, and `SetConnMaxLifetime` are tuned to prevent connection starvation or stale idle connections behind cloud load balancers.
6. **Configuration & Secrets Handling**: Flag raw `os.Getenv` calls scattered throughout handlers or domain logic. All configuration must unmarshal into a validated struct at application startup, failing immediately if required environment variables are missing.
7. **Consumer-Defined Interfaces**: Interfaces must live where they are consumed, not where concrete types are defined. Flag 20-method monolithic interfaces that mirror struct implementations.
8. **Test Signal vs. Coverage Theater**: Verify that tests run with `go test -race ./...`. Prioritize table-driven tests that assert specific error types and boundary conditions over 100% line coverage of happy-path getters and setters.
9. **Automated Static Analysis**: Check `.golangci.yml`. Ensure linters like `govet`, `errcheck`, `staticcheck`, and `gosec` are active in CI and blocking PR merges on failures.
10. **Multi-Stage Graceful Shutdown**: Inspect `main.go`. Shutdown must listen for `SIGINT`/`SIGTERM`, stop accepting new HTTP/gRPC requests, wait for active workers to complete using `sync.WaitGroup`, and finally close persistent database pools.
