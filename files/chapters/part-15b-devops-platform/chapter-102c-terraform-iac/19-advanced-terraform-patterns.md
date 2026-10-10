## 102C.17 Advanced Terraform Patterns

### Workspaces vs Directory-Per-Environment

Terraform offers two primary strategies for managing multiple environments. Understanding the trade-offs is essential at scale.

**Workspaces** (`terraform workspace new staging`) use a single configuration with separate state files stored under `env:/staging/` in your backend. They share the same provider configuration and module versions:

```hcl
# main.tf -- workspace-based environment separation
locals {
  env = terraform.workspace  # "default", "staging", "production"

  config = {
    default    = { instance_type = "t3.micro",  min_capacity = 1, max_capacity = 2  }
    staging    = { instance_type = "t3.small",  min_capacity = 2, max_capacity = 4  }
    production = { instance_type = "t3.large",  min_capacity = 4, max_capacity = 20 }
  }

  current = local.config[local.env]
}

resource "aws_autoscaling_group" "app" {
  min_size = local.current.min_capacity
  max_size = local.current.max_capacity
}
```

**Directory-per-environment** uses separate directories (`environments/staging/`, `environments/production/`) each with their own `.tf` files and `backend.tf`. This is the pattern Terragrunt formalizes.

| Dimension | Workspaces | Directory-Per-Env |
|---|---|---|
| Configuration drift risk | High, all envs share same code | Low, each env can diverge intentionally |
| State isolation | Logical only (same backend bucket) | Physical (separate keys/paths) |
| Access control | Hard (same IAM role for all envs) | Easy (separate AWS accounts/roles) |
| Module version pinning | Impossible, all envs same version | Possible, staging on v1.1, prod on v1.0 |
| Blast radius | High, workspace mistake affects all | Low, isolated by directory |

**Verdict**: Workspaces are suitable for simple projects with identical infrastructure across environments. Directory-per-environment (with Terragrunt) is the industry standard for any organization managing production workloads. HashiCorp itself advises against using workspaces as an environment isolation mechanism for production.

---

### Module Versioning and Registry

The public Terraform Registry requires a GitHub repository named `terraform-<PROVIDER>-<NAME>`. Standard module structure:

```
terraform-aws-eks/
├── main.tf
├── variables.tf
├── outputs.tf
├── versions.tf
├── README.md
├── examples/
│   ├── basic/
│   └── full/
└── modules/
    ├── node-group/
    └── addons/
```

Pin module versions with semantic version constraints:

```hcl
# Exact version -- safest for production
module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "5.1.2"
}

# Patch updates allowed (~> pessimistic constraint)
module "rds" {
  source  = "terraform-aws-modules/rds/aws"
  version = "~> 6.3"  # >= 6.3.0, < 6.4.0
}
```

**Best practice**: Pin to exact versions in production. Never use `>= x.y` without an upper bound, a major version bump will break your config silently on `terraform init -upgrade`. Commit `.terraform.lock.hcl` to Git.

---

### Dynamic Blocks and for_each Patterns

Dynamic blocks eliminate repetitive nested block definitions, particularly for security group rules, policy statements, and resource tags:

```hcl
variable "ingress_rules" {
  type = list(object({
    description = string
    from_port   = number
    to_port     = number
    protocol    = string
    cidr_blocks = list(string)
  }))
}

resource "aws_security_group" "alb" {
  name   = "${var.name}-alb"
  vpc_id = var.vpc_id

  dynamic "ingress" {
    for_each = var.ingress_rules
    content {
      description = ingress.value.description
      from_port   = ingress.value.from_port
      to_port     = ingress.value.to_port
      protocol    = ingress.value.protocol
      cidr_blocks = ingress.value.cidr_blocks
    }
  }
}
```

`for_each` with a `map(object)` provides stable resource keys. The map key becomes the resource address, so removing one entry never triggers destroy/recreate of other entries:

```hcl
variable "microservices" {
  type = map(object({
    image         = string
    cpu           = number
    memory        = number
    port          = number
    desired_count = number
    health_path   = string
  }))
}

resource "aws_ecs_task_definition" "services" {
  for_each                 = var.microservices
  family                   = each.key
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = each.value.cpu
  memory                   = each.value.memory

  container_definitions = jsonencode([{
    name         = each.key
    image        = each.value.image
    portMappings = [{ containerPort = each.value.port, protocol = "tcp" }]
    healthCheck  = {
      command  = ["CMD-SHELL", "curl -sf http://localhost:${each.value.port}${each.value.health_path} || exit 1"]
      interval = 30
      timeout  = 5
      retries  = 3
    }
  }])
}

resource "aws_ecs_service" "services" {
  for_each        = var.microservices
  name            = each.key
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.services[each.key].arn
  desired_count   = each.value.desired_count
  launch_type     = "FARGATE"
}
```

---

### Complex Variable Types

Objects with optional fields (Terraform 1.3+) enable backward-compatible module evolution, callers using older configs continue to work when new optional fields are added to the module:

```hcl
variable "database_config" {
  type = object({
    engine         = string
    engine_version = string
    instance_class = string
    # Optional fields with defaults
    allocated_storage     = optional(number, 20)
    max_allocated_storage = optional(number, 100)
    multi_az              = optional(bool, false)
    deletion_protection   = optional(bool, true)
    backup_retention_days = optional(number, 7)
  })

  validation {
    condition     = contains(["mysql", "postgres", "mariadb"], var.database_config.engine)
    error_message = "Database engine must be mysql, postgres, or mariadb."
  }
}
```

---

### Conditional Resource Creation

Conditional resource creation uses `count = var.enable_feature ? 1 : 0` to optionally include a resource based on a boolean variable, or `for_each = var.enable_feature ? toset(["enabled"]) : toset([])` for resources that need associated dynamic blocks. This pattern lets a single module configuration serve multiple environments where optional infrastructure (such as NAT gateways in dev vs prod) differs by cost or necessity rather than requiring separate module configurations.

```hcl
variable "enable_nat_gateway" { type = bool; default = true }
variable "single_nat_gateway" { type = bool; default = false }

# One NAT per AZ (HA) or single (cost savings): count expression handles all cases
resource "aws_nat_gateway" "main" {
  count         = var.enable_nat_gateway ? (var.single_nat_gateway ? 1 : length(var.availability_zones)) : 0
  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id
  tags          = merge(var.tags, { Name = "${var.name}-nat-${count.index + 1}" })
}

# for_each with conditional set -- stable even if feature toggling changes
resource "aws_wafv2_web_acl_association" "main" {
  for_each     = contains(var.enabled_features, "waf") ? toset(["enabled"]) : toset([])
  resource_arn = aws_lb.main.arn
  web_acl_arn  = aws_wafv2_web_acl.main[0].arn
}
```

---

### Junior → FAANG: Advanced Patterns as Code Review Signals

When you encounter these advanced patterns in code review, you can either approve them reflexively or ask the right questions. The right questions demonstrate infrastructure awareness that goes beyond syntax.

For the workspace vs. directory-per-environment comparison: if you see a team using workspaces for production and staging, the question to ask is "how do you pin module versions independently between environments?" The answer almost always reveals that they cannot, which opens the conversation about migrating to directory-per-environment. Raising this in a code review demonstrates the judgment that separates an L4 who knows patterns from an L5 who understands their organizational implications.

For module registry versioning: the practical habit is never using `ref=main` in production module sources. Every production module call should use a pinned tag (`ref=v2.3.0`). If you inherit a codebase using `ref=main`, document the risk (any change to the module immediately affects production without a deploy step) and propose pinned versions as a technical debt item with a clear priority level.

For the optional object fields with default values: this pattern is the Go equivalent of a function with optional parameters. When you see `optional(number, 20)` in a variable definition, it means the module author is making a backward-compatible addition. This is good module design. When you see a new required variable added to an existing module, that is a breaking change that requires all callers to update. Flag it in review.

### Senior @ FAANG: Advanced Patterns as Platform Architecture Tools

At L6, the patterns above are building blocks for platform architecture decisions that affect hundreds of engineers. The evaluation is not "does this pattern work?" but "does this pattern scale to our organizational model?"

**The workspaces vs. directory comparison as an ADR.** The table in this section is the starting point for a formal architectural decision record. At L6, you write the ADR explicitly, with three sections: the decision (use directory-per-environment with Terragrunt), the alternatives considered (workspaces, feature flags in HCL, separate state files without Terragrunt), and the consequences (more directories to maintain, but true environment isolation, independent blast radii, and per-environment module version pinning). The ADR is committed to the infrastructure repository and referenced in the Terragrunt documentation so future engineers do not relitigate the decision without understanding the rationale.

**Dynamic blocks as a complexity signal.** When a module's dynamic block depth exceeds two levels, it is a signal to evaluate the module boundary. At L6, you recognize this as the point where CDKTF's Go loops are more expressive than HCL's dynamic blocks. The organizational decision is not "should this engineer use dynamic blocks?" but "what is the module complexity threshold at which we recommend CDKTF for new modules?" Define the threshold explicitly, document it in the platform engineering guide, and ensure the Terraform module review checklist includes a check for this threshold.

**Optional fields and backward compatibility as a governance contract.** The `optional()` pattern is a capability, not a practice. At L6, you define the organizational convention: all new fields added to existing module variables must be optional with a default that preserves existing behavior, and this is enforced by the module PR checklist. Required field additions require a major version bump and a migration guide. Encoding this convention in a checklist item rather than relying on reviewer knowledge prevents the silent breaking changes that affect 40 caller teams simultaneously when a module author adds a required field without recognizing its impact.
