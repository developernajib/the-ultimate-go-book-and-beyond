## 118.3 Effective Prompting for Engineers

### The Prompting Mindset

Most engineers approach prompting like asking a favor: "can you write me a function that does X?" This produces mediocre results.

Senior engineers approach prompting like writing a specification: they provide context, constraints, requirements, and acceptance criteria. The AI becomes a code generator executing a well-defined spec.

**The shift**:
- From: "write a user service"
- To: "implement the `UserService` interface defined in `internal/domain/user.go` using PostgreSQL via pgx/v5. The `GetByEmail` method must use parameterized queries. Wrap all errors with context using `fmt.Errorf`. Propagate the context to all database calls. Follow the pattern established in `internal/repository/org_repository.go`."

The second prompt produces something worth reviewing. The first produces a guess.

### Prompting Patterns for Code

**Pattern 1: The Context Dump**

Before asking for anything complex, orient the AI to your codebase:

```text
I'm working on a Go 1.27 API. Here's the relevant context:

Domain interface (internal/domain/auth.go):
[paste interface]

JWT middleware we already have (internal/middleware/jwt.go):
[paste existing middleware]

Now implement the RefreshToken endpoint handler following the same patterns as
the existing Login handler in internal/handlers/auth.go:
[paste login handler]

Requirements:
- Validate refresh token signature using the same key as access tokens
- Return a new access token (15min) and new refresh token (7 days)
- Invalidate the old refresh token in Redis
- Return 401 if token is invalid or expired, 500 for internal errors
```
This is verbose. It is also dramatically more effective than "write a refresh token endpoint."

**Pattern 2: The Constraint Prompt**

Explicit constraints prevent AI from introducing complexity you don't want:

```text
Write a rate limiter middleware for Go HTTP handlers.

Constraints:
- Use only stdlib (no external packages)
- In-memory only (no Redis, no distributed state)
- Per-IP rate limiting using a sliding window algorithm
- Must be safe for concurrent use
- Must implement http.Handler interface
- Requests over limit return 429 with Retry-After header
- No init(), no global state
- All exported functions must have godoc comments

Test requirements:
- Table-driven tests
- Test concurrent access with t.Parallel()
- Test the sliding window behavior specifically
```
**Pattern 3: The Example-Driven Prompt**

Show input and output, especially for data transformations:

```text
Write a Go function that normalizes phone numbers.

Input examples:
- "+1 (555) 123-4567"  → "+15551234567"
- "555-123-4567"        → "+15551234567" (assume US if no country code)
- "+44 20 7946 0958"   → "+442079460958"
- "not-a-phone"        → error: "invalid phone number format"

Function signature:
func NormalizePhone(raw string) (string, error)

Use only stdlib. Return descriptive errors. Include tests with the examples above.
```
**Pattern 4: The Incremental Prompt**

Break complex tasks into steps. Never ask AI to build "a complete system" in one prompt:

```text
Step 1 of 4: Define the interfaces only. No implementation.

I'm building a notification system that sends emails and SMS.
Define Go interfaces for:
- NotificationService (Send method, accepts message struct)
- MessageTemplate (Render method, returns formatted string)
- NotificationStore (store sent notifications for audit)

Use context.Context everywhere. Return errors idiomatically.
Just the interfaces, no implementation yet.
```
After reviewing and approving the interfaces, continue:

```text
Step 2 of 4: Implement the email provider only.

Using the NotificationService interface you just defined,
implement an EmailProvider using the standard net/smtp package.
[paste interface from step 1]
...
```
This approach gives you checkpoints where you validate direction before investing in implementation.

**Pattern 5: The Critique Prompt**

Use AI to find problems in your own code or AI-generated code:

```text
Review this Go code for:
1. Security vulnerabilities, especially SQL injection and auth bypasses
2. Concurrency bugs: race conditions, goroutine leaks
3. Error handling issues: swallowed errors, missing checks
4. Go anti-patterns: anything that is not idiomatic Go
5. Edge cases that will cause panics or incorrect behavior

Be specific. Cite line numbers. Explain why each issue is a problem and what the fix is.
If you are not sure whether something is a bug, say so rather than guessing.
```

```text
[paste code here]
```

This is one of the highest-value uses of AI in a Go project. Use it before every PR. Treat the output as a list of leads to check, not a verdict: it will miss real bugs and it will flag things that are fine. A clean report from this prompt is not evidence that the code is correct.

**Pattern 6: The Refactor Prompt**

```text
Refactor this code to use the repository pattern.

Current code (everything in one function, direct database calls):
[paste code]

Target architecture:
- UserRepository interface in internal/domain/user.go
- PostgresUserRepository struct in internal/repository/user_repository.go
- UserService that depends on the interface (not the implementation)
- Dependency injection via constructor

Follow the pattern established in internal/repository/org_repository.go:
[paste existing repository for reference]
```

**Pattern 7: The Test-First Prompt**

This is the most important pattern for maintaining quality:

```text
Write table-driven tests for this interface BEFORE implementing it:

    type OrderService interface {
        CreateOrder(ctx context.Context, req CreateOrderRequest) (*Order, error)
        GetOrder(ctx context.Context, id uuid.UUID) (*Order, error)
        CancelOrder(ctx context.Context, id uuid.UUID, reason string) error
        ListOrders(ctx context.Context, userID uuid.UUID, filter OrderFilter) ([]*Order, error)
    }

Tests should cover:
- Happy path for each method
- Error cases (not found, invalid input, database errors)
- Edge cases (empty list, zero values, nil context)

Use testify/mock to mock the interface.
Use testify/assert for assertions.
Test names: TestOrderService_MethodName_Scenario_Expected
```

Once you approve the tests, ask AI to implement against them. The tests become your specification. The ordering is what does the work: tests written before the implementation encode what you wanted, while tests written afterward tend to encode whatever the implementation happens to do, including its bugs. Ask a model to write tests for existing code and it will cheerfully assert that a function returns the wrong value, because that is what it returns.

### Prompting for System Design

AI is a useful brainstorming partner for architecture decisions, with the caveat that it is pattern-matching against designs it has seen rather than reasoning about your constraints. It is good for widening the option space and terrible at telling you which option is right:

```text
I'm designing a notification system for a multi-tenant SaaS platform.
Requirements:
- Support email, SMS, push notifications, in-app notifications
- Templates with variable substitution
- Delivery guarantees (at-least-once)
- Rate limiting per tenant (configurable)
- Audit log of all notifications sent
- ~1M notifications/day initially, must scale to 10M/day

What are the trade-offs between:
1. Synchronous delivery (in-request)
2. Queue-based async (Kafka/NATS/RabbitMQ)
3. Dedicated notification microservice

For each, cover: consistency guarantees, failure modes, operational complexity,
scaling characteristics, and which you'd recommend for this use case.
```

Read the answer as a checklist of considerations you might have missed, not as a recommendation. The model has no idea what your team can operate at 3am.

For RFC drafts:

```text
Write a draft RFC for the following system design:
[describe system]

RFC format:
- Problem Statement
- Proposed Solution
- Alternatives Considered
- Security Considerations
- Performance Considerations
- Rollout Plan
- Open Questions
```

For architecture review:

```text
Here is our current architecture for [component]:
[paste design doc or describe architecture]

Identify:
1. Single points of failure
2. Scalability bottlenecks
3. Security concerns
4. Operational complexity issues
5. What would fail first at 10x current load
```

### Prompting for Debugging

The most effective debugging prompt structure:

```text
I have a bug in my Go service. Help me find the root cause.

Error:

    panic: runtime error: invalid memory address or nil pointer dereference
    goroutine 1 [running]:
    main.(*UserService).GetUser(0xc000112000, {0x10e8c40, 0xc000116780}, {0xc000114000, 0x24})
        /app/internal/services/user.go:47 +0x1a8

Context:
- This panic happens when GetUser is called with a valid user ID
- It only happens in production, not in tests
- We deployed a change 2 hours ago that added caching (I'll paste it below)

Relevant code (user.go lines 35-60):
[paste code]

Recent change that may be related:
[paste change]

What's the most likely root cause? What additional information would help confirm it?
```

Note the last line. Asking what would confirm the hypothesis, rather than asking for the fix, is what keeps this honest. A model asked to find a bug will always find one, whether or not it is there.

### What Makes a Bad Prompt

Understanding bad prompts makes good prompts easier:

**Too vague**: "write a web server"
- AI has to guess: what framework? what endpoints? what middleware? what database?
- Output will be generic and will not fit your project

**No context**: "add error handling to this function"
- Which error handling patterns does your project use?
- Should errors be logged here or returned?
- What error types does your domain define?

**Too ambitious**: "build me a complete auth system with JWT, RBAC, and OAuth"
- No AI can build a production auth system in one prompt
- The output will be untested, inconsistent, and potentially insecure
- Break into: interfaces → implementation → tests → integration

**Ambiguous requirements**: "make this faster"
- Faster in what dimension? Latency? Throughput? Memory?
- What is the current bottleneck?
- What are the acceptable trade-offs?

**Missing constraints**: "write a cache"
- In-memory or distributed?
- What eviction policy?
- TTL? What type?
- Thread-safe?

---

### Junior → FAANG: Prompting as a Learnable Engineering Skill

Effective prompting is a skill that compounds over time because every prompting session teaches you what context the AI needs to produce correct output. Keep a personal prompt library: a collection of prompts that reliably produce high-quality output for the task types you do repeatedly (writing a new repository method, implementing a new handler, adding a new test case to an existing table-driven test). After six months of AI-assisted Go development, a handful of well-worn prompts will cover most of your routine implementation tasks. Sharing this library with your team is a most useful knowledge-sharing contribution.

The "context before request" prompting pattern maps directly to how you should structure FAANG design discussions. In a system design interview, presenting the constraints and requirements before proposing a solution is the expected format. "Given that we have 10 million daily active users, a read-heavy workload with 100:1 read-to-write ratio, and a latency requirement of under 50ms at P99, here is the caching strategy I would use..." is the same structure as a good AI prompt: "Given this interface definition and this error handling convention, implement the following function..." The prompting discipline builds the communication habit that makes system design interviews more effective.

The "What Makes a Bad Prompt" list at the end of this section is a debugging tool for when AI output consistently misses the mark. When the AI generates code that is technically correct but does not fit the project context, work backwards through that list to find the context you left out: did the prompt specify the error handling pattern? Did it include the interface definition? Did it mention the testing framework? Adding the missing context to the prompt and re-running usually produces the correct output. This diagnostic process develops intuition for which context elements are most important for specific task types.

### Senior @ FAANG: Prompting Strategy as Team Productivity Infrastructure

At senior level, the prompting strategy described in this section is the foundation for team-wide AI productivity infrastructure. Individual engineers develop idiosyncratic prompting styles with widely variable output quality. Standardized prompt templates, validated against the project's code quality standards and embedded in CLAUDE.md slash commands or team documentation, eliminate this variability. A team that has standardized prompts for "implement a new repository method," "implement a new service function," and "implement a new HTTP handler" will produce consistently higher-quality AI-assisted code than a team where each engineer invents their prompting approach from scratch.

The "context before request" discipline, applied at the organizational level, becomes the documentation standard for AI-assisted development. Every task that an engineer delegates to AI should be documented with: the context provided (relevant interfaces, existing patterns, constraints), the request made, the AI output received, and the modifications made before merging. This documentation creates an audit trail for AI-assisted code that is valuable for future incident analysis (what was the AI asked to generate? what context did it have?) and for retrospective quality analysis (which types of tasks consistently required significant modification versus being mergeable directly?). Maintaining this documentation as a team practice requires a small process investment but produces significant institutional knowledge.

The unanswered questions behind a bad prompt ("write a cache" leaves TTL, eviction, and thread safety unspecified) are exactly what separates AI-generated code that works in a prototype from AI-generated code that works in production. Each one corresponds to a production concern the AI cannot know unless told, and it will silently pick a default instead of asking. Developing a checklist of these questions for each task type (for caching: TTL, eviction policy, thread safety, key namespace, max size, for database access: transaction scope, connection pool config, query timeout, retry policy) and encoding these as part of the standard prompt template is a senior engineer's contribution to AI-assisted engineering quality at the team level.
