## 102C.21 Production Drift & State Pitfalls

### Anti-Pattern 1: Hardcoded Credentials in Provider Configuration

```hcl
# WRONG -- long-lived credentials committed to version control
provider "aws" {
  access_key = "AKIAIOSFODNN7EXAMPLE"
  secret_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
  region     = "us-east-1"
}
```

**Solution**: Use IAM instance roles (for EC2/ECS), AWS named profiles (for local development), or OIDC federation for CI/CD (zero long-lived credentials):

```yaml
# GitHub Actions: OIDC -- no AWS access keys stored anywhere
- uses: aws-actions/configure-aws-credentials@v4
  with:
    role-to-assume: arn:aws:iam::123456789:role/GitHubActionsDeployRole
    aws-region: us-east-1
```

```hcl
# CORRECT -- no credentials in code - resolved from execution environment
provider "aws" {
  region = var.aws_region
  # Resolution order: IAM role > env vars > ~/.aws/credentials > instance profile
}
```

---

### Anti-Pattern 2: Using count with Lists (Index Instability)

```hcl
# WRONG -- inserting or removing an element shifts all subsequent indexes
variable "environments" { default = ["a", "b", "c"] }

resource "aws_s3_bucket" "env" {
  count  = length(var.environments)
  bucket = "my-app-${var.environments[count.index]}"
}
# Removing "b" shifts "c" from index 2 to index 1:
# Terraform destroys aws_s3_bucket.env[2] and recreates it as aws_s3_bucket.env[1]
```

**Solution**: Use `for_each` with a set, the element value becomes the stable resource key:

```hcl
# CORRECT -- removing "b" only destroys the "b" bucket; "c" is untouched
variable "environments" {
  type    = set(string)
  default = ["a", "b", "c"]
}

resource "aws_s3_bucket" "env" {
  for_each = var.environments
  bucket   = "my-app-${each.value}"
}
```

---

### Anti-Pattern 3: Sensitive Values in Outputs Without Marking Them Sensitive

```hcl
# WRONG -- RDS password printed in plan output and visible in Terraform Cloud UI
output "db_password" {
  value = aws_db_instance.main.password
}
```

**Solution**: Mark sensitive or, better, avoid outputting secrets at all:

```hcl
# RECOMMENDED -- output the Secrets Manager ARN - applications fetch at runtime
output "db_secret_arn" {
  value       = aws_secretsmanager_secret.db.arn
  description = "ARN of the Secrets Manager secret containing DB credentials"
}

# ACCEPTABLE if you must output it -- redacted in logs - still stored in state file
output "db_password" {
  value     = aws_db_instance.main.password
  sensitive = true
}
```

---

### Anti-Pattern 4: Monolithic Modules

```
# WRONG -- one 1500-line module manages all infrastructure
modules/everything/
├── vpc.tf         # 200 lines
├── eks.tf         # 300 lines
├── rds.tf         # 150 lines
├── iam.tf         # 400 lines
└── monitoring.tf  # 200 lines
# Result: 15-minute plans, 1000-resource blast radius, untestable in isolation
```

**Solution**: Single-responsibility modules composed at the environment level:

```
modules/
├── vpc/           # VPC, subnets, routing, gateways only
├── eks-cluster/   # EKS control plane and node groups only
├── rds-postgres/  # RDS instance, subnet group, parameter group only
└── iam-roles/     # IAM roles and policies only

environments/production/
└── main.tf        # Composes modules; each module plans in < 30 seconds
```

---

### Anti-Pattern 5: Unpinned Provider Versions

```hcl
# WRONG -- silent major version upgrades break configurations on terraform init -upgrade
terraform {
  required_providers {
    aws = { source = "hashicorp/aws" }
  }
}
```

The AWS provider v4 to v5 upgrade introduced breaking changes: S3 bucket ACL arguments removed (moved to separate resources), IAM policy attachment changes, and authentication modifications. Teams on unpinned versions had production apply failures.

**Solution**: Pin providers with pessimistic constraints and commit `.terraform.lock.hcl` to version control:

```hcl
terraform {
  required_version = ">= 1.5, < 2.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.31"   # Accepts 5.31.x patches; blocks 6.x
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.25"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 2.12"
    }
  }
}
# To upgrade providers deliberately: terraform init -upgrade && review the changelog
```

---

### Junior → FAANG: Anti-Patterns as Interview Signals

Each anti-pattern in this section is a question that interviewers use to screen for real production experience. If you have encountered and corrected each of these in a real codebase, you have concrete stories to tell. If you have not, you can still demonstrate awareness by explaining the failure mode and the correct solution.

For Anti-Pattern 1 (hardcoded credentials): the OIDC federation approach in the solution is the current best practice and is actively tested in AWS security certifications and platform engineering interviews. Being able to explain "OIDC federation lets GitHub Actions assume an IAM role without storing any long-lived AWS credentials in GitHub Secrets" places you in the top quartile of candidates for infrastructure roles.

For Anti-Pattern 3 (sensitive outputs): the recommended solution is "output the Secrets Manager ARN, not the secret value." This is the correct answer that demonstrates security awareness beyond just marking outputs `sensitive = true`. The deeper principle is that secrets should never appear in Terraform state at all, and the ARN-based pattern achieves this.

For Anti-Pattern 4 (monolithic modules): the single-responsibility module composition pattern is the key message. Each module should plan in under 30 seconds with a blast radius of under 50 resources. If you encounter a module that takes 15 minutes to plan, the correct response is to propose splitting it, not to optimize the plan command.

### Senior @ FAANG: Anti-Patterns as Organizational Failure Modes

At L6, the five anti-patterns above are not just individual mistakes. They are symptoms of organizational failures in IaC governance. Each one points to a missing control.

**Hardcoded credentials** indicates that the platform team has not provided a zero-credential path for CI/CD. Engineers use long-lived credentials because OIDC federation was never set up. The fix is not to tell engineers "stop doing that". It is to make the correct path the only available path. Remove IAM user programmatic access keys from the CI/CD account entirely, leaving OIDC as the only authentication mechanism. Engineers adopt the correct pattern because there is no alternative.

**count with list instability** indicates that the module review checklist does not include a check for this pattern. At L6, you add a `tflint` rule that flags `count = length(var.<list_variable>)` when the resource has a name or identifier attribute (indicating it is not a truly anonymous resource). The linter runs in CI and blocks the PR. The anti-pattern becomes unmerge-able without a documented exception.

**Sensitive values in unmarked outputs** indicates that the security scanning step is missing from the CI pipeline. `tfsec` and Checkov both have rules that detect known-sensitive resource attributes in non-sensitive outputs. Adding these tools to the plan stage (not just the apply stage) catches this class of mistake before any human reviews the plan.

**Monolithic modules** indicates that the module governance model has no blast radius limit. At L6, you define an explicit limit: no module manages more than 100 resources in a single apply. This limit is enforced by a `terraform state list | wc -l` check in the module CI pipeline. Modules approaching the limit trigger a review conversation about splitting them before they exceed it. The limit is documented in the module governance guide with the rationale: a 100-resource module takes under 90 seconds to plan, can be Terratest-tested in a bounded time window, and has a manageable blast radius in the event of a plan error.

**Unpinned provider versions** indicates that the upgrade governance process is missing. At L6, you define the process: provider upgrades are initiated by a quarterly review of changelogs, proposed via a dedicated PR that updates all pinned versions, tested by running the full Terratest suite against the upgraded providers in the test account, and merged only after the test suite passes. This converts provider upgrades from accidental surprises into deliberate, reviewed events.
