## Learning Objectives

1. **Understand platform engineering fundamentals** - cognitive load reduction, paved roads vs golden paths, and why platform engineering differs from DevOps and SRE
2. **Design IDP architecture** - service catalog, self-service portal, developer portal, and golden path templates
3. **Implement Backstage** - software catalog, TechDocs, scaffolding templates, and custom plugins
4. **Build golden path templates** - Go microservice template with CI/CD, observability, and Kubernetes configuration
5. **Implement self-service infrastructure** - Crossplane for self-service databases and environments
6. **Measure developer experience** - SPACE framework, DX metrics, and platform ROI
7. **Build platform APIs in Go** - provisioning endpoints, GitOps webhooks, and reconciliation controllers

### Junior → FAANG: Using Learning Objectives as an Interview Checklist

Learning objectives are not just a reading preview. For interview preparation, treat each objective as a question you must be able to answer with a concrete example or a short code sketch.

Objective two (IDP architecture) is the most commonly tested at the junior level. Interviewers ask candidates to describe the layers of a developer portal and explain what each layer does. The pattern to memorize: developer-facing portal (Backstage), abstraction API (Go service), infrastructure layer (Crossplane, ArgoCD). Each layer has one responsibility and is independently replaceable.

Objective six (SPACE framework) is frequently misunderstood by junior engineers who conflate it with DORA. DORA measures delivery throughput and stability. SPACE measures the broader developer experience including satisfaction and flow. Know both, know the difference, and know which one a platform team owns primarily (SPACE, with DORA as the delivery component).

Objective seven is a Go-specific skill goal. A junior engineer joining a platform team will be expected to write Kubernetes controller code using `controller-runtime`. If you have not worked with custom controllers, the key concepts to study are: reconcile loops, idempotent operations, status-driven state machines, and `RequeueAfter` for asynchronous resources.

### Senior @ FAANG: Reading Objectives as a Maturity Model

A senior or staff engineer should read learning objectives as checkboxes against a platform maturity model. An organization that has mastered objective four (golden path templates) but not objective six (DX measurement) has a platform that may be technically sound but cannot prove its value to leadership. That gap is a strategic risk.

At the L6 level, the ability to build any individual component (Backstage plugin, Crossplane composition, Go provisioning API) is assumed. What differentiates a staff engineer is the ability to sequence these investments correctly, resist building the wrong thing at the wrong time, and instrument each capability to measure adoption and impact before moving to the next.

Objective seven deserves special attention at the senior level because platform APIs built in Go must be designed with the same rigor as external APIs: backward compatibility, versioning, documented deprecation windows, and SLOs for availability and latency. A provisioning endpoint that goes down silently blocks every team that depends on it. The platform API is production infrastructure. It must be treated as such from the first commit.
