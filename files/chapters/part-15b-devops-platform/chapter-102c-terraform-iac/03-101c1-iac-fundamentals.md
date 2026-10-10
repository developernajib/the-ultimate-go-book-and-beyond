## 102C.1 IaC Fundamentals

### Declarative vs Imperative

Infrastructure as Code (IaC) can be written imperatively. As a sequence of shell commands that create resources. Or declaratively, where you describe the desired end state and let a tool figure out the steps. Terraform uses the declarative model: you write HCL that defines what resources should exist, and Terraform computes a diff against the current state to determine what to create, update, or delete. The critical advantage is idempotency. Running `terraform apply` twice produces the same result, whereas running an imperative script twice often creates duplicate resources.

```
Imperative (scripts):
  aws ec2 run-instances --image-id ami-xxx --instance-type t3.medium
  aws ec2 describe-instances --filters Name=instance-state-name,Values=running

  Problem: You must know WHAT to do AND HOW to do it.
  If the instance already exists, the script creates a duplicate.

Declarative (Terraform):
  resource "aws_instance" "app" {
    ami           = "ami-xxx"
    instance_type = "t3.medium"
  }

  Terraform figures out: create, update, or do nothing based on current state.
  Apply twice → idempotent, same result.
```

### The Terraform Workflow

Every Terraform change follows a predictable four-step lifecycle: write, init, plan, apply. The `plan` step is the safety net. It shows exactly which resources will be created, modified, or destroyed before any change is committed. The state file is Terraform's source of truth about what it has already created. Never edit it manually, and always store it in a remote backend so that teams can collaborate safely.

```
1. Write HCL → define desired state
2. terraform init → download providers, set up backend
3. terraform plan → diff: desired state vs actual state
4. terraform apply → create/update/delete resources to match desired state
5. State file → Terraform's record of what it created

Key principle: Terraform manages the LIFECYCLE of resources.
You never manually change infrastructure that Terraform manages  - 
manual changes cause "drift" that terraform plan will detect and want to revert.
```

---

### Junior → FAANG: Building the Declarative Mental Model

The hardest conceptual leap for engineers new to Terraform is letting go of imperative thinking. When you write a bash script to create an EC2 instance, you think: "run this command." When Terraform applies the same resource, it thinks: "what is the gap between desired state and current state, and what is the minimal set of API calls to close that gap?" This difference has a practical consequence at your first job: you should never write `null_resource` blocks with shell commands to work around HCL limitations. Every time you reach for a provisioner or a local-exec, you are importing imperative thinking into a declarative system, and the result breaks idempotency.

For entry-level interviews, practice the four-step lifecycle from memory: write, init, plan, apply. Be ready to explain what happens on the second `terraform apply` with no changes (exit code 0, "No changes. Infrastructure is up-to-date.") and why that outcome is the correct one. Interviewers use this question to filter candidates who have actually run Terraform from those who have only read documentation.

The drift concept is equally important. If someone changes a security group rule in the AWS console, the next `terraform plan` will show a change to revert it. Being able to explain this as "Terraform's desired state in HCL diverged from the actual state in AWS, so the plan shows the delta" is the correct answer.

### Senior @ FAANG: Idempotency Contracts and Drift as an Operational Signal

At senior level, idempotency is not just a property to appreciate. It is a contract to enforce. Modules that are not idempotent (they produce a non-empty plan on the second apply with no input changes) are production liabilities. Every CI pipeline at a mature organization includes an idempotency check: apply, then immediately plan again and assert exit code 0. Any module failing this check is blocked from merging.

The imperative-vs-declarative distinction has organizational implications beyond individual code quality. Organizations that start with Terraform but allow ad-hoc console modifications as a "quick fix" pattern accumulate drift that grows faster than the team's capacity to reconcile it. At L6, you design the guardrails that prevent this: AWS SCPs that block console modifications of Terraform-managed resources in production, Terraform-managed tag policies that mark every resource with `ManagedBy=terraform`, and a scheduled drift detection pipeline that alerts when the real world diverges from the declared state.

The lifecycle metadata argument, specifically `ignore_changes`, is a nuanced production tool. It is correct for credentials managed externally (database passwords rotated by Lambda) and for autoscaling state (desired_count managed by the autoscaler rather than Terraform). It is wrong when engineers add it to suppress plan noise caused by a poorly designed module. At bar-raiser reviews, the question "why do you have this ignore_changes?" should have a precise, documented answer, not "it was causing noise."
