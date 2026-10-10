## 102C.11 Core Terraform Interview Questions

**Q1: What is the difference between declarative and imperative IaC? Why does Terraform use declarative?**

Declarative IaC describes the desired end state. The tool figures out how to achieve it. Imperative IaC describes the steps to take. Terraform is declarative: you write "I want 3 EC2 instances of type t3.medium" and Terraform determines whether to create, update, or do nothing based on the current state. Benefits: (1) idempotency - applying the same config twice produces the same result. (2) drift detection - Terraform compares desired vs actual state and shows what's out of sync. (3) reduced cognitive load - you don't track resource lifecycle, Terraform does. The trade-off: less control over order of operations and complex workflows require workarounds (depends_on, provisioners).

---

**Q2: How does Terraform manage state? What are the risks of state file corruption?**

Terraform state tracks every resource it manages: resource type, ID, attributes, and dependencies. State enables plan to calculate diffs. Risks: (1) state file contains sensitive data (passwords, keys) - must be encrypted at rest (S3 SSE-KMS). (2) concurrent applies without locking corrupt state (DynamoDB lock table prevents this). (3) manual changes to resources cause "drift" - state says resource has attribute X, actual resource has Y. (4) state file deletion = Terraform loses track of resources (can't destroy them safely). Best practices: remote state in S3 (versioned + encrypted), DynamoDB locking, never edit state manually except with `terraform state` commands, regular state backups.

---

**Q3: Explain the difference between count and for_each. When should you use each?**

`count` creates N identical copies addressed by index (0-based). `for_each` creates named copies addressed by key (string or set element). The critical difference: with `count`, removing an item from the middle causes all subsequent items to be renumbered, triggering unnecessary destroy/recreate. With `for_each`, each resource has a stable key independent of other resources - removing one key only affects that resource. Rule of thumb: use `count` only for truly identical, unnamed resources where order doesn't matter. Use `for_each` for named resources, AZ-specific resources, per-environment configs, or any resource where stability of other instances matters when one changes.

---

**Q4: What is a Terraform module? How do you version them?**

A module is a reusable set of Terraform configurations in a directory. Modules encapsulate complex resource relationships behind a clean interface (input variables → resources → output values). Versioning: (1) local modules - no versioning, use relative paths. (2) Git modules - reference by tag (`github.com/myorg/modules//vpc?ref=v2.3.0`), semantic versioning enforced by team convention. (3) Terraform Registry - publish at `registry.terraform.io`, versions are semantic version tags on the Git repo. Breaking changes require major version bump. Consumers pin to `~> 2.0` (allows 2.x.x, blocks 3.x.x). Test modules with Terratest before publishing new versions.

---

**Q5: What is Terraform workspace? When would you use separate workspaces vs separate state files?**

Workspaces allow multiple state files from the same configuration, selectable via `terraform workspace select`. They're useful for testing - create a `test` workspace to validate changes before applying to default. However, workspaces share the same backend config and are prone to "apply to wrong workspace" mistakes. For production multi-environment setups, separate state files (different S3 keys) are safer: each environment has its own directory with its own backend config. This prevents accidental cross-environment applies. Workspaces are appropriate for: personal sandboxes, PR preview environments, load testing environments that mirror production temporarily.

---

**Q6: Explain the Terraform dependency graph. How does depends_on work?**

Terraform automatically builds a dependency graph by analyzing resource references: if resource A references `aws_vpc.main.id`, Terraform knows A depends on `aws_vpc.main` and creates it first. `depends_on` is for explicit dependencies Terraform can't infer - typically when resources have hidden dependencies not expressed as attribute references. Example: an ECS service depends on an IAM policy being attached before the first task can run, but the ECS service config doesn't directly reference the IAM attachment. `depends_on = [aws_iam_role_policy_attachment.task]` tells Terraform to wait. Overuse of `depends_on` serializes the graph unnecessarily. Prefer attribute references when possible.

---

**Q7: What is the difference between a Terraform provider and a provisioner?**

A **provider** is a plugin that manages a specific API or infrastructure platform (AWS, GCP, Kubernetes, GitHub). Providers define resource types and their CRUD operations. A **provisioner** executes scripts on local machines or remote resources AFTER they're created (e.g., running a bash script on a new EC2 instance to install software). Provisioners are considered a last resort: they don't integrate with Terraform's dependency graph, failures leave resources in unknown state, and they're not idempotent. Best practice: use provisioners only when absolutely necessary (bootstrapping a VM that can't use cloud-init), prefer cloud-native solutions (AWS SSM, user data scripts, AMI baking) instead.

---

**Q8: How do you handle Terraform at scale across a large organization?**

Key patterns: (1) **Module governance**: centralized module library with versioning, code review, and Terratest coverage - teams consume modules, don't write raw resources. (2) **Atlantis/Terraform Cloud**: automated plan on PR, approval before apply, prevents manual applies from laptops. (3) **State file sharding**: split state by team/service/environment - 100-200 resources per state file maximum. (4) **Policy-as-code**: OPA or Sentinel policies enforce security standards (no public S3, encrypted volumes, required tags) - rejected at plan time, not after deploy. (5) **Drift detection**: scheduled `terraform plan` that alerts on detected drift. (6) **Environment promotion**: changes flow through dev→staging→prod with automated testing at each stage.

---

**Q9: What is Terragrunt and what problems does it solve?**

Terragrunt is a thin wrapper around Terraform that adds: (1) **DRY backend configs** - define remote state config once in root `terragrunt.hcl`, all child modules inherit it with the path automatically added to the state key. (2) **DRY provider configs** - generate provider blocks from shared config. (3) **Dependency management** - declare dependencies between modules, Terragrunt resolves order and passes outputs as inputs. (4) **run-all commands** - apply/plan/destroy all modules in a directory tree in dependency order. (5) **Before/after hooks** - run scripts before or after terraform commands. Without Terragrunt, managing 50+ modules across 3 environments requires 150 copies of nearly identical backend config. Terragrunt reduces this to one.

---

**Q10: How do you test Terraform modules? What does Terratest actually do?**

Terratest is a Go library for testing infrastructure code. It works by: (1) calling `terraform.InitAndApply()` to create real infrastructure in a test environment. (2) making assertions about the infrastructure using AWS/GCP/etc. SDK calls. (3) calling `terraform.Destroy()` via defer to clean up after tests. Types of tests: unit tests (validate config, no real infrastructure - `terraform validate`, `tflint`), integration tests (create real resources, validate they work, destroy), end-to-end tests (deploy full stack, hit HTTP endpoints, validate responses). Terratest tests are slow (minutes to hours) and cost money (real AWS resources). Run them in CI against a dedicated test account, not production. Use `t.Parallel()` to run multiple module tests concurrently.

---

**Q11: What happens if you `terraform apply` and it fails halfway through?**

Terraform applies changes resource by resource. If it fails midway, the state file reflects the resources successfully created before the failure. On the next `terraform apply`, Terraform will try to create the remaining resources. This is usually safe because Terraform is idempotent - re-creating an already-created resource is a no-op (Terraform detects it exists in state). However, watch for: (1) resources that were partially created (an RDS instance created but not yet available - Terraform will wait for it). (2) resources with `create_before_destroy` that left an old resource running. (3) failed `null_resource` provisioners that left the resource in an inconsistent state. Always run `terraform plan` after a failed apply before re-applying.

---

**Q12: How do you import existing infrastructure into Terraform?**

`terraform import <resource_address> <resource_id>` adds an existing resource to the state file without modifying the real resource. Steps: (1) write the resource block in your `.tf` file (empty or with expected values). (2) run `terraform import aws_instance.app i-1234567890abcdef0`. (3) run `terraform plan` - it will show what attributes differ between your config and the real resource. (4) update your `.tf` to match (or accept the update plan). Caveats: import only works for resources with a single ID. Some complex resources (like IAM policies with complex ARNs) are tricky. Terraform 1.5+ introduced `import` blocks in HCL for automated imports, enabling import as part of a plan.

---

**Q13: What is the Terraform provider lock file (.terraform.lock.hcl)?**

The lock file records the exact provider versions and checksums downloaded by `terraform init`. It ensures all team members and CI pipelines use identical provider binaries. Commit it to Git. Never edit it manually. To update providers: `terraform init -upgrade` regenerates the lock file with the latest versions that satisfy your version constraints. The checksums in the lock file verify provider binary integrity - Terraform rejects any binary that doesn't match, preventing supply-chain attacks where a malicious provider is substituted.

---

**Q14: How do you handle secret rotation with Terraform?**

Terraform is not designed for frequent secret rotation (it's for provisioning, not runtime secrets management). Best pattern: (1) use `random_password` to generate initial secrets, store in Secrets Manager. (2) let Secrets Manager rotation Lambda handle ongoing rotation. (3) add `ignore_changes = [password]` to the resource so Terraform doesn't revert Secrets Manager's rotations. (4) ECS/K8s workloads fetch secrets from Secrets Manager at runtime (not baked into task definitions). Never rotate secrets by changing Terraform configs - this triggers resource recreation (e.g., RDS password change via Terraform requires a modification, not a secret rotation).

---

**Q15: Compare Terraform, Pulumi, and AWS CDK for a Go engineering team.**

Terraform: HCL declarative syntax, massive ecosystem (10,000+ modules), language-agnostic. Best for: mixed teams, using existing modules, policy-as-code with Sentinel/OPA. Learning curve: minimal for simple configs, steep for complex. Pulumi: infrastructure in Go/Python/TypeScript. Best for: Go teams who want programming language features (loops, conditionals, OOP), testing with standard Go test frameworks, integrating infra provisioning into CI code. CDK (AWS only): TypeScript/Python, generates CloudFormation internally, tightly integrated with AWS services, strong type safety. For a Go team: Pulumi's Go SDK is compelling since infra tests are regular Go tests. However, Terraform's ecosystem advantage (pre-built modules, community, documentation) means most Go teams use Terraform for infra and Go for everything else.

---

### Junior → FAANG: Building an Interview Answer Bank

The 15 questions above cover the full interview topic space for a platform or DevOps engineering role at a FAANG-tier company. For entry-level interviews (L3, L4), questions 1 through 8 are the most likely targets. You will be asked to explain declarative vs. imperative, demonstrate state management awareness, and articulate the count vs. for_each distinction.

Before any interview, practice answering Q2 (state risks) and Q11 (failed apply) out loud, not just in your head. These questions require you to walk through a scenario step by step under time pressure. The correct answer for Q11 is: run `terraform plan` to see what was created and what remains, verify the partially created resources are in a usable state, then re-run `terraform apply` to complete the remaining work. Knowing that Terraform is idempotent and will not re-create what already exists in state is the key fact.

For Q7 (provider vs. provisioner): the one-sentence summary is "providers manage API resources declaratively, provisioners run scripts imperatively and break idempotency." This sentence alone separates candidates who understand Terraform's design philosophy from those who have just run a few tutorials.

### Senior @ FAANG: Interview Questions as System Design Prompts

At L6, the 15 questions above are table stakes, not differentiators. The bar-raiser interview adds system design dimensions to each one. Q8 (scale across a large organization) is the canonical L6 system design prompt. The complete answer addresses six layers: module governance as an internal product with a registry, semantic versioning, and a stability tier. State topology as a design artifact with blast radius boundaries. Automation as the primary enforcement mechanism (Atlantis, OPA, tflint, Checkov) rather than code review. Drift detection as a reliability metric tracked over time. Account vending as the foundation that makes everything else scalable. And GitOps as the final state where Terraform is the only door into production.

Q14 (secret rotation) at L6 becomes a question about the trust model between the provisioning layer and the runtime secrets management layer. The complete answer distinguishes three categories: secrets that Terraform provisions once and never touches again (initial database passwords handed off to Secrets Manager rotation), secrets that are read at runtime and never stored in state (application API keys fetched from Secrets Manager by the container at startup), and secrets that Terraform must manage throughout their lifecycle (TLS certificates managed by ACM with automatic renewal). Each category requires a different HCL pattern and a different operational model. Being able to articulate this taxonomy is an L6-level response.

Q15 (tool comparison) at L6 is an ADR prompt. The expected output is not a pros-and-cons list but a decision with rationale: "Given that our team is 80% Go engineers, our modules are becoming too complex for HCL loops, and we want `go test` to cover infrastructure without a Terratest framework, we should migrate new platform modules to CDKTF while maintaining existing HCL modules. The migration criterion is complexity: any module requiring more than two levels of nested dynamic blocks is a CDKTF candidate." This kind of structured decision with migration criteria is what separates L6 answers from L4 answers.
