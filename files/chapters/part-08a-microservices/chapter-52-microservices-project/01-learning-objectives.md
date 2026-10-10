## Learning Objectives

By the end of this chapter, you will be able to:

- **Design a complete microservices architecture** with proper service boundaries and data ownership
- **Implement synchronous and asynchronous communication** using gRPC and Kafka
- **Build a saga orchestrator** for distributed transactions across services
- **Deploy services with Docker** and orchestrate with docker-compose
- **Implement service discovery** with Consul for dynamic service registration
- **Add observability** with structured logging, metrics, and distributed tracing
- **Apply production patterns** used by Amazon, Shopify, and Stripe for e-commerce

### Junior → FAANG: Mapping Objectives to Interview Readiness

Each objective above maps to a predictable interview topic. Understanding that mapping helps you study with purpose rather than hoping you covered the right material.

**Service boundary design** maps to the system design question "design an e-commerce platform." The answer interviewers are looking for is a bounded-context decomposition with explicit reasoning about data ownership, not a list of microservices. Practice articulating why inventory is separate from order, and what invariants each service must protect.

**Synchronous vs asynchronous communication** maps to the follow-up "how do you handle a failure in the payment service during checkout?" A candidate who only knows synchronous calls answers with retries and circuit breakers. A candidate who also understands events answers with the saga pattern plus an event-driven fallback.

**Saga orchestration** maps to "how do you implement distributed transactions without 2PC?" This is a near-universal FAANG interview question in the distributed systems track. Know both choreography and orchestration, know when each is appropriate, and name at least one failure mode for each.

**Docker Compose and service discovery** map to infrastructure and deployment knowledge. At entry level, being able to explain how a service registers itself and how a client finds it, without hand-waving, signals operational maturity.

**Observability** maps to "how do you debug a slow checkout in production?" The answer requires structured logging with a correlation ID, distributed tracing across service boundaries, and metrics dashboards. Candidates who say "I'd add some logs" without describing trace propagation are not demonstrating production readiness.

For each objective, go one level deeper than the code in this chapter. Know why it was written that way, what breaks if you change it, and what a more production-hardened version would look like.

### Senior @ FAANG: Objectives as Governance Checkpoints

At staff level, learning objectives become the checklist for evaluating whether a team's system is production-ready, not whether an individual can write the code.

**Service decomposition governance.** The right question is not "can we deploy these services independently" but "do we have a process for changing service boundaries when the domain model evolves?" FAANG platform teams maintain a service catalog with ownership, SLOs, and dependency maps. When a new team proposes a new service, the catalog review catches duplication, circular dependencies, and missing ownership before the service is built.

**Communication protocol governance.** Choosing gRPC vs events is not a one-time decision per service pair. It is a policy. A well-governed platform defines: synchronous calls are used only when the caller cannot proceed without a response and the dependency is in the same SLO tier. All other interactions use events. Documenting this policy prevents gradual drift toward a distributed monolith, which is the most common failure mode in teams that started with good service boundaries.

**Saga implementation standards.** A platform team should define a standard saga implementation: which library or framework (hand-written, Conductor, Temporal), how sagas are monitored (saga state exposed as a Prometheus gauge, dead sagas alerted within N minutes), and what the rollback SLA is. Without this standard, each team invents its own saga, creating an unmanageable diversity of failure modes.

**Observability as a platform feature, not a per-service concern.** The learning objective "add observability" should translate to: observability is injected by the platform at the infrastructure layer (service mesh, sidecar) and applications opt in to semantic conventions (span naming, cardinality limits on labels). Teams that build observability from scratch in each service create inconsistent dashboards, different cardinality budgets, and missing cross-service correlation. The bar-raiser signal is proposing a platform observability library with a structured review process for adding new metric names.

**Kubernetes as the graduation target.** Docker Compose is the right learning tool. The governance question is: what is the migration path to Kubernetes, and what changes when you get there? Specifically: service discovery moves from Consul to `Service` + DNS, secrets move from environment variables to Vault or cloud KMS, resource limits become `requests` and `limits` on pods, and health checks become liveness and readiness probes. A staff engineer reviewing this system design asks about that migration path on day one.

---
