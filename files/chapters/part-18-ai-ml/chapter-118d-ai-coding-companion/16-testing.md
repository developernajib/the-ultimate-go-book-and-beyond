### CLAUDE.md Specification: Testing Requirements

Testing conventions keep generated tests consistent with the existing suite:

```markdown
## Testing
- Unit tests use standard testing package with testify/assert
- Integration tests use testcontainers-go for PostgreSQL
- Run: go test ./... -race -count=1
- Coverage threshold: 80% on business logic packages
```

### Junior → FAANG: Testing Configuration as Engineering Discipline Signal

The testing configuration in this file (race detector enabled, testcontainers for real database integration tests, 80% coverage threshold on business logic) is a signal of testing discipline that distinguishes production engineering from prototype engineering. The race detector catches concurrency bugs that are otherwise silent. Testcontainers verify real database behavior including schema constraints, indexes, and transaction behavior that mocks cannot simulate. The coverage threshold ensures that business logic has meaningful test coverage rather than just line coverage. Knowing why each configuration choice exists, and being able to explain it in an interview, demonstrates production testing maturity.

### Senior @ FAANG: Testing Configuration as CI Infrastructure Investment

At senior level, the testing configuration requires CI infrastructure investment: the race detector adds runtime overhead that requires longer CI timeouts, testcontainers requires Docker in the CI environment with sufficient memory for the database container, and coverage threshold enforcement requires a coverage measurement and comparison step in CI. Specifying these CI requirements when defining the testing configuration, and ensuring the CI environment is provisioned correctly before the tests are written, is the infrastructure engineering discipline that makes testing standards achievable rather than aspirational.
