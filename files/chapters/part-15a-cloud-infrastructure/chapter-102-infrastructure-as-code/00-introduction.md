# Chapter 102: Infrastructure as Code for Go Services

> *"Infrastructure as code is not about automating what you already do manually. It's about making infrastructure a first-class software artifact - reviewed, tested, versioned, and deployed with the same rigor as application code."*

Infrastructure as Code (IaC) is the practice of defining cloud infrastructure - networks, compute instances, databases, IAM policies, DNS records, load balancers - in declarative or programmatic files that live in version control alongside your application code. The benefits compound over time: reproducible environments eliminate "works on my machine" discrepancies between staging and production, peer review catches misconfigurations before they reach live infrastructure, automated plan-and-apply pipelines prevent manual configuration drift, and disaster recovery becomes a `terraform apply` instead of a frantic reconstruction from memory. For Go teams operating in the cloud, IaC is the difference between infrastructure that is understood and infrastructure that is feared.

Terraform has been the dominant IaC tool for a decade, and its HCL language and provider ecosystem are mature and well-understood. But Pulumi represents a fundamentally different approach: defining infrastructure in real programming languages - including Go - with full access to loops, conditionals, functions, abstractions, and the Go type system. For Go engineers, Pulumi unlocks the ability to write infrastructure using the same patterns as application code: interfaces for provider abstraction, structs for resource configuration, packages for reusable modules, and `go test` for infrastructure unit tests. Complex conditional logic that would be verbose and fragile in HCL becomes clear, testable Go code. Pulumi and Terraform are not mutually exclusive - many teams use Terraform for foundational infrastructure and Pulumi for application-layer infrastructure that requires real programming logic.

GitOps closes the loop between infrastructure code and running systems. Flux and ArgoCD continuously reconcile the state of a Kubernetes cluster (or a cloud environment, via Terraform Cloud or Atlantis) against the declared state in a Git repository. Any drift - whether caused by a manual `kubectl edit`, a cloud console click, or an automated scaling event that made a permanent change - is detected and can be automatically corrected. Drift detection surfaces mismatches between declared and actual state before they become incidents. This chapter gives you a complete, opinionated infrastructure engineering workflow: Pulumi with Go for infrastructure definition, Terraform for foundational primitives, and GitOps pipelines for continuous reconciliation - all applied to the Go services you have been building throughout this book.

**What you'll learn in this chapter:**

- How to write Terraform configurations for complete Go service infrastructure - VPC, EKS/GKE cluster, RDS, Redis, ALB/NLB - using modules for reusability and workspaces for environment separation
- How to use the Pulumi Go SDK to define the same infrastructure as strongly-typed Go code, with loops, functions, and component resources that eliminate HCL's limitations
- How to manage Terraform and Pulumi state backends securely using S3/GCS with encryption, versioning, and DynamoDB/GCS locking to prevent concurrent modification corruption
- How to design reusable infrastructure modules (Terraform) and component resources (Pulumi) that encapsulate organizational standards - tagging policies, security group rules, IAM boundaries
- How to implement drift detection pipelines that alert on infrastructure state divergence and optionally auto-remediate or create incident tickets
- How to manage secrets in IaC workflows using HashiCorp Vault, AWS Secrets Manager, and SOPS for encrypted secrets committed to Git
- How to implement a GitOps workflow with Flux or ArgoCD where merged pull requests to an infrastructure repository trigger automated plan-and-apply pipelines with approval gates
- How to write infrastructure tests using Terratest (for Terraform) and Pulumi's testing framework (for Go Pulumi programs) that validate real deployed infrastructure

**Why this matters at scale:**

Mature platform teams manage thousands of cloud resources across dozens of accounts through Terraform, with a policy that no infrastructure change reaches production without a reviewed, CI-validated plan - at that maturity, the IaC repository often sees more pull requests per day than any application repository. Cloudflare uses Pulumi with Go to manage its global network infrastructure across 250+ data center locations, using Go's type system to enforce invariants that would be impossible to express in HCL. Lyft built an internal IaC platform on Terraform that provisions complete, compliant Go service environments in under 10 minutes, including networking, IAM, observability, and Kubernetes namespaces. Datadog uses GitOps with Terraform Cloud and Atlantis to manage its multi-cloud infrastructure, processing drift detection alerts as P2 incidents to maintain configuration integrity.

**Prerequisites:** Chapters 97--101 (the full cloud infrastructure sequence), familiarity with at least one cloud provider (AWS, GCP, or Azure), and Go modules knowledge from Part 1.

---

### Junior → FAANG: Infrastructure as Code as Engineering Discipline

Many engineers encounter IaC for the first time when they need to provision a new environment and are handed a Terraform repository. The instinct is to copy-paste existing code and change the relevant values. This approach works in the short term but produces drift, duplication, and confusion over time.

The foundational principle that changes this pattern: IaC code is software. It needs the same quality bar as application code: clear naming, DRY principles (modules instead of copy-paste), version control with meaningful commit messages, code review before applying changes, and testing (at minimum, `terraform validate` and `terraform plan` review before `apply`).

First-job habit: never apply infrastructure changes without reviewing the plan output. `terraform plan` shows exactly what will be created, modified, or destroyed. Reviewing it carefully before `apply` is the equivalent of code review, and skipping it is the most common cause of infrastructure incidents.

### Senior @ FAANG: IaC as the Foundation of Infrastructure Governance

At staff level, IaC is the foundation of infrastructure governance. When all infrastructure is expressed as code in version control, every change has an author, a timestamp, a review record, and a diff. This audit trail is the basis for compliance reporting, incident root cause analysis, and cost attribution.

The organizational IaC strategy at FAANG scale: a centralized module registry (internal Terraform module registry or Pulumi registry) where the platform team publishes approved, tested modules for common infrastructure patterns (VPC, EKS cluster, RDS instance). Service teams consume these modules with approved configurations. Custom infrastructure requires justification and review. This centralization enforces standards, prevents configuration drift, and reduces the surface area for security misconfiguration.

The governance concern that most organizations underinvest in: drift detection. A Terraform configuration that is applied once and never reviewed may diverge from the actual infrastructure if changes are made via the cloud console or the CLI. Scheduled `terraform plan` runs that detect drift and alert the owning team are the mechanism that keeps IaC as the actual source of truth rather than just the declared one.
