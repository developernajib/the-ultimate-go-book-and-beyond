## 93.10 Take-Home Assignments and Portfolio Reviews

Many companies, especially startups and companies like Stripe, use take-home assignments as part of their interview process. This section covers how to excel at them.

### Understanding Take-Home Assignments

Unlike a timed coding screen, take-home assignments are explicitly designed to simulate real work: you have access to documentation, your editor, and time to think. This means the bar shifts from "can you solve this puzzle under pressure" to "can you produce production-quality code given reasonable time". Reviewers expect tests, error handling, and a README that explains trade-offs, submitting a working program without those signals is the equivalent of shipping code without a PR description.

```
┌──────────────────────────────────────────────────────────────────┐
│              TAKE-HOME ASSIGNMENT OVERVIEW                       │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  TYPICAL STRUCTURE:                                              │
│  ├── Time allotted: 4-8 hours (sometimes a weekend)              │
│  ├── Scope: Build a small but complete application               │
│  ├── Requirements: Usually well-defined with some ambiguity      │
│  └── Submission: GitHub repo or zip file                         │
│                                                                  │
│  WHAT COMPANIES EVALUATE:                                        │
│  ├── Code quality and organization                               │
│  ├── Testing (often more important than features)                │
│  ├── Error handling                                              │
│  ├── Documentation                                               │
│  ├── Architectural decisions and trade-offs                      │
│  └── Communication (README explaining choices)                   │
│                                                                  │
│  COMMON ASSIGNMENT TYPES:                                        │
│  ├── API service (REST or gRPC)                                  │
│  ├── CLI tool                                                    │
│  ├── Data processing pipeline                                    │
│  ├── Bug finding and fixing (Stripe's approach)                  │
│  └── Extend existing codebase                                    │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Take-Home Best Practices

The most common mistake is over-investing in features at the expense of structure and tests. A minimal API with solid error handling, a coherent package layout, and 80% test coverage will score significantly higher than a feature-rich submission with no tests and panicking on bad input. Treat the README as a design document: explicitly state which requirements you de-prioritized, what you would change with more time, and what trade-offs you made, reviewers weight this communication as heavily as the code itself.

```markdown
# Take-Home Assignment Strategy

## Before Starting

1. READ REQUIREMENTS THOROUGHLY
   - Read 2-3 times before writing any code
   - Note any ambiguities to address
   - Identify must-haves vs nice-to-haves

2. PLAN YOUR TIME
   4-hour assignment breakdown:
   - 30 min: Planning and setup
   - 2.5 hours: Core implementation
   - 30 min: Tests
   - 30 min: Documentation and cleanup

3. SET UP PROJECT PROPERLY
   - Standard Go project structure
   - Makefile with common targets
   - README from the start
   - Git with meaningful commits

## During Implementation

1. PRIORITIZE CORRECTLY
   Order of importance:
   a. Working core functionality
   b. Tests for critical paths
   c. Error handling
   d. Documentation
   e. Extra features (only if time)

2. MAKE DECISIONS AND DOCUMENT THEM
   "I chose SQLite over PostgreSQL because the
    assignment scope didn't require multi-instance
    deployment. For production, I would use PostgreSQL."

3. WRITE TESTS ALONGSIDE CODE
   - Don't leave testing for the end
   - At minimum: test happy path and one error case
   - Table-driven tests show Go proficiency

4. HANDLE ERRORS PROPERLY
   - No ignored errors
   - Meaningful error messages
   - Proper HTTP status codes
```

### Project Structure for Take-Homes

Reviewers evaluate take-home projects in minutes, so project layout is the first signal of professionalism. Separating `cmd/` (entry points) from `internal/` (private application code) follows Go's idiomatic convention and communicates that you understand package boundaries and won't accidentally expose internal APIs. Including a `Makefile`, `Dockerfile`, and `README` demonstrates production awareness: reviewers want to see that you can hand off a project a teammate could run, test, and deploy without asking you questions.

```go
// Example project structure for a take-home API service

/*
Myproject/
├── cmd/
│ └── server/
│ └── main.go # Entry point
├── internal/
│ ├── api/
│ │ ├── handler.go # HTTP handlers
│ │ ├── handler_test.go # Handler tests
│ │ ├── middleware.go # Auth, logging, etc.
│ │ └── routes.go # Route definitions
│ ├── domain/
│ │ ├── user.go # Domain types
│ │ └── errors.go # Domain errors
│ ├── storage/
│ │ ├── storage.go # Interface
│ │ ├── memory.go # In-memory implementation
│ │ └── postgres.go # PostgreSQL implementation
│ └── service/
│ ├── user.go # Business logic
│ └── user_test.go # Unit tests
├── Makefile # Build, test, run targets
├── Dockerfile # Containerization
├── docker-compose.yml # Local development
├── go.mod
├── go.sum
├── .gitignore
└── README.md # Documentation
*/

// Example Makefile for take-home
/*
.PHONY: build test run clean lint

Build:
	go build -o bin/server ./cmd/server

Test:
	go test -v -race ./...

Test-coverage:
	go test -coverprofile=coverage.out ./...
	Go tool cover -html=coverage.out -o coverage.html

Run:
	go run ./cmd/server

Lint:
	golangci-lint run

Clean:
	rm -rf bin/ coverage.*

Docker-build:
	docker build -t myproject .

Docker-run:
	docker-compose up -d
*/
```

### README Template for Take-Homes

````markdown
# Project Name

Brief description of what this application does.

## Design Decisions

### Architecture
I chose [pattern] because [reason]. The trade-offs are:
- Pro: [advantage]
- Con: [disadvantage]

### Data Storage
Using [SQLite/PostgreSQL/in-memory] because [reason].
For production, I would [changes].

### Error Handling
Errors are wrapped with context and returned to callers.
HTTP responses use appropriate status codes.

## Running the Application

### Prerequisites
- Go 1.21+
- Make
- Docker (optional)

### Quick Start

Once the prerequisites are in place, getting the application running requires just three commands. The `make run` target handles dependency fetching, building, and starting the server so you can focus on exploring the code rather than configuring the environment.

```bash
# Clone and run
git clone [repo]
cd [project]
make run
```

### Running Tests

The test suite validates all business logic and HTTP handlers in isolation using Go's standard `testing` package. Running with coverage gives you an immediate view of which code paths are exercised, which is especially useful when extending the project or preparing to discuss test strategy in an interview.

```bash
make test           # Run all tests
make test-coverage  # Generate coverage report
```

### API Examples

These `curl` commands demonstrate the two most fundamental operations against the REST API: creating a resource with a JSON body and retrieving it by ID. Running them against the locally running server confirms that routing, deserialization, persistence, and serialization are all wired together correctly end-to-end.

```bash
# Create user
curl -X POST http://localhost:8080/users \
  -H "Content-Type: application/json" \
  -d '{"name": "Alice", "email": "alice@example.com"}'

# Get user
curl http://localhost:8080/users/1
```

## What I Would Do Differently

Given more time, I would:
1. Add integration tests with a real database
2. Implement rate limiting
3. Add OpenTelemetry instrumentation
4. Deploy to Kubernetes with Helm chart

## Time Breakdown

- Planning: 30 minutes
- Core implementation: 2.5 hours
- Testing: 45 minutes
- Documentation: 15 minutes
- Total: ~4 hours
````

### Portfolio Review Preparation

```
┌─────────────────────────────────────────────────────────────────┐
│ PORTFOLIO REVIEW INTERVIEW                                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│ WHAT INTERVIEWERS LOOK FOR:                                     │
│ ├── Code quality and consistency                                │
│ ├── Project complexity and depth                                │
│ ├── Testing practices                                           │
│ ├── Documentation quality                                       │
│ ├── Open source contributions                                   │
│ └── How you explain your work                                   │
│                                                                 │
│ PROJECTS TO HIGHLIGHT:                                          │
│ ├── Complete applications (not just tutorials)                  │
│ ├── Projects with tests and documentation                       │
│ ├── Contributions to well-known projects                        │
│ ├── Side projects solving real problems                         │
│ └── Technical blog posts with code                              │
│                                                                 │
│ PREPARE TO DISCUSS:                                             │
│ ├── Why you built it                                            │
│ ├── Technical challenges and how you solved them                │
│ ├── What you would do differently now                           │
│ ├── Architecture and design decisions                           │
│ └── Trade-offs you considered                                   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Junior → FAANG: Take-Home Assignments as a Leveling Opportunity

Take-home assignments are simultaneously the most forgiving and most discriminating interview format for early-career candidates. They are forgiving because you have time to look things up, think carefully, and produce polished output without real-time pressure. They are discriminating because the output quality ceiling is much higher, and a mediocre take-home from a candidate with otherwise strong signals is more damaging than a mediocre live coding round.

The most important thing to understand about take-home evaluation is that the assignment itself is the minimum bar. What separates candidates who advance from candidates who do not is the written README and the portfolio review conversation. A correctly functioning solution with a poorly written README that does not explain the design decisions will often score lower than a slightly incomplete solution with a clear explanation of what was attempted, what tradeoffs were made, and what would be added with more time.

Practical guidance: allocate 30 percent of your take-home time to writing the documentation. Explain why you made the architectural choices you made, what alternatives you considered and rejected, and what you would do differently in a production context. This is the Go-specific version of "show your work," and it is how interviewers distinguish between candidates who got a working solution and candidates who understand what makes a solution good.

### Senior @ FAANG: Portfolio Review Depth and the ADR Presentation Pattern

At senior level, the portfolio review conversation is a governance exercise disguised as an engineering discussion. The interviewer is not evaluating whether you built something technically correct. They are evaluating whether you can articulate the reasoning behind architectural decisions with the clarity and confidence that a senior engineer needs to drive cross-team alignment.

Structure your portfolio review using the ADR format explicitly: this was the problem, these were the options I considered, here were the tradeoffs on each axis, this was the decision and the reasoning, and here is what I learned about whether it was the right call. This format makes your reasoning auditable and demonstrates that you think about decisions as documented records rather than intuitive choices.

The production-readiness dimensions that senior candidates are expected to address without prompting: observability (how would you know if this system was degrading), operational complexity (what does the on-call runbook look like), failure mode analysis (what breaks first and how does it degrade gracefully), and migration path (if this were replacing an existing system, how would the transition be managed). Candidates who address these dimensions in their written documentation before the review conversation signal L6-level thinking consistently.

---
