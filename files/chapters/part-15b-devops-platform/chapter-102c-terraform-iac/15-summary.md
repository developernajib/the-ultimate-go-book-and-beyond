## 102C.13 Mid-Chapter Synthesis: Core Architecture Recap

Terraform transforms infrastructure management from artisanal manual operations into reproducible, reviewable, and testable code. The principles covered in this chapter - declarative state management, modular composition, DRY configurations with Terragrunt, and automated testing with Terratest - form the foundation of every production infrastructure workflow at FAANG-scale companies.

**The progression of IaC maturity**: Start with basic Terraform resources and remote state → extract modules for reusability → add Terragrunt for multi-environment DRY configs → implement Terratest for module validation → add policy-as-code with OPA/Sentinel → full GitOps with automated plan/apply pipelines.

**Go engineers and infrastructure**: Understanding Terraform deeply pays dividends beyond writing `.tf` files. Terraform providers are written in Go - you can write custom providers for internal APIs. Terratest is Go - infrastructure tests are Go tests. Pulumi lets you write infrastructure in Go. The skills compound.

**Key takeaways for FAANG interviews**:
1. State management is the foundation - remote state, locking, and encryption are non-negotiable for team environments
2. `for_each` over `count` for stable resource keys - avoids cascading destroy/recreate on list changes
3. Modules are the unit of reuse - build small, composable modules with clear interfaces
4. Never apply without a reviewed plan - Atlantis/Terraform Cloud enforces this in CI
5. Terragrunt solves the DRY problem at scale - essential for multi-environment, multi-account organizations

---

### Junior → FAANG: Consolidating the Chapter into Interview-Ready Knowledge

The progression described in this summary maps directly to the seniority ladder in platform engineering interviews. If you can speak to the first two stages (basic Terraform plus remote state, and modular composition) you are ready for an L3 or L4 role. Adding Terragrunt and Terratest gets you to L5. Policy-as-code and GitOps are the L6 conversation starters.

The single most valuable habit from this chapter to carry into your first role is the plan-before-apply discipline. Never run `terraform apply` without a saved plan file. Never run `terraform apply -auto-approve`. This discipline, applied consistently, prevents the majority of infrastructure incidents caused by unexpected resource deletions. It also builds the muscle memory for working in a CI/CD context where the plan step and the apply step are always separated by a review gate.

The Go connection in this chapter is the professional differentiator. Most engineers who use Terraform cannot write Go. As a Go engineer, you can write Terratest suites, build custom providers, and use CDKTF to express infrastructure as typed Go code. These skills are explicitly listed in platform engineering job descriptions at FAANG and make you competitive for roles that most pure-infrastructure engineers cannot reach.

### Senior @ FAANG: The Chapter Viewed Through a Governance Lens

At staff level, this chapter is a blueprint for building an IaC platform, not a collection of individual tools. The progression from basic resources to GitOps enforcement is an organizational maturity model. The question at L6 is not "which tool should I use?" but "what is the minimum governance layer that keeps 300 engineers from breaking each other while moving fast?"

The answer, derived from the patterns in this chapter, is four layers working together. The first layer is the module library: a curated, tested, versioned set of infrastructure primitives that encode organizational standards. The second layer is policy-as-code: OPA or Sentinel rules that encode security and compliance invariants as machine-readable assertions rather than review checklists. The third layer is the automation platform: Atlantis or Terraform Cloud as the sole apply executor, making every infrastructure change auditable and reviewed. The fourth layer is drift detection: nightly plan runs that treat a non-empty plan as an operational signal requiring investigation.

A staff engineer who can articulate these four layers, explain why each is necessary, describe the failure modes when any one is absent, and estimate the engineering investment required to build them is demonstrating L7-adjacent thinking. This is the bar-raiser territory in platform engineering interviews at the most infrastructure-sophisticated companies.
