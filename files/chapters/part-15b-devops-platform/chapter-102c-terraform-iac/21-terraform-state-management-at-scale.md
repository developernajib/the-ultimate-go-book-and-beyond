## 102C.19 Terraform State Management at Scale

### Remote State with S3 and DynamoDB Locking

The S3+DynamoDB backend is the most widely deployed remote state solution for AWS, providing object versioning (state recovery), server-side encryption, and atomic locking via DynamoDB conditional writes:

```hcl
# backend.tf
terraform {
  backend "s3" {
    bucket         = "my-org-terraform-state-prod"
    key            = "services/payment-service/terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true
    kms_key_id     = "arn:aws:kms:us-east-1:123456789:key/abc123"
    dynamodb_table = "terraform-state-locks"
    role_arn       = "arn:aws:iam::123456789:role/TerraformStateAccessRole"
  }
}
```

Bootstrap the S3 bucket and DynamoDB table once with a separate local-state configuration:

```hcl
# bootstrap/main.tf -- apply ONCE manually with local backend
resource "aws_s3_bucket" "terraform_state" {
  bucket    = "my-org-terraform-state-${data.aws_caller_identity.current.account_id}"
  lifecycle { prevent_destroy = true }
}

resource "aws_s3_bucket_versioning" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id
  versioning_configuration { status = "Enabled" }  # Required for state recovery
}

resource "aws_s3_bucket_server_side_encryption_configuration" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.terraform_state.arn
    }
  }
}

resource "aws_s3_bucket_public_access_block" "terraform_state" {
  bucket                  = aws_s3_bucket.terraform_state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_dynamodb_table" "terraform_state_locks" {
  name         = "terraform-state-locks"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"
  attribute    { name = "LockID"; type = "S" }
  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.terraform_state.arn
  }
  lifecycle { prevent_destroy = true }
}
```

### State Splitting Strategies

**Anti-pattern**: a single monolithic state file for all infrastructure. Every plan touches all 500+ resources, plans take 10+ minutes, and a mistake in one service can lock state for the entire organization.

**Split by lifecycle**, the recommended approach for most organizations:

```
state/
├── networking/terraform.tfstate         # VPC, subnets, routes -- changes: quarterly
├── platform/terraform.tfstate           # EKS, RDS, ElastiCache -- changes: monthly
├── services/
│   ├── payment-service/terraform.tfstate
│   ├── user-service/terraform.tfstate
│   └── api-gateway/terraform.tfstate    # Changes: every deployment
└── monitoring/terraform.tfstate         # Dashboards, alarms -- changes: weekly
```

Cross-state data sharing via `terraform_remote_state`:

```hcl
data "terraform_remote_state" "networking" {
  backend = "s3"
  config = {
    bucket = "my-org-terraform-state-prod"
    key    = "networking/terraform.tfstate"
    region = "us-east-1"
  }
}

resource "aws_ecs_service" "payment" {
  network_configuration {
    subnets = data.terraform_remote_state.networking.outputs.private_subnet_ids
  }
  cluster = data.terraform_remote_state.platform.outputs.ecs_cluster_arn
}
```

### State Migration Patterns

State migration moves an existing Terraform configuration's state from one backend to another. Typically from local storage to S3 when onboarding a team to remote state, or from one S3 prefix to another when reorganizing stacks. The migration procedure involves adding the new backend block to `backend.tf`, running `terraform init -migrate-state` which prompts Terraform to copy the existing state to the new location, and verifying with `terraform state list` that all resources are visible in the new backend. Never delete the old state file until you have confirmed the migration succeeded.

```bash
# Migrate from local backend to S3: add backend block to backend.tf, then:
terraform init -migrate-state
# Terraform prompts: "Do you want to copy existing state to the new backend? yes"

# Migrate between S3 key paths (reorganizing state layout):
terraform state pull > old-state.tfstate
# Update key in backend.tf to new path
terraform init -reconfigure
terraform state push old-state.tfstate
terraform plan   # Must show: No changes.
```

### State Surgery: rm, mv, and import

**`terraform state rm`** removes resources from state without destroying real infrastructure, use to "forget" resources that will be managed elsewhere:

```bash
terraform state rm aws_instance.legacy_app     # Single resource
terraform state rm module.old_module            # Entire module subtree
terraform state list | grep module.old          # List before surgery
```

**`terraform state mv`** moves resources to new addresses, essential when refactoring module structure:

```bash
# Rename without destroy/recreate
terraform state mv aws_security_group.app aws_security_group.application

# Move root resource into a module
terraform state mv aws_iam_role.ecs_task module.ecs.aws_iam_role.task

# Cross-state move (different tfstate file)
terraform state mv \
  -state-out=../new-module/terraform.tfstate \
  module.shared.aws_ecs_cluster.main \
  aws_ecs_cluster.main
```

**HCL-based import** (Terraform 1.5+), declare imports in `.tf` files alongside regular resources:

```hcl
# import.tf -- plan-time import declarations
import {
  to = aws_security_group.existing_sg
  id = "sg-0abc123def456"
}
import {
  to = aws_route53_record.api_dns
  id = "Z1234567890/api.example.com/A"
}
import {
  to = module.eks.aws_eks_cluster.main
  id = "my-existing-cluster"
}
```

Run `terraform plan` to see the generated configuration diff, then `terraform apply` to add resources to state without modifying them.

### Atlantis for PR-Based Terraform Workflows

Atlantis enforces the most important production Terraform rule: **no human runs `terraform apply` locally against production**. All infrastructure changes flow through reviewed pull requests with attached plan output.

```yaml
# atlantis.yaml
version: 3
automerge: false

projects:
  - name: networking
    dir: infrastructure/networking
    workspace: default
    terraform_version: v1.6.0
    autoplan:
      when_modified: ["*.tf", "*.tfvars", "../modules/**/*.tf"]
      enabled: true
    apply_requirements:
      - approved
      - mergeable

  - name: production-services
    dir: infrastructure/services
    workspace: production
    terraform_version: v1.6.0
    apply_requirements:
      - approved
      - mergeable
      - undiverged   # Require branch up-to-date before apply
```

Workflow:
1. Engineer opens a PR modifying `.tf` files
2. Atlantis auto-runs `terraform plan` and posts the plan diff as a PR comment
3. Reviewer reads the plan output and approves the PR
4. Engineer comments `atlantis apply -p networking` on the PR
5. Atlantis runs `terraform apply` and posts the result
6. PR is merged, full audit trail in GitHub (every change has a linked plan and apply)

---

### Junior → FAANG: State Management as Your Professional Foundation

Every concept in this section is foundational. Before you deploy to any team environment, be able to answer these three questions from memory: where is the state file stored (S3 bucket name and key path), how is concurrent access prevented (DynamoDB lock table name), and what is the recovery procedure if the state is corrupted (restore from S3 versioned backup, verify with `terraform plan`, expect zero changes).

The state surgery commands (`state rm`, `state mv`, import blocks) are the tools for refactoring infrastructure without downtime. The mental model is: these commands change Terraform's record of what exists, not the actual infrastructure. `state rm` makes Terraform forget a resource (it still exists in AWS). `state mv` makes Terraform rename its record (the resource is unchanged). Import adds a record for something Terraform was not previously tracking. Every state surgery operation should be preceded by `terraform state pull > backup.tfstate` to create a recovery point you can restore with `terraform state push` if the surgery goes wrong.

For the Atlantis workflow: understand that Atlantis is not just a convenience tool. It is an audit and enforcement layer. The PR comment history becomes the complete record of every plan that was reviewed and every apply that was executed, linked to the code change that triggered it. This is the audit trail that satisfies SOC 2 requirements for infrastructure change management.

### Senior @ FAANG: State at Organizational Scale

At L6, state management is a platform design problem, not a configuration problem. The architectural decisions made here determine the throughput, blast radius, and security posture of the entire IaC platform.

**State topology as a team structure mirror.** Conway's Law applies to state files: the structure of your state topology will mirror the structure of your organization's team boundaries. If networking, data, and compute are owned by separate teams, they should have separate state files. If a single platform team owns all foundational infrastructure, a shared foundational state file with strict access control may be appropriate. At L6, you make this mapping explicit: draw the org chart, map teams to infrastructure components, and define state file boundaries that give each team independent apply authority without requiring cross-team coordination for routine changes.

**The Atlantis deployment model as a trust boundary.** Atlantis is a privileged component: it holds AWS credentials with broad apply permissions and runs arbitrary Terraform code submitted via pull requests. Securing Atlantis requires: running it in a dedicated namespace with its own IAM role (not shared with other workloads), validating that plan output matches the current state of the target branch before apply (the `undiverged` requirement in `atlantis.yaml`), restricting which repositories can trigger Atlantis plans and applies, and audit logging every Atlantis action to a SIEM. At bar-raiser level, you describe Atlantis as a trusted execution environment and articulate the threat model: what can a malicious PR author cause Atlantis to execute, and what controls prevent it?

**State migration as a zero-downtime operation.** The state migration commands in this section (pull, push, init -migrate-state) are operations that must be executable without stopping ongoing development. At scale, this requires a migration procedure that tolerates concurrent plans: freeze the source stack by merging a no-op PR to the source branch, perform the migration, verify zero changes in the destination, then unfreeze. Document this procedure as a runbook before you need it during an incident, because state migrations under pressure are the most common source of state corruption in production IaC platforms.
