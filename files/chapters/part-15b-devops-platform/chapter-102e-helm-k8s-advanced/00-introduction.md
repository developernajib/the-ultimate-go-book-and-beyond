# Chapter 102E: Helm & Kubernetes Advanced

*Kubernetes is a platform for building platforms. Helm is the package manager for that platform.*

Running containers in Kubernetes is straightforward. Running them reliably - with consistent configuration across environments, enforced security policies, automatic scaling under variable load, and guaranteed resource isolation between tenants - requires a far deeper engagement with the platform's extensibility model. Most engineers learn Kubernetes by writing Deployments and Services. Senior engineers understand the admission control pipeline, build Custom Resource Definitions to extend the API, and implement webhooks that enforce organizational standards at every deployment.

Go is the native language of the Kubernetes ecosystem. The controller-runtime library, client-go, and the entire operator pattern are Go-first. When your organization needs an admission webhook that rejects non-compliant workloads, a custom controller that manages database clusters as Kubernetes resources, or a KEDA scaler that responds to business metrics - Go is the implementation language. This chapter treats Kubernetes not just as an operations target but as an extension platform that Go engineers actively build on.

This chapter moves through Helm chart development, Kustomize integration, CRD design, admission webhook construction in Go, advanced autoscaling with HPA/VPA/KEDA, zero-trust network policies, and resource quota management - giving you the complete toolkit for operating Kubernetes at platform-engineering maturity.

**What you'll learn in this chapter:**
- Helm chart development: structure, Sprig template functions, named templates, pre/post hooks, dependencies, and chart testing
- Kustomize with Helm: overlay strategy, strategic merge patches, JSON patches, and the Helm-vs-Kustomize decision framework
- Custom Resource Definitions: designing CRDs with OpenAPI v3 validation, status subresource, printer columns, and versioning
- Building admission webhooks in Go: validating and mutating webhooks, cert-manager TLS bootstrapping, and OPA/Gatekeeper integration
- Advanced autoscaling: HPA with custom and external metrics, VPA for right-sizing, KEDA for event-driven scaling from Kafka/SQS
- Kubernetes network policies: implementing zero-trust pod-to-pod communication with default-deny and explicit allow rules
- Resource management: namespace quotas, LimitRange defaults, PodDisruptionBudgets, QoS classes, and workload right-sizing
- Operator pattern: reconciliation loops, controller-runtime scaffolding, and managing stateful applications as Kubernetes resources

**Why this matters at scale:**
Google runs millions of containers on Borg - Kubernetes' spiritual predecessor - relying on admission control and CRDs to enforce consistency. Stripe uses custom Kubernetes operators to manage their stateful infrastructure, reducing operator toil by codifying operational runbooks directly into controllers.

**Prerequisites:** Chapter 97 (Docker), Chapter 98 (Kubernetes), Chapter 102C (Terraform & IaC), Chapter 102D (GitOps & Deployment Strategies)

### Junior → FAANG: Understanding What "Advanced Kubernetes" Actually Means

Most engineers encounter Kubernetes through Deployments, Services, and ConfigMaps. The gap between that starting point and platform-engineering maturity is wide, and it is easy to underestimate it during early-career interviews.

The prerequisite gaps that show up most often: not knowing what an admission webhook does or when it fires, treating Helm as "YAML templating" without understanding release lifecycle, and conflating CRDs with ConfigMaps. Interviewers at FAANG-tier companies will probe whether you can distinguish operator-managed state from configuration-managed state, and whether you understand the reconciliation model well enough to reason about failure cases.

First-job habits to build now: deploy real applications with Helm, write a LimitRange or ResourceQuota for a namespace, and try reading a controller's reconcile loop even if you did not write it. Entry-point interview framing: know the difference between a validating webhook and a mutating webhook, and be able to say concretely why you would use one over the other.

### Senior @ FAANG: Platform Maturity and the Kubernetes Extension Model as Infrastructure Policy

At the staff and principal level, the question is never "can we run this on Kubernetes" but rather "what contract does our platform offer to every team that deploys on it, and how is that contract enforced without requiring human review of every change."

That shift changes how you read this chapter. Admission webhooks become policy enforcement points that replace manual PR reviews for security and cost compliance. CRDs become the API surface through which platform teams expose controlled abstractions to application teams, hiding operational complexity behind a curated schema. Helm charts become governance artifacts: the chart is the organizational decision about how a service is deployed, not just a packaging convenience.

ADR consideration: when your organization reaches the point where multiple teams are building operators, you need a governance model for the CRD API surface itself. CRDs are cluster-scoped resources and schema changes can break existing consumers. Treating CRD versioning with the same discipline as a public API, including conversion webhooks and deprecation timelines, is a staff-level concern that rarely appears in junior or mid-level conversations.

Bar-raiser signals in interviews at this level: candidates who can describe the admission control pipeline in order (mutation, then validation, with webhook ordering implications), who know that webhook failures can be configured as fail-open or fail-closed and can articulate the availability vs. safety tradeoff, and who have thought about what happens to cluster operations when a webhook is unavailable during an incident.

Platform thinking at L6/L7: the goal is that every team can deploy confidently without understanding every cluster-level detail, and that platform engineers can enforce organizational standards without becoming a bottleneck. This chapter's topics, taken together, are the implementation vocabulary for that goal.
