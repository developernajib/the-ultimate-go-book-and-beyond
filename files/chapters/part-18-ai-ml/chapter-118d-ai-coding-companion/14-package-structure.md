### CLAUDE.md Specification: Package Structure

The package map lets the assistant place new code where the team expects it:

```markdown
## Package Structure
- cmd/          - Entry points (main packages)
- internal/api/ - HTTP handlers (chi)
- internal/service/ - Business logic (no HTTP awareness)
- internal/repository/ - Database access (pgx)
- internal/model/ - Domain types and validation
- pkg/          - Shared libraries used by other services
```

### Junior → FAANG: Package Structure as Dependency Arrow Understanding

The package structure encodes dependency arrows: internal/api depends on internal/service, internal/service depends on internal/repository, and both depend on internal/model. No package depends on internal/api (the HTTP layer does not leak into business logic). The Go compiler enforces this through import cycles, making architectural violations compile errors. Understanding this enforcement mechanism is Go architectural fluency that distinguishes engineers who understand Go's module system from those who only know how to write Go syntax.

### Senior @ FAANG: Package Structure as New Engineer Onboarding Tool

At senior level, a clear package structure with documented layer responsibilities is the most effective new engineer onboarding tool for codebase navigation. An engineer who reads this package structure immediately knows where to add a new endpoint (internal/api), where to add business logic for that endpoint (internal/service), where to add the database query (internal/repository), and where to add the data types (internal/model). Without this documented structure, the same engineer spends their first week navigating the codebase trying to understand its organization. The package structure documentation in CLAUDE.md pays for itself in reduced onboarding time for every engineer who joins the team.
