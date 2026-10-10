## 118.13 Reference: Go-Specific AI Prompt Templates

This section provides copy-paste prompt templates for the most common Go engineering tasks. They produce output worth reviewing, which is the honest claim: none of them produce output worth merging unread. Adapt them to your project's conventions, especially the parts in `[brackets]`. Notice how much of every template is you pasting in an existing example: that is doing most of the work here, not the wording.

---
### Template 1: New HTTP Handler

This template instructs the AI to follow your existing handler conventions exactly, same error mapping, same request parsing pattern, same response envelope, rather than inventing its own style. Pasting one representative existing handler as context is the single most important thing you can do to get immediately usable output.

```text
Context: I'm adding a new HTTP handler to a Go [chi/v5 | net/http | gin] API.

Existing handler pattern (follow this exactly):
[paste one existing handler from your codebase]

Domain service interface:
[paste the service interface this handler will call]

Domain error types:
[paste your error types]

New endpoint spec:
- Method: [POST/GET/PUT/DELETE]
- Path: /api/v1/[resource]
- Auth: [required/optional/none], via [JWT middleware | API key]
- Request body: [describe or paste struct]
- Response: [describe success response]
- Errors: [list expected error cases and their HTTP status]

Generate:
1. The handler function
2. The request/response structs with JSON tags and validation
3. Table-driven tests with testify
4. Error cases: invalid input (400), not found (404), unauthorized (401), internal (500)
```
---
### Template 2: New Repository Method

The Repository pattern abstracts data access behind an interface, decoupling business logic from storage implementation details. In Go this makes services trivially testable by swapping production storage for in-memory implementations during unit tests.

```text
I'm adding a new method to a Go repository.

Database: PostgreSQL with pgx/v5
Existing repository for reference (follow this pattern exactly):
[paste 1-2 existing methods from your repository]

Table schema:
[paste CREATE TABLE SQL]

New method spec:
- Method name: [GetByEmailAndStatus]
- Parameters: [ctx context.Context, email string, status UserStatus]
- Returns: [(*User, error)]
- Query behavior: [find a user by email where status matches, return domain.ErrNotFound if missing]

Generate:
1. The repository interface addition (in internal/domain/)
2. The implementation using pgx/v5 named parameters
3. Table-driven tests with a mock database (use pgxmock or testify/mock)
4. Test cases: found, not found, invalid input, database error, context cancellation
```
---
### Template 3: Database Migration

This template generates database migration files compatible with goose. It produces both Up and Down migrations with proper constraints, indexes, and timestamp columns.

```text
Generate a SQL migration for goose (format: -- +goose Up / -- +goose Down).

New table/change: [describe what you need]

Requirements:
- Include created_at, updated_at timestamps with DEFAULT NOW()
- Foreign key constraints with appropriate CASCADE rules
- Indexes on: [list columns that will be queried frequently]
- All columns with sensible NOT NULL / DEFAULT constraints
- The Down migration must be safe to run (no data loss on Down for new tables)

Existing related tables for FK reference:
[paste relevant CREATE TABLE statements]
```
---
### Template 4: Middleware

This template generates Go HTTP middleware that follows either the standard `http.Handler` wrapper pattern or chi's `func(http.Handler) http.Handler` signature. Providing an existing middleware as reference ensures the output uses your project's logger, error type, and context key conventions rather than introducing new dependencies.

```text
Generate a Go HTTP middleware for [chi/v5 | net/http standard pattern].

Middleware purpose: [rate limiting | authentication | request logging | CORS | etc.]

Existing middleware for reference (follow this pattern):
[paste existing middleware]

Requirements:
- Must implement http.Handler interface (or return func(http.Handler) http.Handler for chi)
- Must propagate context correctly
- Thread-safe: will be called by concurrent goroutines
- Must handle: [list specific cases, e.g. missing header, invalid token, rate exceeded]
- On error: return [appropriate HTTP status] with JSON error body

Configuration:
[describe how middleware is configured - window size, key function, etc.]

Generate:
1. The middleware implementation
2. Options struct with functional options pattern for configuration
3. Table-driven tests including concurrent access test (t.Parallel, multiple goroutines)
```
---
### Template 5: Complete Test Suite for an Interface

This template generates a table-driven test suite with a `testify/mock` implementation for every method on an interface, covering the happy path and the most common error scenarios. Specifying the package name and import path prevents the AI from guessing and introducing incorrect module paths.

```text
Generate a complete test suite for this Go interface using testify/mock:

[paste interface definition]

Test requirements:
- One test file per interface (naming: [interface_name]_test.go)
- Use testify/mock to generate mock: type Mock[InterfaceName] struct { mock.Mock }
- Table-driven tests for every method
- Each test case: name, inputs, mock setup (what to return), expected output, expected error
- Subtests using t.Run
- Test naming: Test[InterfaceName]_[Method]_[Scenario]

Test scenarios for each method:
- Happy path (success)
- Not found (if applicable)
- Validation error (if applicable)
- Database/external service error
- Context cancellation (pass a canceled context)
- Edge cases: nil values, empty strings, zero values, max values

Testing style: use assert.NoError, assert.Equal, and assert.ErrorIs rather than assert.Nil
```
---
### Template 6: Security Review

This template directs the AI to audit Go code across the eight categories below, from injection through goroutine leaks. Asking for severity levels and line references makes the output triageable. Use it as a first pass that surfaces candidates, never as a sign-off: it misses real vulnerabilities and invents others, and for anything touching auth or crypto a human with security expertise still reviews the code (Section 118.5).

```text
Perform a security review of this Go code. I'm specifically concerned about:

1. SQL injection: look for any string concatenation or fmt.Sprintf in queries
2. Authentication bypass: JWT validation completeness, signature verification
3. Authorization: are permission checks enforced at every access point?
4. Input validation: what inputs are trusted without validation?
5. Sensitive data exposure: are any credentials, tokens, or PII being logged?
6. Crypto issues: weak algorithms (MD5, SHA1) used for security purposes,
   or math/rand (including math/rand/v2) used where crypto/rand is required
7. Race conditions: concurrent access to shared state without synchronization
8. Goroutine leaks: goroutines started without a shutdown mechanism

For each issue found:
- Severity: CRITICAL (exploit immediately) | HIGH (exploit with effort) | MEDIUM (bad practice) | LOW (style)
- Location: file path and line number
- Description: what the vulnerability is
- Exploit scenario: how an attacker would exploit it
- Fix: the specific change required

Code to review:
[paste code]
```
---
### Template 7: Refactor to Pattern

This template asks the assistant to restructure working code toward a named Go pattern (functional options, worker pool, middleware chain) while preserving behavior, and to justify the change.

```text
Refactor this Go code to use the [repository pattern | service layer | strategy pattern | factory pattern].

Current code (the problem):
[paste current code: monolithic, mixed concerns, etc.]

Target architecture:
[describe the structure you want]

Reference implementation to follow:
[paste an existing implementation of the pattern in your codebase]

Constraints:
- Maintain 100% behavioral equivalence (same inputs → same outputs)
- All existing tests must continue to pass
- No new external dependencies
- Use dependency injection (constructor functions, not global state)

Generate:
1. The refactored code in the target structure
2. Updated tests (if test structure needs to change)
3. A diff summary: what changed and why
```
---
### Template 8: Performance Analysis

This template asks the AI for a ranked list of *hypotheses* about hot-path allocations, contention, and unnecessary copies. The AI cannot profile: it has never run your code and has no idea what is actually slow. Note the last line of the template, which is the important one. You profile, the model guesses, and the profiler wins every disagreement.

```text
Analyze this Go function for performance issues. It's called [N] times per second in production.

Current performance: [p50: Xms, p99: Xms] (or "unknown, investigating")
Target performance: [p99 < Xms]

Function:
[paste function]

Caller context:
[describe how it's called: loop, concurrent, per-request, etc.]

Analyze for:
1. Memory allocations in the hot path (allocations cause GC pressure)
2. Unnecessary copies of large structs (pass pointers for >~64 bytes)
3. Mutex contention (how often is the lock contested?)
4. I/O that could be batched or cached
5. Algorithm complexity (is there an O(n²) where O(n) is possible?)
6. String operations (conversions, concatenations in loops)

For each issue:
- What it is
- Why it matters at [N] calls/second
- The specific fix
- Estimated improvement (rough order of magnitude)

Note: I will profile with pprof to validate before optimizing. This is a hypothesis list.
```
---
### Template 9: ADR Generation

This template generates an Architecture Decision Record in standard ADR format (Context, Decision, Consequences) from a prose description of the problem and the chosen solution. Providing the alternatives you considered and rejected prevents the AI from defaulting to generic trade-off descriptions that do not reflect your actual evaluation.

```text
Write an Architecture Decision Record for this decision.

Decision: [one sentence describing what was decided]
Date: [today's date]
Status: [Proposed | Accepted | Deprecated | Superseded by ADR-XXX]

Context I'll provide:
- The problem we were solving: [describe]
- The constraints we had: [list]
- The options we evaluated: [list 2-4 options]
- What we chose: [the chosen option]
- Why: [key reasons]

ADR format:
# ADR-[NNN]: [Title]
## Status
[Proposed | Accepted | Deprecated | Superseded by ADR-XXX]
## Context
[The forces at play: constraints, requirements, team expertise, what
 made this decision necessary. Rich enough that someone can re-evaluate
 it in two years when the constraints have changed.]
## Decision
[What we are doing, in one unambiguous sentence, plus who decided.]
## Consequences
[Positive and negative. An ADR with no negative consequences is not
 an ADR. Name what this makes harder and what we are giving up.]
## Alternatives Considered
[Each rejected option and the specific reason it was rejected.
 "We considered X" without a reason is not useful to a future reader.]
```

Two warnings on this one. The model will write a Consequences section that is entirely upbeat unless you insist otherwise, because agreeable text is more probable than critical text, so the instruction above is load-bearing. And it will invent plausible-sounding rationales for a decision it was not present for. The Context and Alternatives sections are the parts of an ADR that have any value in two years, and they are the parts only you can write. Use the template for structure and prose. Supply the reasoning yourself.

### Junior → FAANG: Prompt Templates as Skill Scaffolding

Prompt templates are scaffolding: they help you produce good output while you are developing the underlying skill, and they become unnecessary once the skill is internalized. Use the templates in this section for 60-90 days, then try generating the same types of code without the templates and compare the output quality. The templates encode the constraint specification discipline (interface first, error handling pattern, test requirements) that produces quality AI output. After 60-90 days of following the template structure, the discipline becomes a habit that you apply without the template.

For FAANG interview preparation, the templates serve a different purpose: they demonstrate that you have thought carefully about what context AI needs to produce correct Go code. An interviewer who asks "how do you prompt AI for code generation?" who receives an answer that covers specifying the interface, the error handling pattern, the testing framework, and the security requirements is seeing a structured, experienced approach. Practice explaining why each section of the template exists: the interface specification prevents the AI from designing the API, the error handling pattern prevents the default (swallowing errors or returning generic errors), the testing requirement prevents untested output.

The ADR template at the end is a bonus artifact: a complete, structured ADR template that you can use for any technology decision in any project. Having a standard ADR template and using it consistently is one of the documentation habits that distinguishes L5 and above engineers at FAANG.

### Senior @ FAANG: Prompt Templates as Organizational Knowledge Infrastructure

At senior level, the prompt template library is an organizational knowledge asset that encodes the team's collective understanding of what AI needs to produce production-quality code. A team with 20 engineers each developing their own prompting approach produces variable output quality. A team with 20 engineers using 10 shared, validated prompt templates produces consistent output quality. The templates capture the institutional knowledge about which constraints must be specified for each task type, which is knowledge that takes months to develop individually but can be shared instantly through a template library.

Building and maintaining the organizational prompt library is a platform engineering responsibility. The process is: collect prompts that consistently produce high-quality output from team members, normalize them into a standard format (task type, template, example output, adaptation notes), validate them against the team's quality standards, publish them in the team's engineering handbook, and update them as AI model capabilities change or as the team's conventions evolve. This library, integrated into CLAUDE.md as slash command definitions or linked from the engineering handbook, is the AI productivity infrastructure that multiplies the value of AI tool adoption across the team.
