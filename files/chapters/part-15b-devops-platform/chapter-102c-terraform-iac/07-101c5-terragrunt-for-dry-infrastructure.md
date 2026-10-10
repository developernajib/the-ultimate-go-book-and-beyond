## 102C.5 Terragrunt for DRY Infrastructure

### Problem: Config Duplication

Vanilla Terraform requires every environment/component combination to repeat the same backend configuration block. Bucket name, DynamoDB table, region, and encryption settings. With ten components across three environments this means 30 nearly identical files that drift over time. Terragrunt eliminates this by generating backend configuration from a root `terragrunt.hcl` that is inherited by all child modules, keeping backend settings DRY while still producing isolated state files per component.

```hcl
# Without Terragrunt: EVERY environment/component needs full backend config
# dev/vpc/terraform.tf, staging/vpc/terraform.tf, prod/vpc/terraform.tf
# All nearly identical except for environment name and state key
```

### Terragrunt Solution

The root `terragrunt.hcl` uses `read_terragrunt_config` and `find_in_parent_folders` to read account, environment, and region variables from ancestor directories. It generates a `backend.tf` file in each child module directory at runtime, inserting the correct S3 key derived from the relative path. This means you write backend configuration once at the root and get a unique, correctly-keyed state file for every module with zero repetition.

```hcl
# terragrunt.hcl (root)
locals {
  account_vars     = read_terragrunt_config(find_in_parent_folders("account.hcl"))
  environment_vars = read_terragrunt_config(find_in_parent_folders("env.hcl"))
  region_vars      = read_terragrunt_config(find_in_parent_folders("region.hcl"))

  account_id  = local.account_vars.locals.aws_account_id
  environment = local.environment_vars.locals.environment
  aws_region  = local.region_vars.locals.aws_region
}

remote_state {
  backend = "s3"
  generate = {
    path      = "backend.tf"
    if_exists = "overwrite_terragrunt"
  }
  config = {
    bucket         = "mycompany-terraform-${local.account_id}"
    key            = "${path_relative_to_include()}/terraform.tfstate"
    region         = local.aws_region
    encrypt        = true
    dynamodb_table = "terraform-state-lock"
  }
}

# Generate provider config for every module
generate "provider" {
  path      = "provider.tf"
  if_exists = "overwrite_terragrunt"
  contents  = <<EOF
provider "aws" {
  region = "${local.aws_region}"
  default_tags {
    tags = {
      Environment = "${local.environment}"
      ManagedBy   = "terraform"
    }
  }
}
EOF
}
```

```hcl
# live/prod/vpc/terragrunt.hcl
include "root" {
  path = find_in_parent_folders()
}

terraform {
  source = "../../../modules//vpc"  # // = strip module path before this point
}

inputs = {
  project            = "myapp"
  environment        = "prod"
  cidr_block         = "10.10.0.0/16"
  availability_zones = ["us-east-1a", "us-east-1b", "us-east-1c"]
}
```

```hcl
# live/prod/app/terragrunt.hcl - dependency management
include "root" {
  path = find_in_parent_folders()
}

terraform {
  source = "../../../modules//ecs-service"
}

dependency "vpc" {
  config_path = "../vpc"

  # Mock outputs for terraform validate without running vpc first
  mock_outputs = {
    private_subnet_ids = ["subnet-mock1", "subnet-mock2"]
    vpc_id             = "vpc-mock"
  }
  mock_outputs_allowed_terraform_commands = ["validate", "plan"]
}

dependency "rds" {
  config_path = "../rds"
  mock_outputs = {
    endpoint = "mock.endpoint.local"
  }
}

inputs = {
  vpc_id     = dependency.vpc.outputs.vpc_id
  subnet_ids = dependency.vpc.outputs.private_subnet_ids
  db_host    = dependency.rds.outputs.endpoint
}
```

### Terragrunt Commands

Terragrunt wraps the Terraform CLI and adds two key commands: `run-all apply` executes `terraform apply` across all child modules in dependency order, and `run-all plan` gives you a unified plan view of the entire infrastructure stack. The `--terragrunt-include-dir` and `--terragrunt-exclude-dir` flags let you scope a `run-all` operation to a subset of modules, which is useful for applying only the networking stack while leaving application modules unchanged.

```bash
# Apply all modules in dependency order
terragrunt run-all apply

# Plan all modules, showing dependency graph
terragrunt run-all plan

# Apply specific environment
cd live/prod && terragrunt run-all apply

# Apply only if changes detected (CI/CD optimization)
terragrunt run-all plan --terragrunt-ignore-external-dependencies
```

---

### Junior → FAANG: When You Need Terragrunt and When You Do Not

Terragrunt adds a layer of indirection that is worth its complexity only when you have more than one or two environments. If you are working on a side project or a startup with a single prod environment, plain Terraform is the right choice. The complexity of root `terragrunt.hcl`, `env.hcl`, and `account.hcl` files is overhead that does not pay off until you have three or more environments each with five or more module components.

The first practical skill to develop with Terragrunt is understanding `find_in_parent_folders`. When a child module calls this function, Terragrunt walks up the directory tree looking for `terragrunt.hcl`. This is how a `live/prod/app/terragrunt.hcl` inherits configuration from `live/prod/terragrunt.hcl` which inherits from `live/terragrunt.hcl`. If you do not understand this traversal, the generated backend paths will surprise you.

The `mock_outputs` feature in dependency blocks is critical for local development and CI. Without it, every `terragrunt validate` requires the upstream module to already be applied, which makes it impossible to validate a new stack before the dependencies exist. With `mock_outputs`, the VPC subnet IDs are mocked to plausible-looking values and the plan validates against the schema even in an empty environment.

### Senior @ FAANG: Terragrunt as a Platform Layer

At L6, Terragrunt is not just a DRY tool. It is the abstraction layer that sits between engineering teams and raw Terraform. The design decisions you make in the Terragrunt layer have organizational impact:

**Account-per-environment isolation.** The root `terragrunt.hcl` pattern shown above uses `find_in_parent_folders("account.hcl")` to read the AWS account ID. This is how you implement full account isolation: dev, staging, and prod each live in separate AWS accounts, each with their own IAM roles, separate state buckets, and independent Service Control Policies. The Terragrunt layer generates the correct provider and backend configuration for each account without requiring callers to know account IDs. This is the architecture that satisfies most compliance frameworks (PCI DSS, SOC 2) that require environment separation at the account level.

**Run-all as a change management tool.** `terragrunt run-all plan` from the root gives you a pre-apply impact assessment for any change to a shared module. When the networking team proposes a change to the VPC module, running `run-all plan` shows every environment and component that will be affected before anyone approves the PR. At L6, you build this into the CI pipeline: shared module PRs automatically trigger a `run-all plan` and post the combined output as a PR comment. The reviewer can see the blast radius without manual investigation.

**Terragrunt hooks for compliance automation.** Terragrunt `before_hook` and `after_hook` blocks execute shell commands before or after Terraform commands. This is the integration point for policy enforcement: run `conftest test` on the plan output before every apply, run `infracost diff` to show the cost delta, post audit events to a central compliance log. At staff level, you design these hooks as part of the platform's compliance automation layer rather than leaving them to individual teams to implement inconsistently.

**Dependency graph as organizational interface.** The `dependency` blocks in child `terragrunt.hcl` files encode the architectural dependency graph explicitly. When the application stack declares `dependency "vpc"`, it is documenting that the application team depends on the networking team's output. At bar-raiser interviews, the question is whether you have designed this dependency graph to minimize coupling: application teams should depend on platform-level outputs (VPC IDs, cluster ARNs), not on sibling team outputs. Circular dependencies in the Terragrunt graph are an architectural smell that usually indicates two teams sharing responsibilities that should be separated.
