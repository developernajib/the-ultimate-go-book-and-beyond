## 102C.10 Mid-Chapter Synthesis: IaC Anti-Patterns

### 1. Using count Instead of for_each for Named Resources

When `count` is used with a list, Terraform addresses each resource by its numeric index, so removing an element in the middle causes every subsequent resource to be re-indexed and recreated. Switching to `for_each` with a set or map makes each resource identity stable and keyed by a meaningful value. Here the availability zone name. So removing one zone destroys only that specific subnet without touching the others.

```hcl
# WRONG: deleting az[1] renumbers az[2] and az[3] → destroys and recreates them
resource "aws_subnet" "private" {
  count  = 3
  vpc_id = aws_vpc.main.id
  cidr_block = cidrsubnet(var.vpc_cidr, 8, count.index)
}

# CORRECT: deleting an AZ only affects that specific subnet
resource "aws_subnet" "private" {
  for_each          = toset(var.availability_zones)
  vpc_id            = aws_vpc.main.id
  availability_zone = each.key
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, index(var.availability_zones, each.key))
}
```

### 2. Hardcoding Sensitive Values

Hardcoded secrets in Terraform configuration end up in two places you cannot easily purge them from: version control history and the Terraform state file. The correct approach generates a cryptographically random password with Terraform's `random_password` resource, stores it in AWS Secrets Manager, and references it in the database resource so the secret never appears in plain text in your repository.

```hcl
# WRONG: secrets in version control
resource "aws_db_instance" "main" {
  password = "SuperSecret123!"  # visible in state file AND git history
}

# CORRECT: use Secrets Manager + random password
resource "random_password" "db" {
  length  = 32
  special = true
}

resource "aws_secretsmanager_secret_version" "db_password" {
  secret_id     = aws_secretsmanager_secret.db_password.id
  secret_string = random_password.db.result
}

resource "aws_db_instance" "main" {
  password = random_password.db.result  # stored in state, but state is encrypted
}
```

### 3. Not Using `lifecycle { prevent_destroy = true }` on Critical Resources

Without destroy protection, a `terraform destroy`, a misconfigured module, or an accidental refactor can silently delete your production database. The `prevent_destroy = true` lifecycle attribute causes Terraform to fail with an explicit error if any plan would destroy the resource, requiring the engineer to deliberately remove the guard before the destruction can proceed. Adding a mandatory human checkpoint for irreversible operations.

```hcl
# Without prevent_destroy: terraform destroy removes your production database
resource "aws_db_instance" "main" {
  identifier = "prod-db"

  lifecycle {
    prevent_destroy = true  # requires explicit removal before resource can be destroyed
  }
}
```

### 4. Not Pinning Provider Versions

Unpinned Terraform providers download the latest available version on each `terraform init`, meaning a major provider release can silently introduce breaking changes into your configuration with no code change on your part. The `~>` pessimistic constraint operator pins to a specific minor version while still allowing patch-level updates, giving you security fixes without the risk of unexpected API or behavior changes.

```hcl
# WRONG: unpinned providers can introduce breaking changes
terraform {
  required_providers {
    aws = {
      source = "hashicorp/aws"
    }
  }
}

# CORRECT: pin to minor version, allow patch updates
terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.40"  # allows 5.40.x but not 6.x
    }
  }
}
```

### 5. Storing State Locally

Local state works for individual experimentation but breaks down the moment more than one person or CI pipeline runs Terraform, because there is no shared view of current infrastructure and no locking to prevent concurrent applies from corrupting state. The S3 backend with a DynamoDB lock table provides shared, encrypted, versioned state storage where `dynamodb_table` serializes concurrent operations and `encrypt = true` ensures secrets in the state file are never stored in plain text.

```hcl
# WRONG: local state can't be shared, no locking, no backup
# (just missing backend config = uses local state)

# CORRECT: always use remote state for team environments
terraform {
  backend "s3" {
    bucket         = "my-terraform-state"
    key            = "prod/app/terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true
    dynamodb_table = "terraform-state-lock"
  }
}
```

### 6. Not Using `terraform plan` Output in CI Before Apply

Running `terraform apply -auto-approve` in CI bypasses the plan review step, meaning infrastructure changes are applied without any human verification of what will be created, modified, or destroyed. The correct pattern saves the plan to a file with `-out=tfplan`, posts the plan output as a PR comment for review, then applies exactly that pre-approved plan. Ensuring the apply step executes the reviewed diff and nothing else.

```yaml
# WRONG CI pipeline:
- run: terraform apply -auto-approve

# CORRECT: always review plan before apply
- run: terraform plan -out=tfplan
- run: # Human reviews plan output in PR comment
- run: terraform apply tfplan  # apply the reviewed plan only
```

### 7. Giant Monolithic State Files

Putting all infrastructure in one state file creates: long plan times, high blast radius on mistakes, difficult collaboration across teams.

```
# WRONG: one state for everything
main.tf  # 5000 lines, manages VPC + ECS + RDS + ElastiCache + IAM + Route53 + ...

# CORRECT: separate state per layer/service
networking/  # VPC, subnets, route tables
security/    # IAM roles, policies, KMS keys
databases/   # RDS, ElastiCache
services/    # ECS clusters and services
```

### 8. Not Running Terraform in CI/CD

Manual `terraform apply` from laptops leads to: configuration drift (unapplied changes), unclear who changed what, inability to audit changes, and accidental production changes.

```yaml
# Use Atlantis, Terraform Cloud, or GitHub Actions:
name: Terraform
on:
  pull_request:
    paths: ['terraform/**']
  push:
    branches: [main]

jobs:
  plan:
    runs-on: ubuntu-latest
    steps:
      - uses: hashicorp/setup-terraform@v3
        with:
          terraform_version: 1.7.0
      - run: terraform init
      - run: terraform plan -out=tfplan
        env:
          AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
```

---

### Junior → FAANG: Mistakes That End Careers Early

The mistakes catalogd above are not theoretical. Each one has caused a production incident at a real company. Junior engineers who internalize them before their first IaC role avoid the most common failure modes that damage reputations early in a career.

The two highest-impact mistakes to eliminate immediately are hardcoded secrets and local state. A secret committed to version control is permanently compromised, even after a `git rebase` to remove it, because the history exists in forks and pull request snapshots. Always use `random_password` plus Secrets Manager from day one. Local state is not a temporary shortcut. It is a team reliability risk. If you inherit a repo with local state files, migrating to S3 + DynamoDB is the first task to propose in your first week.

For the `count` versus `for_each` mistake: this is the question that appears most frequently in Terraform interviews and code reviews. If you can explain the index-stability problem clearly and correct it in code, you demonstrate real hands-on experience. Practice the correction until it is automatic.

The missing `lifecycle { prevent_destroy = true }` mistake is the hardest to recover from. An accidentally destroyed RDS instance in production requires a snapshot restore, a DNS update, a cache warm-up period, and usually a customer-visible incident. Adding two lines of HCL prevents all of this. Treat it as mandatory for any stateful resource.

### Senior @ FAANG: From Mistake Patterns to Organizational Controls

At L6, your job is not to avoid these mistakes yourself. It is to make them structurally impossible for 200 engineers to make. Each mistake in this list maps to a systemic control:

**Hardcoded credentials.** The control is OIDC federation for CI/CD and IAM roles for all runtime execution. There are zero scenarios where a long-lived AWS access key should appear in any configuration file. Enforce this with a `tfsec` or Checkov policy that blocks any file containing `access_key` or `secret_key` attribute assignments. Run this check on every PR before plan output is generated.

**count vs for_each.** The control is `tflint` with the `aws_resource_missing_tags` and custom rules that flag `count` usage on resources that have a name or identifier variable. This catches the anti-pattern before it reaches review. Write the rule once, enforce it across all repositories in your organization.

**Missing prevent_destroy.** The control is an OPA policy that asserts any `aws_db_instance`, `aws_rds_cluster`, `aws_elasticache_replication_group`, `aws_s3_bucket` (with data), and `aws_dynamodb_table` resource in any workspace tagged `environment=production` must have `lifecycle { prevent_destroy = true }`. The policy runs in CI and blocks merge if violated. This converts a human memory requirement into an automated gate.

**CI/CD enforcement.** The control is removing IAM permissions from all human principals for `terraform apply` in production accounts. The only IAM principal with apply permissions is the Atlantis or Terraform Cloud service role. Engineers cannot apply from laptops because they do not have the permissions to do so. This is the zero-trust model applied to infrastructure changes: assume every engineer will make a mistake under pressure, and design controls that make the mistake impossible rather than relying on discipline.
