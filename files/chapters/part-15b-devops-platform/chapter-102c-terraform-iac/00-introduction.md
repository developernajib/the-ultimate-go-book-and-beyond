# Chapter 102C: Terraform & Infrastructure as Code Deep Dive

*Infrastructure is code, and like all code, it must be reviewed, tested, version-controlled, and deployed with discipline.*

Before Infrastructure as Code became the industry standard, spinning up a new environment meant hours of manual console clicks, undocumented configuration drift, and the ever-present risk of a single engineer's tribal knowledge becoming a single point of failure. At companies managing hundreds of AWS accounts and thousands of cloud resources, the inability to reproduce environments consistently translated directly into slower releases, harder incident recovery, and compounding technical debt that grew with every manual change.

Go engineers increasingly own infrastructure decisions - whether writing Terratest suites to validate Terraform modules, building internal provisioning APIs that call Terraform internally, or designing platform tooling that enforces infrastructure standards across teams. Understanding Terraform deeply is no longer just an ops skill. It is a core competency for any senior Go engineer operating in a cloud-native environment.

This chapter covers Terraform from first principles through production-grade patterns. You will write real HCL, manage remote state safely, build reusable modules, scale configurations with Terragrunt, and validate infrastructure correctness using Go-based tests with the Terratest framework - all applied to a complete AWS production environment including VPC, ECS, RDS, and ElastiCache.

**What you'll learn in this chapter:**
- The declarative IaC model: how Terraform's plan-apply-destroy cycle works and why idempotency matters for safe automation
- Writing production-grade HCL with variables, locals, outputs, for_each, dynamic blocks, and lifecycle rules
- Managing Terraform state safely with remote backends (S3 + DynamoDB locking) and workspace isolation
- Building reusable Terraform modules with proper structure, versioning, and composition patterns
- Scaling multi-environment deployments with Terragrunt for DRY configuration management
- Writing infrastructure tests in Go using Terratest to validate real cloud resources before promotion
- Provisioning a complete AWS infrastructure stack: VPC, ECS cluster, RDS (Multi-AZ), ElastiCache, and ALB
- Integrating Terraform workflows into CI/CD pipelines with automated plan previews and gated applies

**Why this matters at scale:**
HashiCorp reports that Terraform manages billions of cloud resources globally. Companies like Stripe and Cloudflare use IaC to provision and tear down hundreds of environments daily, making reproducibility and automated testing the only viable path to reliability at that velocity.

**Prerequisites:** Chapters 97--102, 102B, 102N, 102Q (Docker, Kubernetes, Cloud Providers, IaC Fundamentals, Networking, FinOps, Edge/Serverless). Familiarity with Go and AWS/GCP basics.

---

### Junior → FAANG: Why Infrastructure Code Is Still Code

Junior engineers often treat Terraform as a one-time setup chore rather than a first-class engineering artifact. The most common gap is writing HCL that works once but cannot be reproduced, shared, or tested. Before your first infrastructure role at a FAANG-adjacent company, internalize two habits:

First, never run `terraform apply` without a saved plan. Get used to `terraform plan -out=tfplan` followed by `terraform apply tfplan`. This discipline surfaces unintended destroy operations before they happen and is the foundation of every CI gate you will encounter.

Second, treat the state file as the most important artifact in the system. If you lose or corrupt it, Terraform no longer knows what it created. Remote state in S3 with DynamoDB locking is not optional for team environments. Set it up before writing your first resource.

Entry-level interview questions in this space test whether you can explain why Terraform is declarative and what idempotency means. Practice articulating: "Running apply twice on the same config produces the same result because Terraform diffs the desired state against the state file rather than executing steps blindly."

### Senior @ FAANG: Platform Thinking for IaC at Organizational Scale

At staff and principal level, Terraform is not a tool you use. It is a platform you govern. The architectural questions shift from "how do I write this resource?" to "how does 300 engineers safely write infrastructure without stepping on each other, violating compliance requirements, or creating a single catastrophic blast radius?"

**Blast radius architecture.** The first governance decision is state topology. A single state file for all of prod means a botched `terraform apply` can take down unrelated services while the lock is held. At L6, you design a sharding strategy: one state file per service team per environment, with networking and shared platform infrastructure in separate foundational stacks. You define the interface between stacks using remote state outputs or, better, a shared SSM parameter layer that decouples consumer stacks from needing read access to provider state files.

**Module governance as a product.** Large organizations treat the internal Terraform module library as an internal product with real customers. This means: semantic versioning with a changelog, a stability tier (stable, experimental, deprecated), automated upgrade PRs via Renovate Bot when callers fall behind, and breaking changes requiring a major version bump with a written migration guide. At bar-raiser level, you are asked to describe this governance model and explain how you prevent module authors from making silent breaking changes that break 40 downstream callers simultaneously.

**Policy-as-code as a control plane.** Sentinel or OPA/Conftest policies are not optional additions. They are the compliance enforcement layer. A senior engineer defines policies that encode security invariants: no unencrypted S3 buckets, no publicly accessible RDS, deletion protection required on stateful resources in any workspace tagged `environment=production`. These policies run in CI before plan output reaches a human reviewer. You can never rely on humans to catch every policy violation during code review at scale.

**ADR: Workspaces vs. directory-per-environment.** This is a canonical architectural decision at every organization that outgrows a single environment. The recommendation, backed by HashiCorp's own guidance, is directory-per-environment. Workspaces share provider config and module versions, making it impossible to pin staging on module v1.1 while prod runs v1.0 for a staged rollout. Document this decision with the alternatives considered, and capture it in an ADR so future engineers do not relitigate it.

**Drift as a reliability metric.** A mature platform team tracks infrastructure drift as an operational health metric, not just an occasional nuisance. Scheduled nightly `terraform plan` runs against production post their diff to a monitoring channel. Any non-empty plan is an incident signal: either unauthorized manual changes occurred, or the desired state in HCL diverged from the deployed reality. At L7, you close this loop by enforcing AWS SCPs that block console modifications of production infrastructure entirely, making Terraform the only door into production.
