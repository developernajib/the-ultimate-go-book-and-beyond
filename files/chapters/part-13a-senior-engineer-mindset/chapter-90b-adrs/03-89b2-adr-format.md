## 90B.2 ADR Format

An ADR format is the structure and set of sections that every ADR in your project follows. Having a consistent format means that any engineer on the team can open any ADR and immediately know where to find the context, the decision, and the trade-offs. Think of it like a recipe template: the structure is fixed, but the content changes for every decision. Choosing the right format for your team is one of the first decisions you will make when adopting ADRs.

There is no single mandated ADR format. The format you choose should match your team's working style and existing documentation tooling. Two formats dominate in practice: Michael Nygard's original format and the MADR (Markdown Architectural Decision Records) format.

### Michael Nygard's Original Format

Michael Nygard proposed this format in 2011. It is intentionally minimal.

```markdown
# ADR-001: Use PostgreSQL for User Service

## Status

Accepted

## Context

The user service needs a persistent store for user profiles,
authentication credentials, and session data. We require ACID
transactions for credential updates, complex queries for admin
tooling, and a mature ecosystem with strong Go driver support.

We evaluated three options:
- PostgreSQL 15
- MongoDB 6
- MySQL 8

## Decision

We will use PostgreSQL 15 as the primary data store for the user service.

## Consequences

**Positive:**
- ACID transactions ensure credential updates are atomic
- Rich query capabilities simplify admin reporting
- pgx driver is the best-in-class Go PostgreSQL driver
- Strong operational tooling (pgAdmin, pg_dump, pg_restore)
- JSONB columns provide flexibility where schema-less storage is useful

**Negative:**
- Requires schema migrations for structural changes
- Horizontal write scaling requires partitioning or Citus
- Operational complexity higher than a managed NoSQL service

**Neutral:**
- Team already has PostgreSQL operational expertise
- Cloud-managed options (RDS, Cloud SQL, Supabase) reduce operational burden
```

This format is effective because it is small enough that engineers actually write it. The four sections - Status, Context, Decision, Consequences - cover everything necessary.

### MADR Format (Lightweight)

MADR (Markdown Architectural Decision Records) extends Nygard's format with explicit consideration of alternatives. This is valuable for decisions where multiple options were seriously evaluated.

```markdown
# ADR-002: Use gRPC for Internal Service Communication

## Status

Accepted

## Context and Problem Statement

Our microservices need a communication protocol for internal
service-to-service calls. We handle approximately 50,000 RPC
calls per second at peak, with strict latency requirements
(p99 < 10ms). We need strong typing, code generation, and
bidirectional streaming for specific use cases.

## Decision Drivers

* Performance: must handle 50K RPS at p99 < 10ms
* Type safety: schema evolution must be backward compatible
* Code generation: avoid hand-writing client/server boilerplate
* Streaming: order status updates require server-push capability
* Language support: primarily Go, some Python sidecars

## Considered Options

* gRPC with Protocol Buffers
* REST with OpenAPI/Swagger
* GraphQL
* Apache Thrift
* JSON-RPC

## Decision Outcome

Chosen option: **gRPC with Protocol Buffers**, because it provides
the best combination of performance, type safety, and streaming
support for our use case.

### Positive Consequences

* Binary serialization (protobuf) is 3-5x faster than JSON
* Strong schema with backward/forward compatibility rules
* Code generation eliminates client library maintenance
* Native streaming for real-time order updates
* Excellent Go support via `google.golang.org/grpc`

### Negative Consequences

* Less human-readable than JSON REST for debugging
* Browser clients cannot call gRPC directly (requires grpc-web or transcoding)
* Proto schema files require toolchain setup (protoc, buf)
* Learning curve for engineers unfamiliar with protobuf

## Pros and Cons of the Options

### gRPC with Protocol Buffers

* Good, because binary serialization outperforms JSON by 3-5x
* Good, because streaming is a first-class primitive
* Good, because schema evolution rules prevent breaking changes
* Bad, because browser clients need additional proxy layer
* Bad, because proto toolchain adds build complexity

### REST with OpenAPI

* Good, because universally understood and easy to debug
* Good, because excellent browser support
* Good, because vast ecosystem of tooling
* Bad, because JSON serialization overhead at high RPS
* Bad, because streaming requires SSE or WebSockets (separate protocols)
* Bad, because OpenAPI code generation quality is inconsistent

### GraphQL

* Good, because flexible querying reduces over-fetching
* Neutral, because performance acceptable for most use cases
* Bad, because N+1 query problem requires careful DataLoader implementation
* Bad, because overkill for internal RPC calls with known request shapes

## Links

* Superseded by: None
* Related: ADR-003 (REST for external APIs)
* Implementation: `internal/rpc/`
```

### When to Write an ADR

Not every decision warrants an ADR. The cost of writing must be justified by the significance of the decision. Use these criteria:

**Always write an ADR when:**

- The decision affects multiple services or teams
- The decision is hard to reverse (database choice, communication protocol, auth framework)
- The decision involves a significant trade-off between competing values (performance vs. consistency, build vs. buy)
- You are adopting a new technology or pattern for the first time in your organization
- You are explicitly rejecting an approach others might expect you to use
- The decision has non-obvious security, compliance, or regulatory implications

**Consider writing an ADR when:**

- You spend more than two hours evaluating alternatives
- The decision would surprise a reasonable senior engineer on your team
- You want to signal architectural intent for code that looks unusual

**Skip the ADR when:**

- The decision is easily reversible (choice of logging format within a single service)
- The context is obvious (use the standard library for standard library tasks)
- The decision is purely stylistic (variable naming, comment style)

A practical heuristic: if you would spend more than five minutes explaining "why did we do it this way?" in a code review, write an ADR.

### Junior → FAANG: Choosing a Format and Committing to It

The debate between Nygard format and MADR is less important than the discipline of picking one and using it consistently. Inconsistent formats across a codebase make ADRs harder to navigate and signal that the team has not committed to the practice. For a first-time implementation, MADR is the better starting point: it is more structured, which reduces the blank-page problem for engineers writing their first ADR.

The most common mistake when writing a first ADR is writing the context section too briefly. Engineers who know the problem intimately underestimate how much context a reader six months in the future will need. A good test: give the draft ADR to a colleague who was not involved in the decision and ask if they can reconstruct, from the context section alone, why this decision was worth documenting. If they cannot, the context section needs more work.

Format matters less than completeness in the alternatives section. The alternatives section is where the reader learns that you actually considered other options and did not just rationalize a conclusion you had already reached. An ADR with a single alternative is almost as unconvincing as an ADR with no alternatives.

### Senior @ FAANG: Format Standardization as a Platform Decision

At FAANG scale, ADR format is a platform decision, not an individual one. When 50 teams each adopt a slightly different ADR format, the organization loses the ability to build tooling that searches, links, and audits across the corpus. Staff engineers who own the ADR practice need to standardize the format early and provide tooling that makes the standard format the path of least resistance.

The format standardization decision itself should be an ADR. A meta-ADR that documents why your organization chose MADR over Nygard, what tooling supports it, and how deviations should be handled is both a useful artifact and a demonstration of the practice. Engineers who are skeptical of ADRs respond well to seeing the practice applied to itself.

Google's design document format, which predates MADR but covers similar ground, includes an explicit "considered alternatives" section that is treated as a quality gate in design review. Reviewers who see a design doc without alternatives are expected to ask "what else was considered?" before approving. The same social norm applied to ADRs produces the same quality improvement: the existence of the alternatives section creates accountability for having actually done the alternatives analysis.

At the L7 level, format governance extends to the review process. Who reviews an ADR before it is accepted? The answer to that question determines whether the ADR practice is producing accountability or theater. An ADR that can be accepted by its own author, without external review, is a statement of intent rather than a governance artifact. An ADR that requires review by at least one senior engineer outside the authoring team, and by the staff engineer responsible for the affected domain, is a governance artifact with teeth.

---
