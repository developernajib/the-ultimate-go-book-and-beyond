## 102C.9 Real-World Case Studies: IaC at Scale

### HashiCorp - Terraform's Own Infrastructure

HashiCorp manages Terraform Cloud (now HCP Terraform) using Terraform itself - eating their own dog food. Their infrastructure serves 500K+ organizations and processes millions of Terraform runs per month.

**Key patterns**: (1) **Sentinel policies**: HashiCorp uses their own Sentinel policy-as-code framework to enforce compliance. Every Terraform plan must pass Sentinel checks before apply: no unencrypted S3 buckets, no public security groups, mandatory tags on all resources. (2) **Private module registry**: All shared infrastructure patterns are published to HCP Terraform's private registry with semantic versioning. Teams consume `registry.terraform.io/mycompany/vpc/aws//5.0.0` for pinned, tested versions. (3) **No-code provisioning**: For teams without Terraform expertise, HashiCorp builds "no-code modules" with variable sets - a developer fills in a form, Terraform does the rest.

**Go lessons**: HashiCorp's providers are written in Go using the Terraform Plugin Framework (`github.com/hashicorp/terraform-plugin-framework`). If your team maintains custom resources (internal APIs, legacy systems), writing a Terraform provider in Go is the correct abstraction rather than using `null_resource` + external scripts.

---

### Uber - Multi-Cloud Infrastructure at Scale

Uber operates infrastructure across AWS, GCP, and their own datacenters. Terraform manages 100K+ resources across this multi-cloud environment.

**Challenges at scale**: (1) **State file size**: Terraform state files grow with resource count. Uber's monorepo states reached 100MB+, making plan/apply times unacceptably long (10+ minutes). Solution: split state by service/team with strict ownership boundaries. (2) **Provider version conflicts**: Different teams need different provider versions. Solution: workspace isolation with separate provider lock files per workspace. (3) **Blast radius control**: A `terraform apply` in the wrong workspace could destroy production. Solution: OPA (Open Policy Agent) policies enforced in CI that prevent applying prod configs outside approved pipelines.

**CI/CD pattern**: Every pull request runs `terraform plan` with output posted as a PR comment. Human approval required before `terraform apply`. Atlantis (self-hosted Terraform collaboration tool) orchestrates this workflow. Failed applies trigger automatic rollback via previous state restore.

---

### Airbnb - Infrastructure as Software

Airbnb treats Terraform configurations as software: code review, unit tests (Terratest), and CI/CD pipelines. Their "infra-as-code" team maintains the module library that 200+ engineers consume.

**Module governance**: (1) Every module change requires approval from the infrastructure team. (2) Breaking changes require major version bump with a migration guide. (3) Deprecated modules trigger automated PRs to consuming teams. (4) Module test coverage > 80% is enforced - Terratest tests must exist for all modules.

**Terragrunt at scale**: Airbnb uses Terragrunt for their multi-account AWS organization (dev, staging, prod across 30+ AWS accounts). `terragrunt run-all plan` shows the full blast radius of any change across all accounts before applying.

---

### Stripe - Compliance-First Infrastructure

Stripe manages infrastructure under PCI DSS Level 1 compliance - the strictest standard for payment processors. Every infrastructure resource must be auditable and provably compliant.

**Compliance automation**: Sentinel policies enforce PCI DSS requirements in code: all EBS volumes encrypted, no inbound 0.0.0.0/0 rules, MFA required for all IAM actions, S3 buckets not publicly accessible. A plan that violates any policy is rejected automatically - no human override possible.

**Audit trail**: Terraform Cloud's audit log captures every plan, apply, and state change with the identity of who triggered it. This audit trail satisfies PCI DSS requirement 10.2 (audit log of administrator activities).

---

### Junior → FAANG: Lessons from Company Case Studies

Each case study above maps to a real interview question. The HashiCorp case ("providers are written in Go") surfaces in questions like "how would you automate infrastructure management for an internal API that has no Terraform provider?" The answer: write a Terraform provider in Go using `terraform-plugin-framework`. This is a realistic task for a senior engineer, but knowing it exists separates you from candidates who default to `null_resource` with shell scripts.

The Uber case (state files reaching 100MB) surfaces in the question "how do you scale Terraform for a team of 50 engineers?" State sharding with strict ownership boundaries is the correct answer. One monolithic state is not an option beyond a few dozen resources.

The Airbnb case (module test coverage > 80%) surfaces in "how do you ensure infrastructure quality at scale?" The answer involves Terratest as a merge gate, not an optional practice. Knowing that a real company enforces coverage thresholds on infrastructure code makes this a concrete reference rather than an abstract principle.

### Senior @ FAANG: Extracting Platform Patterns from Case Studies

The four companies above represent four distinct organizational models for IaC governance. At staff level, you recognize which model fits your organization's scale and choose accordingly rather than copying patterns wholesale.

**HashiCorp's internal platform model.** The "no-code provisioning" pattern (a developer fills in a form, Terraform runs automatically) is the ultimate expression of platform engineering: the infrastructure interface is so well-abstracted that consumers do not need to know Terraform exists. This requires mature, thoroughly tested modules with clear variable surfaces, and an organization where the platform team's reliability targets are as strict as production services. At L7, you evaluate whether your organization's module library is mature enough to expose this interface or whether it would create a false sense of safety.

**Uber's scale-first model.** The key architectural insight from Uber is that 100MB state files are not a storage problem. They are a team structure problem. When a state file grows that large, it means multiple teams are sharing a state boundary that should be separated. The OPA policies blocking prod applies outside approved pipelines is the enforcement layer for a principle that sounds obvious but is hard to enforce without tooling: production changes require automation review, not just human review. At L6, you build this enforcement layer before you need it rather than after your first unauthorized production change.

**Airbnb's software engineering model.** Treating infrastructure as software (code review, unit tests, CI/CD, deprecation) is the correct model for organizations where infrastructure changes as frequently as application code. The "deprecated modules trigger automated PRs to consuming teams" pattern requires investment in automation tooling (a bot that can create PRs in 50 repositories) but pays off by preventing the common scenario where deprecated infrastructure patterns persist for years because no one knows which teams are using them.

**Stripe's compliance-first model.** Sentinel policies with "no human override possible" is not just a security best practice. It is a compliance architecture decision. PCI DSS Level 1 requires that security controls cannot be bypassed by any individual, regardless of their role. Encoding this in Sentinel makes the control provably automatic to auditors rather than relying on process documentation that humans can circumvent. At L6, you evaluate which of your infrastructure invariants require this level of enforcement and design the policy layer accordingly.
