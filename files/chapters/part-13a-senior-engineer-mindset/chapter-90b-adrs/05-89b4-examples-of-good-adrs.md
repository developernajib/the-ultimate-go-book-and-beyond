## 90B.4 Examples of Good ADRs

Reading well-written ADRs is the fastest way to understand what good looks like. Each example below is a complete, standalone ADR that you could drop into a real project with minimal changes. Pay close attention to how the context section provides enough detail for a future engineer to understand the constraints, how alternatives are evaluated honestly rather than dismissed, and how consequences include genuine negatives alongside the positives. These are the qualities that separate an ADR that is useful three years later from one that is ignored after a week.

The following are five complete, production-quality ADR examples covering common decisions in Go microservices architectures.

### Example 1: Choose PostgreSQL over MongoDB for User Service

````markdown
# ADR-001: Use PostgreSQL for User Service Data Store

Date: 2024-01-10
Author: @sarah-chen
Status: Accepted

## Context

The user service requires persistent storage for:
- User profile data (name, email, preferences): ~2KB/user
- Authentication credentials (hashed passwords, OAuth tokens): ~500B/user
- Session metadata: ~200B/session, up to 10 sessions/user
- Role and permission assignments: ~100B/user

Expected scale: 5M users at launch, growing to 50M users within 3 years.
Write load: approximately 500 writes/second at peak (password changes,
profile updates, session creation/expiry).
Read load: approximately 5,000 reads/second at peak (authentication checks,
profile fetches).

The engineering team evaluated three options:
1. PostgreSQL 15 (relational, ACID, SQL)
2. MongoDB 6.0 (document store, eventual consistency options, BSON)
3. DynamoDB (managed NoSQL, AWS-native, key-value + document)

### Evaluation Criteria

| Criterion                    | Weight |
|------------------------------|--------|
| ACID transaction support     | High   |
| Query flexibility            | High   |
| Operational maturity         | Medium |
| Go driver quality            | Medium |
| Horizontal write scaling     | Low    |
| Team existing expertise      | Medium |

### Evaluation Matrix

| Criterion              | PostgreSQL | MongoDB | DynamoDB |
|------------------------|------------|---------|----------|
| ACID transactions      | ✅ Full     | ⚠️ Multi-doc only | ⚠️ Limited |
| Query flexibility      | ✅ Full SQL  | ✅ Rich query | ❌ Key/index only |
| Operational maturity   | ✅ 30+ years | ✅ Mature | ✅ Managed |
| Go driver quality      | ✅ pgx v5   | ⚠️ Official driver | ⚠️ AWS SDK |
| Write scaling          | ⚠️ Vertical/partition | ✅ Native sharding | ✅ Auto-scaling |
| Team expertise         | ✅ 4/5 engineers | ⚠️ 2/5 engineers | ❌ 1/5 engineers |

## Decision

We will use PostgreSQL 15 as the data store for the user service, deployed
on AWS RDS with Multi-AZ for high availability.

The primary driver is ACID transaction support. Authentication credential
updates must be atomic - a partial update to credentials is a security
vulnerability. PostgreSQL's transaction model provides this guarantee
without application-level complexity.

The secondary driver is query flexibility. Admin tooling requires complex
joins and aggregations (e.g., "find all users who have not logged in for
90 days but have active paid subscriptions"). These queries are
straightforward SQL but require complex aggregation pipelines in MongoDB.

The horizontal write scaling limitation of PostgreSQL is not a concern
at our current and projected scale. 500 writes/second is well within
the capacity of a single PostgreSQL primary (benchmarks: 50,000+
writes/second on c5.4xlarge). We will revisit if we exceed 10,000
writes/second.

## Consequences

### Positive

- ACID transactions ensure credential updates are atomic and consistent
- Full SQL support simplifies reporting and admin queries
- `pgx/v5` is the highest-quality Go PostgreSQL driver available, with
  native support for pgx types, batch queries, and COPY protocol
- AWS RDS Multi-AZ provides automatic failover with < 60s RTO
- Team has deep PostgreSQL expertise - no learning curve
- JSONB columns provide document-store flexibility for user preferences
  without schema migrations
- pg_partman extension enables partition-based archival of old sessions

### Negative

- Schema migrations required for structural changes (mitigated by golang-migrate)
- Horizontal write scaling requires application-level sharding or Citus
  extension if we exceed 10K writes/second
- RDS Multi-AZ doubles the cost of the database tier vs. single-instance

### Neutral

- PostgreSQL is the team's default database choice - this decision
  codifies existing practice for new engineers
- Managed RDS reduces operational overhead vs. self-managed PostgreSQL

## Links

- Rejected: MongoDB - insufficient ACID guarantees for credential storage
- Rejected: DynamoDB - limited query flexibility, team unfamiliar
- Related: ADR-005 (Redis for session caching layer)
- Related: ADR-008 (Database migration tooling: golang-migrate)
- Implementation: `internal/store/postgres/`
````

### Example 2: Use gRPC for Internal Services, REST for External

````markdown
# ADR-002: gRPC for Internal Communication, REST for External APIs

Date: 2024-01-18
Author: @marcus-okonkwo
Status: Accepted

## Context

Our platform consists of 12 microservices. These services communicate
both with each other (internal) and with external consumers including
our web application, mobile apps, and third-party partners.

Internal communication characteristics:
- Caller and callee are both services we own
- Both sides can be updated simultaneously
- Performance-sensitive: order processing path involves 8 service hops
- Some use cases require streaming (order status updates, inventory feeds)
- Volume: ~200K internal RPC calls/second at peak

External communication characteristics:
- Callers include browsers, iOS/Android apps, third-party integrations
- We cannot control client update cycles
- Must be debuggable by partners without specialized tooling
- Stable contract required - breaking changes are customer-impacting
- Volume: ~15K external API calls/second at peak

We evaluated:
1. gRPC/Protobuf for all communication
2. REST/JSON for all communication
3. gRPC internal + REST external (hybrid)
4. GraphQL for external + gRPC internal

## Decision

We will use:
- **gRPC with Protocol Buffers** for all internal service-to-service
  communication
- **REST with JSON** for all external-facing APIs (web, mobile, partners)

A transcoding layer (grpc-gateway or Envoy transcoding) will expose
selected internal gRPC services as REST endpoints where the BFF
(Backend for Frontend) pattern is not sufficient.

## Consequences

### Positive (gRPC internal)

- Protobuf binary serialization reduces CPU overhead by ~40% vs JSON
  (measured via benchmarking: 180ns/op vs 320ns/op for typical payloads)
- Schema evolution rules (field addition is backward compatible,
  field removal is forward compatible) prevent accidental breaking changes
- Code generation via `buf generate` eliminates hand-written client code
- Native streaming for order status push notifications
- gRPC interceptors provide uniform request logging, tracing, and auth

### Positive (REST external)

- Universal client compatibility - no special tooling required
- Human-readable for debugging and partner integration
- OpenAPI 3.0 spec provides machine-readable contract for SDK generation
- Mature ecosystem for rate limiting, API gateways, and caching

### Negative

- Two protocols increases cognitive overhead for engineers who work
  across the boundary
- grpc-gateway transcoding adds latency (~50μs per request) for
  services that need both protocols
- Proto toolchain (buf, protoc-gen-go, protoc-gen-go-grpc) must be
  installed and kept in sync across all developer machines
- gRPC error codes (codes.NotFound, codes.InvalidArgument) must be
  mapped to HTTP status codes carefully at the transcoding layer

### Neutral

- All new internal services must include a `.proto` file as part of
  their service definition
- External API versioning (v1, v2) continues under existing REST conventions
- Proto files are stored in the `proto/` monorepo with buf.yaml config

## Links

- Related: ADR-001 (PostgreSQL for user service)
- Related: ADR-010 (API versioning strategy)
- Rejected: GraphQL external - overkill for our use case, no mobile
  framework preference
- Implementation proto files: `proto/`
- Implementation gRPC server: `internal/rpc/`
- Implementation REST gateway: `internal/gateway/`
````

### Example 3: Adopt Structured Logging with zerolog

````markdown
# ADR-003: Adopt zerolog for Structured Logging

Date: 2024-02-05
Author: @priya-kapoor
Status: Accepted

## Context

Our services currently use a mix of:
- `log` (standard library): 3 services
- `logrus`: 5 services
- `zap`: 4 services
- Custom fmt.Printf-based logging: 2 services

This inconsistency creates operational problems:
1. Log aggregation (Datadog) cannot apply consistent parsing rules
2. Log fields are inconsistently named (e.g., "user_id", "userID", "userId")
3. Performance varies - logrus is ~10x slower than zap in benchmarks
4. No correlation ID support in 8 of 14 services
5. New engineers must learn multiple logging APIs

We need to standardize on a single structured logging library.

### Benchmark Results (our environment)

```
BenchmarkLog/logrus-json      1000000    1256 ns/op    856 B/op
BenchmarkLog/zap-json          5000000     234 ns/op    128 B/op
BenchmarkLog/zerolog-json     10000000     118 ns/op      0 B/op
BenchmarkLog/slog-json         3000000     387 ns/op    192 B/op
```

### Evaluated Options

1. **zerolog** - zero-allocation JSON logging, chained API
2. **zap** - high-performance, explicit sugar API
3. **slog** (Go standard library since 1.21) - structured logging in stdlib
4. **logrus** - current partial standard, feature-rich but slow

## Decision

We will standardize on **zerolog** for structured logging across all
Go services.

Rationale: zerolog's zero-allocation design achieves the lowest latency
and memory overhead in our benchmarks. In high-throughput services
(order processing, inventory service) logging represents up to 3% of
CPU time - zerolog's performance advantage is material.

The chained API is idiomatic Go and produces consistent field naming
when used through our `internal/log` wrapper package.

We will **not** use `slog` despite it being in the standard library
because: (1) its performance is worse than zerolog in our benchmarks,
(2) we want zerolog's zero-allocation guarantee, (3) zerolog's chained
API produces more consistent field naming across our codebase.

We will migrate existing services over Q2 2024. Migration order:
custom fmt.Printf services first (highest impact), then logrus services,
then zap services (lowest priority - functional but non-standard).

### Standardized Field Names

To enforce consistent field naming, we create `internal/log/fields.go`:

```go
package log

// Standard field names used across all services.
// Always use these constants rather than string literals.
const (
    FieldRequestID  = "request_id"
    FieldUserID     = "user_id"
    FieldServiceName = "service"
    FieldTraceID    = "trace_id"
    FieldSpanID     = "span_id"
    FieldDuration   = "duration_ms"
    FieldError      = "error"
    FieldHTTPMethod = "http_method"
    FieldHTTPPath   = "http_path"
    FieldHTTPStatus = "http_status"
    FieldGRPCMethod = "grpc_method"
    FieldGRPCCode   = "grpc_code"
)
```

#### Consequences

### Positive

- Uniform log format enables consistent Datadog parsing rules
- Zero-allocation logging reduces GC pressure in hot paths
- Mandatory correlation IDs (enforced by our wrapper) enable
  distributed request tracing
- Single logging API reduces cognitive overhead for engineers
- Standard field names enable cross-service log correlation in Datadog

### Negative

- Migration effort for 14 services (estimated 2-4 hours each)
- zerolog's chained API is unfamiliar to engineers who know logrus
- Zero-allocation guarantee requires discipline - common mistakes
  (appending to log events after Send()) break the guarantee

### Neutral

- We create `internal/log` wrapper to enforce field naming and
  add context propagation - direct zerolog usage is discouraged

#### Migration Guide

For each service:

```go
// Before (logrus)
logrus.WithField("user_id", userID).Info("user logged in")

// After (zerolog via internal/log)
log.Info(ctx).
    Str(log.FieldUserID, userID).
    Msg("user logged in")
```

#### Links

- Implementation: `internal/log/`
- Related: ADR-006 (Distributed tracing with OpenTelemetry)
- Related: ADR-011 (Log aggregation: Datadog)
- Rejected: slog - Go version compatibility, performance
- Rejected: zap - good choice, but zerolog is faster - migration
  cost same either way
````

### Example 4: Use Event Sourcing for Order Service

````markdown
# ADR-004: Use Event Sourcing for Order Service

Date: 2024-03-12
Author: @daniel-ferreira
Status: Accepted

## Context

The order service manages the lifecycle of customer orders: created →
paid → fulfilling → fulfilled → returned/canceled. Orders have these
characteristics:

1. **Audit requirement**: Regulations require complete audit trail of
   all order state changes with timestamps and causality
2. **Dispute resolution**: ~0.3% of orders result in customer disputes
   requiring full reconstruction of order history
3. **Integration complexity**: 6 downstream systems subscribe to order
   events (inventory, shipping, notifications, analytics, finance, fraud)
4. **Compensation transactions**: Order cancellations require compensating
   actions in payment, inventory, and shipping services
5. **Temporal queries**: Business intelligence requires "what did this
   order look like at 14:32 on March 5th?"

We evaluated:
1. Traditional CRUD with audit log table (append-only audit_events table)
2. Event Sourcing with EventStoreDB
3. Event Sourcing with PostgreSQL as event store
4. CQRS without event sourcing (separate read/write models, no event log)

## Decision

We will implement event sourcing for the order service using
**PostgreSQL as the event store**.

We choose PostgreSQL over a dedicated event store (EventStoreDB) because:
- We already operate PostgreSQL and have runbook expertise
- Our event volume (500 order events/second peak) is within PostgreSQL's
  comfortable capacity
- PostgreSQL's LISTEN/NOTIFY provides sufficient pub/sub for our downstream
  consumers at current scale
- We can migrate to EventStoreDB if we exceed 50,000 events/second

The core data model:

```sql
CREATE TABLE order_events (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id    UUID NOT NULL,
    event_type  TEXT NOT NULL,
    event_data  JSONB NOT NULL,
    metadata    JSONB NOT NULL DEFAULT '{}',
    version     INTEGER NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT order_events_version_unique
        UNIQUE (order_id, version)
);

CREATE INDEX idx_order_events_order_id
    ON order_events (order_id, version);
CREATE INDEX idx_order_events_occurred_at
    ON order_events (occurred_at);
CREATE INDEX idx_order_events_event_type
    ON order_events (event_type);
```

Event types:
- `OrderCreated`
- `OrderPaymentReceived`
- `OrderPaymentFailed`
- `OrderFulfillmentStarted`
- `OrderFulfilled`
- `OrderCancellationRequested`
- `OrderCanceled`
- `OrderReturnInitiated`
- `OrderReturned`

#### Consequences

### Positive

- Complete audit trail: every state change is stored immutably with
  timestamp, actor, and causality
- Temporal queries: reconstruct order state at any point in time by
  replaying events up to that timestamp
- Compensation transactions: event log provides the exact sequence
  of actions to compensate for cancellations
- Downstream integration: new downstream consumers can subscribe to
  events without changing the order service
- Debugging: reproduce any order bug by replaying events in a test
  environment with the same event sequence

### Negative

- **Complexity**: event sourcing is significantly more complex than
  CRUD - engineers must understand aggregate roots, event replay,
  and snapshot patterns
- **Query complexity**: "find all orders over $500 placed by users
  in California" requires a separate read model (CQRS projection)
- **Schema evolution**: changing event schemas requires versioning
  and upcasting strategies
- **Onboarding**: estimated 1-2 weeks for engineers new to event
  sourcing to become productive

### Neutral

- A read model (order_projections table) is maintained by an event
  processor for query use cases
- Snapshots will be taken every 50 events to bound replay time
- The order service is the only service using event sourcing  - 
  we do not mandate this pattern broadly

#### Links

- Related: ADR-002 (gRPC for internal communication - order events
  published via gRPC streaming)
- Related: ADR-007 (Outbox pattern for reliable event publishing)
- Rejected: CRUD + audit log - insufficient for temporal queries
  and compensation transaction reconstruction
- Implementation: `services/order/`
````

### Example 5: Choose Kubernetes over Bare VMs

````markdown
# ADR-005: Use Kubernetes for Container Orchestration

Date: 2024-01-05
Author: @alex-morrison
Status: Accepted

## Context

We are moving from a monolithic Rails application to a Go
microservices architecture. We need an infrastructure platform
to host 14+ services, each with different scaling characteristics:

- Order service: CPU-bound, scales with transaction volume
- Notification service: I/O-bound, requires burst capacity
- ML inference service: GPU-required, expensive to scale
- Admin service: low traffic, waste if always running

Current state: 8 EC2 instances (c5.2xlarge) running the monolith
via Docker Compose.

We evaluated:
1. **Bare EC2 VMs**: each service on dedicated or shared VMs
2. **AWS ECS**: managed container orchestration, AWS-native
3. **Kubernetes (EKS)**: industry-standard orchestration
4. **AWS Lambda**: serverless, per-invocation billing

Scale targets:
- 14 services at launch, growing to 40+ within 2 years
- SLA: 99.9% availability per service
- Deploy cadence target: 10+ deployments per day across all services
- On-call: 2 engineers, cannot manage high operational complexity

## Decision

We will use **Kubernetes on AWS EKS** for container orchestration.

We rule out bare VMs because per-service VM management at 14+
services creates unsustainable operational overhead. We rule out
Lambda because our services have stateful connections and p99
latency requirements incompatible with cold starts.

ECS vs EKS: EKS wins on portability (avoid AWS lock-in),
ecosystem (Helm charts, operators, CNCF tooling), and talent
pipeline (Kubernetes is the industry standard - easier to hire).

We choose EKS (managed Kubernetes) over self-managed Kubernetes
on EC2 to reduce control plane operational burden.

## Consequences

### Positive

- Declarative deployments: service definitions as code in `k8s/`
- Automatic bin-packing reduces infrastructure cost by ~35%
  vs. one-service-per-VM approach
- Horizontal pod autoscaling handles traffic bursts without
  manual intervention
- Rolling deployments with health checks enable zero-downtime
  deployments at target deploy cadence
- Kubernetes-native service discovery eliminates need for
  separate service registry
- Rich ecosystem: Helm for packaging, ArgoCD for GitOps,
  Prometheus + Grafana for observability
- Portability: applications run the same in local (kind),
  staging (EKS), and production (EKS)

### Negative

- **Steep learning curve**: Kubernetes concepts (pods, deployments,
  services, ingress, RBAC) require 2-4 weeks to become productive
- **Operational complexity**: EKS simplifies control plane but
  engineers still manage worker nodes, networking, and storage
- **Minimum viable cluster cost**: ~$500/month for a minimal
  production EKS cluster before workload costs
- **Debugging**: distributed systems failures are harder to diagnose
  than single-VM failures

### Neutral

- We will use Fargate for burst capacity (notification service)
  to avoid over-provisioning worker nodes
- Infrastructure-as-code for EKS cluster: Terraform in `infra/`
- GitOps deployment: ArgoCD (ADR-012)
- All Go services must expose `/healthz` (liveness) and
  `/readyz` (readiness) endpoints for Kubernetes probes

## Links

- Related: ADR-012 (GitOps with ArgoCD)
- Related: ADR-013 (Service mesh: Linkerd)
- Rejected: AWS ECS - portability concern, smaller ecosystem
- Rejected: Bare VMs - operational overhead at scale
- Implementation: `k8s/`, `infra/`
````

### Junior → FAANG: Reading Good ADRs to Build Judgment

The examples in this section teach by demonstration what good ADR writing looks like. Before you write your first ADR, read all of them carefully and notice the patterns: the context sections set up the problem without editorializing, the consequences sections are honest about negative outcomes, and the alternatives sections demonstrate that real options were considered and evaluated against specific criteria.

The most common quality gap in first-time ADRs is in the consequences section. Engineers are trained to present solutions as purely positive, because proposing something with acknowledged downsides can feel like handing critics ammunition. In an ADR, acknowledged downsides are a quality signal, not a weakness. A decision document that claims no negative consequences is not credible. Every non-trivial decision accepts some cost in exchange for some benefit. The consequences section is where you show that you understand what you are accepting.

### Senior @ FAANG: Using Examples to Establish Organizational Standards

A library of high-quality ADR examples is the most effective onboarding tool for the practice. When a new engineer is told "write an ADR," they need a reference for what "good" looks like in your specific organizational context. A collection of five to ten examples covering different decision types (infrastructure, API design, data storage, security, tooling) gives them a diverse reference set without overly constraining the format.

At FAANG, the quality of an ADR library reflects the quality of the organization's decision-making culture. Organizations with rich, well-maintained ADR libraries tend to have lower incident rates from the class of failures caused by "we didn't know we were reversing a past decision." They also tend to onboard new staff engineers faster, because the ADR library gives new hires access to the organizational reasoning that took existing engineers years to accumulate.

Staff engineers who want to improve their org's ADR quality should use the examples in this section as a rubric for reviewing existing ADRs. For each ADR in the corpus, ask: does the context section give a reader with no prior knowledge enough information to understand why this decision was consequential? Does the alternatives section list at least two genuine alternatives, not strawmen? Does the consequences section name at least one negative consequence honestly? ADRs that fail these tests should be flagged for revision in the next architecture review cycle.

---
