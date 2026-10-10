## 118.6 AI in the Software Development Lifecycle

### Planning & Architecture

**Using AI for RFC drafts**:

```text
Generate an RFC draft for the following system:

System: A real-time notification delivery system for our B2B SaaS
Scale: 500K active users, peak 50K concurrent, 2M notifications/day
Constraints:
- Must deliver notifications within 2 seconds for in-app
- Email delivery best-effort (5min acceptable delay)
- Must work with existing PostgreSQL + Redis stack
- Single-region initially, multi-region in 6 months
- Team has 2 backend engineers maintaining it

Generate sections:
1. Problem Statement
2. Goals and Non-Goals
3. Proposed Solution with architecture diagram (Mermaid)
4. Data Model
5. API Design
6. Alternatives Considered (with pros/cons)
7. Security Considerations
8. Failure Modes and Mitigation
9. Rollout Plan
10. Open Questions
```
**Generating Mermaid architecture diagrams**:

```text
Generate a Mermaid sequence diagram showing:
1. User login flow with JWT issuance
2. Token refresh flow
3. Protected endpoint access with middleware validation
Include: frontend, API gateway, auth service, user service, Redis (token store)
```
### Code Generation Workflow

The most effective AI-assisted development workflow for Go:

```text
1. Design the interfaces          (you write these)
2. Write the test contracts       (AI drafts, you review)
3. Implement against contracts    (AI drafts, you review)
4. Run tests, iterate on failures (AI assists)
5. Security review of AI output   (you, with AI as a second opinion)
6. Integration test scaffolding   (AI drafts)
```

The ordering is the point, not the clock. Steps 1 and 5 are yours and do not compress: they are where the engineering happens. Steps 2, 3, and 6 are mechanical expression of decisions already made, and that is where the tool earns its keep.

Compare to the traditional workflow of design, implement, debug, test, debug again. The shape of the win is that you spend a larger fraction of your time on design and review and a smaller fraction on typing. Whether that nets out to faster on any given task depends on the task, and on how well you know the codebase. Recall from the introduction that the one study of experienced developers in repositories they knew well measured a slowdown. If you want to know what this workflow does for you, measure it (Section 118.14). Do not trust the feeling, and do not trust the number in anyone's blog post, including a plausible-looking one in a book.

**Feature branch workflow with Claude Code**:

```bash
# Start a feature branch
git checkout -b feature/user-notifications

# Open Claude Code with context
claude

# In the session:
> I'm implementing a user notification feature. Here's my design:
> [paste interface definitions]
> Start with the database schema and repository layer.
> Follow patterns in internal/repository/user_repository.go

# Claude Code will:
# 1. Read your existing repository code
# 2. Check your migrations directory
# 3. Generate the migration SQL
# 4. Generate the repository implementation
# 5. Generate tests

# Review everything, then:
> run the tests for the notification repository

# Claude Code runs: go test ./internal/repository/... -v -run TestNotification
# If failures:
> fix the test failures in notification_repository_test.go
```
### Testing with AI

**Generating table-driven tests for Go interfaces**:

```text
Write thorough table-driven tests for this service:
```

```go
type PaymentService interface {
    ChargeCard(ctx context.Context, req ChargeRequest) (*Charge, error)
    RefundCharge(ctx context.Context, chargeID string, amount int64) (*Refund, error)
    GetCharge(ctx context.Context, chargeID string) (*Charge, error)
}
```

```text
Requirements:
- Use testify/mock for the Stripe client mock
- Test cases for each method:
  - Success case
  - Stripe API error
  - Network timeout
  - Invalid input (empty ID, negative amount, etc.)
  - Idempotency (duplicate charge attempt)
- Each test name: TestPaymentService_MethodName_Scenario
- Use subtests (t.Run)
- Table structure: name, input, mockSetup, expected output, expected error
```
**Edge case generation**:

```text
Given this function signature and its implementation:
[paste function]

What edge cases am I missing in my tests? Consider:
- nil inputs
- empty collections
- boundary values (max int, empty string, zero)
- concurrent access
- context cancellation during execution
- partial failures (first item succeeds, second fails)
- very large inputs
```
**Generating test data with builders**:

```text
Generate a test data builder for the Order struct using the builder pattern.
The builder should:
- Have a sensible default for every field
- Allow overriding any field
- Have semantic builders like WithExpiredDate(), WithLargeAmount(), WithCanceledStatus()
- Be used in tests as: NewOrderBuilder().WithStatus(Canceled).Build()
```
### Documentation with AI

**Generating godoc comments**:

```text
Add godoc comments to every exported function and type in this file.
Follow the godoc convention: first sentence starts with the function name.
Include parameter descriptions for non-obvious parameters.
Include example usage where helpful.
```
**Generating OpenAPI from Go handlers**:

```text
Analyze these HTTP handler functions and generate an OpenAPI 3.0 spec.
Include:
- All endpoints with path parameters
- Request/response schemas from the structs used
- Error responses (400, 401, 403, 404, 500)
- Authentication (Bearer JWT)
- Example requests and responses

Handlers:
[paste handler functions]
Types:
[paste request/response types]
```
**Generating Architecture Decision Records**:

```text
Write an Architecture Decision Record (ADR) for the following decision:

Context: We chose PostgreSQL with raw SQL (pgx/v5) instead of an ORM (GORM/ent)

ADR format:
# ADR-007: Use Raw SQL with pgx instead of ORM
## Status
Accepted
## Context
[what forces led to this decision: team size, query complexity, performance
 requirements, existing expertise]
## Decision
[what we are doing, stated plainly]
## Consequences
[both the good and the bad: what this makes easy, what this makes hard,
 what we give up]
## Alternatives Considered
[GORM, ent, sqlc: why each was rejected, honestly]

Do not write only the positive consequences. An ADR whose Consequences
section lists no downsides is not an ADR, it is marketing.
```

The last instruction matters. Left alone, a model writes ADRs that read like a press release for the decision you already made, because agreeable text is more probable than critical text. You have to ask for the costs explicitly, and you should still be the one who writes them.

### Incident Response and Postmortems

AI is genuinely useful during an incident, in one narrow way: it is fast at generating hypotheses, and hypothesis generation is exactly what you are worst at when adrenaline is up at 3am.

```text
Our Go API's p99 latency went from 40ms to 3s at 14:20 UTC. No deploy
went out. Error rate is flat. CPU is normal. Goroutine count climbed
from ~2K to ~40K over the same window and is still rising.

Give me a ranked list of plausible causes, and for each, the specific
thing I could check that would confirm or rule it out.
```

Note what is being asked for. Not "fix it", but a ranked list plus a falsification test for each item. That framing is what makes this safe. You keep the diagnosis, and the model widens the search.

The rules during an incident are stricter than usual, for a reason:

- **Never let it act on production.** It suggests. You run. The one time the suggestion is wrong is during the incident you are already having.
- **Never paste production data, customer records, or credentials into the prompt.** Redact. An incident is precisely when people get sloppy about this, and a breach on top of an outage is a very bad day.
- **Treat every hypothesis as unverified.** The model will produce a confident, fluent, specific root cause that is completely wrong, and under time pressure that is seductive. Confirm with evidence from your own systems before you act on it.

For the postmortem afterward, AI is a decent editor and a poor investigator. It can turn your notes and a log excerpt into a clean timeline, spot gaps where the narrative jumps, and draft the customer-facing summary. It cannot tell you why the change was made, what the on-call engineer was thinking, or which organizational pressure produced the shortcut. Those are the parts of a postmortem that are worth anything, and they come from people.

### Junior → FAANG: SDLC Integration as Career Differentiation

Most junior engineers use AI tools only at the implementation phase: they write code by hand until stuck, then ask AI to help. Engineers who integrate AI across the full SDLC (planning, architecture, implementation, code review, testing, documentation, incident response) are significantly more productive and are the engineers that FAANG companies are actively hiring. Understanding how AI fits into each phase, with concrete examples, is the interview answer that distinguishes candidates who have thought systematically about AI-assisted engineering from those who have only used it tactically.

The ADR generation use case is particularly valuable for junior engineers because ADRs are a communication artifact that many junior engineers have never written. An AI that can generate an ADR from a prompt about a technology decision (raw SQL vs ORM, PostgreSQL vs MongoDB, gRPC vs REST) gives junior engineers a template to start from, which dramatically reduces the activation energy for writing ADRs. The discipline of writing ADRs, even when they are started from AI templates, builds the structured decision-making and communication skills that are explicitly assessed at L5 and above in FAANG engineering ladders.

The incident response use case is one that junior engineers should practice before they encounter a real incident. Practice running a post-incident analysis with AI assistance: describe the symptoms, ask AI to suggest potential root causes, ask AI to generate diagnostic queries, ask AI to draft the incident timeline. The AI will suggest causes you had not considered, which is the value. It will also suggest causes that are confidently wrong, which is why every hypothesis needs confirming against your own telemetry before you act on it. Practicing this workflow in a low-stakes environment (after a minor incident or in a simulation) prepares you to use it effectively under the pressure of a real production incident.

### Senior @ FAANG: AI-SDLC Integration as Organizational Capability Building

At senior level, AI-SDLC integration is an organizational capability that must be built deliberately, not an individual skill that engineers develop independently. The planning phase integration (AI for requirements analysis, use case generation, risk identification) requires that the team has a structured requirements process that produces the inputs AI needs. The architecture phase integration (AI for ADR drafting, alternative generation, trade-off analysis) requires that the team has an ADR process and that engineers know when to create ADRs. The testing phase integration (AI for test case generation, coverage gap identification) requires that the team has a test writing standard that AI-generated tests must meet.

Each SDLC phase integration point requires a quality gate: a standard that AI output must meet before it advances to the next phase. AI-generated requirements must be reviewed by a product engineer for completeness and consistency. AI-generated ADRs must be reviewed by an architect for correctness of trade-off analysis. AI-generated test cases must be reviewed for coverage of edge cases and security scenarios. Without quality gates, AI integration accelerates the creation of artifacts that appear complete but are not production-quality, which creates more work in later phases than it saves in earlier phases.

The incident response integration point is the most impactful opportunity for senior engineers because incidents are high-pressure situations where productivity gains are most valuable. Building a team capability for AI-assisted incident response (standardized diagnostic prompts, runbooks that include AI-assistance steps, post-incident review process that uses AI for timeline reconstruction) multiplies the value of AI tools at the moment when they matter most. Documenting this capability and including it in the team's on-call runbook is a concrete senior engineering contribution that reduces the mean time to resolution for production incidents.
