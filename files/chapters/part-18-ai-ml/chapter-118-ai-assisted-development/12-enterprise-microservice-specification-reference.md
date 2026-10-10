## Enterprise Microservice Specification Reference

A concrete reference implementation of repository rules, non-negotiable security bounds, test fixtures, and build automation commands tailored for AI pair programmers.

---

### Specification Rule: What this service does

[1-2 sentences: what problem it solves, who uses it]

### Junior → FAANG: Service Descriptions as Interview Fluency

The ability to describe any service you have worked on in one or two sentences is an interview prerequisite. "This service handles subscription management for B2B customers, processing plan upgrades and downgrades and synchronizing subscription state with Stripe" is a service description. It names the problem (subscription management), the customer type (B2B), the key operations (plan changes), and the key dependency (Stripe). Engineers who can produce this description instantly, without thinking, have a clear mental model of the service. Practicing this for every service you work on builds the rapid system communication skill that is assessed in every FAANG design discussion.

### Senior @ FAANG: Service Descriptions as Microservices Governance

At senior level, requiring every service to have a clear, current one-paragraph description is a microservices governance mechanism. Organizations with more than 20 services frequently have engineers who cannot name what half the services do without reading the code. A registry of service descriptions, kept current by requiring each service owner to update the description in CLAUDE.md when the service's purpose or boundaries change, is a lightweight but effective service catalog. This catalog supports decision-making about service ownership, service consolidation, and dependency analysis without requiring a full service mesh topology to be readable by non-platform engineers.


---

### Specification Rule: Tech stack

- Go 1.27
- PostgreSQL 16 (pgx/v5 driver)
- Redis 7 (go-redis/v9)
- HTTP: chi/v5 router
- Testing: testify/assert, testify/mock, testcontainers-go

### Junior → FAANG: Technology Stack Fluency as Interview Prerequisite

Each item in this tech stack list is a separate interview topic. For Go 1.27, know which standard library additions are available and when they landed (`log/slog` since 1.21, the `slices` and `maps` packages since 1.21, range-over-func iterators since 1.23). For PostgreSQL 16 with pgx/v5, know how to write parameterized queries, how to handle named parameters, how to scan results into structs, and how to manage transactions. For Redis with go-redis/v9, know how to implement the cache-aside pattern, how to set TTLs, and how to handle cache misses. For chi/v5, know how to register middleware, how to extract URL parameters, and how to group routes with shared middleware.

Knowing why each technology was chosen, not just what it does, is the depth that FAANG interviews test. Chi over gin because chi is more lightweight and has no external dependencies. pgx over database/sql because pgx provides better performance, named parameters, and richer PostgreSQL-specific features. `github.com/redis/go-redis/v9` rather than the older `github.com/go-redis/redis/v8`, noting that the module path itself moved at v9, which is exactly the kind of detail a model trained on older code gets wrong. These rationale answers demonstrate the evaluative judgment that distinguishes engineers who have made deliberate technology choices from those who use whatever is in the project they joined.

### Senior @ FAANG: Tech Stack Decisions as Long-Term Operational Commitments

At senior level, each item in the tech stack list represents a long-term operational commitment with a cost model. PostgreSQL requires DBA expertise, backup and restore procedures, index maintenance, query optimization work, and schema migration management. Redis requires eviction policy decisions, memory sizing, persistence configuration, and cluster topology decisions for high availability. Go itself requires an upgrade plan: there is no LTS release, and the Go team supports only the two most recent major versions with security fixes, so staying current is the supported path rather than an optional one. Evaluating the full operational cost of each technology choice, not just the development convenience, is the analysis that staff engineers apply when approving or rejecting technology additions to the stack.


---

### Specification Rule: Repository structure


A well-defined directory layout enforces the dependency rule at the filesystem level: code in `internal/domain` must never import from `internal/handlers` or `internal/services`, keeping your core types free of framework coupling. The `cmd/` directory holds only wiring and startup logic, while all reusable, non-application-specific utilities live under `pkg/` and can safely be imported by other modules. Following this layout from the start prevents the common drift where business logic bleeds into HTTP handlers and becomes untestable without a running server.

```text
cmd/
  api/        - main.go, server setup, dependency wiring
internal/
  domain/     - interfaces and domain types (no external deps)
  handlers/   - HTTP handlers (thin layer, no business logic)
  services/   - business logic (implement domain interfaces)
  repository/ - database access (implement domain interfaces)
  middleware/ - HTTP middleware (auth, logging, rate limiting)
  errors/     - domain error types and HTTP error mapping
pkg/
  validation/ - input validation helpers
  crypto/     - crypto utilities
migrations/   - SQL migrations (goose format)
```

### Junior → FAANG: Repository Structure as Dependency Rule Enforcement

The repository structure enforces the dependency rule at the filesystem level: code in internal/domain cannot import from internal/handlers without creating an import cycle that the Go compiler rejects. This compile-time enforcement of architectural constraints is one of Go's most valuable features for large codebases. Understanding this enforcement mechanism, and being able to explain why the specific structure prevents coupling between layers, is Go architectural fluency that FAANG interviewers test in system design rounds for Go-specific roles.

Practice mapping each directory to its layer in the hexagonal architecture: domain is the application core (no external dependencies, only pure Go types and interfaces), services is the application use case layer (depends on domain, orchestrates repositories and external adapters), handlers is the HTTP adapter layer (depends on services, translates HTTP to domain), and repository is the database adapter layer (depends on domain interfaces, implements them with database calls). This mapping, applied to any Go codebase, gives you an instant understanding of the intended architecture and where to look for architectural violations.

### Senior @ FAANG: Repository Structure as Monorepo vs Microservices Decision Point

At senior level, the repository structure question extends to: should this team use a monorepo or separate repositories for each service? The structure shown here (one repository per service) is the microservices default. Monorepos (all services in one repository with service-specific subdirectories) have different trade-offs: easier cross-service refactoring, shared tooling and linting configuration, simpler dependency management, but more complex CI/CD (rebuild only changed services), larger repository size, and potential for unintended cross-service coupling if internal package import rules are not enforced. Documenting the decision and its rationale in a CLAUDE.md that is shared across the organization's service repositories is a platform engineering contribution that prevents each new service team from re-litigating the monorepo versus multi-repo question independently.


---

### Specification Rule: Architecture rules


#### Dependency Direction
domain ← services ← handlers
domain ← repository
Never import handlers from services. Never import external deps in domain.

#### Constructor Pattern
All structs use constructor functions with dependency injection:
```go
func NewUserService(repo domain.UserRepository, cache Cache, logger *slog.Logger) *UserService
```

#### Context
- context.Context is ALWAYS the first parameter
- Never store context in struct fields
- Pass context to ALL database and HTTP calls

#### Error Handling
- Wrap with context: fmt.Errorf("finding user %s: %w", id, err)
- Return errors, never log-and-return
- Domain errors defined in internal/errors/errors.go
- Handlers map domain errors to HTTP status codes in internal/errors/http.go

#### Logging
- Use slog everywhere (NOT logrus, zap, or fmt.Print)
- Structured key-value pairs: slog.Info("action", "key", value)
- Never log: passwords, tokens, PII (email, name, phone)
- Include request_id from context in all log statements

### Junior → FAANG: Architecture Rules as Interview Talking Points

Each architecture rule in this file has a corresponding "why" that is an interview talking point. The dependency direction rule (domain does not import handlers, handlers do not import services) exists to keep business logic testable without a running HTTP server. The constructor pattern with dependency injection exists to make dependencies explicit and mockable in tests. The context-as-first-parameter rule exists to enable request cancellation propagation. The error wrapping rule exists to preserve the error chain for errors.Is checks and for debugging. The logging rules exist to prevent PII leaks and to enable distributed tracing via request_id.

Practice reciting the "why" for each rule until it is automatic. In a FAANG system design interview, "we follow the dependency inversion principle by defining domain interfaces and injecting implementations at the constructor level" signals architectural maturity. "We pass context as the first argument to every function so that request cancellation propagates through the entire call chain without requiring goroutine coordination" signals Go-specific systems thinking. These explanations transform a list of rules into demonstrated understanding.

### Senior @ FAANG: Architecture Rules as Linter Configuration

At senior level, architecture rules that are only documented in CLAUDE.md are enforced inconsistently because not every engineer reads CLAUDE.md before writing code. The goal is to automate enforcement: the dependency direction rule can be enforced with a custom linter that uses go/analysis to detect import violations. The constructor pattern can be partially enforced by a linter that flags unexported struct initialization. The logging rule can be enforced by a linter that detects fmt.Print in non-main packages. The PII logging rule can be enforced by a string analysis linter that flags field names matching PII patterns. Every rule that can be automated should be automated, so that the documented rules and the enforced rules are the same set, and engineers get immediate feedback when they violate an architecture rule rather than discovering it in code review.


---

### Specification Rule: Security rules non negotiable

- ALL SQL uses parameterized queries (pgx named args preferred)
- JWT validation lives in internal/middleware/auth.go: use it, do not reimplement it
- All inputs validated before hitting the service layer
- Rate limiting on /auth/* is configured in cmd/api/server.go
- Secrets come from environment variables only: never hardcode them, and never
  paste a real key, token, or connection string into a prompt

### Junior → FAANG: Security Rules as Non-Negotiable Defaults

The "NON-NEGOTIABLE" label on security rules is a signal that these rules do not have exceptions based on convenience or time pressure. Understanding which security requirements are non-negotiable (parameterized queries to prevent SQL injection, JWT validation on all authenticated endpoints, no hardcoded secrets) versus which are best-practice guidelines (structured logging format, specific error wrapping style) is professional security literacy. In a FAANG code review, a PR that violates a non-negotiable security rule is blocked, regardless of how much time was invested in the feature.

"Use it, don't reimplement" for JWT validation is the most important security rule in this list. JWT validation has multiple components that are easy to get wrong: algorithm verification (the algorithm in the token header must match the expected algorithm, preventing algorithm confusion attacks), expiration check (the exp claim must be in the future), issuer check (the iss claim must match the expected issuer), and signature verification (the signature must be valid against the server's public key). A custom JWT validation implementation that misses any of these is a security vulnerability. Using the validated, tested implementation in the middleware package is the correct default. Reimplementing it "because you need slightly different behavior" is the path to vulnerabilities.

### Senior @ FAANG: Security Rule Enforcement as Security Engineering Platform

At senior level, the security rules list is the minimum security baseline that the organization's security team has defined for Go services. "NON-NEGOTIABLE" means there is an organizational enforcement mechanism: security scanning in CI that fails PRs with SQL concatenation, secret scanning that blocks commits containing API keys or passwords, required security review for any change to the JWT middleware. These enforcement mechanisms are built and maintained by the security engineering team or the platform team, not by individual service teams. Senior engineers coordinate with the security team to ensure the enforcement is current and comprehensive, and to escalate when a service's requirements genuinely require an exception with compensating controls.


---

### Specification Rule: Testing conventions

- Table-driven tests for all non-trivial functions
- Test names: TestTypeName_MethodName_Scenario
- Mock pattern: create mock in *_test.go using testify/mock
- Integration tests in internal/*/integration_test.go with build tag: //go:build integration
- Run: make test (unit), make test-integration (needs Docker)

### Junior → FAANG: Testing Conventions as Code Readability

Test naming conventions are not cosmetic. TestTypeName_MethodName_Scenario means that when a test fails in CI, the failure message immediately tells you which type, which method, and which scenario failed without reading the test body. TestUserService_CreateUser_DuplicateEmail is a failing test that immediately tells you the UserService's CreateUser method behaves incorrectly when the email already exists. Contrast this with TestCreate2 failing: you have no idea what to look for without opening the test file. Good test names are the first line of debugging communication.

The build tag pattern for integration tests (//go:build integration) allows make test to run only unit tests in the normal development loop (fast, no Docker required) while make test-integration runs the full suite including database integration tests (slower, requires Docker, run in CI). Understanding and implementing this separation is a Go testing maturity signal that FAANG interviewers assess: can the engineer configure the test suite so that the development feedback loop is fast while the CI suite is comprehensive?

### Senior @ FAANG: Testing Conventions as Quality Metric Foundation

At senior level, the testing conventions are the foundation for quality metrics. Test names in the TestTypeName_MethodName_Scenario format produce parseable failure reports that can be aggregated into quality dashboards: which service has the most test failures this week? Which method has the highest test flakiness rate? Which scenario category (edge cases, error paths, security) has the lowest coverage? These metrics require consistent naming to be parseable programmatically. Engineers who follow the naming convention contribute to the organization's test quality visibility without any additional effort, while engineers who do not follow it create metric gaps. The senior engineer's role is to enforce the convention in code review and to build the dashboards that make the value of consistent naming visible to the team.


---

### Specification Rule: Makefile commands

- make test              (unit tests with race detector)
- make test-integration  (integration tests, starts DB via testcontainers)
- make lint              (golangci-lint)
- make build             (compile binary)
- make migrate-up        (run pending migrations)
- make generate          (run go generate, regenerates mocks)

### Junior → FAANG: Makefile as Developer Experience Standard

The Makefile is the developer experience contract for a project. Engineers should not need to know the exact `go test -race -count=1 -tags=integration ./...` command. They should know `make test-integration`. Makefile targets are the user interface for the development workflow, and a well-designed Makefile is as important as a well-designed API. For FAANG interviews about developer experience or platform engineering, being able to describe the Makefile design principles (short, memorable target names, targets that handle their own dependencies, consistent target naming across the organization's repositories) demonstrates DX thinking.

The `make test` target with the race detector is a specific production quality signal. The Go race detector detects concurrent memory access bugs at runtime during testing, catching race conditions that would be silent data corruption bugs in production. Running tests with `-race` costs you real time and memory (the Go team's own figures are roughly 5-10x memory and 2-20x execution time, varying by program) but it catches a class of bug that almost nothing else will. FAANG engineers are expected to run tests with the race detector routinely, not just when they suspect a concurrency bug.

### Senior @ FAANG: Makefile Standardization as Organizational Developer Experience

At senior level, Makefile standardization across the organization reduces cognitive overhead for engineers who work across multiple services. When every service's Makefile has the same target names for the same operations (make test, make lint, make build, make deploy), engineers can switch between services without consulting documentation. This standardization is a platform engineering concern: the organization's service template should include a standard Makefile, and deviations should be reviewed and approved. The review criteria: does the deviation have a valid reason (service requires a non-standard build process) or is it stylistic preference (engineer prefers different target names)? Stylistic deviations add cognitive overhead without benefit and should be declined.


---

### Specification Rule: What not to do


```text
## What NOT to Do
- No global variables (except slog default logger in main)
- No init() functions
- No panic() except in main for unrecoverable setup errors
- No `interface{}` / `any` as a parameter or field type: use concrete types or generics
- No ORM: raw SQL only
- No importing internal/ packages from pkg/
- No direct database calls from handlers
- No business logic in handlers
```
### Team CLAUDE.md vs Personal CLAUDE.md

**Repository CLAUDE.md** (commit to git): Project architecture, patterns, conventions. Shared by the whole team. Reviewed in PRs.

**Personal `~/.claude/CLAUDE.md`** (in your home directory, not committed): personal preferences, shortcuts, and workflow instructions. It applies across all your projects, so keep project facts out of it.

```markdown
# Personal CLAUDE.md

When I ask you to "wire up" something, I mean:
1. Define the interface in internal/domain/
2. Implement the struct in the appropriate package
3. Update the dependency injection in cmd/api/main.go
4. Write tests

When I ask for "the full package", include tests.

My review style:
- I prefer verbose error messages over short ones
- I prefer early returns over nested if statements
- I prefer explicit over implicit
```
### Keeping CLAUDE.md Updated

CLAUDE.md is a living document. It should evolve with your codebase. Add it to your PR review checklist:

> "Does this PR introduce a new pattern, deprecate an old one, or change conventions? If yes, update CLAUDE.md."

Stale CLAUDE.md is worse than no CLAUDE.md, because it gives the AI confident, wrong information and you will not notice until the output is subtly wrong in a way that matches the file rather than the code. Treat it like a test: if CLAUDE.md says one thing and the codebase does another, one of them is a bug, and you have to decide which.

---

### Junior → FAANG: Personal vs Team CLAUDE.md as Professional Maturity Signal

The distinction between team CLAUDE.md (committed to the repository, shared by everyone, defines project conventions) and personal CLAUDE.md (in your home directory, not committed, defines your personal workflow preferences) is a professional maturity signal. Engineers who put personal preferences in the team CLAUDE.md are imposing their style on the team without consensus. Engineers who put team conventions in their personal CLAUDE.md are missing the project context that makes AI assistance accurate. Understanding this distinction and maintaining both files appropriately is the same maturity as understanding the difference between a personal branch and main: one is for individual work, the other is shared infrastructure.

The "wire up" shorthand in the personal CLAUDE.md example (define interface, implement struct, update DI, write tests) is an example of encoding your personal workflow vocabulary into AI instructions. Building up a handful of these shorthand commands for the task types you do repeatedly is a high-return investment: each shorthand saves you from specifying the same four-step process every time, and the AI's output quality improves because it has a precise, consistent specification to follow. Practice building this personal vocabulary over the course of working on a project.

The CLAUDE.md freshness principle (stale CLAUDE.md is worse than none) applies to all documentation but has a specific cost in the AI context: the AI will confidently generate code that follows the stale convention, which then fails review and must be regenerated. This cost is more visible than the cost of an engineer following a stale convention because the AI generates more code per unit time. Making CLAUDE.md updates part of the PR checklist prevents staleness from accumulating.

### Senior @ FAANG: CLAUDE.md Governance as Documentation Debt Management

At senior level, CLAUDE.md governance is part of the broader documentation debt management practice. Every codebase accumulates documentation debt: READMEs that describe a deprecated architecture, runbooks with outdated commands, API documentation that misses recently added fields. CLAUDE.md adds a new category of documentation debt with a unique impact: stale CLAUDE.md immediately affects AI tool quality, making the staleness visible in every AI-assisted PR as incorrect suggestions. This visibility is both a curse (stale CLAUDE.md causes more rework) and an opportunity: the AI's incorrect suggestions are a signal that CLAUDE.md needs updating, creating a natural feedback loop that keeps CLAUDE.md more current than other documentation types.

Building the PR checklist question ("does this PR introduce a new pattern or deprecate an old one? update CLAUDE.md") into the team's code review template is the process change that converts CLAUDE.md from a one-time effort into a living document. Pairing this with a periodic review (quarterly CLAUDE.md review during the team's retrospective) catches the staleness that individual PRs miss (convention changes that happened gradually over many PRs, not in a single change). The periodic review also identifies conventions that should be added (patterns that have become de facto standards without being documented) and conventions that should be removed (anti-patterns that no longer appear in the codebase because engineers have learned to avoid them).
