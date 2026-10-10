### CLAUDE.md Specification: Architecture

The most effective artifact in a personal AI workflow is the project-context file (a `CLAUDE.md` or equivalent) that every prompt inherits. The next few sections walk through a production-grade example for a Go payment service, one block at a time. It opens with the architecture:

```markdown
## Architecture
- Go 1.27 with chi router
- PostgreSQL 16 with pgx driver (no ORM)
- Redis 7 for caching and rate limiting
- gRPC for inter-service communication
- Deployed on Kubernetes via Helm charts
```

### Junior → FAANG: Architecture Stack as Interview Context

This architecture stack (Go, chi, pgx, Redis, gRPC, Kubernetes, Helm) represents a common FAANG Go service stack. For FAANG interviews, knowing the rationale for each technology choice in your stack is as important as knowing how to use each technology. Chi over gin: lightweight, no external dependencies, idiomatic Go middleware pattern. pgx over database/sql: better PostgreSQL support, named parameters, connection pool management. Redis for rate limiting: atomic increment operations, TTL-based key expiration, distributed state without a database. gRPC for inter-service: type-safe service contracts via protobuf, bidirectional streaming, automatic client generation.

### Senior @ FAANG: Architecture Stack as Operational Complexity Budget

At senior level, each technology in the stack adds to the team's operational complexity budget. A 4-engineer team has a limited operational complexity budget: too many services and databases and queues and caches become impossible to operate reliably. The payment service stack (Go, PostgreSQL, Redis, Kubernetes, gRPC) is already 5 distinct operational concerns. Adding another technology (Kafka for event streaming, Elasticsearch for search) requires demonstrating that the benefit justifies the additional operational load. Senior engineers who maintain this discipline prevent the complexity accumulation that makes services expensive to operate and difficult to debug.
