# Chapter 52E: Multi-Tenancy Patterns at Scale

*Multi-tenancy is not a feature you add. It is an architectural decision you make on day one, and it affects every layer of your stack.*

Every SaaS product confronts the same architectural question: should each customer get their own isolated deployment, or should all customers share a single system with logical separation? One deployment per customer is operationally expensive at scale. A thousand customers means a thousand databases to migrate, a thousand Kubernetes namespaces to monitor, and a thousand times the infrastructure cost. Fully shared infrastructure with only row-level separation introduces data isolation risks and compliance challenges that enterprise customers will not accept. The practical answer is almost never at either extreme. It is a deliberate choice somewhere on the spectrum between them, made with full knowledge of the engineering, cost, and compliance trade-offs at each point.

Multi-tenancy is not a feature added after the fact. The tenant context must permeate every layer: the HTTP routing that identifies which tenant is making the request, the authentication middleware that scopes tokens to a tenant, the database queries that filter or route to tenant-specific storage, the rate limiter that enforces per-tenant quotas, and the observability stack that dimensions every metric by tenant. An architecture that treats tenancy as an afterthought - a single `tenant_id` column bolted on late in development - will leak tenant data, break under cross-tenant load spikes, and resist the compliance controls that enterprise deals require.

This chapter covers multi-tenancy in Go with PostgreSQL: the three data isolation models (shared table, schema-per-tenant, database-per-tenant), tenant context propagation through middleware and service layers, subdomain and header-based routing, Redis-backed per-tenant rate limiting, PostgreSQL Row-Level Security for automatic query filtering, and operational patterns for tenant provisioning, data export, and GDPR-compliant deletion.

**What you'll learn in this chapter:**
- The multi-tenancy isolation spectrum from shared-table row-level separation to fully dedicated deployments, with trade-off analysis for each
- Implementing shared-table, schema-per-tenant, and database-per-tenant isolation models in Go with PostgreSQL
- Building HTTP middleware that extracts tenant identity from subdomains, path prefixes, or request headers and propagates it via context
- Applying PostgreSQL Row-Level Security policies for automatic, application-transparent tenant data isolation
- Designing and implementing Redis-backed per-tenant rate limiting with configurable tiers and burst allowances
- Building per-tenant feature flags and configuration with in-memory caching and invalidation
- Implementing tenant provisioning, quota enforcement, data export, and GDPR-compliant deletion workflows
- Instrumenting a multi-tenant system with tenant-aware structured logging, distributed tracing, and per-tenant metrics

**Why this matters at scale:**
Salesforce serves over 150,000 business customers from a shared multi-tenant infrastructure, maintaining cost efficiency that would be impossible with per-customer deployments. Cloudflare's Workers platform uses tenant-aware isolation to run millions of customer functions on shared infrastructure with strict security and performance boundaries enforced at the runtime level.

**Prerequisites:** Chapter 47 (Microservices Architecture), Chapter 51 (API Gateway), Chapter 39 (Authentication), familiarity with PostgreSQL

### Junior → FAANG: Why Multi-Tenancy Is a Day-One Decision

Most engineers first encounter multi-tenancy when tasked with "add a tenant_id column." That moment of friction is the signal that the design was never tenant-aware from the start. FAANG interviews expose this gap quickly.

The prerequisite understanding you need before arriving at an interview:

- Multi-tenancy is not a flag or a column. It is a constraint that propagates through every layer: HTTP routing, authentication, database queries, caching keys, observability labels, and background job queues.
- The three AWS SaaS Factory models (pool, silo, bridge) are the shared vocabulary. Know them by name and be able to describe when each is appropriate.
- A Go context is the canonical mechanism for carrying tenant identity through a request. Understand why `context.WithValue` with an unexported key type prevents cross-package collisions.
- The "missed WHERE clause" is the canonical failure mode. Know that PostgreSQL Row-Level Security is the database-layer defense against it.

First-job habits that signal you understand the stakes:

- Never accept a ticket that says "add multi-tenancy support" without asking which isolation model is required. Pool versus silo is a business and compliance decision, not a developer preference.
- Every repository method you write should call `tenant.MustFromContext` at line one. If the context does not carry a tenant, the panic is intentional: it surfaces the bug in tests, not in production.
- Write a cross-tenant isolation test for every new repository method before code review. It takes five minutes and catches the class of bug that triggers breach notifications.

Interview entry point: if asked "how would you add multi-tenancy to an existing app," walk through the layers in order: routing first, then context propagation, then database scoping, then observability. Showing that you know the dependency order signals experience over theory.

### Senior @ FAANG: Architectural Decision Records and Platform-Level Tenancy Governance

At staff level, multi-tenancy is not an implementation problem. It is a governance problem. The implementation is straightforward once the architecture decision is locked. The difficulty is making the right decision, documenting it, and building the platform primitives that make it impossible for product teams to violate the isolation contract.

**ADR template for isolation model selection:**

When a team proposes a new service in a multi-tenant platform, they should be required to answer four questions before writing code:

1. What is the maximum tenant count we must support in year three? Under one thousand favors silo, over ten thousand favors pool.
2. What compliance frameworks apply? HIPAA, PCI-DSS, or FedRAMP almost always require silo or at minimum schema isolation for audit purposes.
3. What is the performance isolation requirement in the SLA? "No tenant affects another" requires bulkheads and dedicated pools, not just rate limiting.
4. What is the blast radius of a tenant data leak? If the answer is "company-ending," the architecture must have defense in depth at every layer, not just application-code filters.

**Maturity model for multi-tenant platforms:**

Level 1 (Naive): Single database, `tenant_id` columns, no RLS, no cross-tenant tests. Data isolation is hope-based.

Level 2 (Defensive): RLS enabled, `MustFromContext` enforced, cross-tenant isolation tests in CI, per-tenant rate limiting.

Level 3 (Operational): Three-layer tenant context caching with pub/sub invalidation, per-tier statement timeouts, noisy-neighbor detection with automated throttling, tenant-aware structured logging and traces.

Level 4 (Platform): The isolation tier (pool, schema, silo) is a tenant attribute that the data access layer reads at runtime. Product teams write repository code once and the platform handles routing. Migration pipelines cover all three isolation modes. Compliance certifications reference the RLS policies and silo provisioning scripts as evidence.

Level 5 (Staff-level): The platform exposes a self-service "tenant isolation contract" that product engineers declare in a config file (isolation tier, data residency region, retention policy, deletion SLA). The infrastructure plane reads this contract and provisions accordingly. No human needs to touch database configuration for a new tenant or a tier upgrade.

**Bar-raiser signals in design interviews:**

A bar-raiser at L6/L7 level is looking for candidates who can articulate what breaks at scale and who owns the failure. Signals that separate strong candidates:

- Distinguishing Prometheus label cardinality constraints from log store constraints. Knowing that `tenant_id` belongs in logs and traces but not in Prometheus label sets, and explaining why (cardinality explosion), is a specific and correct answer that most candidates miss.
- Understanding that dual-write during isolation-tier migration must be atomic with the original write. Eventual consistency here means divergence during cutover, which means wrong data for the customer who just paid for enterprise. Framing this as a transaction-scope constraint, not a retry problem, is the correct framing.
- Knowing that GDPR right-to-erasure has edges beyond the database: search indexes, analytics warehouses, CDN edges, async backups with their own retention windows, and third-party processors. Enumerating these without being prompted separates candidates who have operated production systems from those who have only designed them.
- Proposing crypto-shredding (per-tenant encryption keys, delete the key to make data unrecoverable across all stores simultaneously) as a complement to explicit deletion pipelines, especially for regulated tenants with data residency requirements.

**Platform thinking at L7:** The goal is not to build a great multi-tenant app. It is to build a platform where building a multi-tenant app is the path of least resistance. That means tenant context propagation is automatic (sidecar or framework-level injection), isolation tier routing is invisible to business logic, compliance controls are auditable artifacts (not developer discipline), and new services are multi-tenant by default because the scaffolding enforces it.

---
