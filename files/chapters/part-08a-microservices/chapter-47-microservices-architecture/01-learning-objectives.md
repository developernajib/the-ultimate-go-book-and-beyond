## Learning Objectives

By the end of this chapter, you will be able to:

- **Design microservices** using Domain-Driven Design bounded contexts and clear service boundaries
- **Implement service communication** patterns including synchronous (REST/gRPC) and asynchronous (events)
- **Build service discovery** with Consul integration and client-side load balancing
- **Create API gateways** that route, authenticate, and rate-limit traffic to backend services
- **Manage distributed configuration** with dynamic updates and change notifications
- **Apply patterns from Netflix, Uber, and Amazon** for building production-grade microservices
- **Avoid common pitfalls** like distributed monoliths, shared databases, and chatty interfaces

### Junior → FAANG: Mapping Objectives to Interview Topics

Learning objectives in a chapter are not just a checklist. At entry level, the skill is knowing which objective is tested in which interview format.

Service boundaries and DDD bounded contexts appear in system design rounds. If you are asked to design an e-commerce system, the interviewer expects you to name bounded contexts (Catalog, Order, Payment, Shipping), explain why each is independent, and describe what data each owns. Saying "I'd split it into microservices" without a DDD rationale signals that you are cargo-culting the pattern.

Service communication (sync vs async) appears in both system design and coding rounds. In system design you explain when to use gRPC vs Kafka. In a coding round you may be asked to implement a circuit breaker or an idempotent Kafka consumer.

Service discovery, API gateways, and configuration management are infrastructure-level objectives that appear more often at L5+ interviews. At L3/L4 you are expected to know they exist and roughly how they work. At L5+ you are expected to have operated them and to have opinions on tradeoffs.

Practical preparation: for each objective in this list, write one paragraph explaining the tradeoff involved. Service discovery: client-side vs server-side. Communication: sync vs async. API gateway: thin vs thick. If you cannot write the tradeoff paragraph without looking it up, you have not yet mastered the objective.

### Senior @ FAANG: Maturity Model Thinking Across the Objectives

Senior engineers use learning objectives as a maturity model, not just a competency checklist. The question is not "do we do this?" but "how well do we do this, and what is the gap between our current state and production-grade?"

**Service design maturity.** Level 1: services exist and roughly align to business capabilities. Level 2: each service has a published interface contract (proto or OpenAPI) versioned independently. Level 3: context maps are documented and reviewed at architecture board. Level 4: event storming sessions are run before any new service is proposed, and context boundaries are explicit in the ADR.

**Communication maturity.** Level 1: services call each other synchronously. Level 2: async events exist for some workflows. Level 3: the transactional outbox is implemented on all event-publishing paths. Level 4: schema registry enforces compatibility, consumers are hardened for at-least-once delivery, and dead-letter queues are monitored with runbooks.

**Observability maturity.** Level 1: logs exist. Level 2: Prometheus metrics with RED method, structured logs with correlation IDs. Level 3: distributed traces with OTel, sampled intelligently, correlated with logs and metrics in a single backend. Level 4: SLOs defined per service, error budgets tracked, burn-rate alerts, and quarterly SLO review meetings with the product team.

**Resilience maturity.** Level 1: circuit breakers exist in some clients. Level 2: every inter-service call has a timeout and a circuit breaker. Level 3: chaos engineering (Chaos Monkey, Gremlin, or a custom failure injection framework) runs weekly in staging. Level 4: game days simulate regional failover and multi-service outages on a quarterly cadence, with blameless post-mortems and improvement tracking.

The staff-level contribution is moving the organization from one maturity level to the next, not implementing features inside an individual service. When preparing for an L6/L7 interview, the candidate should be able to map their current employer's microservices practice to this maturity model and articulate specifically what they drove to close a gap.

---
