## 90F.9 Company Case Studies

### Google - staticcheck and go vet

Go vet ships with built-in analyzers written using `go/analysis`:
- `printf`: verifies printf format strings match arguments
- `structtag`: checks struct tags are well-formed
- `loopclosure`: detects goroutine variable capture bugs
- `nilness`: static nil pointer dereference detection

staticcheck (Dominik Honnef) extends this with 150+ analyzers and has become the industry standard linter. Key insight: staticcheck treats linting as type-checked program analysis, not regex matching. This eliminates false positives dramatically.

**Go lesson**: build linters using `go/analysis`, not string matching. The type system gives you precision that textual analysis can't achieve.

### Uber - go-header and Custom Linters

Uber's monorepo contains 50M+ lines of Go. They've built dozens of custom analyzers to enforce:
- Copyright headers on all files (`go-header`)
- API stability requirements (no breaking changes to exported types)
- Correct error handling patterns specific to their infrastructure
- Dependency injection requirements for testability

Their key insight: a linter that runs in CI and blocks PRs is far more effective than code review comments for enforcing structural rules.

**Go lesson**: identify structural patterns in your codebase that cause bugs repeatedly (missing error checks, wrong context usage, missing auth) and automate their detection. The investment in one analyzer pays dividends across thousands of future PRs.

### Stripe - Custom Protobuf Plugins

Stripe generates large amounts of code from Protocol Buffer definitions:
- Go HTTP clients for each service
- TypeScript SDK stubs
- OpenAPI documentation
- Database migration stubs from proto schema annotations

Each code generator is a custom `protoc-gen-*` plugin in Go. The benefit: API changes in `.proto` files automatically propagate correct client code across languages, eliminating manual synchronization.

**Go lesson**: invest in code generation for cross-cutting concerns (auth, logging, metrics, retry) that otherwise require copy-paste across many files. `go generate` plus template-based codegen can eliminate entire categories of maintenance work.

### Junior → FAANG: Learning from Case Studies

These case studies show that tooling investment at FAANG companies is a strategic priority, not a nice-to-have. When you use `staticcheck` or `golangci-lint`, you are using the output of this strategic investment. Understanding the rationale behind each tool (type-checked analysis for precision, CI enforcement for culture change, codegen for API consistency) lets you explain in an interview why you chose a particular tooling approach with more depth than "we used the standard linter."

### Senior @ FAANG: Platform Tooling as a Competitive Differentiator

At L6, the case studies represent concrete archetypes for platform investments you might propose. Uber's monorepo linter suite (enforcing dependency injection, API stability, and error handling patterns) is the outcome of multiple engineering quarters of investment justified by the productivity impact on 50M+ lines of Go. Making that case to leadership, quantifying the expected return, and driving the multi-quarter roadmap is a staff-level skill. The technical work of building the analyzer is the easier part.

The Stripe pattern (protobuf-driven multi-language codegen) is a systems architecture decision as much as a tooling decision. It presupposes that all services are defined in protobuf, that all clients are generated, and that the source of truth for API contracts lives in `.proto` files. These are org-wide conventions that require buy-in from every team. A staff engineer who drives this adoption is doing organizational change management alongside technical work.

---
