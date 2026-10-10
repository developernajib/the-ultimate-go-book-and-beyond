## 102.9 Interview Questions with Frameworks

### Question 1: "Explain the difference between Terraform and Pulumi. When would you choose each?"

**Interview Question:** "Your team is deciding between Terraform and Pulumi. Walk me through the trade-offs."

**Framework for Answering:**

```
┌─────────────────────────────────────────────────────────────────────────┐
│              TERRAFORM VS PULUMI DECISION FRAMEWORK                     │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  DIMENSION 1: LANGUAGE                                                  │
│  ─────────────────────                                                  │
│  Terraform: HCL (domain-specific language)                              │
│  • Pro: Simple, declarative, easy to read                               │
│  • Con: Limited programming constructs                                  │
│                                                                         │
│  Pulumi: Real programming languages (Go, Python, TypeScript)            │
│  • Pro: Full language power (loops, conditions, types)                  │
│  • Con: Can be over-engineered                                          │
│                                                                         │
│  DIMENSION 2: ECOSYSTEM                                                 │
│  ─────────────────────                                                  │
│  Terraform: Largest provider ecosystem                                  │
│  • 4000+ providers                                                      │
│  • Most mature documentation                                            │
│                                                                         │
│  Pulumi: Growing, uses Terraform providers                              │
│  • Supports most Terraform providers via bridge                         │
│  • Native SDKs for major clouds                                         │
│                                                                         │
│  DIMENSION 3: TEAM SKILLS                                               │
│  ────────────────────────                                               │
│  Terraform: Lower barrier, anyone can learn HCL                         │
│  Pulumi: Requires programming knowledge, benefits Go teams              │
│                                                                         │
│  DIMENSION 4: STATE MANAGEMENT                                          │
│  ─────────────────────────────                                          │
│  Both support remote state with locking                                 │
│  Pulumi Cloud provides additional features (secrets, audit)             │
│                                                                         │
│  RECOMMENDATION MATRIX:                                                 │
│  ┌──────────────────────────┬───────────────────────────┐               │
│  │ Scenario                 │ Recommendation            │               │
│  ├──────────────────────────┼───────────────────────────┤               │
│  │ Multi-cloud, large team  │ Terraform (industry std)  │               │
│  │ Go-first team            │ Pulumi with Go            │               │
│  │ Complex logic needed     │ Pulumi                    │               │
│  │ Simple infra             │ Either (prefer familiar)  │               │
│  │ Compliance/audit focus   │ Terraform (maturity)      │               │
│  └──────────────────────────┴───────────────────────────┘               │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

**Complete Answer:**

```markdown
"The choice depends on team context and requirements:

**Choose Terraform when:**
1. Industry standardization matters (most DevOps engineers know it)
2. Multi-cloud with maximum provider coverage needed
3. Simple infrastructure that doesn't need complex programming
4. Compliance auditing is critical (mature tooling)
5. Team has mixed programming backgrounds

**Choose Pulumi when:**
1. Team is Go-first and wants infra in same language as apps
2. Complex conditional logic or loops are frequently needed
3. Type safety and IDE support are priorities
4. Tight integration between app code and infra code is desired
5. Team prefers familiar programming over learning new DSL

**Hybrid approach at large companies:**
- Use Terraform for foundational infra (VPCs, IAM, core services)
- Use Pulumi for application-specific infra where Go teams own it
- Both can consume each other's outputs via remote state

In my experience, I'd choose Terraform for a new project unless the
team has strong Go expertise and needs complex abstractions."
```

### Question 2: "How would you handle secrets in Infrastructure as Code?"

**Interview Question:** "You're setting up IaC for a new project. How do you manage sensitive values like database passwords?"

**Framework for Answering:**

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    SECRET MANAGEMENT FRAMEWORK                          │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  PRINCIPLE: Secrets should NEVER be in version control                  │
│                                                                         │
│  TIER 1: GENERATION (Passwords, API Keys)                               │
│  ─────────────────────────────────────────                              │
│  • Generate secrets during apply, not beforehand                        │
│  • Use random_password in Terraform                                     │
│  • Use pulumi.secret() in Pulumi                                        │
│                                                                         │
│  TIER 2: STORAGE (Where secrets live)                                   │
│  ────────────────────────────────────                                   │
│  • AWS Secrets Manager / SSM Parameter Store                            │
│  • HashiCorp Vault                                                      │
│  • GCP Secret Manager                                                   │
│  • Azure Key Vault                                                      │
│                                                                         │
│  TIER 3: INJECTION (How apps get secrets)                               │
│  ─────────────────────────────────────────                              │
│  • K8s: External Secrets Operator, CSI Secrets Driver                   │
│  • ECS: Secrets Manager integration                                     │
│  • Lambda: Environment from Secrets Manager                             │
│                                                                         │
│  TIER 4: ROTATION (Keeping secrets fresh)                               │
│  ─────────────────────────────────────────                              │
│  • Automatic rotation via Secrets Manager                               │
│  • IaC tracks rotation configuration, not secret values                 │
│                                                                         │
│  ANTI-PATTERNS TO AVOID:                                                │
│  ✗ terraform.tfvars with secrets                                        │
│  ✗ Secrets in state file (always sensitive)                             │
│  ✗ Hardcoded in resource definitions                                    │
│  ✗ Environment variables in CI logs                                     │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

**Complete Answer with Code:**

```hcl
# Terraform: Proper secret handling

# 1. Generate password (never commit this value)
resource "random_password" "db_password" {
  length  = 32
  special = true
}

# 2. Store in Secrets Manager
resource "aws_secretsmanager_secret" "db" {
  name = "/${var.environment}/database/credentials"

  # Enable automatic rotation
  rotation_lambda_arn = aws_lambda_function.rotate_secret.arn
  rotation_rules {
    automatically_after_days = 30
  }
}

resource "aws_secretsmanager_secret_version" "db" {
  secret_id = aws_secretsmanager_secret.db.id
  secret_string = jsonencode({
    username = aws_db_instance.main.username
    password = random_password.db_password.result
    host     = aws_db_instance.main.address
    port     = 5432
    dbname   = aws_db_instance.main.db_name
  })

  # This ensures the secret is updated when password changes
  lifecycle {
    ignore_changes = [secret_string]
  }
}

# 3. Use in RDS (password flows through Secrets Manager)
resource "aws_db_instance" "main" {
  # ... other config ...
  password = random_password.db_password.result

  # Important: Mark as sensitive to hide from logs
  lifecycle {
    ignore_changes = [password]
  }
}

# 4. For Kubernetes: Use External Secrets Operator
resource "kubernetes_manifest" "external_secret" {
  manifest = {
    apiVersion = "external-secrets.io/v1beta1"
    kind       = "ExternalSecret"
    metadata = {
      name      = "db-credentials"
      namespace = "app"
    }
    spec = {
      refreshInterval = "1h"
      secretStoreRef = {
        name = "aws-secrets-manager"
        kind = "ClusterSecretStore"
      }
      target = {
        name = "db-credentials"
      }
      data = [{
        secretKey = "DATABASE_URL"
        remoteRef = {
          key = aws_secretsmanager_secret.db.name
        }
      }]
    }
  }
}
```

### Question 3: "Describe your approach to managing infrastructure across multiple environments"

**Interview Question:** "You need to deploy the same application to dev, staging, and prod. How do you structure your IaC?"

**Framework for Answering:**

```
┌─────────────────────────────────────────────────────────────────────────┐
│           MULTI-ENVIRONMENT IaC STRUCTURE FRAMEWORK                     │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  APPROACH 1: WORKSPACES (Terraform)                                     │
│  ───────────────────────────────────                                    │
│  Pro: Simple, single codebase                                           │
│  Con: Easy to apply to wrong environment                                │
│                                                                         │
│  infra/                                                                 │
│  ├── main.tf                                                            │
│  ├── variables.tf                                                       │
│  └── envs/                                                              │
│      ├── dev.tfvars                                                     │
│      ├── staging.tfvars                                                 │
│      └── prod.tfvars                                                    │
│                                                                         │
│  APPROACH 2: DIRECTORY PER ENVIRONMENT (Recommended)                    │
│  ─────────────────────────────────────────────────────                  │
│  Pro: Complete isolation, clear separation                              │
│  Con: More files, need to sync modules                                  │
│                                                                         │
│  infra/                                                                 │
│  ├── modules/                   # Shared, reusable modules              │
│  │   ├── vpc/                                                           │
│  │   ├── eks/                                                           │
│  │   └── rds/                                                           │
│  └── environments/              # Per-environment config                │
│      ├── dev/                                                           │
│      │   ├── main.tf            # Calls modules with dev params         │
│      │   ├── backend.tf         # s3://state/dev/...                    │
│      │   └── terraform.tfvars                                           │
│      ├── staging/                                                       │
│      └── prod/                                                          │
│                                                                         │
│  APPROACH 3: TERRAGRUNT (For complex setups)                            │
│  ────────────────────────────────────────────                           │
│  Pro: DRY configuration, inheritance                                    │
│  Con: Additional tool to learn                                          │
│                                                                         │
│  KEY DIFFERENCES BY ENVIRONMENT:                                        │
│  ┌───────────────┬────────────────┬──────────────────┐                  │
│  │               │ Dev            │ Prod             │                  │
│  ├───────────────┼────────────────┼──────────────────┤                  │
│  │ Instance size │ t3.small       │ m5.xlarge        │                  │
│  │ Replicas      │ 1              │ 3+               │                  │
│  │ Multi-AZ      │ false          │ true             │                  │
│  │ Backup days   │ 7              │ 35               │                  │
│  │ Deletion prot │ false          │ true             │                  │
│  └───────────────┴────────────────┴──────────────────┘                  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

**Complete Answer:**

```hcl
# infra/modules/app/main.tf
# Reusable module for any environment

variable "environment" {
  type = string
}

variable "config" {
  type = object({
    instance_type = string
    min_replicas  = number
    max_replicas  = number
    multi_az      = bool
  })
}

locals {
  is_prod = var.environment == "prod"
}

resource "aws_db_instance" "main" {
  identifier = "app-${var.environment}"

  instance_class      = var.config.instance_type
  multi_az            = var.config.multi_az
  deletion_protection = local.is_prod

  backup_retention_period = local.is_prod ? 35 : 7
  skip_final_snapshot     = !local.is_prod
}

# infra/environments/prod/main.tf
# Production-specific configuration

module "app" {
  source = "../../modules/app"

  environment = "prod"

  config = {
    instance_type = "db.r6g.xlarge"
    min_replicas  = 3
    max_replicas  = 10
    multi_az      = true
  }
}

# infra/environments/dev/main.tf
# Development-specific configuration

module "app" {
  source = "../../modules/app"

  environment = "dev"

  config = {
    instance_type = "db.t3.small"
    min_replicas  = 1
    max_replicas  = 2
    multi_az      = false
  }
}
```

### Question 4: "How do you implement GitOps and what are the benefits?"

**Interview Question:** "Explain GitOps and how you would set it up for a Kubernetes deployment."

**Framework for Answering:**

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      GITOPS EXPLANATION FRAMEWORK                       │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  DEFINITION:                                                            │
│  GitOps = Git as single source of truth for declarative infrastructure  │
│  "The desired state IS what's in Git"                                   │
│                                                                         │
│  CORE PRINCIPLES:                                                       │
│  1. Declarative: Describe desired state, not how to get there           │
│  2. Versioned: All changes tracked in Git history                       │
│  3. Automated: System converges to desired state automatically          │
│  4. Auditable: Git history = audit trail                                │
│                                                                         │
│  FLOW:                                                                  │
│  Developer → PR → Review → Merge → GitOps Agent → Cluster               │
│                                                                         │
│     [Git Repo]                                                          │
│         │                                                               │
│         ▼                                                               │
│  ┌─────────────┐                                                        │
│  │ ArgoCD/Flux │  Watches repo, reconciles cluster                      │
│  └─────────────┘                                                        │
│         │                                                               │
│         ▼                                                               │
│  ┌─────────────┐                                                        │
│  │  Kubernetes │  Actual state converges to desired                     │
│  └─────────────┘                                                        │
│                                                                         │
│  BENEFITS:                                                              │
│  • No direct kubectl access needed                                      │
│  • Rollback = git revert                                                │
│  • Disaster recovery = point at repo                                    │
│  • Self-healing (drift detection)                                       │
│  • PR-based workflow for infra changes                                  │
│                                                                         │
│  TOOL COMPARISON:                                                       │
│  ┌──────────┬─────────────────────────────────────────┐                 │
│  │ ArgoCD   │ UI, App-of-Apps, easier visualization   │                 │
│  │ Flux     │ Pure GitOps, better CI/CD integration   │                 │
│  └──────────┴─────────────────────────────────────────┘                 │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

**Complete Answer:**

```markdown
"GitOps treats Git as the single source of truth for infrastructure.
Here's how I'd implement it:

**Setup Process:**

1. **Repository Structure:**
   - `apps/` - Application manifests (Deployments, Services)
   - `infrastructure/` - Cluster-level (Ingress, cert-manager)
   - `envs/` - Environment-specific overlays (Kustomize)

2. **Install GitOps Operator:**
   - ArgoCD for visibility and UI
   - Or Flux for pure GitOps with image automation

3. **Define Application:**
   ```yaml
   apiVersion: argoproj.io/v1alpha1
   kind: Application
   metadata:
     name: my-app
   spec:
     source:
       repoURL: https://github.com/org/infra
       path: envs/production
     destination:
       server: https://kubernetes.default.svc
     syncPolicy:
       automated:
         prune: true    # Delete resources not in Git
         selfHeal: true # Fix drift automatically
   ```

4. **Workflow:**
   - Developer creates PR to change manifest
   - CI validates (lint, policy check)
   - Reviewer approves, PR merges
   - ArgoCD/Flux detects change, applies to cluster
   - Rollback = revert the commit

**Benefits I've seen:**
- Disaster recovery: Spin up new cluster, point ArgoCD at repo, done
- Audit: Every change has a commit, PR review, approver
- Security: No one needs cluster admin, just Git access
- Consistency: Same process for all changes"
```

---

### Junior → FAANG: IaC Interview Preparation

IaC interview questions test practical knowledge, not vocabulary. "Explain Terraform state" should be answered with the state file's purpose (mapping declared resources to real resources), how it is stored (remote backends with locking), and what happens when it is lost or corrupted (you lose Terraform's ability to manage the existing resources, not the resources themselves). This level of concrete understanding signals that you have actually worked with Terraform, not just read about it.

For first-job preparation, build a working Terraform or Pulumi configuration that creates real cloud resources (use the free tier) and apply and destroy it multiple times. The experience of dealing with real provider errors, state conflicts, and plan surprises is irreplaceable preparation for interview scenarios.

### Senior @ FAANG: IaC Design Interview Signals at Staff Level

At staff level, IaC design questions test organizational thinking. "Design the IaC strategy for a 50-engineer team moving to AWS" should cover: the module library design and governance model, the state backend strategy (one bucket per team, per environment, or centralized), the CI/CD integration (plan on PR, apply on merge, approval gates), the access control model (who can apply to production), the drift detection strategy, and the onboarding process for new teams.

The bar-raiser signal is addressing the organizational concerns proactively: who owns the module library? How are security standards enforced in IaC code (policy-as-code)? What is the process when a team needs a non-standard configuration? How is the IaC strategy communicated to new engineers? These questions reveal whether the candidate thinks about infrastructure at the team level (L5) or at the organizational level (L6/L7).
