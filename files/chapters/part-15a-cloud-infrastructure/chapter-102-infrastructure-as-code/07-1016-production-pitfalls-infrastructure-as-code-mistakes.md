## 102.7 Production Pitfalls: Infrastructure as Code Mistakes

### Pitfall 1: Storing State File Locally

**Real Incident Report**: A developer ran `terraform apply` with a local state file. Another developer, unaware, ran `terraform apply` from their machine with a different (outdated) state file. Resources were recreated, data was lost, and the infrastructure diverged from what either state file showed.

**The Anti-Pattern**:
```hcl
# WRONG: Default local state
terraform {
  # No backend configured - state is local
}

# Result:
# - State in terraform.tfstate on local disk
# - No locking - concurrent applies corrupt state
# - No team collaboration
# - State lost if laptop dies
```

**The Better Approach**:
```hcl
# RIGHT: Remote state with locking
terraform {
  backend "s3" {
    bucket         = "my-terraform-state"
    key            = "prod/terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true
    dynamodb_table = "terraform-locks"  # State locking!
  }
}

# For Pulumi:
# pulumi login s3://my-pulumi-state
# Or pulumi login (uses Pulumi Cloud with automatic locking)
```

**Key Insight**: Remote state with locking is not optional for teams. It prevents concurrent modifications and provides backup.

### Pitfall 2: Secrets in State or Code

**Real Incident Report**: A team stored their RDS password in a Terraform variable file and committed it to Git. The database was compromised within hours. Even after rotating the password, it remained in git history.

**The Anti-Pattern**:
```hcl
# WRONG: Secrets in code
variable "db_password" {
  default = "supersecret123"  # Committed to git!
}

resource "aws_db_instance" "main" {
  password = var.db_password
}

# terraform.tfvars (also wrong if committed)
db_password = "supersecret123"
```

**The Better Approach**:
```hcl
# RIGHT: External secret management
# Option 1: Environment variable
variable "db_password" {
  sensitive = true  # Hides from output
}
# Set via: TF_VAR_db_password=... terraform apply

# Option 2: AWS Secrets Manager
data "aws_secretsmanager_secret_version" "db" {
  secret_id = "prod/rds/password"
}

resource "aws_db_instance" "main" {
  password = data.aws_secretsmanager_secret_version.db.secret_string
}

# Option 3: Pulumi with secrets
config := pulumi.NewConfig(ctx)
dbPassword := config.RequireSecret("dbPassword")
// Encrypted in state, decrypted at runtime
```

**Key Insight**: Terraform state contains secrets in plaintext. Encrypt state at rest and use external secret managers for sensitive values.

### Pitfall 3: No State Isolation Between Environments

**Real Incident Report**: A developer meant to update staging but ran `terraform apply` in the wrong directory. The production state file was used, and production resources were modified. There was no environment isolation, and a typo caused an outage.

**The Anti-Pattern**:
```
# WRONG: Single state file for all environments
infra/
├── main.tf
├── terraform.tfstate  # Both dev and prod in here!
└── terraform.tfvars
```

**The Better Approach**:
```
# RIGHT: Separate state per environment
infra/
├── modules/
│   └── app/
│       ├── main.tf
│       └── variables.tf
├── environments/
│   ├── dev/
│   │   ├── main.tf
│   │   ├── backend.tf      # s3://state/dev/terraform.tfstate
│   │   └── terraform.tfvars
│   ├── staging/
│   │   ├── main.tf
│   │   ├── backend.tf      # s3://state/staging/terraform.tfstate
│   │   └── terraform.tfvars
│   └── prod/
│       ├── main.tf
│       ├── backend.tf      # s3://state/prod/terraform.tfstate
│       └── terraform.tfvars
```

```hcl
# Each environment has isolated state
# infra/environments/prod/backend.tf
terraform {
  backend "s3" {
    bucket = "my-terraform-state"
    key    = "prod/terraform.tfstate"  # Isolated!
    region = "us-east-1"
  }
}
```

**Key Insight**: Environment isolation prevents accidents. You can't modify prod if you're in the dev directory.

### Pitfall 4: Not Using terraform plan Before Apply

**Real Incident Report**: An engineer ran `terraform apply` without first running `plan`. A configuration change they thought was minor actually destroyed and recreated a production database. 6 hours of downtime, lost data, because they didn't preview the changes.

**The Anti-Pattern**:
```bash
# WRONG: Apply without reviewing plan
terraform apply --auto-approve
# Might delete your database
```

**The Better Approach**:
```bash
# RIGHT: Always plan first
terraform plan -out=tfplan
# Review the output carefully!

# Only after reviewing:
terraform apply tfplan

# In CI/CD:
# 1. terraform plan (output saved)
# 2. Human reviews plan
# 3. Human approves
# 4. terraform apply with saved plan
```

```yaml
# GitHub Actions example
jobs:
  plan:
    steps:
      - run: terraform plan -out=tfplan
      - uses: actions/upload-artifact@v3
        with:
          name: tfplan
          path: tfplan

  apply:
    needs: plan
    environment: production  # Requires approval
    steps:
      - uses: actions/download-artifact@v3
        with:
          name: tfplan
      - run: terraform apply tfplan
```

**Key Insight**: `terraform plan` shows what will change BEFORE it changes. Required review prevents disasters.

### Pitfall 5: Giant Monolithic State Files

**Real Incident Report**: A team managed their entire AWS infrastructure in one Terraform configuration. State file: 50MB. `terraform plan` took 8 minutes. A change to a single resource required locking the entire infrastructure. One bad apply could affect everything.

**The Anti-Pattern**:
```
# WRONG: Everything in one state
infra/
├── main.tf          # VPCs, databases, apps, DNS, everything
└── terraform.tfstate # 50MB, 2000 resources
```

**The Better Approach**:
```
# RIGHT: Modular state separation
infra/
├── network/
│   ├── main.tf       # VPCs, subnets, routing
│   └── outputs.tf    # Exports VPC IDs for other stacks
├── database/
│   ├── main.tf       # RDS, ElastiCache
│   └── outputs.tf
├── apps/
│   ├── service-a/
│   │   └── main.tf   # Consumes network and database outputs
│   └── service-b/
│       └── main.tf
└── dns/
    └── main.tf
```

```hcl
# Consuming outputs from other state
data "terraform_remote_state" "network" {
  backend = "s3"
  config = {
    bucket = "my-terraform-state"
    key    = "network/terraform.tfstate"
    region = "us-east-1"
  }
}

resource "aws_instance" "app" {
  subnet_id = data.terraform_remote_state.network.outputs.private_subnet_id
}
```

**Key Insight**: Smaller state files mean faster plans, smaller blast radius, and easier team collaboration. Split by logical boundaries.

### Quick Reference: IaC Anti-Patterns

| Anti-Pattern | Symptom | Fix |
|--------------|---------|-----|
| Local state | Concurrent corruption, lost state | Remote state with locking (S3+DynamoDB) |
| Secrets in code | Compromised credentials | External secrets manager, sensitive variables |
| No env isolation | Apply to wrong environment | Separate directories and state per environment |
| Apply without plan | "Oops, deleted the database" | Always plan → review → apply |
| Monolithic state | 8 min plans, large blast radius | Split into logical modules |
| No state versioning | Can't recover from bad apply | Enable S3 versioning on state bucket |

---

### Junior → FAANG: IaC Pitfalls as the Basis for Every New Project Setup

The most damaging IaC pitfalls are the ones that occur during project setup, not during ongoing maintenance. Local state storage, missing locking, and no plan review are all decisions made at project inception that become painful only later (when a state file is lost, when two engineers corrupt the state with concurrent applies, or when an unreviewed plan destroys a production database).

The practical approach: create a checklist for new IaC project setup that covers all these pitfalls. Before writing any resource definitions, configure the remote state backend, enable state locking, set up the CI pipeline with plan-on-PR and apply-on-merge, and configure the branch protection rules. This setup takes two hours and prevents the majority of IaC incidents.

### Senior @ FAANG: IaC Pitfall Prevention Through Organization-Wide Standards

At staff level, IaC pitfalls are prevented through organization-wide standards that are enforced rather than documented. The standard for remote state configuration (specific S3 bucket and DynamoDB table, enforced by a compliance check that rejects configurations with local or unversioned state) prevents the local state pitfall. The standard for `terraform plan` review (required as a PR check, enforced by a GitHub Actions workflow that posts the plan to the PR and requires approval before merge) prevents the no-plan-review pitfall.

The hardest pitfall to prevent automatically is monolithic configurations that have complex dependencies. This requires an architectural review process where IaC changes above a certain complexity threshold require a senior engineer review. Defining this threshold, the review process, and the ownership model for shared infrastructure configurations is an organizational policy decision that the staff engineer defines and advocates for.
