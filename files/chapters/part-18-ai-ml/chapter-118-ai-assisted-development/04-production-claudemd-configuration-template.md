## Production CLAUDE.md Configuration Template

A comprehensive, production-grade `CLAUDE.md` and cursor rules template establishing architectural guardrails, forbidden patterns, security constraints, and pinned Go dependencies for AI coding assistants.

---

### Template Section: What this is

A REST API for a B2B SaaS platform. Go 1.27. PostgreSQL 16.
Handles subscription management, billing (Stripe), and user/org management.

### Junior → FAANG: Project Context Files as Engineering Communication

The "What This Is" section of a CLAUDE.md is deceptively simple but critically important. It forces you to articulate the system's purpose in two or three sentences, which is also what you need to do in the first 30 seconds of a FAANG system design interview. Practice writing this section for every project you work on: what does this system do, what are the primary data stores, what are the key external integrations? Engineers who can answer this question concisely have a clear mental model of the system. Engineers who cannot answer it clearly often struggle with system design questions because their mental model is fuzzy.

The Go 1.27 and PostgreSQL 16 specifics in this section are also meaningful: they tell the AI which language features are available (structured logging with `log/slog` since Go 1.21, generics since Go 1.18, range-over-func iterators since Go 1.23) and which version-specific idioms to use. This matters more than it looks, because a model's training data is dominated by older Go. Left unpinned, it will reach for `logrus` and hand-rolled helpers that the standard library has since absorbed. Keeping this line current as you upgrade is what stops the AI from writing 2019 Go in a 2026 codebase.

### Senior @ FAANG: System Context as Architectural Communication Standard

At senior level, the "What This Is" section establishes a communication standard for the team. Every service in a microservices architecture should have a one-paragraph answer to "what does this service do, what does it own, and what does it depend on?" Encoding this answer in CLAUDE.md ensures that AI tools have the context they need, but more importantly it ensures that every engineer who joins the team has an immediate, unambiguous answer to the most basic question about the service. Services without a clear answer to "what is this?" are architectural design smells: they either have unclear ownership or they have accumulated responsibilities beyond their original scope. Using CLAUDE.md authoring as a forcing function for this clarity is a lightweight architectural review mechanism that senior engineers can implement without a formal process.


---

### Template Section: Architecture

- cmd/api/           - main entry point, server setup
- internal/          - all business logic (not importable externally)
  - auth/            - JWT auth, RBAC middleware
  - billing/         - Stripe integration
  - domain/          - core domain types and interfaces
  - handlers/        - HTTP handlers (thin layer, call services)
  - services/        - business logic (implement domain interfaces)
  - repository/      - database access (implement domain interfaces)
  - middleware/       - HTTP middleware
- pkg/               - reusable packages (importable)
- migrations/        - SQL migrations (goose)

### Junior → FAANG: Repository Structure as Systems Thinking Evidence

Being able to explain a repository structure in an interview demonstrates systems thinking at the architectural level. The structure in this file reflects standard Go project layout conventions: cmd for executables, internal for private packages, pkg for importable packages, and migrations at the root. When asked "walk me through your codebase architecture," start with the directory structure and explain the responsibility of each top-level directory. This shows that you understand the separation of concerns embedded in the structure, not just that you can find files in the tree.

The internal/ directory separation into domain, service, handler, repository, and middleware layers directly maps to the hexagonal architecture pattern (also called ports and adapters). Domain contains the business logic and interfaces. Repository implements the database ports. Handler implements the HTTP adapter ports. Service orchestrates domain objects. Understanding this pattern and naming it in an interview signals architecture-level thinking. Practice explaining why this separation matters: it makes the business logic independently testable without a running database, it allows the storage technology to be swapped without changing business logic, and it prevents HTTP concerns from leaking into business logic.

### Senior @ FAANG: Repository Structure as Team Convention Enforcement

At senior level, the repository structure is a governance artifact. When new services are created by different teams, they drift toward different structures unless a canonical structure is enforced. Encoding the required structure in CLAUDE.md for the organization's service template means that AI tools will generate new code in the correct structure, even when the engineer creating the service is unfamiliar with the convention. This is a concrete example of how CLAUDE.md content can scale a senior engineer's architectural influence across a team without requiring synchronous communication. The CLAUDE.md template becomes part of the service creation runbook, and following the template becomes the path of least resistance.


---

### Template Section: Patterns we use

- Repository pattern for all database access
- Service layer for all business logic
- Domain interfaces in internal/domain/
- Dependency injection via constructor functions (no DI framework)
- context.Context propagated everywhere, first argument always
- Structured logging via slog (Go 1.21+)
- errors.Is/errors.As for error checking (never string comparison)

### Junior → FAANG: Pattern Fluency as Technical Interview Currency

Each pattern in this list is a technical interview topic. "Repository pattern for all database access" generates the question: "why use the repository pattern instead of calling the database directly from the service?" The answer covers testability (you can mock the repository interface in service tests), the open-closed principle (you can add caching in a decorator without modifying the service), and separation of concerns (SQL is not mixed with business logic). Practicing this question-and-answer for each pattern in the list prepares you for the "why did you make this design decision" questions that appear in FAANG design interviews.

The "context.Context propagated everywhere, first argument always" pattern is the one most juniors undervalue. Context propagation is what enables request cancellation in Go: when the HTTP request is canceled by the client, the context is canceled, which propagates to every goroutine and blocking call in the call stack, allowing them to exit cleanly rather than continuing to consume resources for a request that will never return a response. Without context propagation, canceled requests leak goroutines and database connections. Interviewers at companies with high-traffic Go services ask specifically about context propagation and cancellation, so be prepared to explain both the mechanics and the production motivation.

### Senior @ FAANG: Pattern Lists as Code Review Standards

At senior level, the patterns list is a code review checklist. Every PR that adds new code should be checked against the patterns list: does it use the repository pattern for database access? Is context propagated as the first argument? Does it use errors.Is/errors.As rather than string comparison? Encoding these checks into automated linting where possible (errcheck for missing error handling, custom linter rules for context argument position) reduces review burden while ensuring consistency. The patterns that cannot be automated are the ones that require the most explicit attention in code review: "does this code belong in the service layer or the handler layer?" is a judgment call that linting cannot make. CLAUDE.md gives the AI the same checklist, so AI-generated code that violates a pattern produces a more consistent warning from the reviewer because the deviation is visible against an explicit standard.


---

### Template Section: Patterns we do not use

- Global variables (except logger in main)
- init() functions
- panic() except in main setup
- `interface{}` / `any` as a parameter or field type: use concrete types or generics
- ORMs: we use raw SQL with pgx/v5

### Junior → FAANG: Anti-Patterns as Code Review Red Flags

The "patterns we do not use" list is just as important for AI-assisted development as the patterns we do use, because AI models trained on large corpora of public Go code will frequently generate these anti-patterns. AI will generate init() functions for side-effect-based setup. It will generate global variables for configuration. It will generate panic() calls for error handling in non-main code. It will offer ORM-based queries when you have asked for database code. Knowing this list before you review AI output means you can immediately flag and regenerate sections that use forbidden patterns rather than debugging them after the fact.

The "no ORM" pattern is the one that most frequently surprises engineers coming from other languages. Go's standard library database/sql and the pgx/v5 driver provide enough abstraction for most use cases, and raw SQL is explicit about what queries will be executed, making performance analysis and query optimization straightforward. ORMs in Go also tend to generate N+1 queries unless carefully configured, which is a common production performance problem. Knowing how to write parameterized queries with pgx/v5, how to scan results into structs, and how to use named parameters is Go database fluency that FAANG interviewers test directly.

### Senior @ FAANG: Anti-Pattern Governance Through CLAUDE.md

At senior level, the anti-pattern list is a governance document. Every item on the list represents a class of bugs, security vulnerabilities, or maintenance problems that the team has decided to prevent proactively. "Never string comparison for errors" prevents bugs where error strings change across library versions. "No global variables" prevents race conditions in concurrent code and makes testing harder to reason about. "No ORM" prevents N+1 query performance problems and maintains query explicitness for performance tuning. Each prohibition has a reason, and knowing the reason is what allows engineers to apply the principle correctly in edge cases rather than mechanically.

The most important governance aspect of the anti-pattern list is its effect on AI-generated code. Without the list in CLAUDE.md, AI will generate code using these patterns because they are common in public Go code. With the list, it violates them far less often, though "far less often" is not "never" and the list does not remove the need to check. The governance mechanism is: when an anti-pattern appears in AI-generated code, the reviewer adds it to CLAUDE.md if it is not already there, creating a feedback loop that makes the list progressively more complete over time. This maintenance process should be assigned to a specific team member or included in the team's onboarding checklist to ensure it does not fall through the cracks.


---

### Template Section: Error handling

- Wrap errors with %w: fmt.Errorf("doing X: %w", err)
- Return errors, never log and return
- Use sentinel errors in domain package for known error types
- HTTP handlers translate domain errors to HTTP status codes

### Junior → FAANG: Error Handling as Go Maturity Signal

Error handling discipline is one of the clearest signals of Go maturity in a FAANG interview. The four conventions in this file are the ones most frequently violated by junior Go engineers: wrapping with %w is skipped in favor of creating new errors that lose context. Errors are logged and returned (double-logging), which floods log systems and complicates incident analysis. String comparison is used instead of errors.Is/errors.As, which breaks across library version upgrades. And HTTP handlers return 500 for all errors instead of mapping domain errors to appropriate HTTP status codes.

Practice explaining each convention with its motivation: wrapping with %w preserves the error chain so that errors.Is can check any error in the chain against a sentinel. Returning without logging keeps each error logged exactly once at the boundary where it is handled. Errors.Is is safe against library refactors that change error message strings. And mapping domain errors to HTTP status codes prevents leaking internal error details to clients while giving them actionable status codes (409 Conflict for a duplicate resource, 404 Not Found for a missing resource, 422 Unprocessable Entity for validation failures). Each motivation is an interview talking point.

### Senior @ FAANG: Error Handling Conventions as Platform Observability Foundation

At senior level, the error handling conventions are the foundation of the service's observability. If errors are logged and returned at every level, the log volume is N times the actual error count for a call stack N deep, making it difficult to identify the frequency of specific errors. If errors are not wrapped with %w, the error chain is broken and errors.Is cannot check against sentinel types, which means the HTTP handler cannot distinguish between "database not found" and "database connection failed" without string matching. If HTTP handlers do not map domain errors to status codes, the monitoring layer cannot alert on 404 vs 500 rate changes, which have very different operational implications (404 rate increase might indicate a client bug, 500 rate increase indicates a service bug).

The convention of translating domain errors to HTTP status codes at the handler boundary is the most architecturally significant. It enforces the principle that HTTP is an adapter, not a first-class concern of the business logic. The domain package defines sentinel errors (ErrNotFound, ErrConflict, ErrValidation) without any HTTP awareness. The handler package maps these to status codes. This mapping is the only place in the codebase where domain logic and HTTP protocol intersect, which makes it easy to add a gRPC adapter later without changing any business logic. Encoding this in CLAUDE.md ensures AI-generated handlers implement the mapping rather than generating ad-hoc status codes based on error message inspection.


---

### Template Section: Security requirements

- All endpoints except /health and /auth require valid JWT
- RBAC: roles are owner, admin, member, viewer
- Never log PII (email, name, payment info)
- All SQL uses parameterized queries, with pgx named arguments preferred
- Rate limiting on /auth/* endpoints (sliding window, Redis)

### Junior → FAANG: Security Requirements as Default Constraints

The security requirements in this file are not aspirational. They are the minimum bar for any production Go API at a FAANG-level company. JWT validation on all endpoints except /health is so standard that its absence in code review is an immediate blocker. RBAC at the role level is the minimum access control model. Production systems add resource-level permissions on top. Never logging PII is a compliance requirement (GDPR Article 32, CCPA) as much as a security requirement. Parameterized queries are the only acceptable defense against SQL injection.

For FAANG interviews, be prepared to explain the implementation of each requirement, not just its existence. JWT validation means: verify the signature using the provider's public key, check the exp claim against the current time, check the iss claim against the expected issuer, extract the sub claim as the user ID, and propagate the user ID through the request context. RBAC means: load the user's role from the database (or from a JWT claim if role is embedded), check the role against the required permission for the requested action before executing the action, and return 403 Forbidden if the check fails. These implementation details are what separate "knows about security" from "implements security correctly."

### Senior @ FAANG: Security Requirements as Non-Negotiable Platform Standards

At senior level, the security requirements list is the security baseline for the organization's API surface. Each item has an organizational enforcement mechanism: JWT validation is enforced by the authentication middleware that all handlers must register. RBAC is enforced by the authorization middleware that checks permissions before the handler executes. PII logging is enforced by a structured logging framework that redacts fields tagged as PII. Parameterized queries are enforced by the code review checklist and by `gosec`, which flags string-formatted SQL (rules G201 and G202). Rate limiting is enforced by the API gateway or the middleware layer.

Note the ordering in that paragraph, because it is the whole point. Every one of these controls is enforced by middleware, a linter, or a gate that runs whether or not the code came from an AI. That is deliberate. CLAUDE.md is a way to raise the quality of the first draft, and it is not a security control, because nothing that relies on the model choosing to comply can be one. An AI that lacks the RBAC requirement will confidently generate handler code that fetches and modifies data with no permission check at all. An AI that has the requirement is much more likely to call the authorization check first, which saves review cycles and is worth doing. It is still the middleware and the failing test, not the prompt, that decide whether an unauthorized request is actually rejected. Write the requirements into CLAUDE.md to get better drafts. Enforce them somewhere the model cannot forget them.


---

### Template Section: Testing

- Table-driven tests for all service and handler functions
- Use testify/assert and testify/mock
- Integration tests in _test/ with real PostgreSQL (testcontainers)
- Aim for >80% coverage on services and handlers

### Junior → FAANG: Testing Conventions as Interview Evidence

Table-driven tests are the idiomatic Go testing pattern and the one most frequently asked about in FAANG Go interviews. Be prepared to write a table-driven test from memory: a slice of test case structs (name string, input ..., expected ..., wantErr bool), a loop over the slice that calls t.Run(tc.name, ...) for subtest isolation, and assertions using tc.expected as the expected value. The test case struct design is itself an interview topic: what fields does it need? How do you name the test cases so that failures are self-explaining? How do you structure the input for functions with complex input types?

Integration tests with testcontainers are a signal of production-grade testing discipline that junior engineers rarely encounter until they join a FAANG-level company. Testcontainers spins up real PostgreSQL in a Docker container for the test run, allowing integration tests to test real SQL against a real database schema without mocking the database layer. The trade-off versus mocking is: integration tests are slower (container startup adds 5-10 seconds per test run) but catch bugs that mocking misses (SQL syntax errors, constraint violations, index behavior). Knowing when to use mocks (unit tests for business logic, fast CI feedback) versus testcontainers (integration tests for repository functions, catch SQL bugs) is Go testing maturity.

### Senior @ FAANG: Testing Standards as Quality Gate Engineering

At senior level, testing conventions are quality gate engineering: defining the test requirements that code must meet before it can be merged, and building the infrastructure to enforce them. The ">80% coverage on services and handlers" requirement needs two things: a coverage measurement tool (go test -cover integrated into CI), and a coverage enforcement mechanism (CI fails if coverage drops below 80%). Both need to be set up and maintained. Coverage requirements that are defined but not enforced become aspirational rather than normative within 6 months.

The testcontainers-based integration testing requirement is operationally significant: it means the CI environment must be able to run Docker. This affects the choice of CI platform (GitHub Actions supports Docker, some CI platforms require additional configuration), the CI runner resource requirements (testcontainers need more RAM than unit tests alone), and the test timeout configuration (container startup adds latency). Accounting for these operational requirements when setting testing standards is the difference between standards that work in practice and standards that are theoretically correct but operationally impractical. Senior engineers define testing standards with their operational implications, not just their quality implications.


---

### Template Section: Dependencies pinned


```text
## Dependencies (pinned)
- github.com/jackc/pgx/v5 (database)
- github.com/go-chi/chi/v5 (HTTP router)
- github.com/golang-jwt/jwt/v5 (JWT)
- github.com/redis/go-redis/v9 (Redis)
- github.com/stripe/stripe-go (Stripe: pin the major, it moves fast)
- github.com/testcontainers/testcontainers-go (integration tests)

List the major version you are on. This is the single highest-value section of the
file, because a model's training data is full of the previous major version's API.
```

### What Belongs in CLAUDE.md

A well-written CLAUDE.md is worth more than the most sophisticated prompt engineering. It means every interaction with Claude Code in your project starts from a shared understanding of your architecture.

**What to include in CLAUDE.md**:
- Project overview (1 paragraph)
- Directory structure with purpose of each directory
- Patterns you use (with examples if non-obvious)
- Patterns you explicitly DO NOT use (this is the highest-value section: it prevents the AI from reintroducing patterns you have already rejected)
- Error handling conventions
- Security requirements
- Testing conventions
- Key dependencies and why you chose them

**What NOT to include**:
- Lengthy tutorials on how Go works (Claude knows Go)
- Information that belongs in your README (keep them separate)
- Team processes that don't affect code generation

### Slash Commands

Claude Code ships a set of built-in slash commands (`/help`, `/clear`, `/compact`, `/review`, and others: run `/help` to see the current list, which changes between releases). The more useful capability for a team is that you can define your own. A custom command is just a markdown file in `.claude/commands/`, and its filename becomes the command name:

```markdown
<!-- .claude/commands/racecheck.md -->
Run `go test -race -count=1 ./...` and, for each failure, identify the
shared variable involved and which goroutines touch it. Propose the
smallest correct fix. Do not widen a mutex to cover the whole struct
unless the data is genuinely accessed together.
```

Invoke it with `/racecheck`. This is how team knowledge stops being tribal: the prompt that a senior engineer worked out lives in the repository, is code reviewed, and is one keystroke away for everyone else.

### MCP Servers: Extending Claude Code

Model Context Protocol (MCP) servers extend Claude Code with custom tools. Point it at your database and it can read your actual schema when writing repository code, so it stops guessing column names. Point it at your issue tracker and it can read the ticket it is implementing.

The normal way to add one is `claude mcp add`, which writes the configuration for you. Servers you want shared with the team are project-scoped, and project scope lives in a `.mcp.json` file at the repository root that you commit:

```json
// .mcp.json - project-scoped MCP servers, committed to the repository
{
  "mcpServers": {
    "postgres": {
      "command": "npx",
      "args": ["-y", "some-postgres-mcp-server"],
      "env": {
        "POSTGRES_CONNECTION_STRING": "postgresql://localhost/myapp_dev"
      }
    }
  }
}
```

Because that file is committed, a server arriving in a clone is a server somebody else chose. Claude Code holds project-scoped servers at pending approval until you accept them in an interactive session, which is the right default and worth leaving alone. Chapter 118b covers the protocol itself in depth, pinned to a specific dated revision, and is the place to go before you write a server rather than configure one.

Two warnings, and neither is optional reading.

**Vet the server, and check whether it is still maintained.** The reference MCP servers that most tutorials still copy-paste, including `@modelcontextprotocol/server-postgres`, were moved to the `modelcontextprotocol/servers-archived` repository in May 2025 and are explicitly unmaintained with no security guarantees. The archived Postgres server has a publicly documented SQL injection that bypasses its own read-only mode, and it will never be patched. It still gets tens of thousands of weekly downloads, largely from stale tutorials and from models that learned it during training. Your AI assistant will suggest it to you. That is precisely the failure mode this chapter is about: the model is repeating what was true in its training data, confidently, and you are the one who has to know better. Check the repository, check that it is maintained, and check its advisories before you wire anything into your development database.

**Anything an MCP server returns is untrusted input.** This is the part engineers consistently underrate. When an agent reads a GitHub issue, that issue was written by whoever opened it, which on a public repository is anyone at all. Invariant Labs demonstrated in May 2025 that an attacker could file an issue on a public repo whose text is instructions to the agent, and when a maintainer innocently asked their agent to "look at the open issues," the agent followed those instructions and exfiltrated private repository contents into a public PR. Nothing was wrong with the GitHub MCP server's code. The architecture was the vulnerability: the agent had one identity holding a broad personal access token, and no boundary separated "data I am reading" from "instructions I follow."

Treat this as a genuine security boundary rather than an edge case. Scope tokens to the minimum, and never hand an agent a PAT that spans your private repositories and public ones at the same time. Prefer per-repository, read-only, short-lived credentials. Keep production credentials out entirely, since the connection string above points at `myapp_dev` for a reason. Above all, keep a human on the approval of anything that writes or publishes, because the agent cannot reliably tell the difference between a task you gave it and a task a stranger embedded in the data you told it to read. That is not a bug that gets patched. It follows from what these models are.

### Hooks: Automating Workflows

Claude Code hooks run commands automatically at key points in the workflow. Event names are case-sensitive PascalCase (`PreToolUse`, `PostToolUse`, `Stop`, `SessionStart`, and others). A `PostToolUse` hook matching the file-writing tools is the one that pays for itself immediately:

```json
// .claude/settings.json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/gofmt-hook.sh"
          }
        ]
      }
    ]
  }
}
```

Hooks do not receive the edited path in an environment variable. They receive a JSON object on stdin, so the hook script parses it:

```bash
#!/usr/bin/env bash
# .claude/hooks/gofmt-hook.sh
set -euo pipefail

file=$(jq -r '.tool_input.file_path // empty')
[[ "$file" == *.go ]] || exit 0

gofmt -w "$file"
go vet "$(dirname "$file")/..." >&2 || true
```

Every Go file Claude Code writes is now formatted before you ever see it, and `go vet` findings land in the transcript where the model can react to them. Two points of realism, though. Hooks fire on tool use, so there is no "pre-commit" event: enforce the full `go test -race ./...` suite in a real git pre-commit hook and in CI, where it applies to all code rather than only the code that came from this tool. And keep hook scripts fast, because they run on every matching edit.

---

### Junior → FAANG: Project Configuration as a high-value Investment

CLAUDE.md is a high-value investment that most junior engineers skip. A well-written CLAUDE.md eliminates the most common AI error category: the AI generates code that is technically correct but violates your project's conventions, uses the wrong package, or ignores a constraint that was obvious from reading the codebase. Write your CLAUDE.md incrementally: every time an AI-generated suggestion misses a project convention, add that convention to CLAUDE.md. After three months, your CLAUDE.md captures the institutional knowledge of your project in a form that the AI can act on. This reduces review cycles and increases the percentage of AI suggestions that are mergeable without modification.

Slash commands and hooks are the same investment applied to workflow rather than to knowledge, and they are worth reaching for earlier than most engineers do. A junior engineer who notices that they type the same three-paragraph prompt every week and turns it into a `.claude/commands/` file has done a small piece of platform work on their own team. A junior engineer who wires `gofmt` into a `PostToolUse` hook has removed an entire category of review comment from their PRs permanently rather than fixing it one PR at a time. That instinct, automating the correction rather than repeating it, is the same instinct that separates senior engineers from junior ones in every other part of the job, and it reads clearly in an interview when you can describe a concrete instance of it.

The MCP security material is the highest-value interview content in this section, because it is where most candidates are shallow. Anyone can say that prompt injection exists. The answer that lands explains why it is architectural rather than a bug: the agent has one identity, a broad token, and no boundary between the data it reads and the instructions it follows, so text a stranger wrote into a GitHub issue arrives in the same channel as the task you gave it. Be ready to name the mitigations that follow from that framing, which are scoped short-lived credentials, read-only by default, no token that spans public and private repositories, and a human on any action that writes or publishes.

### Senior @ FAANG: Configuration as Organizational Infrastructure

The CLAUDE.md file, viewed at organizational scale, becomes a platform engineering artifact. A centralized CLAUDE.md template that encodes the organization's coding standards, security requirements, testing conventions, and architectural patterns can be distributed to every repository as a starting point. Teams customize it for their specific context, but the shared baseline ensures that AI-generated code across the organization starts from the same foundation. Maintaining this template, keeping it current as standards evolve, and measuring its adoption is the kind of platform engineering work that multiplies the value of AI tools across dozens of teams simultaneously.

Slash commands and hooks extend that argument from knowledge to enforcement, and the distinction between the two matters when you design the platform. A CLAUDE.md constraint is a request the model usually honors. A hook is a command that runs whether the model cooperates or not. Anything you actually require belongs in the second category, and anything you require unconditionally belongs in CI rather than in either, because a hook only governs the code that came through this tool on this developer's machine. The mature pattern is a shared repository of reviewed prompts and hook scripts, distributed like any other internal tooling, with CI as the backstop that does not depend on developer configuration at all.

MCP is where the organizational security surface actually lives, and it is the part of AI tooling most likely to produce an incident rather than a slowdown. The policy questions are concrete: which servers are approved, who reviews a new one before it can be added to a `.mcp.json` that every clone of the repository picks up, what credentials may an agent hold, and which actions require a human at the approval boundary. Answer them before an incident rather than after, and write the answers down as an ADR, because the failure mode here is not a model producing bad code that review catches. It is an agent doing exactly what a stranger's text told it to do with a token you gave it.
