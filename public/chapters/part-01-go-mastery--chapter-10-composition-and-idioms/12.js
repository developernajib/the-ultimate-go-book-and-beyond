export default `## 10.11 Interview Questions

These questions appear frequently in Go interviews at companies that run Go in production. Each answer demonstrates both theoretical understanding and practical application.

> **What FAANG actually tests here**: whether you can defend Go's design choices (no inheritance, small interfaces, functional options) against common criticisms without dogma, and whether you can apply the patterns to a real system without over-engineering.

### Question 1: Why does Go prefer composition over inheritance?

**What FAANG expects**: the classic objections to inheritance (fragile base, tight coupling, diamond problem), plus what Go offers in its place (embedding, interfaces, dependency injection). Candidates who recite "inheritance is bad" without explaining why fail the senior bar.

**Answer:**
Go deliberately omits inheritance to avoid several problems:

1. **Fragile base class problem**: In inheritance, changes to parent classes can break child classes in unexpected ways. With composition, components are more isolated.

2. **Tight coupling**: Inheritance creates strong dependencies between classes. Composition allows for looser coupling through interfaces.

3. **Deep hierarchies**: Complex inheritance trees are hard to understand and navigate. Flat composition is more straightforward.

4. **Diamond problem**: Multiple inheritance creates ambiguity about which parent's method to use. Go's embedding with explicit disambiguation avoids this.

Go achieves code reuse through:
- **Struct embedding**: Automatic method/field promotion
- **Interface composition**: Building larger interfaces from smaller ones
- **Dependency injection**: Passing dependencies as parameters

**Follow-ups**:
- How does Go's embedding avoid the diamond problem that multiple inheritance has?
- When is "composition over inheritance" wrong, and is Go's strict stance ever a handicap?

### Question 2: When should you use embedding vs composition?

**What FAANG expects**: clear criteria (API exposure, method interception, interface satisfaction), and awareness that embedding is itself a form of composition in Go, just one with automatic method promotion.

**Answer:**

**Use embedding when:**
- You want the outer type to satisfy interfaces the inner type satisfies
- The inner type's entire API is appropriate for the outer type
- You're genuinely extending functionality

\`\`\`go
// Embedding: Server "is-a" http.Server
type Server struct {
    http.Server
    // additional fields
}
// Server.ListenAndServe() works automatically
\`\`\`

**Use composition when:**
- You want to hide or restrict the inner type's API
- You need to intercept or transform method calls
- The inner type's API doesn't make sense for the outer type

\`\`\`go
// Composition: Server "has-a" http.Server
type Server struct {
    httpServer *http.Server
}

func (s *Server) Start() error {
    return s.httpServer.ListenAndServe()
}
\`\`\`

**Follow-ups**:
- If two embedded types define a method with the same name, what does the outer type see?
- How does embedding interact with pointer-receiver vs value-receiver method sets?

### Question 3: What is the functional options pattern and when should you use it?

**What FAANG expects**: the pattern, when it pays off (many optional parameters, validation, backwards compatibility), and when it is overkill (1-2 required fields, simple constructors).

**Answer:**
The functional options pattern uses functions to configure structs:

\`\`\`go
type Option func(*Config)

func WithTimeout(d time.Duration) Option {
    return func(c *Config) {
        c.timeout = d
    }
}

func NewClient(opts ...Option) *Client {
    cfg := &Config{timeout: 30 * time.Second} // defaults
    for _, opt := range opts {
        opt(cfg)
    }
    return &Client{config: cfg}
}

// Usage
client := NewClient(WithTimeout(60 * time.Second))
\`\`\`

**Use it when:**
- You have many optional configuration parameters
- You want self-documenting API (option names describe what they do)
- You need to add new options without breaking existing code
- You want validation logic in options

**Avoid when:**
- Configuration is simple (1-2 required parameters)
- All parameters are required

**Follow-ups**:
- How would you return an error from an option function (e.g., validation fails)?
- What is the builder pattern alternative, and why is the functional options pattern usually preferred in Go?

### Question 4: Explain the Go proverb "The bigger the interface, the weaker the abstraction."

**What FAANG expects**: the implementation-and-testability argument plus concrete examples from the standard library (\`io.Reader\`, \`io.Writer\`, \`error\`) where tiny interfaces enable vast ecosystem compatibility.

**Answer:**
Smaller interfaces provide stronger abstractions because:

1. **Easier to implement**: A type needs fewer methods to satisfy the interface
2. **More reusable**: More types naturally satisfy smaller interfaces
3. **Clearer intent**: It's obvious what the interface is for
4. **Better testing**: Mocks are simpler with fewer methods

\`\`\`go
// Weak: too many methods
type DataStore interface {
    Get, Set, Delete, List, Watch, Transaction, Backup, Restore...
}
// Few types can implement all these methods

// Strong: minimal interface
type Getter interface {
    Get(key string) ([]byte, error)
}
// Many types already implement this: Redis, S3, files, memory, etc.
\`\`\`

The standard library exemplifies this: \`io.Reader\` (one method) is implemented by files, network connections, buffers, HTTP bodies, gzip readers, and countless more.

**Follow-ups**:
- When does a multi-method interface make sense? (hint: \`http.ResponseWriter\`)
- How do you refactor a large interface without breaking existing implementations?

### Question 5: How do you organize packages in a Go project?

**What FAANG expects**: organization by feature/domain rather than by technical layer, \`cmd/internal/pkg\` conventions, and awareness that layer-based organization (\`handlers/\`, \`services/\`) is an anti-pattern in Go.

**Answer:**
Organize by **feature/domain**, not by layer:

\`\`\`
// Good: by feature
internal/
├── user/
│   ├── handler.go    # HTTP handlers
│   ├── service.go    # Business logic
│   └── repository.go # Data access
├── order/
└── payment/

// Bad: by layer
internal/
├── handlers/
├── services/
└── repositories/
\`\`\`

**Key principles:**

1. **cmd/** for main packages (entry points)
2. **internal/** for private packages (can't be imported outside module)
3. **pkg/** for public libraries (if any)
4. **Avoid circular imports** using interfaces or shared types packages
5. **Package names** should be short, lowercase, no underscores
6. **One package per directory**

**Follow-ups**:
- How do you break a circular import when two packages genuinely need each other?
- What goes in \`pkg/\` that does not belong in \`internal/\`?

### Q (Senior track): How do you enforce idiomatic Go across a team of fifty engineers?

**What FAANG expects**: a multi-layered answer covering tooling, review, and documentation.

**Answer**: Three layers. First, tooling: \`gofmt\`, \`golangci-lint\` with a tuned ruleset, custom linters for team-specific patterns. Wire into CI as blocking checks. Second, code review: the team's review checklist references the patterns in this chapter, and reviewers are empowered to cite specific rules. Third, documentation: the team's "how we write Go" guide covers the conventions with before-and-after examples.

The hard part is discipline, not enforcement. A single senior engineer who approves non-idiomatic PRs undermines the whole system. Make the conventions the team's shared language.

### Q (Staff track): Walk through how you would roll out a new idiom to a team of 200 Go engineers without a revolt.

**What FAANG expects at staff**: an execution plan with stakeholder buy-in, automation, measurement, and a grace period. A naive "just enforce it" answer fails the bar.

**Answer**: Five-phase rollout.

1. **Draft and socialise.** Write the new idiom in a one-page RFC. Include motivation, examples, anti-examples, and cost estimate for existing code. Circulate to the senior pool for input before announcing to the full team.
2. **Pilot.** One volunteer team applies the idiom to a representative codebase for four weeks. Track time spent, PRs touched, bugs introduced, bugs avoided. The pilot either validates the idiom or kills it cheaply.
3. **Tooling.** Ship a linter rule or a codemod that automates detection (ideally, fixing). Without automation, enforcement is reviewer exhaustion. With it, the tool catches 80% and review catches the remaining 20%.
4. **Grace period.** Announce the idiom to the full team with a six-to-twelve-week grace period. During this time the linter warns, not errors. Old code does not need to migrate, but new code should follow the idiom.
5. **Hard enforcement.** After the grace period, the linter errors. Old code is migrated opportunistically, not in a flag-day rewrite. Include dashboards showing adoption trend.

The common failures: skipping the pilot (the idiom turns out to have a fatal flaw), skipping automation (reviewers burn out flagging the same thing 500 times), skipping the grace period (the team revolts). A staff engineer who has rolled out an idiom before knows the failure modes and designs around them.

**Follow-ups**:
- How would you measure the idiom's adoption six months later?
- What if the pilot reveals the idiom is wrong for half the codebase?

### Q (Staff track): You inherit a codebase where every microservice reimplements middleware, config loading, and error handling differently. How do you converge them?

**What FAANG expects**: a migration strategy that does not force a flag day, preserves velocity, and respects team autonomy.

**Answer**: Three-stage convergence.

1. **Stop the bleeding.** Freeze the creation of new services with bespoke shapes. Any new service must adopt the shared library. This stops the problem from growing.
2. **Build the shared library.** Extract the best-of-breed middleware, config loader, and error handling from existing services. The shared library is not invented. It is the generalisation of what already works.
3. **Opportunistic migration.** When a team touches an existing service for any reason (feature, bug, refactor), they adopt the shared library for that service. Do not force a coordinated migration. Over 12 to 24 months, most services migrate naturally.

The counter-intuitive staff insight: the 20% of services that never migrate are often correct to stay on their bespoke shape. Do not force them. The cost of the migration may exceed the benefit of consistency for those specific services. Respect the cost-benefit.

**Follow-ups**:
- How do you handle the team that refuses to migrate because "our way is better"?
- What do you do when two shared libraries emerge organically and disagree?

---
`;
