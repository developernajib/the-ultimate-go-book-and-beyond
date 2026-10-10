## Architecture Overview

An Internal Developer Platform (IDP) is built in horizontal layers: a developer-facing portal (Backstage) sits on top of a Go-implemented Platform API, which in turn delegates to infrastructure provisioning tools such as Crossplane, ArgoCD, and GitHub Actions. This separation means product engineers interact only with high-level abstractions. Provisioning a database or onboarding a service. While the platform team retains full control over the underlying implementation. Each layer is independently replaceable. Swapping Crossplane for Pulumi, for example, requires no changes to the Backstage templates that developers use.

```
┌──────────────────────────────────────────────────────────────────────────┐
│                  Internal Developer Platform (IDP)                       │
└──────────────────────────────────────────────────────────────────────────┘

  Developer Experience Layer
  ┌──────────────────────────────────────────────────────────────────────┐
  │                        Backstage Portal                              │
  │  ┌─────────────────┐  ┌──────────────┐  ┌──────────────────────┐     │
  │  │ Service Catalog │  │  TechDocs    │  │  Scaffolding         │     │
  │  │ (what exists)   │  │  (docs)      │  │  (create new service)│     │
  │  └─────────────────┘  └──────────────┘  └──────────────────────┘     │
  └──────────────────────────────────────────────────────────────────────┘
           │                    │                      │
           ▼                    ▼                      ▼
  Service Registry         Docs Site            GitHub Repo
  (catalog-info.yaml)      (generated)          (from template)

  Platform API Layer (Go)
  ┌──────────────────────────────────────────────────────────────────────┐
  │  POST /environments/provision  → creates namespace + RBAC + network  │
  │  POST /databases/provision     → creates RDS via Crossplane          │
  │  POST /services/onboard        → creates repo + CI/CD + ArgoCD app   │
  └──────────────────────────────────────────────────────────────────────┘
           │
           ▼
  Infrastructure Provisioning
  ┌────────────────┐  ┌────────────────┐  ┌──────────────────┐
  │   Crossplane   │  │    ArgoCD      │  │  GitHub Actions  │
  │  (databases,   │  │  (K8s deploy)  │  │  (CI pipeline)   │
  │   S3, secrets) │  │                │ │                   │
  └────────────────┘  └────────────────┘  └──────────────────┘
```

### Junior → FAANG: Reading Architecture Diagrams in Interviews

Architecture overview diagrams are almost always part of a system design interview. The key skill is not memorizing the diagram but being able to explain the responsibility of each layer and what would happen if one layer were replaced.

For this diagram, practice explaining it out loud: Backstage is the developer-facing portal. It does not provision anything itself. Provisioning happens through the Platform API, which is a Go service. The API delegates to Crossplane for cloud resources, ArgoCD for Kubernetes deployments, and GitHub Actions for CI pipelines. A developer never touches any of those tools directly.

The independence of layers is the key design principle here. If the team decides to replace Crossplane with Pulumi, the Backstage templates do not change. Only the Platform API implementation changes. If the team replaces GitHub Actions with Buildkite, the Backstage scaffolder does not change. This is the Open-Closed Principle applied at the architecture level: each layer is open for internal replacement but closed from the perspective of the layer above it.

A common junior mistake in interviews is to treat this as a monolith with three labels. Challenge yourself to explain what the API contract is between each pair of layers, what would fail if the Platform API were unavailable, and how you would test each layer in isolation.

### Senior @ FAANG: Evaluating Architectural Fitness for Scale

The layered IDP architecture shown here is well-suited to organizations with fifty to several hundred engineers. At FAANG scale (thousands of engineers, multiple business units, multiple cloud providers), additional concerns emerge that are not visible in this diagram.

The first concern is multi-tenancy at the Platform API layer. A single Go service handling all provisioning requests for every team in a large organization becomes a single point of failure and a bottleneck. At scale, the Platform API is typically replaced by a control plane with domain-specific sub-services: one service owns namespace provisioning, another owns database provisioning, a third owns CI/CD pipeline management. These are joined by a shared catalog and routing layer, not a monolithic handler.

The second concern is the Backstage node. At scale, Backstage itself must be treated as a production service with high availability, deployment pipelines, and database redundancy for its catalog backend. The plugin ecosystem also becomes a governance concern: with hundreds of teams writing plugins, you need a review process, a deprecation policy, and a versioning strategy for the plugin API surface.

The third concern is the cost attribution layer. The diagram shows no mechanism for tracking which team provisioned which resource and what it costs. At FAANG scale, chargeback or showback reporting is essential for cost governance. The Platform API must tag every resource it creates with team, service, and cost-center labels that feed into a centralized cost reporting pipeline.

An L6 or L7 candidate presenting this architecture to a FAANG panel should proactively address these concerns and propose how the architecture would evolve as the organization scales, rather than waiting to be asked.
