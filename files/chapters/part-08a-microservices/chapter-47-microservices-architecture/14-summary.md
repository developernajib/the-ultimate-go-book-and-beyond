## Summary

Microservices architecture decomposes a system along business capability boundaries so that each service can be deployed, scaled, and owned independently. The value is reduced coupling, not smaller code, and the cost is distributed systems complexity that must be managed deliberately.

Key takeaways from this chapter:

1. **Service Design**: Use DDD bounded contexts to identify cohesive service boundaries. Model the same real-world concept differently in each context (User vs CustomerRef) to prevent cross-service coupling.
2. **Communication**: Choose synchronous calls (REST/gRPC) for queries that need immediate responses. Use asynchronous events for workflows, fan-out, and operations where eventual consistency is acceptable.
3. **Discovery**: Register services with Consul and use blocking queries for change notification. Client-side load balancing eliminates an extra network hop compared to server-side discovery.
4. **API Gateway**: Centralize authentication, rate limiting, and routing at the edge. Keep the gateway thin, push service-specific logic to sidecars or the services themselves.
5. **Configuration**: Store configuration in a distributed key-value store with local caching and watcher callbacks for dynamic updates without redeployment.
6. **Resilience**: Wrap every inter-service call with context deadlines and circuit breakers. Use the saga pattern with compensating transactions for multi-service workflows.
7. **Observability**: Instrument with Prometheus metrics, structured `slog` logging with correlation IDs, and OpenTelemetry distributed traces. Use adaptive sampling to control cost.

The next chapter covers service mesh and sidecar patterns, which move many of these cross-cutting concerns (mTLS, traffic management, observability) out of application code and into infrastructure.

### Junior → FAANG: Chapter Summary as Interview Checklist

The seven takeaways in this summary map directly to the topics tested in FAANG system design and behavioral interviews. Use this list as a self-assessment checklist before an interview.

Service design: can you explain what a bounded context is and give a concrete example with two contexts modeling the same real-world entity differently? If not, re-read the DDD section.

Communication: can you explain in one sentence when you would use gRPC vs Kafka? If not: gRPC for synchronous user-facing queries and tight two-service fan-outs, Kafka for cross-service workflows, fan-out to multiple consumers, and operations where eventual consistency is acceptable.

Discovery: on Kubernetes, what is the one-sentence answer? Kubernetes Services provide a DNS name, kube-proxy routes to healthy pods, readiness probes control pod inclusion. No registry code needed.

API gateway: what is the one thing the gateway must not do? Business logic. What is the one thing every production gateway must have? At minimum: authentication, rate limiting, and routing. TLS termination is handled at the gateway in most architectures.

Configuration: what is the three-layer model? Environment variables for startup, ConfigMaps/Consul for non-sensitive runtime config, secrets manager for credentials.

Resilience: what are the two patterns for multi-service workflows? Circuit breaker for per-call resilience. Saga with compensating transactions for multi-step workflow resilience.

Observability: what is RED? Rate, Errors, Duration. What is the 2026 standard instrumentation SDK? OpenTelemetry. What is the recommended sampling strategy for production? Adaptive: 100% for errors and slow requests, 1 to 5% for normal traffic.

### Senior @ FAANG: Chapter as a Governance Framework for Microservices Organizations

The seven takeaways in this summary are not just individual design decisions. At staff level, each one is a domain that requires organizational governance, tooling, and ongoing operational discipline.

**Service design governance.** The organization needs an architecture review board (formal or lightweight) with a published decision framework for service decomposition. The framework specifies which forcing functions justify extraction, what the review process looks like, and where the decision is recorded (ADR in the service repository or a central architecture decision log). Without this, decomposition decisions are made ad-hoc and the organization accumulates architectural debt that is invisible until the next major incident.

**Communication governance.** The organization needs a published communication policy: which protocols are approved for internal service-to-service calls, which message brokers are the standard, what the schema evolution rules are, and which library versions are pinned. Deviations from the policy require a documented exception. The platform team enforces the policy through service template defaults and CI gates, not through social pressure.

**Discovery governance.** The organization needs a service registry SLO (Consul or Kubernetes API server availability), a documented procedure for what happens during a registry outage (stale cache behavior, fail-open vs fail-closed policy), and a chaos engineering scenario that tests the discovery stampede recovery path.

**API gateway governance.** The organization needs a published gateway SLO, a capacity plan that specifies when to scale horizontally, a runbook for gateway incidents that includes the traffic bypass procedure, and a security review process for new routes (who approves the auth requirement for a new endpoint? who verifies that rate limiting is correctly configured?).

**Configuration governance.** The organization needs a secrets rotation policy (max credential lifetime, rotation automation), a config change review process (GitOps PR with mandatory review), a validation framework (type-checked config structs with startup-time validation), and a security audit of any config key that has ever contained a plaintext credential.

**Resilience governance.** The organization needs a mandatory circuit breaker policy (every external call has one), a game day schedule (quarterly chaos engineering for critical paths), a saga testing framework (inject failure at each step, verify compensation executes correctly), and a post-mortem process for resilience failures that feeds back into the platform defaults.

**Observability governance.** The organization needs an SLO for every production service (derived from user journey requirements), an error budget process (what happens when the error budget is exhausted: freeze new features, focus on reliability), an observability cost budget (monitoring spend as a percentage of infra cost), and a quarterly review of trace sampling rates and log cardinality to prevent the observability data explosion pitfall. At L6/L7, you are the person who builds and maintains this governance framework, not just the person who follows it.

---
