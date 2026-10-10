## 118.11 Hands-on Practical Exercises

### Exercise 1: Bootstrap a Project with Claude Code

**Objective**: Build a production-grade Go service skeleton with AI assistance while maintaining quality standards.

**Setup**:
```bash
mkdir notification-service && cd notification-service
go mod init github.com/yourorg/notification-service
claude
```
**Task sequence**:
1. Describe the service: notification delivery for a SaaS platform
2. Ask Claude Code to generate the directory structure and CLAUDE.md
3. Ask Claude Code to define the domain interfaces (no implementation)
4. Review the interfaces: do they make sense for your domain?
5. Ask Claude Code to write tests for the interfaces (mock-based)
6. Review the tests: do they capture the right behavior?
7. Ask Claude Code to implement the interfaces
8. Review for: error handling, context propagation, security
9. Run `go test ./... -race` and fix any failures

**What you're practicing**: The TDD-with-AI workflow. Interfaces first, tests second, implementation third.

---
### Exercise 2: The Security Review Drill

**Objective**: Find AI-generated security vulnerabilities before they ship.

**Setup**: Ask AI to generate a complete authentication handler (deliberately do not give security guidance):

```text
Write a Go HTTP handler for user login. Accept email and password,
check against a users table in PostgreSQL, return a JWT token if valid.
```
**Review task**: Using the security checklist from section 118.4, find every security issue in the generated code. Common issues to find:
- SQL injection in user lookup query
- JWT signed with weak or hardcoded key
- Missing rate limiting
- Password comparison timing attack
- Sensitive data in logs
- Missing input validation

**Then**: Re-prompt with explicit security requirements and verify the output is clean.

**What you're practicing**: Security review of AI output. This drill makes the patterns instinctive.

---
### Exercise 3: Build Your CLAUDE.md

**Objective**: Create a CLAUDE.md for an existing project that genuinely improves AI assistance.

**For an existing project you work on**:
1. Document the directory structure with purposes
2. List 5 patterns you use consistently
3. List 5 patterns you explicitly do NOT use (and why)
4. Write your error handling convention
5. Write your testing convention
6. List security requirements

**Test it**: Open Claude Code in the project. Ask it to implement a new feature. Compare the output quality before and after CLAUDE.md. The difference should be visible immediately: the AI should now reach for the right interfaces, the right packages, and your error handling conventions without being told.

**What you're practicing**: project context engineering, one of the highest-value AI productivity skills.

---
### Exercise 4: The Concurrency Bug Hunt

**Objective**: Identify AI-generated concurrency bugs.

**Setup**: Ask AI to implement a simple in-memory cache with expiration:

```text
Implement an in-memory cache in Go with:
- Set(key string, value any, ttl time.Duration)
- Get(key string) (any, bool)
- Delete(key string)
- A background goroutine that purges expired entries
```
**Hunt for**:
1. Missing mutex protection on map reads/writes
2. Locking on value receiver vs pointer receiver
3. Goroutine that can't be stopped (no context or done channel)
4. Race between expiry check and access
5. Potential deadlock if purge goroutine holds lock while accessing map being modified by another operation

**Verify with**: `go test -race`. Write a test that hammers the cache concurrently from multiple goroutines. If the implementation has races, the race detector will find them.

**What you're practicing**: concurrency review, the hardest category of AI-generated bug to find by reading.

---
### Exercise 5: Prompting for the Repository Pattern

**Objective**: Use the incremental prompt pattern to build a complete repository layer.

**Step 1**: Ask AI to generate only the domain interface for a `Product` repository. Review it.

**Step 2**: Ask AI to write tests for that interface using mocks. Review them: do they capture the behaviors that matter?

**Step 3**: Ask AI to implement the repository using pgx/v5, following the pattern you show it from an existing repository in your codebase.

**Step 4**: Ask AI to generate integration tests using testcontainers-go.

**Step 5**: Run everything. Fix failures. Measure: how many rounds of fixes were needed? What types of errors occurred? This is calibration data for how much you can trust AI output in your context.

**What you're practicing**: The incremental prompt workflow for complex code generation.

---
### Exercise 6: AI-Assisted Performance Analysis

**Objective**: Use AI to generate hypotheses about performance issues, then verify with profiling.

**Setup**: Take a function in your codebase that you suspect has performance issues (or create one with obvious problems: N+1 query, allocation in loop, unnecessary string conversion in hot path).

**Task**:
1. Paste the function to AI with context about how it's used
2. Ask for a list of performance hypotheses
3. Run `pprof` or `benchstat` to generate actual profiling data
4. Compare AI hypotheses to profiling reality
5. Document: what did AI identify correctly? What did it miss? What did it hallucinate?

**What you're practicing**: Using AI as a hypothesis generator, not as a profiler. Keeping profiling data as the source of truth.

---
### Exercise 7: Migrating an Anti-Pattern with AI

**Objective**: Use AI to refactor a known anti-pattern while you maintain architectural oversight.

**Target**: Find a function in your codebase that directly instantiates its dependencies instead of using dependency injection. This is common in older Go code:

```go
func NewUserService() *UserService {
    db := database.Connect() // BAD: dependency constructed, not injected
    cache := redis.NewClient(&redis.Options{Addr: "localhost:6379"}) // BAD: same, plus a hardcoded address
    return &UserService{db: db, cache: cache}
}
```
**Task**:
1. Define the interfaces that `UserService` should depend on
2. Ask AI to refactor the function to use constructor injection
3. Ask AI to update all callers
4. Ask AI to update the tests to use mocks instead of real implementations
5. Review all changes for correctness and Go idioms

**What you're practicing**: Using AI for large refactors while you maintain architectural control.

---
### Exercise 8: Build a Custom AI Code Review Tool

**Objective**: Build a real tool using the Anthropic or OpenAI API.

**Build**: A CLI tool that takes a Go file path and returns a structured review report:

```bash
go run cmd/review/main.go internal/auth/jwt.go
```
Output:
```text
SECURITY ISSUES (BLOCKING):
[1] Line 47: JWT parsed without signature verification.
    jwt.Parse() called with a nil key function, so forged tokens are accepted.
    Fix: Provide key function that validates signing method.

STYLE ISSUES (ADVISORY):
[2] Line 23: Missing godoc on exported function ValidateToken.

OVERALL: 1 blocking issue must be resolved before merge.
```
Use the code from section 118.2 (CodeReviewer) as a starting point. Add:
- Go-specific system prompt with common Go security patterns
- Structured output parsing (JSON mode)
- Different severity levels
- Exit code 1 if blocking issues found (for CI integration)

**What you're practicing**: building AI-powered internal tooling, a staff engineer skill.

---
### Exercise 9: Write the Same Code Three Ways

**Objective**: Understand the difference between bad, good, and excellent AI-assisted code generation.

**Task**: Implement a paginated list endpoint for a resource of your choice.

**Round 1, vibe coding**: Prompt with just "write a paginated list endpoint in Go." Accept the first output. Don't review.

**Round 2, reviewed**: Same prompt, but review for the full checklist (security, error handling, concurrency, edge cases). Fix everything you find.

**Round 3, constrained**: Provide your interface, your error types, your existing patterns. Ask AI to implement against your specifications.

**Compare**: The three implementations. Measure: lines of code changed between rounds, number of issues found, test coverage, adherence to your project's patterns.

**What you're practicing**: Understanding the ROI of prompt quality and review rigor.

---
### Exercise 10: Staff Engineer Challenge, Team AI Workflow

**Objective**: Design an AI-assisted workflow for your entire team.

**Deliverables**:
1. **Team CLAUDE.md**: Write a CLAUDE.md suitable for your team's largest service. Have a teammate use it cold: can they get useful AI assistance from it without asking you anything?

2. **Prompt library**: Create a `prompts/` directory with 5-10 pre-written prompts for common tasks (new endpoint, new repository method, security review, test generation). These become team assets.

3. **AI tool evaluation**: Evaluate two AI coding tools against three real tasks from your backlog. Document: output quality, iterations needed, issues found in review, time spent. Recommend one tool with justification.

4. **CI integration**: Add a step to your CI pipeline that runs AI review on changed files and posts the findings as a PR comment. Use the custom tool from Exercise 8. Post the findings, do not gate the merge on them: the model is nondeterministic and will both miss real bugs and block clean PRs on imagined ones, and a flaky gate teaches the team to bypass gates. Deterministic checks (`go vet`, `golangci-lint`, `govulncheck`, the tests) are what gets to fail the build.

**What you're practicing**: multiplying team productivity, the defining skill of a staff engineer.

### Junior → FAANG: Exercises as Portfolio and Interview Preparation

The exercises in this section are designed to be completed in order, each building on the last. Exercise 1 (bootstrap a service) builds the interfaces-then-tests-then-implementation workflow. Exercise 2 (the security review drill) builds the habit of reading AI output adversarially. Exercise 3 (build your CLAUDE.md) builds project context engineering. Exercise 4 (the concurrency bug hunt) targets the single hardest category of AI-generated bug to see by eye. Each completed exercise is a portfolio artifact demonstrating a specific capability.

For FAANG interviews, having a concrete project bootstrapped using these exercises gives you a specific, detailed story for "walk me through a project you built using AI tools." The best interview stories include the specific decisions you made (what you put in CLAUDE.md and why, what constraints you specified before generating the feature implementation, what the AI got wrong on the first generation and how you corrected it), not just the high-level summary. Practice telling the story of each exercise as a two-minute narrative: what you started with, what decisions you made along the way, what you ended up with, and what you would do differently with more experience.

Exercise 10 (the team AI workflow) is the highest-value exercise for interview preparation because it requires you to think at the team level rather than the individual level. Documenting a workflow for a team requires understanding what variation exists in the team's current approach, what the best practices are and why, and how to communicate them clearly enough that others can follow them. This is the same skill that is assessed in the "how would you improve the engineering culture around X?" questions that appear in L5 and above FAANG interviews.

### Senior @ FAANG: Exercises as Team Training Program Design

At senior level, these exercises are the template for an internal AI-assisted development training program. Running the team through Exercise 1 (bootstrap a standard service) as a group reveals variation in CLAUDE.md quality, prompting approach, and review discipline that would otherwise stay invisible. Exercise 2 (the security review drill) run as a group produces a shared team checklist rather than ten personal ones, which has far higher adoption. Exercise 10 (the team AI workflow) run as a retrospective activity produces a living document capturing current practice and naming the gaps.

The "multiplying team productivity" framing of Exercise 10 is the correct framing for staff-level contribution. A senior engineer who improves their personal productivity by 50% adds 0.5 FTE of value. A senior engineer who improves the team's productivity by 10% by sharing workflows, tooling configurations, and CLAUDE.md templates adds 0.1N FTE of value where N is the team size. For a team of 20, that is 2 FTE of value from one engineer's organizational contribution. This scaling property of platform and tooling work is what makes it the most effective investment for staff engineers, and why exercises that build team-multiplying habits are more valuable than exercises that only build individual productivity.

---


---

### Capstone AI Development Exercises


1. **CLAUDE.md-Driven Project Bootstrap**: Create a `CLAUDE.md` for a new Go microservice project that encodes: module name, Go version, error handling conventions (sentinel errors vs. wrapping), test framework (`testify`), linting rules (`golangci-lint` config path), security requirements (no hardcoded secrets, parameterized DB queries only), and commit message format. Use the file to generate a complete CRUD endpoint (handler + service + repository + tests) via AI assistance and measure how many correction rounds are needed compared to a baseline without `CLAUDE.md`. Expected outcome: a documented context file that measurably reduces AI correction rounds by providing precise, machine-readable project conventions.

2. **AI Security Review Automation**: Write a Go CLI tool that sends a code diff (from `git diff --staged`) to an LLM with a structured security review prompt covering OWASP Top 10 categories. Parse the LLM's JSON response and print findings grouped by severity, defaulting to advisory (exit code 0) with an opt-in `--strict` mode that exits 1 on HIGH or CRITICAL. Then run it over a corpus of diffs you have already reviewed by hand and measure both numbers that matter: what fraction of real issues it caught, and how often it flagged something fine. Expected outcome: a pre-commit hook that surfaces likely security problems early, plus your own hard data on its false-positive rate, which is what tells you whether `--strict` is defensible at all. A nondeterministic gate that blocks clean commits gets disabled within a week, and then it protects nothing.

3. **Prompt Template A/B Testing Framework**: Build a Go CLI that evaluates two prompt variants against a shared test set of (input, expected_output) pairs. For each input, call both variants, score outputs using exact-match and LLM-as-judge (1-5 quality rating), and run a paired t-test to determine if the difference in mean quality scores is statistically significant at p < 0.05. Export results as a CSV report. Expected outcome: a data-driven prompt evaluation tool that replaces subjective "feels better" prompt comparisons with statistically validated quality measurements.

4. **AI-Assisted Test Generation Pipeline**: Implement a Go tool that reads a source file, extracts all exported function signatures using `go/ast`, and generates a table-driven test file for each function via an LLM call with a structured prompt specifying: Go version, `testify` assertions, edge cases (nil inputs, empty slices, boundary values), and mock generation for interface parameters. Post-process the LLM output through `gofmt` and `go vet` and report any formatting or compilation errors. Expected outcome: a tool that produces compilable, idiomatic test files for any Go source file with 80%+ test coverage on happy paths.

5. **AI Workflow Metrics Dashboard**: Instrument a development workflow to capture DORA-aligned metrics: time from first commit to merged PR (cycle time), number of AI-assisted vs. manually written commits (from commit messages), PR review iteration count, and post-merge defect rate (issues opened referencing a PR). Store events in SQLite and build a Go HTTP server serving a `/metrics` JSON endpoint and a `/report?period=30d` HTML summary. Expected outcome: a personal or team dashboard that surfaces objective data on how AI assistance affects cycle time and defect rate over rolling 30-day periods.

6. **Context-Aware Code Review Bot**: Build a Go service that integrates with the GitHub Pull Request API. On each PR, fetch the diff, extract the repository's `CLAUDE.md` context, and submit a structured review prompt to an LLM requesting inline comments for: Go idiom violations, missing error handling, untested code paths, and security issues. Post the LLM's findings as GitHub review comments using the GitHub REST API. Expected outcome: an automated code review bot that adds actionable, context-aware inline comments to every PR within 60 seconds of opening.

### Junior → FAANG: Exercises as Concrete FAANG Interview Evidence

Each exercise in this list produces a concrete artifact that can be discussed in a FAANG interview. Exercise 1 (CLAUDE.md-driven bootstrap with measurement) produces a data point: "with CLAUDE.md, I needed 1.2 correction rounds on average. Without it, I needed 3.4 rounds." This quantified result is exactly the kind of evidence that FAANG interview questions about impact and measurement are looking for. Exercise 6 (context-aware code review bot) is the most complex and most impressive as a portfolio artifact: it combines Go service development, GitHub API integration, LLM API integration, and prompt engineering into a system that provides visible, measurable value to a team.

For FAANG interviews specifically, be ready to discuss the technical decisions you made in each exercise, not just the outcome. For Exercise 2 (security review automation), what was the false-positive rate, and how did you decide whether the tool was worth running? For Exercise 5 (metrics dashboard), what did you discover about your own productivity that you had not expected, and did it match how the work felt at the time? For Exercise 6 (review bot), how did you design the prompt to minimize false positives while still catching real issues? These decision and discovery narratives are the substance of FAANG behavioral and technical interview answers.

The expected outcomes in each exercise description are the success criteria: if your implementation does not meet the expected outcome, you have not completed the exercise. Holding yourself to these criteria builds the discipline of defining and verifying success conditions that is central to FAANG engineering culture.

### Senior @ FAANG: Exercises as Team Training Program and Platform Prototype

At senior level, Exercise 6 (context-aware code review bot) is not just a learning exercise. It is a platform prototype. A production version of this system, with error handling, rate limiting, cost tracking, and a configurable rule set, is the starting point for an organization's AI-assisted code review platform. Building the exercise to production quality, documenting the design decisions, and presenting it to the team as a platform proposal is a concrete path from individual skill development to organizational platform contribution.

Exercises 3 and 5 together define a productivity measurement platform. Exercise 3 (prompt A/B testing) supplies the controlled-experiment machinery, including the part most teams skip: a significance test, so that a difference of two points on a five-point judge score is not reported as an improvement. Exercise 5 (metrics dashboard) supplies the longitudinal infrastructure. Feeding the first into the second gives you a running productivity experiment on your own codebase, which is the only kind of evidence that should drive AI tool investment decisions. Recall from Section 118.14 that the alternative, asking engineers whether they feel faster, has been measured and found to point the wrong way. This is the organizational measurement infrastructure that staff engineers design and champion, even when the initial implementation is a personal exercise.
