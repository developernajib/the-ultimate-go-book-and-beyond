## 102.2 Terraform for Go Services

### Basic Terraform Configuration

Every Terraform project for a Go service begins with three foundational decisions: the minimum Terraform version, the provider versions to pin, and where to store remote state. Using an S3 backend with DynamoDB locking ensures that multiple engineers can run `terraform apply` concurrently without corrupting the state file, while the `default_tags` block on the AWS provider propagates consistent metadata to every resource automatically.

```hcl
# main.tf
terraform {
  required_version = ">= 1.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.0"
    }
  }

  backend "s3" {
    bucket         = "my-terraform-state"
    key            = "go-service/terraform.tfstate"
    region         = "us-west-2"
    encrypt        = true
    dynamodb_table = "terraform-lock"
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Environment = var.environment
      Project     = var.project_name
      ManagedBy   = "terraform"
    }
  }
}
```

### Variables and Outputs

Well-typed variables with validation blocks catch configuration mistakes at `terraform plan` time rather than after resources have been partially created. The `database_config` object variable groups related settings under a single input, keeping the root module interface clean, while marking the `database_endpoint` output as `sensitive` prevents its value from appearing in CI logs or plan summaries.

```hcl
# variables.tf
variable "aws_region" {
  description = "AWS region to deploy resources"
  type        = string
  default     = "us-west-2"
}

variable "environment" {
  description = "Environment name (dev, staging, prod)"
  type        = string
  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "Environment must be dev, staging, or prod."
  }
}

variable "project_name" {
  description = "Name of the project"
  type        = string
}

variable "go_service_image" {
  description = "Docker image for the Go service"
  type        = string
}

variable "go_service_replicas" {
  description = "Number of replicas for the Go service"
  type        = number
  default     = 3
}

variable "database_config" {
  description = "Database configuration"
  type = object({
    instance_class    = string
    allocated_storage = number
    multi_az          = bool
  })
  default = {
    instance_class    = "db.t3.micro"
    allocated_storage = 20
    multi_az          = false
  }
}

# outputs.tf
output "service_endpoint" {
  description = "The endpoint URL for the Go service"
  value       = aws_lb.main.dns_name
}

output "database_endpoint" {
  description = "The endpoint for the RDS database"
  value       = aws_db_instance.main.endpoint
  sensitive   = true
}

output "ecr_repository_url" {
  description = "The URL of the ECR repository"
  value       = aws_ecr_repository.main.repository_url
}
```

### Complete Go Service Infrastructure

A production-ready Go service on AWS requires several layers of infrastructure working together: a VPC with private subnets for workloads, an EKS cluster sized differently per environment, an RDS Postgres instance with automated backups and deletion protection in production, an ECR repository with immutable tags and lifecycle policies, and an ElastiCache Redis cluster with encryption and multi-AZ failover. The configuration below composes all five layers from official community modules and first-party resources, with environment-aware defaults so the same code drives both development and production deployments.

```hcl
# vpc.tf
module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.0"

  name = "${var.project_name}-${var.environment}"
  cidr = "10.0.0.0/16"

  azs             = ["${var.aws_region}a", "${var.aws_region}b", "${var.aws_region}c"]
  private_subnets = ["10.0.1.0/24", "10.0.2.0/24", "10.0.3.0/24"]
  public_subnets  = ["10.0.101.0/24", "10.0.102.0/24", "10.0.103.0/24"]

  enable_nat_gateway   = true
  single_nat_gateway   = var.environment != "prod"
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    "kubernetes.io/cluster/${var.project_name}" = "shared"
  }

  public_subnet_tags = {
    "kubernetes.io/role/elb" = "1"
  }

  private_subnet_tags = {
    "kubernetes.io/role/internal-elb" = "1"
  }
}

# eks.tf
module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 19.0"

  cluster_name    = "${var.project_name}-${var.environment}"
  cluster_version = "1.28"

  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnets

  cluster_endpoint_public_access = true

  eks_managed_node_groups = {
    main = {
      name           = "main"
      instance_types = var.environment == "prod" ? ["m5.large"] : ["t3.medium"]

      min_size     = var.environment == "prod" ? 3 : 1
      max_size     = var.environment == "prod" ? 10 : 3
      desired_size = var.environment == "prod" ? 3 : 2

      labels = {
        Environment = var.environment
      }
    }
  }

  # Cluster access
  manage_aws_auth_configmap = true
}

# rds.tf
resource "aws_db_subnet_group" "main" {
  name       = "${var.project_name}-${var.environment}"
  subnet_ids = module.vpc.private_subnets

  tags = {
    Name = "${var.project_name}-${var.environment}"
  }
}

resource "aws_security_group" "rds" {
  name        = "${var.project_name}-${var.environment}-rds"
  description = "Security group for RDS"
  vpc_id      = module.vpc.vpc_id

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [module.eks.cluster_security_group_id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_db_instance" "main" {
  identifier = "${var.project_name}-${var.environment}"

  engine               = "postgres"
  engine_version       = "15.4"
  instance_class       = var.database_config.instance_class
  allocated_storage    = var.database_config.allocated_storage
  storage_encrypted    = true

  db_name  = replace(var.project_name, "-", "_")
  username = "admin"
  password = random_password.db_password.result

  multi_az               = var.database_config.multi_az
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]

  backup_retention_period = var.environment == "prod" ? 30 : 7
  skip_final_snapshot     = var.environment != "prod"
  deletion_protection     = var.environment == "prod"

  performance_insights_enabled = var.environment == "prod"
}

resource "random_password" "db_password" {
  length  = 32
  special = false
}

# Store password in Secrets Manager
resource "aws_secretsmanager_secret" "db_password" {
  name = "${var.project_name}/${var.environment}/db-password"
}

resource "aws_secretsmanager_secret_version" "db_password" {
  secret_id     = aws_secretsmanager_secret.db_password.id
  secret_string = jsonencode({
    username = aws_db_instance.main.username
    password = random_password.db_password.result
    host     = aws_db_instance.main.address
    port     = aws_db_instance.main.port
    dbname   = aws_db_instance.main.db_name
  })
}

# ecr.tf
resource "aws_ecr_repository" "main" {
  name                 = "${var.project_name}"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }
}

resource "aws_ecr_lifecycle_policy" "main" {
  repository = aws_ecr_repository.main.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Keep last 30 images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 30
        }
        action = {
          type = "expire"
        }
      }
    ]
  })
}

# redis.tf
resource "aws_elasticache_subnet_group" "main" {
  name       = "${var.project_name}-${var.environment}"
  subnet_ids = module.vpc.private_subnets
}

resource "aws_security_group" "redis" {
  name        = "${var.project_name}-${var.environment}-redis"
  description = "Security group for ElastiCache"
  vpc_id      = module.vpc.vpc_id

  ingress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [module.eks.cluster_security_group_id]
  }
}

resource "aws_elasticache_replication_group" "main" {
  replication_group_id = "${var.project_name}-${var.environment}"
  description          = "Redis cluster for ${var.project_name}"

  engine               = "redis"
  engine_version       = "7.0"
  node_type            = var.environment == "prod" ? "cache.r6g.large" : "cache.t3.micro"
  num_cache_clusters   = var.environment == "prod" ? 2 : 1

  automatic_failover_enabled = var.environment == "prod"
  multi_az_enabled           = var.environment == "prod"

  subnet_group_name  = aws_elasticache_subnet_group.main.name
  security_group_ids = [aws_security_group.redis.id]

  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
}
```

---

### Junior → FAANG: Terraform Workflow and the Plan-Apply Discipline

The core Terraform workflow is `init` (download providers), `plan` (show what would change), and `apply` (make the changes). The plan step is the most important and the most frequently skipped. A plan output that destroys 5 resources when you expected to modify 2 is the warning that prevents a major incident. Reading plan outputs carefully before applying is a discipline that prevents the vast majority of Terraform-related incidents.

Remote state configuration (an S3 bucket or Terraform Cloud workspace) is not optional in any shared or production environment. Local state files are lost when the laptop is replaced, not visible to team members, and not locked to prevent concurrent applies. Remote state with locking ensures that only one `apply` runs at a time, preventing state corruption from concurrent modifications.

First-job habit: always use `terraform fmt` and `terraform validate` before committing Terraform code. The formatter enforces consistent style (removing the "whose style is this?" debate from code review), and validate catches structural errors before a plan is even run. Both are instant and costless.

### Senior @ FAANG: Terraform at Scale and the Module Architecture

At staff level, Terraform at scale requires a module architecture that balances standardization with flexibility. The root module pattern (one root module per environment, composed from reusable child modules) is the standard structure for organizations with multiple environments. The module hierarchy: platform modules (owned by the platform team, provide standardized building blocks like VPCs, EKS clusters, RDS instances), service modules (owned by service teams, compose platform modules into service-specific infrastructure), and environment roots (thin compositions of service modules with environment-specific variable values).

The state isolation decision is critical: should production, staging, and development share a state backend (with workspace isolation) or use completely separate backends? Workspace isolation provides convenience (one backend to manage) but means production state lives in the same bucket as development state. Separate backends provide stronger isolation but require more operational setup. For regulated environments, separate backends (and ideally separate AWS accounts or GCP projects) are the correct choice.

Terraform testing at organizational scale: `terraform validate` catches syntax errors, `tflint` catches configuration anti-patterns, `checkov` or `tfsec` catches security misconfigurations, and integration tests using `terratest` verify that the real infrastructure behavior matches the declared configuration. Each layer catches different classes of issues, and all four should run in CI before any Terraform change is applied to production.
