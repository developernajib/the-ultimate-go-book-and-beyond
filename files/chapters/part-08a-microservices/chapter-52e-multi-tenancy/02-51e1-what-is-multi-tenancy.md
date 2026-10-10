## 52E.1 What Is Multi-Tenancy?

### SaaS Multi-Tenancy Defined

Multi-tenancy is an architecture where a single deployment of software serves multiple distinct customers (tenants), with each tenant's data isolated from others. The customer sees a private, dedicated experience, while the operator runs a single shared system.

The business case is straightforward:

| Single-tenant | Multi-tenant |
|---|---|
| One deployment per customer | One deployment for all customers |
| Linear cost scaling | Sub-linear cost scaling |
| Simple isolation | Complex isolation |
| Slow onboarding | Instant onboarding |
| Easy customization | Constrained customization |

For a SaaS company, multi-tenancy is almost always the right default. The cost savings from shared infrastructure compound as the tenant count grows.

### The Spectrum: Fully Shared to Fully Isolated

AWS SaaS Factory's widely adopted taxonomy names three points on this spectrum:

- **Pool model** - all tenants share the same infrastructure and tables, separated only by `tenant_id` and (ideally) PostgreSQL Row-Level Security. Cheapest per tenant, hardest to isolate.
- **Silo model** - each tenant gets dedicated infrastructure (separate database, often separate compute). Strongest isolation, highest per-tenant cost. For compliance-driven tiers (HIPAA, PCI, data residency).
- **Bridge model (hybrid)** - shared application, tenant-aware data layer that routes some tenants to pooled storage and others to siloed storage. This is the pragmatic default: pool by default, silo for enterprise tier.

Multi-tenancy is not binary. It is a spectrum:

```
FULLY SHARED                                          FULLY ISOLATED
    │                                                       │
    ▼                                                       ▼
Shared DB     Shared DB,      Shared cluster,    Separate DB     Separate
Shared table  separate schema separate DB per    per tenant      deployment
(row-level    per tenant      tenant             per tenant      per tenant
 tenant ID)
```

Each point on this spectrum has different properties:

**Shared table (row-level isolation)**
- Data: all tenants in same tables, tenant_id column differentiates
- Compute: shared application servers, shared connection pool
- Cost per tenant: lowest (shared everything)
- Isolation risk: highest (bug in query can leak cross-tenant data)
- Max tenants: unlimited
- Suitable for: high-volume, cost-sensitive SaaS (Slack, Notion, Linear)

**Separate schema per tenant**
- Data: each tenant has their own PostgreSQL schema (`tenant_abc.orders`)
- Compute: shared application servers
- Cost per tenant: low (schemas are lightweight in PostgreSQL)
- Isolation risk: medium (schema prefix required in every query)
- Max tenants: thousands per PostgreSQL instance
- Suitable for: mid-market SaaS with compliance requirements

**Separate database per tenant**
- Data: each tenant has their own database instance (or at least separate logical database)
- Compute: may have dedicated connection pools, possibly dedicated servers
- Cost per tenant: medium-high
- Isolation risk: low (database-level isolation)
- Max tenants: hundreds per cluster, depending on size
- Suitable for: enterprise SaaS, regulated industries (healthcare, finance)

**Separate deployment**
- Everything dedicated: application servers, databases, networking
- Cost per tenant: full infrastructure cost
- Isolation risk: none
- Suitable for: strategic enterprise accounts, regulated customers requiring data residency

### Multi-tenancy vs Single-Tenancy Trade-offs

| Concern | Multi-tenant | Single-tenant |
|---|---|---|
| Data isolation | Harder (software-enforced) | Trivial (physical separation) |
| Cost efficiency | High | Low |
| Onboarding speed | Instant | Days/weeks (new deployment) |
| Customization | Limited | Unlimited |
| Compliance (GDPR, HIPAA) | Complex | Simple |
| Noisy neighbor | Risk | None |
| Scale unit | Service | Deployment |

The right choice depends on your customer profile. B2C SaaS: always multi-tenant. Mid-market B2B: multi-tenant with enterprise-tier isolation option. Large enterprise: often single-tenant per customer, or at minimum separate database per tenant.

### Junior → FAANG: Making the Model Choice Concrete

The taxonomy in this section appears in nearly every system design interview that touches SaaS infrastructure. Interviewers at FAANG and senior-track companies expect you to use the AWS SaaS Factory vocabulary (pool, silo, bridge) and to connect each model to a real-world constraint.

Common gaps that junior candidates reveal in interviews:

- Describing shared-table isolation as "less secure" without understanding that PostgreSQL RLS makes it as enforceable as schema-level isolation, with far lower operational overhead.
- Conflating "isolation" with "separate deployment." Physical separation is one way to achieve isolation, not the only way. The interview question is always about the trade-off, not about which model is "best."
- Forgetting the operational dimension of the silo model. A thousand separate databases means a thousand migration runs, a thousand backup schedules, and a thousand connection pools. The cost is not just infrastructure dollars, it is engineering hours.

Worked example for interviews: "Design a project management SaaS that must support free users, pro teams, and enterprise organizations with HIPAA requirements."

Answer structure: start with the pool model as the default for free and pro. Then add the silo model as a tier upgrade for enterprise, gated by plan. Explain that the bridge model is what holds these together: the application code is identical, the data access layer reads `isolation_tier` from the tenant context and routes accordingly. This is the answer that signals production experience.

First-job habits:

- When the team debates isolation models, ask "what is our enterprise pipeline?" If there is no enterprise pipeline yet, pool is correct. If there is, design for bridge from the start.
- Never propose schema-per-tenant as the default. It has the operational cost of silo without the isolation strength, and it scales poorly past a few thousand tenants.

### Senior @ FAANG: Governance, Cost Modeling, and Migration Readiness

At staff level, the isolation model is a governance decision, not a technical preference. It has legal, financial, and organizational consequences that persist for years. The senior-track concerns here go beyond implementation.

**Cost modeling by tier:**

The business must price each isolation tier correctly or the economics collapse. A rough model:

- Pool tier (free/pro): marginal cost per tenant is effectively zero once the shared infrastructure is provisioned. Revenue per tenant must exceed amortized shared infrastructure cost divided by tenant count.
- Schema tier: adds migration complexity but no significant compute cost. Priced as a mid-market feature ($200-500/month range in typical SaaS).
- Silo tier: dedicated database means dedicated compute, backup storage, and monitoring overhead. Marginal cost per tenant is real and measurable. Enterprise contracts must cover it, typically $2,000-10,000/month in infrastructure cost for a well-sized SaaS database.

**Compliance mapping:**

Different compliance frameworks imply different isolation requirements. A staff engineer must know this mapping without looking it up:

- SOC 2 Type II: can be achieved with pool model plus RLS and strong audit logging.
- HIPAA: requires documented data isolation. Schema or silo is easier to demonstrate in an audit, though pool with RLS and documented policies is defensible.
- PCI-DSS: cardholder data environment must be isolated. Silo model for any tenant handling payment card data.
- FedRAMP: governs where data physically resides, not just logical isolation. Requires silo model with data residency controls.
- GDPR: affects all models equally (deletion, portability), but silo makes the deletion story simpler (`DROP DATABASE` after export).

**Migration readiness ADR:**

Every team that chooses the pool model should document the migration path to bridge before they start. The ADR should include: the trigger condition that initiates the migration (first enterprise deal, first HIPAA requirement, first $X ARR), the estimated engineering cost of the migration (typically two to four sprints), the rollback strategy, and the owner responsible for initiating the migration. Without this ADR, the migration happens reactively, under deadline pressure, and with higher risk.

**Platform-level enforcement:**

A mature multi-tenant platform does not rely on developer discipline to pick the right isolation model. The platform reads the tenant's `isolation_tier` attribute and routes automatically. New services are multi-tenant by construction because the service scaffolding injects the `DataAccessLayer` and the tenant middleware by default. Teams that deviate from the scaffold are required to document the deviation in an ADR and get it reviewed. This is how L7-level thinking manifests: the platform makes the correct behavior the easy behavior.

---
