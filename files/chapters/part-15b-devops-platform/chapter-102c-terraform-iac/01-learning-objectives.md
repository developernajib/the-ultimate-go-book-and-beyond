## Learning Objectives

1. **Master IaC fundamentals** - understand declarative vs imperative approaches, idempotency, and when IaC solves real problems
2. **Write production-grade HCL** - resources, data sources, variables, locals, outputs, for_each, dynamic blocks, and lifecycle rules
3. **Manage Terraform state safely** - remote state with S3+DynamoDB locking, workspaces, state import, and state manipulation
4. **Build reusable modules** - module structure, composition, versioning with semantic versions, and module testing with Terratest
5. **Scale Terraform with Terragrunt** - DRY configurations, dependency management, and multi-environment deployments
6. **Write infrastructure tests in Go** - use Terratest to validate real infrastructure before promoting to production
7. **Build production AWS infrastructure** - VPC, ECS, RDS, ElastiCache, ALB with complete Terraform configurations

---

### Junior → FAANG: Mapping Objectives to Interview Expectations

Each learning objective above corresponds to a real interview question category. Objective 1 (IaC fundamentals) maps to the "explain declarative vs imperative" question that appears in roughly 80% of DevOps or platform engineering screens. Objective 3 (state management) maps to the "what happens if two engineers run apply at the same time?" question that screens for production awareness.

Before your first interview in this space, be able to walk through a complete scenario from scratch: you join a new team, find local state files in version control, and describe exactly what you do to migrate to remote state without losing track of existing resources. Knowing that `terraform init -migrate-state` handles the transfer, and that you run `terraform plan` immediately after to confirm zero changes, separates candidates who have done this from those who have only read about it.

### Senior @ FAANG: Maturity Model Framing for Objectives

Staff engineers evaluate IaC programs against a maturity model rather than a checklist of features. At FAANG scale, the objectives above represent table stakes, not competitive differentiators. What elevates an interview to bar-raiser territory is discussing what comes after:

After module structure comes module governance: a registry, semantic versioning enforced by CI, automated consumer notifications on breaking changes, and a module deprecation lifecycle that does not strand teams on unmaintained code. After Terratest comes a test pyramid: unit tests on synthesized JSON (CDKTF), fast integration tests on lightweight modules with mocked dependencies, and full end-to-end tests gated to merge rather than every PR.

After Terragrunt DRY configs comes account vending: a Control Tower or Customizations for Control Tower (CfCT) pipeline that provisions a new AWS account with baseline security, networking, and Terraform remote state infrastructure in under 10 minutes, with no manual steps. After drift detection comes GitOps with enforcement: AWS SCPs block console modifications in production, and all infrastructure change is auditable because Atlantis or Terraform Cloud is the only actor with apply permissions.

At bar-raiser interviews, the question is not "can you write HCL?" but "how would you design an IaC platform that 500 engineers can use safely without a central infrastructure team becoming a bottleneck?"
