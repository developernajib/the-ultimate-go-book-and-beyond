## 102C.2 HCL Syntax Deep Dive

### Providers and Resources

HCL (HashiCorp Configuration Language) builds infrastructure from three primitives: providers (plugins that communicate with an API), resources (a single infrastructure object), and data sources (read-only lookups of existing objects). Pinning provider versions in the `required_providers` block is essential for reproducibility. An unpinned `~> 5.0` constraint accepts any 5.x release, while `~> 5.40` restricts to 5.40 and above within the 5.x series. Storing the Terraform backend configuration in the same file ensures every team member and CI job uses the same remote state without extra environment variables.

```hcl
# versions.tf - pin versions for reproducibility
terraform {
  required_version = ">= 1.7.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.40"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  backend "s3" {
    bucket         = "mycompany-terraform-state"
    key            = "production/app/terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true
    dynamodb_table = "terraform-state-lock"
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Environment = var.environment
      ManagedBy   = "terraform"
      Team        = var.team
    }
  }
}
```

```hcl
# main.tf - resources with references
resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name = "${var.project}-${var.environment}-vpc"
  }
}

resource "aws_subnet" "private" {
  count             = length(var.availability_zones)
  vpc_id            = aws_vpc.main.id                      # reference to other resource
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, count.index)
  availability_zone = var.availability_zones[count.index]

  tags = {
    Name = "${var.project}-private-${var.availability_zones[count.index]}"
    Tier = "private"
  }
}

# Data source: read existing AWS resources (not managed by this config)
data "aws_ami" "amazon_linux_2023" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-*-x86_64"]
  }
}
```

### Variables and Locals

Variables define the interface of a Terraform module. The knobs a caller turns to customize behavior. Validation blocks enforce domain constraints at plan time rather than letting an invalid value propagate to an API call. Locals are computed values derived from variables and other resources. They eliminate repetition and centralize calculations such as tag maps or derived CIDR blocks, making modules easier to read and less prone to copy-paste bugs.

```hcl
# variables.tf
variable "environment" {
  type        = string
  description = "Deployment environment: dev, staging, prod"

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "Environment must be one of: dev, staging, prod."
  }
}

variable "vpc_cidr" {
  type        = string
  default     = "10.0.0.0/16"
  description = "CIDR block for the VPC"

  validation {
    condition     = can(cidrhost(var.vpc_cidr, 0))
    error_message = "Must be a valid CIDR block."
  }
}

variable "availability_zones" {
  type        = list(string)
  description = "List of AZs to deploy into"
}

variable "instance_type_map" {
  type = map(string)
  default = {
    dev     = "t3.small"
    staging = "t3.medium"
    prod    = "t3.large"
  }
}

# locals.tf - computed values, avoid repetition
locals {
  # Derived values
  instance_type = var.instance_type_map[var.environment]
  is_production = var.environment == "prod"

  # Common tags applied everywhere
  common_tags = {
    Project     = var.project
    Environment = var.environment
    ManagedBy   = "terraform"
  }

  # Complex computed value
  private_subnet_ids = aws_subnet.private[*].id
  public_subnet_ids  = aws_subnet.public[*].id
}
```

### for_each vs count

`count` creates resources by index, which causes unexpected replacements when you remove an element from the middle of a list because all subsequent indices shift. `for_each` keys resources by a stable map key or set element, so removing one entry only destroys that single resource and leaves all others untouched. Prefer `for_each` whenever the collection might change. Reserve `count` for simple boolean presence patterns like `count = var.enable_feature ? 1 : 0`.

```hcl
# count: simple numeric repetition
# Problem: if you delete index 1, resources 2,3,4 get renumbered → plan shows unnecessary destroy/create
resource "aws_subnet" "public_bad" {
  count      = 3
  cidr_block = cidrsubnet(var.vpc_cidr, 8, count.index + 100)
}

# for_each: keyed resources - deleting one key doesn't affect others
resource "aws_subnet" "public" {
  for_each = toset(var.availability_zones)  # Set of AZ names

  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, index(var.availability_zones, each.key) + 100)
  availability_zone = each.key              # each.key = AZ name, each.value = same for set

  tags = {
    Name = "${var.project}-public-${each.key}"
  }
}

# for_each with map: more control
variable "services" {
  type = map(object({
    port          = number
    instance_type = string
    min_capacity  = number
    max_capacity  = number
  }))
  default = {
    api = {
      port          = 8080
      instance_type = "t3.medium"
      min_capacity  = 2
      max_capacity  = 10
    }
    worker = {
      port          = 0
      instance_type = "t3.small"
      min_capacity  = 1
      max_capacity  = 5
    }
  }
}

resource "aws_ecs_service" "services" {
  for_each = var.services

  name            = "${var.project}-${each.key}"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.services[each.key].arn
  desired_count   = each.value.min_capacity
}
```

### Dynamic Blocks

Dynamic blocks allow you to generate repeated nested configuration blocks from a variable list or map, replacing hard-coded repetition with a data-driven loop. They are especially useful for security group rules, IAM policy statements, and any other resource that accepts a variable number of nested blocks. Use them when the number or content of blocks varies by environment or caller input. Avoid them when you only ever need a fixed, well-known set of blocks, as the loop syntax is harder to read than explicit blocks.

```hcl
# Instead of repeating ingress blocks:
resource "aws_security_group" "app" {
  name   = "${var.project}-app-sg"
  vpc_id = aws_vpc.main.id

  dynamic "ingress" {
    for_each = var.ingress_rules
    content {
      from_port   = ingress.value.from_port
      to_port     = ingress.value.to_port
      protocol    = ingress.value.protocol
      cidr_blocks = ingress.value.cidr_blocks
      description = ingress.value.description
    }
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

variable "ingress_rules" {
  type = list(object({
    from_port   = number
    to_port     = number
    protocol    = string
    cidr_blocks = list(string)
    description = string
  }))
}
```

### Lifecycle Rules

Lifecycle meta-arguments give you fine-grained control over how Terraform handles resource replacement, deletion, and drift. The `prevent_destroy` flag is a critical guard for stateful resources like RDS instances. It blocks `terraform destroy` and any plan that would delete the resource, serving as a last-ditch protection against accidental data loss. `create_before_destroy` ensures zero-downtime replacement by provisioning the new resource before removing the old one, which is essential for launch templates and any resource referenced by an autoscaling group.

```hcl
resource "aws_db_instance" "main" {
  identifier        = "${var.project}-${var.environment}-db"
  engine            = "postgres"
  engine_version    = "16.2"
  instance_class    = "db.t3.medium"
  allocated_storage = 20

  lifecycle {
    # Never destroy the database, even with terraform destroy
    prevent_destroy = true

    # Don't replace if these change - update in-place
    ignore_changes = [
      password,           # managed externally via Secrets Manager
      snapshot_identifier # set during restore, don't track
    ]

    # Create new before destroying old (zero-downtime replacement)
    create_before_destroy = true
  }
}

# Replace instance when AMI changes (rolling update)
resource "aws_launch_template" "app" {
  name_prefix   = "${var.project}-"
  image_id      = data.aws_ami.amazon_linux_2023.id
  instance_type = local.instance_type

  lifecycle {
    create_before_destroy = true
  }
}
```

---

### Junior → FAANG: HCL Habits That Signal Production Experience

When interviewers look at HCL written by junior candidates, three patterns immediately signal production inexperience. First: no validation blocks on variables. Adding a `validation` block that checks `contains(["dev", "staging", "prod"], var.environment)` takes two minutes and prevents a whole class of silent misconfiguration bugs. Second: using `count` where `for_each` belongs. If you see a list of availability zones and write `count = length(var.availability_zones)`, you will hit the index-stability problem the first time someone removes a zone. Third: no `lifecycle { prevent_destroy = true }` on stateful resources. If your module creates an RDS instance without this guard, a careless `terraform destroy` in the wrong directory can delete production data.

For your first Terraform role, internalize the rule: providers and modules are always pinned to a specific version. `~> 5.40` for providers, a specific Git tag or registry version for modules. Never accept "we'll pin it later" as a team norm.

### Senior @ FAANG: HCL Expressiveness Limits and When to Cross the Boundary

HCL is a configuration language designed for declarative resource description. It covers 90% of production use cases well. The remaining 10% reveals its limits, and at senior level, you need a clear mental model of where HCL is the right tool versus where you cross into CDKTF or Pulumi.

**Dynamic block depth.** Dynamic blocks work for one level of nesting. When you need dynamic blocks inside dynamic blocks (for example, IAM policy statements where each statement has a dynamic set of conditions), the HCL becomes unreadable quickly. This is a signal to evaluate CDKTF for that specific module, where Go loops express nested dynamic structure naturally.

**for_each with computed keys.** Terraform requires `for_each` keys to be known at plan time. When the keys come from resource outputs that are only known after apply (for example, iterating over the IDs of newly created subnets), you hit the classic error: "The `for_each` map includes keys derived from resource attributes that cannot be determined until apply." The workarounds (using a separate data source, restructuring the dependency graph, splitting into two applies) are all architectural decisions that a senior engineer needs to make deliberately, not stumble into.

**Local values as the refactoring tool.** Locals are underused by junior engineers and overused by engineers who mistake them for a general-purpose programming construct. The correct use of locals is eliminating expression repetition and centralizing derived values (the `common_tags` merge, the `is_production` boolean). The incorrect use is building deeply nested locals that perform multi-step computations that would be clearer as a CDKTF construct or an external data source. At code review, if a local block requires more than 30 seconds to mentally evaluate, it is a candidate for simplification.

**Provider aliasing for multi-region and multi-account.** The `provider "aws" { alias = "us-west-2" }` pattern is essential for multi-region infrastructure. At L6, you design modules that accept a provider alias as an input (`providers = { aws = aws.primary, aws.secondary = aws.dr }`) so callers can inject the correct regional provider without the module hardcoding a region. This is the canonical pattern for global disaster recovery infrastructure and is a bar-raiser topic at companies with multi-region reliability requirements.
