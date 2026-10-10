## Project Overview

**TenantFlow** is a multi-tenant SaaS platform that serves as both a reference implementation and a foundation for building SaaS products. This project demonstrates enterprise-grade patterns for tenant management, billing, authentication, customization, and operations.

### What We're Building
A complete SaaS platform infrastructure that includes: - **Multi-tenant architecture** with flexible isolation strategies
- **Subscription management** with Stripe integration
- **Usage-based billing** and metering
- **White-labeling** with custom domains and branding
- **SSO integration** (SAML, OIDC)
- **Admin dashboard** for platform management
- **Tenant onboarding** with setup wizards
- **API gateway** with tenant-aware routing
- **Kubernetes deployment** with namespace isolation

### Technology Stack

Each technology choice addresses a specific multi-tenancy constraint. PostgreSQL's row-level security enables per-tenant data isolation within a shared schema without separate databases. NATS JetStream provides durable, tenant-scoped event streams so billing events, audit logs, and provisioning workflows are decoupled from synchronous request handling. MinIO's bucket-per-tenant model enforces storage isolation at the object-store level with independent access policies.

```
Backend:        Go 1.27+
Database:       PostgreSQL 16+ (multi-tenant strategies)
Cache:          Redis (tenant-scoped caching)
Message Queue:  NATS JetStream (event-driven architecture)
Payments:       Stripe API
Auth:           Custom JWT + OAuth2 + SAML
Storage:        MinIO (S3-compatible, tenant-isolated)
Search:         Typesense (tenant-scoped search)
Monitoring:     Prometheus, Grafana, Jaeger
Deployment:     Kubernetes, Helm
```

### Architecture Overview

Every inbound request first passes through the API Gateway, which resolves tenant identity from the JWT or subdomain, injects it into the request context, and enforces rate limits before the request reaches any downstream service. This single entry point means tenant isolation and authorization are guaranteed at the infrastructure layer , individual services receive a pre-validated tenant context and can focus on business logic rather than re-implementing auth checks. The Core App Service sits downstream of all three platform services so it can call Tenant, Auth, and Billing without circular dependencies.

```
┌─────────────────────────────────────────────────────────────────┐
│                         API Gateway                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐           │
│  │ Rate Limit   │  │ Tenant Ctx   │  │ Auth/AuthZ   │           │
│  └──────────────┘  └──────────────┘  └──────────────┘           │
└────────────────────────────┬────────────────────────────────────┘
                             │
          ┌──────────────────┼──────────────────┐
          │                  │                  │
┌─────────▼─────────┐ ┌─────▼──────┐ ┌────────▼────────┐
│ Tenant Service    │ │ Auth       │ │ Billing Service │
│                   │ │ Service    │ │                 │
│ • Provisioning    │ │            │ │ • Subscriptions │
│ • Settings        │ │ • Users    │ │ • Usage Metering│
│ • White-label     │ │ • SSO      │ │ • Invoices      │
│ • Quotas          │ │ • RBAC     │ │ • Webhooks      │
└─────────┬─────────┘ └─────┬──────┘ └────────┬────────┘
          │                  │                  │
          └──────────────────┼──────────────────┘
                             │
                    ┌────────▼────────┐
                    │ Core App Service│
                    │  (Your Product) │
                    │                 │
                    │ • Business Logic│
                    │ • Features      │
                    │ • Tenant-aware  │
                    └────────┬────────┘
                             │
          ┌──────────────────┼──────────────────┐
          │                  │                  │
┌─────────▼─────────┐ ┌─────▼──────┐ ┌────────▼────────┐
│ PostgreSQL        │ │ Redis      │ │ NATS JetStream  │
│ (Multi-tenant DB) │ │ (Cache)    │ │ (Events)        │
└───────────────────┘ └────────────┘ └─────────────────┘
```
