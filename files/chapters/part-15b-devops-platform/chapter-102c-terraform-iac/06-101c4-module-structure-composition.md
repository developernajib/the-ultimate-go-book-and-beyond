## 102C.4 Module Structure & Composition

### Module Directory Structure

Terraform modules encapsulate a reusable set of resources behind a well-defined interface of variables and outputs. The standard directory structure separates concerns into dedicated files: `main.tf` for resources, `variables.tf` for inputs, `outputs.tf` for exported values, and `versions.tf` for provider constraints. Keeping IAM resources in a separate `iam.tf` makes permission changes easy to audit and review independently of the core resource logic.

```
modules/
├── vpc/
│   ├── main.tf         # VPC, subnets, IGW, NAT gateway, route tables
│   ├── variables.tf    # All input variables with types and validation
│   ├── outputs.tf      # All outputs consumed by other modules
│   ├── versions.tf     # Provider version constraints
│   └── README.md       # Module documentation (auto-generated with terraform-docs)
├── ecs-service/
│   ├── main.tf
│   ├── variables.tf
│   ├── outputs.tf
│   ├── versions.tf
│   └── iam.tf          # IAM roles for the service
└── rds-postgres/
    ├── main.tf
    ├── variables.tf
    ├── outputs.tf
    ├── versions.tf
    └── parameter_group.tf
```

### Well-Designed Module

A well-designed module exposes every meaningful configuration knob as a typed variable with a description and a sensible default, so callers can adopt it immediately without reading the source. Validation blocks catch invalid input at plan time rather than letting it fail after a partial apply. The ECS service module below shows the full variable surface for a production-grade Fargate service, including autoscaling bounds, health check paths, and Secrets Manager integration for credentials.

```hcl
# modules/ecs-service/variables.tf
variable "service_name" {
  type        = string
  description = "Name of the ECS service"
}

variable "cluster_id" {
  type        = string
  description = "ECS cluster ARN"
}

variable "container_image" {
  type        = string
  description = "Docker image URI (e.g., 123456789.dkr.ecr.us-east-1.amazonaws.com/app:latest)"
}

variable "container_port" {
  type        = number
  default     = 8080
  description = "Port the container listens on"
}

variable "desired_count" {
  type        = number
  default     = 2
  description = "Number of tasks to run"
}

variable "cpu" {
  type        = number
  default     = 512
  description = "CPU units (256, 512, 1024, 2048, 4096)"

  validation {
    condition     = contains([256, 512, 1024, 2048, 4096], var.cpu)
    error_message = "CPU must be one of: 256, 512, 1024, 2048, 4096."
  }
}

variable "memory" {
  type        = number
  default     = 1024
  description = "Memory in MB"
}

variable "environment_variables" {
  type        = map(string)
  default     = {}
  description = "Environment variables for the container"
}

variable "secrets" {
  type        = map(string)
  default     = {}
  description = "Secrets Manager ARNs to inject as env vars (key=env_var_name, value=secret_arn)"
}

variable "subnet_ids" {
  type        = list(string)
  description = "Subnet IDs for the ECS tasks"
}

variable "security_group_ids" {
  type        = list(string)
  description = "Security group IDs for the ECS tasks"
}

variable "target_group_arn" {
  type        = string
  default     = null
  description = "ALB target group ARN (null for worker services with no ALB)"
}

variable "health_check_path" {
  type        = string
  default     = "/health"
  description = "HTTP path for health checks"
}

variable "min_capacity" {
  type        = number
  default     = 2
  description = "Minimum number of tasks for autoscaling"
}

variable "max_capacity" {
  type        = number
  default     = 10
  description = "Maximum number of tasks for autoscaling"
}

variable "scale_out_cpu_threshold" {
  type        = number
  default     = 70
  description = "CPU percentage to trigger scale-out"
}

variable "tags" {
  type        = map(string)
  default     = {}
  description = "Additional tags to apply to resources"
}
```

```hcl
# modules/ecs-service/main.tf
locals {
  full_name = "${var.service_name}"

  # Build container environment from variables + secrets
  environment = [
    for k, v in var.environment_variables : {
      name  = k
      value = v
    }
  ]

  secrets = [
    for k, v in var.secrets : {
      name      = k
      valueFrom = v
    }
  ]
}

resource "aws_ecs_task_definition" "main" {
  family                   = local.full_name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.cpu
  memory                   = var.memory
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([{
    name        = var.service_name
    image       = var.container_image
    essential   = true
    environment = local.environment
    secrets     = local.secrets

    portMappings = [{
      containerPort = var.container_port
      protocol      = "tcp"
    }]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = "/ecs/${local.full_name}"
        "awslogs-region"        = data.aws_region.current.name
        "awslogs-stream-prefix" = "ecs"
      }
    }

    healthCheck = {
      command     = ["CMD-SHELL", "curl -f http://localhost:${var.container_port}${var.health_check_path} || exit 1"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 60
    }
  }])

  tags = merge(var.tags, { Name = local.full_name })
}

resource "aws_ecs_service" "main" {
  name            = local.full_name
  cluster         = var.cluster_id
  task_definition = aws_ecs_task_definition.main.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = var.security_group_ids
    assign_public_ip = false
  }

  dynamic "load_balancer" {
    for_each = var.target_group_arn != null ? [1] : []
    content {
      target_group_arn = var.target_group_arn
      container_name   = var.service_name
      container_port   = var.container_port
    }
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  deployment_controller {
    type = "ECS"
  }

  lifecycle {
    ignore_changes = [desired_count] # managed by autoscaling
  }

  depends_on = [aws_cloudwatch_log_group.main]

  tags = merge(var.tags, { Name = local.full_name })
}

# Auto-scaling
resource "aws_appautoscaling_target" "ecs" {
  max_capacity       = var.max_capacity
  min_capacity       = var.min_capacity
  resource_id        = "service/${var.cluster_id}/${aws_ecs_service.main.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "cpu" {
  name               = "${local.full_name}-cpu-scaling"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.ecs.resource_id
  scalable_dimension = aws_appautoscaling_target.ecs.scalable_dimension
  service_namespace  = aws_appautoscaling_target.ecs.service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
    target_value       = var.scale_out_cpu_threshold
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
  }
}
```

### Using Modules

Calling a module is as simple as a `module` block that specifies the source path and passes values for all required variables. The live configuration below shows how the `vpc` and `ecs-service` modules compose together: the VPC module produces subnet IDs that flow directly into the ECS service module. Environment-specific values like scaling bounds are controlled by locals rather than hard-coded, making it straightforward to promote configuration from staging to production.

```hcl
# live/prod/app/main.tf
module "vpc" {
  source = "../../../modules/vpc"

  project            = var.project
  environment        = var.environment
  cidr_block         = "10.0.0.0/16"
  availability_zones = ["us-east-1a", "us-east-1b", "us-east-1c"]
}

module "api_service" {
  source = "../../../modules/ecs-service"

  service_name    = "api"
  cluster_id      = aws_ecs_cluster.main.id
  container_image = "${var.ecr_registry}/api:${var.image_tag}"
  container_port  = 8080

  subnet_ids         = module.vpc.private_subnet_ids
  security_group_ids = [aws_security_group.api.id]
  target_group_arn   = module.alb.api_target_group_arn

  min_capacity = local.is_production ? 3 : 1
  max_capacity = local.is_production ? 20 : 5

  environment_variables = {
    APP_ENV       = var.environment
    LOG_LEVEL     = local.is_production ? "info" : "debug"
    DB_HOST       = module.rds.endpoint
  }

  secrets = {
    DB_PASSWORD  = aws_secretsmanager_secret.db_password.arn
    JWT_SECRET   = aws_secretsmanager_secret.jwt_secret.arn
  }

  tags = local.common_tags
}
```

---

### Junior → FAANG: Writing Modules That Others Can Actually Use

The gap between a module that works for you and a module that works for your whole team is mostly in the variable surface. Every required variable without a description forces the caller to read the source code. Every variable without type information allows misconfiguration that only surfaces at apply time. Every validation rule you skip becomes a support request when a caller passes `"prod"` where you expected `"production"`.

When writing your first production module, follow this checklist: typed variables with descriptions for every input, validation blocks for constrained values, outputs for every attribute another module might reasonably need, and a `versions.tf` that pins the provider range. The `README.md` in each module directory should be generated by `terraform-docs`, not hand-written, so it never falls out of sync.

For the module composition pattern in the example above, notice that the live configuration only references module outputs, never resource attributes directly. This is the correct layering. If you find yourself writing `aws_vpc.main.id` in a live configuration rather than `module.vpc.vpc_id`, the VPC module is missing an output and the caller is reaching inside the module's implementation.

### Senior @ FAANG: Module Design as API Design

At senior level, a Terraform module is an API. It has a public interface (variables and outputs), an implementation (resources), and a contract (what it guarantees about the infrastructure it creates). Designing this API well is a bar-raiser skill.

**Backward compatibility as a first-class concern.** The `optional()` type modifier (Terraform 1.3+) is the mechanism for evolving a module without breaking existing callers. When you add a new feature to an existing module, make the variable optional with a default that preserves the existing behavior. Callers on older configurations continue to work. This is the HCL equivalent of adding a new function parameter with a default value in a Go API. Breaking changes (removing a variable, changing a type, renaming an output) require a major version bump and a migration guide, just like a Go library.

**Interface segregation for modules.** A module that accepts 40 variables is not a clean interface. It is a resource group with a variable file. Apply the Interface Segregation Principle: if a caller using the simple case must set 15 irrelevant variables to their defaults, the module has too large a surface. Split it: a core module with 8 required variables, and optional sub-modules or feature flags for advanced capabilities. The ECS service module in the example above demonstrates this by making `target_group_arn` nullable for worker services that do not need an ALB.

**Output coupling and the principle of least knowledge.** Modules should output only what they know. A VPC module that outputs the raw `aws_vpc` resource object (not possible in HCL, but possible in CDKTF) would create tight coupling between callers and the module's internal implementation. Correct practice is outputting named, typed values (`vpc_id`, `private_subnet_ids`) that callers can use without knowing how the VPC is implemented. If the implementation changes from a single VPC to a multi-CIDR VPC, the output interface can stay stable.

**Autoscaling and lifecycle interaction.** The `ignore_changes = [desired_count]` in the ECS service module is a recurring design decision that senior engineers understand precisely. Without it, every `terraform apply` would reset the task count to the value in the module, overriding the autoscaler. With it, the autoscaler owns `desired_count` at runtime and Terraform owns every other attribute. At bar-raiser level, you explain this as a separation of concerns between the provisioning layer (Terraform) and the runtime control layer (Application Auto Scaling), and you define clearly in the module documentation which attributes fall in each layer.
