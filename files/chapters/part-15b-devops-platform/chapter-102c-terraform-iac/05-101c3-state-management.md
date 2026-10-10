## 102C.3 State Management

### Remote State with S3 + DynamoDB

Remote state solves the local-state problem. A `.tfstate` file on a single developer's laptop that no one else can safely use concurrently. Storing state in S3 with DynamoDB locking gives you object versioning for rollback, server-side encryption for security, and atomic distributed locking so two concurrent `terraform apply` runs cannot corrupt the state file by writing simultaneously. The bootstrap below creates the S3 bucket and DynamoDB table themselves using Terraform, solving the chicken-and-egg problem by using a separate bootstrap configuration that runs only once.

```hcl
# Bootstrap: create state bucket and lock table BEFORE using them as backend
# This is a chicken-and-egg problem - solve it with a separate bootstrap config

# bootstrap/main.tf
resource "aws_s3_bucket" "terraform_state" {
  bucket = "mycompany-terraform-state-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.terraform_state.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.terraform_state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "aws:kms"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket = aws_s3_bucket.terraform_state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_dynamodb_table" "terraform_lock" {
  name         = "terraform-state-lock"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }
}
```

### Workspaces vs Separate State Files

Terraform workspaces create logically separate state files within the same backend configuration, but they share the same provider configuration and module code, making environment-specific differences harder to manage. Separate state file paths per environment (achieved with Terragrunt or manual backend config) give full isolation: different IAM roles, different bucket paths, and independent blast radii. For production workloads, separate state files are almost always the right choice.

```bash
# Workspaces: same config, different state
terraform workspace new staging
terraform workspace select staging
terraform apply  # uses staging.tfstate

# Problem: workspaces share the same backend config
# and it's easy to accidentally apply to the wrong workspace

# Better pattern: separate state files per environment
# dev/terraform.tfstate
# staging/terraform.tfstate
# prod/terraform.tfstate

# Achieved with Terragrunt or separate backend configs per env
```

### State Commands

State manipulation commands are necessary when refactoring Terraform configurations or importing infrastructure that was created outside of Terraform. `terraform import` brings an existing resource under Terraform management without recreating it. `terraform state mv` renames or restructures resources within the state, which is essential when extracting resources into a module. Always take a state backup before running any manual state commands, since mistakes can leave Terraform unable to track resources it was managing.

```bash
# Import existing resources into Terraform state
terraform import aws_instance.app i-1234567890abcdef0

# Move resource in state (e.g., when refactoring module structure)
terraform state mv aws_instance.app module.app.aws_instance.main

# Remove resource from state without destroying it
# Useful when transferring ownership between Terraform configs
terraform state rm aws_instance.old_app

# Show all resources in state
terraform state list

# Show specific resource state
terraform state show aws_db_instance.main

# Manual state lock release (if apply was interrupted)
terraform force-unlock LOCK_ID
```

### Cross-Stack References with Remote State

Splitting a large Terraform configuration into separate stacks (networking, databases, applications) reduces blast radius and speeds up plan/apply cycles. Cross-stack references let one stack consume outputs from another via `data "terraform_remote_state"`, which reads the state file directly from S3 without requiring a separate API call or shared variable file. This is the canonical way to pass a VPC ID or subnet list from the networking stack into the application stack.

```hcl
# networking/outputs.tf
output "vpc_id" {
  value = aws_vpc.main.id
}
output "private_subnet_ids" {
  value = aws_subnet.private[*].id
}

# app/main.tf - read outputs from networking stack
data "terraform_remote_state" "networking" {
  backend = "s3"
  config = {
    bucket = "mycompany-terraform-state"
    key    = "${var.environment}/networking/terraform.tfstate"
    region = "us-east-1"
  }
}

resource "aws_ecs_service" "app" {
  # Use VPC from networking stack
  network_configuration {
    subnets         = data.terraform_remote_state.networking.outputs.private_subnet_ids
    security_groups = [aws_security_group.app.id]
  }
}
```

---

### Junior → FAANG: State Management as Your First Reliability Responsibility

The most irreversible mistake a junior engineer can make with Terraform is running it against production from a laptop with local state. If your laptop dies or your colleague runs apply from their machine at the same time, you have a corruption problem with no lock and no shared truth. Before touching any team environment, confirm that remote state is configured and that the DynamoDB lock table exists.

The `terraform state` commands above (list, show, mv, rm, import) are tools you use for refactoring and recovery, not for day-to-day work. In interviews, you will be asked what you do when a resource was created manually and you want Terraform to manage it. The answer is: write the resource block in HCL, run `terraform import aws_resource.name <id>`, then run `terraform plan` and reconcile any attribute differences before applying. If the plan shows zero changes, the import was clean.

For the workspace vs. separate state file question: workspaces are fine for personal sandbox environments, but use separate state files (different S3 keys) for dev, staging, and prod. This gives you independent IAM roles, independent blast radii, and the ability to have different module versions in each environment.

### Senior @ FAANG: State as an Organizational Risk Surface

State files are the operational heart of your Terraform deployment. At scale, they are also a significant security and reliability risk surface that deserves dedicated architectural attention.

**State encryption in depth.** The default S3 SSE-S3 encryption is insufficient for state files that contain database credentials, private keys, and OAuth secrets. The correct configuration is SSE-KMS with a customer-managed key, key rotation enabled, and a key policy that allows only the Terraform execution role and the state bucket's IAM principal. OpenTofu 1.7+ adds client-side state encryption with AES-GCM as an additional layer, which is worth evaluating for organizations with strict data residency requirements.

**State access control as a privilege boundary.** Reading the state file is effectively the same as reading the AWS console for your entire infrastructure layer. In a large organization, not every team should be able to read every other team's state. Use separate S3 buckets per environment or per team, with IAM policies that restrict cross-team state reads. Cross-stack references via `terraform_remote_state` grant implicit read access to the full producer state, which is why the SSM parameter alternative (publishing only necessary outputs as SSM parameters) is architecturally cleaner for sensitive environments.

**The bootstrap problem as a recurring pattern.** The chicken-and-egg problem for state infrastructure (creating the S3 bucket and DynamoDB table that will store state) is the first instance of a recurring pattern in platform engineering: you cannot use the tool to provision the tool itself. The canonical solution is a separate bootstrap module with local state that runs exactly once, with the resulting resource IDs committed to a README and the S3 bucket protected with `prevent_destroy = true`. At L6, you identify all other instances of this pattern in your infrastructure (the Atlantis EKS cluster that manages EKS, the CI/CD pipeline that deploys the CI/CD pipeline) and document the manual steps required for full environment recovery.

**State surgery risk model.** Every `terraform state mv`, `terraform state rm`, and `terraform import` is a write to production infrastructure without a plan review step. At a governance-conscious organization, state surgery commands require: a backup (`terraform state pull > backup.tfstate`), a documented rollback procedure, a second engineer watching, and ideally a written runbook entry. The `terraform force-unlock` command in particular should require incident-level approval, because running it while an apply is genuinely in-progress corrupts state. Build these controls into your operational runbooks before you need them during an incident.
