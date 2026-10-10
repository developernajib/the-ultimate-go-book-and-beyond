# Capstone Project 14: Multi-Tenant SaaS Platform

**Difficulty**: Advanced
**Estimated Time**: 3-4 weeks
**Target**: Enterprise multi-tenant B2B SaaS foundation with isolation, billing, and RBAC
**Tech Stack**: Go 1.27+, PostgreSQL (RLS & Schema Isolation), Redis, Stripe API, Casbin / OPA, Docker, Kubernetes

---

### Project Overview & Architecture

Building multi-tenant Software-as-a-Service (SaaS) applications is the dominant commercial application of backend engineering. Unlike simple single-user apps, enterprise SaaS platforms host thousands of distinct corporate tenants on shared infrastructure, requiring rigorous data isolation, flexible subscription billing, fine-grained access control, and tenant lifecycle automation.

In this capstone project, you will design and implement an enterprise-grade Multi-Tenant SaaS Architecture in Go. The platform supports dynamic tenant onboarding from custom domains and subdomains, implements bulletproof multi-tenant database isolation using PostgreSQL Row-Level Security (RLS) and separate schema pools, enforces fine-grained authorization via Casbin RBAC/ABAC, and integrates Stripe for automated tiered subscriptions and metered usage billing.

```
┌──────────────────────────────────────────────────────────────┐
│                    Multi-Tenant Traffic                      │
│                                                              │
│     tenant1.saas.com  │  tenant2.saas.com  │  custom-domain  │
└──────────────────────────────┬───────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────┐
│                  Tenant Context & Middleware                 │
│                                                              │
│   Tenant Resolver Middleware (Subdomain, Header, JWT Claim)  │
│   ├─ Dynamic Tenant Context Injection (context.Context)      │
│   ├─ Tenant Quota & Rate Limiter (Redis Token Bucket)        │
│   └─ Authentication & RBAC Policy Enforcement (Casbin/OPA)   │
└──────────────────────────────┬───────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────┐
│              Database Isolation Layer (PostgreSQL)           │
│                                                              │
│   ├─ Row-Level Security (RLS): Tenant ID Session Variable    │
│   ├─ Schema-Per-Tenant for Enterprise Tier Isolation         │
│   └─ Automatic Tenant Connection Pooling & Migrations        │
└──────────────────────────────┬───────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────┐
│                   External Integrations                      │
│                                                              │
│       Stripe Subscriptions  │  Audit Logs  │ Email / Webhooks│
└──────────────────────────────────────────────────────────────┘
```

### What You Will Build and Learn Across Sections

- **Part 1 & 2 (Project Foundation & Multi-Tenancy Patterns)**: Design the core domain models, tenant identification middleware, and compare database isolation strategies (shared database + shared schema vs schema-per-tenant).
- **Part 3 (Tenant Provisioning & Lifecycle)**: Automate tenant registration, database schema provisioning, subdomain assignment, and tenant deactivation workflows.
- **Part 4 (Authentication & RBAC/ABAC)**: Build a multi-tenant authentication engine with support for organization user invites, roles, permissions, and session tokens.
- **Part 5 (Billing & Subscription Management)**: Integrate the Stripe API for customer portal management, tiered subscription plans, metered usage reporting, and webhook handling.
- **Part 6 (Tenant Analytics & Observability)**: Tag telemetry, logs, and database metrics with tenant IDs to detect noisy neighbors and monitor usage spikes.
- **Part 7 (Deployment & Production Hardening)**: Containerize the platform, configure automated schema migrations across all tenant databases, and deploy with Helm.

### Junior → FAANG: Security & Isolation Boundaries

- **The Cardinal Rule of Multi-Tenancy**: A single cross-tenant data leak (e.g. Tenant A viewing Tenant B's invoices) is an existential security event for any B2B SaaS company. A common junior mistake is relying solely on application-level `WHERE tenant_id = ?` query filters, which human developers eventually forget in complex joins. Master setting database session variables (`SET LOCAL app.current_tenant_id = ?`) backed by PostgreSQL Row-Level Security (RLS) to enforce isolation at the database engine level.
- **Safe Context Propagation**: Learn how to safely attach verified tenant entities to Go's `context.Context` using unexported key types, preventing context key collisions and unauthorized context tampering.

### Senior @ FAANG: Scalability & Enterprise Operations

- **Tackling the "Noisy Neighbor" Problem**: If Tenant A launches a massive bulk export job, it must not degrade API latency for Tenant B. Implement per-tenant token bucket rate limits in Redis and separate background task queues so enterprise tenants receive dedicated processing capacity.
- **Managing Multi-Tenant Migrations at Scale**: When your SaaS reaches 10,000 tenants with schema-per-tenant isolation, running database migrations synchronously will timeout your deployment pipeline. Design asynchronous migration coordinators that migrate tenant schemas in parallel batches with canary verification and zero customer downtime.
