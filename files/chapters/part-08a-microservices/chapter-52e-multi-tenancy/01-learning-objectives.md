## Learning Objectives

By the end of this chapter, you will be able to:

- Explain the spectrum of multi-tenancy models and choose the right isolation level for a given business requirement
- Implement all three primary data isolation patterns in Go with PostgreSQL
- Build tenant context propagation through HTTP middleware, service layers, and database queries
- Design and implement subdomain, path, and header-based tenant routing
- Build a Redis-backed per-tenant rate limiting system with configurable tiers
- Implement per-tenant feature flags and configuration with caching
- Execute tenant provisioning, data export, and GDPR-compliant deletion
- Instrument a multi-tenant system with tenant-aware logging, tracing, and metrics
- Apply PostgreSQL Row-Level Security for automatic tenant isolation
- Design for horizontal scale using tenant-aware sharding

### Junior → FAANG: Mapping Objectives to Interview Questions

Learning objectives are a roadmap for the interview loop. Each bullet above maps to at least one common question at FAANG and high-growth SaaS companies. Before leaving this chapter, you should be able to answer each of these without notes:

- "Explain the three isolation models and when you'd pick each." This is the opening question in almost every system design interview that touches SaaS.
- "How does tenant context flow from an HTTP request to a database query in Go?" This tests whether you understand context propagation or just know the API.
- "What happens if you forget the `tenant_id` filter in one query?" This tests whether you know about RLS as a defense-in-depth layer.
- "How would you rate-limit tenants on different plans without a separate Redis key per request?" This tests algorithmic thinking about the token bucket and sliding window trade-offs.

First-job habits aligned to these objectives:

- When joining a team that already has a multi-tenant system, your first PR should be a cross-tenant isolation test for any repository method that lacks one. It is the highest-value security contribution a new engineer can make.
- Never add a new endpoint that skips the tenant middleware, even for health checks. Establish the habit of explicit opt-out, not implicit opt-in.
- Read the PostgreSQL docs for Row-Level Security before your first week ends. Understanding `SET LOCAL` versus `SET` on pooled connections is the kind of operational detail that prevents production incidents.

### Senior @ FAANG: Evaluating Learning Outcomes Against Production Readiness

At senior and staff level, learning objectives are evaluated not by whether you can describe the pattern, but by whether you can identify the failure modes, the operational costs, and the governance gaps in a running system.

For each objective in this chapter, the senior-track question is not "can you implement it" but "what breaks at scale and what would you change":

**Isolation model selection:** Can you run an enterprise deal that requires HIPAA compliance on the same codebase as your free tier, without a separate deployment? The answer requires the bridge model, a `TenantDatabaseRouter` with lazy pool initialization, and a migration pipeline that covers silo databases. Most teams discover this need after signing the enterprise deal, not before. The senior-track learning is to design for it before the contract is on the table.

**Context propagation:** Can you propagate tenant context to a Kafka consumer, a gRPC stream, a WebSocket connection, and a background cron job, all without losing the tenant identity or leaking it across boundaries? Each of these has a different answer, and each failure mode is distinct. Goroutine-leaked contexts, message-header-embedded tenant IDs, and database-row-embedded tenant context for async jobs are three separate patterns, all required in a complete system.

**Observability:** Can you answer "what was the p99 latency for tenant X on endpoint Y yesterday at 14:00 UTC" without a multi-hour data archaeology project? If not, your observability design does not meet the bar. The senior-level objective is a queryable time-series store (ClickHouse or TimescaleDB) with per-tenant granularity, not just per-plan granularity.

**Scaling:** Can you move a single large tenant from the shared pool to a dedicated shard with zero downtime and a tested rollback path? This requires the dual-write migration pattern, schema versioning across isolation tiers, and a verification step before cutover. The learning objective here is not the implementation, it is the runbook: the sequence of steps, the invariants that must hold at each step, and the rollback trigger conditions.

**Bar-raiser framing:** A bar-raiser does not ask whether you completed these objectives. They ask whether you can teach them to a team, identify where the team's current implementation falls short, and propose the changes with enough specificity that a senior engineer could implement them without follow-up questions. That is the difference between a mid-level and a senior at this level.

---
